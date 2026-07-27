import crypto from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type Role = "pc" | "iphone";

interface Peer {
  socket: WebSocket;
  role: Role;
  roomId: string;
  joinedAt: number;
  bytesThisWindow: number;
  windowStartedAt: number;
  alive: boolean;
}

interface Room {
  secretHash: Buffer;
  peers: Map<Role, Peer>;
  expiresAt: number;
}

const port = Number(process.env.PORT ?? 8_080);
const bindAddress = process.env.BIND_ADDRESS ?? "0.0.0.0";
const maxMessageBytes = Number(process.env.MAX_MESSAGE_BYTES ?? 8_500_000);
const maxBytesPerMinute = Number(process.env.MAX_BYTES_PER_MINUTE ?? 1_000_000_000);
const idleRoomMs = Number(process.env.IDLE_ROOM_MS ?? 15 * 60_000);
const maxRooms = Number(process.env.MAX_ROOMS ?? 10_000);
const rooms = new Map<string, Room>();

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseJoin(request: http.IncomingMessage): {
  roomId: string;
  role: Role;
  secret: string;
} | null {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/v2/relay") return null;
  const roomId = url.searchParams.get("room") ?? "";
  const role = url.searchParams.get("role");
  const secret = url.searchParams.get("secret") ?? "";
  if (!/^[a-zA-Z0-9_-]{16,96}$/.test(roomId)) return null;
  if (role !== "pc" && role !== "iphone") return null;
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret)) return null;
  return { roomId, role, secret };
}

function sendControl(socket: WebSocket, value: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function closePeer(peer: Peer, code: number, reason: string): void {
  if (
    peer.socket.readyState === WebSocket.OPEN ||
    peer.socket.readyState === WebSocket.CONNECTING
  ) {
    peer.socket.close(code, reason);
  }
}

function removePeer(peer: Peer): void {
  const room = rooms.get(peer.roomId);
  if (!room) return;
  if (room.peers.get(peer.role)?.socket === peer.socket) room.peers.delete(peer.role);
  room.expiresAt = Date.now() + idleRoomMs;
  for (const remaining of room.peers.values()) {
    sendControl(remaining.socket, { type: "peer-left", role: peer.role });
  }
}

const server = http.createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", rooms: rooms.size, version: 3 }));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: maxMessageBytes,
  perMessageDeflate: false,
  clientTracking: false
});

server.on("upgrade", (request, socket, head) => {
  const join = parseJoin(request);
  if (!join) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!rooms.has(join.roomId) && rooms.size >= maxRooms) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, request, join);
  });
});

sockets.on(
  "connection",
  (socket: WebSocket, _request: http.IncomingMessage, join: ReturnType<typeof parseJoin>) => {
    if (!join) {
      socket.close(1008, "Invalid join request");
      return;
    }
    const candidateHash = crypto.createHash("sha256").update(join.secret).digest();
    let room = rooms.get(join.roomId);
    if (!room) {
      room = {
        secretHash: candidateHash,
        peers: new Map(),
        expiresAt: Date.now() + idleRoomMs
      };
      rooms.set(join.roomId, room);
    } else if (!constantTimeEqual(room.secretHash, candidateHash)) {
      socket.close(1008, "Room authentication failed");
      return;
    }

    const existing = room.peers.get(join.role);
    if (existing) closePeer(existing, 4001, "Replaced by a newer connection");
    const peer: Peer = {
      socket,
      role: join.role,
      roomId: join.roomId,
      joinedAt: Date.now(),
      bytesThisWindow: 0,
      windowStartedAt: Date.now(),
      alive: true
    };
    room.peers.set(join.role, peer);
    room.expiresAt = Date.now() + idleRoomMs;

    const otherRole: Role = join.role === "pc" ? "iphone" : "pc";
    const other = room.peers.get(otherRole);
    sendControl(socket, {
      type: other ? "paired" : "waiting",
      role: join.role,
      protocolVersion: 3
    });
    if (other) sendControl(other.socket, { type: "paired", role: other.role, protocolVersion: 3 });

    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - peer.windowStartedAt >= 60_000) {
        peer.windowStartedAt = now;
        peer.bytesThisWindow = 0;
      }
      const bytes = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.length, 0)
        : data.byteLength;
      peer.bytesThisWindow += bytes;
      if (peer.bytesThisWindow > maxBytesPerMinute) {
        closePeer(peer, 1008, "Rate limit exceeded");
        return;
      }
      room!.expiresAt = now + idleRoomMs;
      const destination = room!.peers.get(otherRole);
      if (destination?.socket.readyState === WebSocket.OPEN) {
        destination.socket.send(data, { binary: isBinary });
      } else {
        sendControl(socket, { type: "waiting", role: join.role, protocolVersion: 3 });
      }
    });
    socket.on("close", () => removePeer(peer));
    socket.on("error", () => removePeer(peer));
  }
);

const maintenance = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    for (const peer of room.peers.values()) {
      if (!peer.alive) {
        closePeer(peer, 1001, "Connection timed out");
        removePeer(peer);
        continue;
      }
      peer.alive = false;
      if (peer.socket.readyState === WebSocket.OPEN) peer.socket.ping();
    }
    if (room.peers.size === 0 && room.expiresAt < now) rooms.delete(roomId);
  }
}, 30_000);
maintenance.unref();

function shutdown(): void {
  clearInterval(maintenance);
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) closePeer(peer, 1001, "Relay shutting down");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, bindAddress, () => {
  process.stdout.write(`PocketDock relay listening on ${bindAddress}:${port}\n`);
});
