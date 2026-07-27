import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Relay message timed out.")), 5_000);
    const listener = (data, isBinary) => {
      if (!predicate(data, isBinary)) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(data);
    };
    socket.on("message", listener);
  });
}

const port = await availablePort();
const testMessageLimit = 1_024;
const child = spawn(process.execPath, ["dist/server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    BIND_ADDRESS: "127.0.0.1",
    MAX_MESSAGE_BYTES: String(testMessageLimit)
  },
  stdio: ["ignore", "pipe", "inherit"]
});

try {
  await once(child.stdout, "data");
  const room = "pocketdock-test-room";
  const secret = "this-is-a-long-random-test-room-secret";
  const pc = new WebSocket(
    `ws://127.0.0.1:${port}/v2/relay?room=${room}&role=pc&secret=${secret}`
  );
  await once(pc, "open");
  const phone = new WebSocket(
    `ws://127.0.0.1:${port}/v2/relay?room=${room}&role=iphone&secret=${secret}`
  );
  await once(phone, "open");
  await waitForMessage(phone, (data, isBinary) =>
    !isBinary && data.toString().includes('"type":"paired"')
  );

  const received = waitForMessage(pc, (_data, isBinary) => isBinary);
  phone.send(Buffer.from("encrypted-frame"));
  const payload = await received;
  if (payload.toString() !== "encrypted-frame") throw new Error("Relay changed the payload.");

  const boundaryReceived = waitForMessage(pc, (_data, isBinary) => isBinary);
  phone.send(Buffer.alloc(testMessageLimit, 0x61));
  const boundaryPayload = await boundaryReceived;
  if (boundaryPayload.byteLength !== testMessageLimit) {
    throw new Error("Relay rejected a frame at the configured message limit.");
  }

  const oversizedClose = once(phone, "close");
  phone.send(Buffer.alloc(testMessageLimit + 1, 0x62));
  const [closeCode] = await Promise.race([
    oversizedClose,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Relay accepted an oversized frame.")), 5_000)
    )
  ]);
  if (closeCode !== 1009) throw new Error("Relay used the wrong oversized-frame close code.");

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!health.ok) throw new Error("Relay health endpoint failed.");
  pc.close();
  phone.close();
  process.stdout.write("PocketDock relay smoke test passed.\n");
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}
