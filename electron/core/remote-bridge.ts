import type { RemoteStatus } from "./types.js";
import {
  decryptRemoteTunnel,
  createRemoteEphemeralKeyPair,
  deriveRemoteSessionSecret,
  encryptRemoteTunnel,
  type RemoteEphemeralKeyPair,
  type RemoteTunnelEnvelope
} from "./remote-tunnel.js";
import { RemoteReplayGuard } from "./remote-replay-guard.js";

interface RelayRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RelayControl {
  type: "paired" | "waiting" | "peer-left";
}

interface RelayKeyExchange {
  type: "key-exchange";
  version: 2;
  publicKey: string;
}

export class RemoteBridge {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionGeneration = 0;
  private stopped = true;
  private readonly replayGuard = new RemoteReplayGuard();
  private ephemeral: RemoteEphemeralKeyPair | null = null;
  private sessionSecret: string | null = null;
  private status: RemoteStatus = {
    configured: false,
    connected: false,
    waitingForPeer: false
  };

  constructor(
    private readonly localBaseUrl: () => string | null,
    private readonly relayIdentity: () => { roomId: string; secret: string },
    private readonly transferSecret: () => string,
    private readonly pairingPin: () => string,
    private readonly onStatus: () => void
  ) {}

  configure(enabled: boolean, relayBaseUrl: string): void {
    this.stop();
    this.status = {
      configured: enabled && Boolean(relayBaseUrl),
      connected: false,
      waitingForPeer: false,
      rejectedReplayCount: 0,
      forwardSecrecyActive: false
    };
    if (!this.status.configured) {
      this.onStatus();
      return;
    }
    this.stopped = false;
    this.connect(relayBaseUrl);
  }

  stop(): void {
    this.stopped = true;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "PocketDock stopping");
    this.socket = null;
    this.ephemeral = null;
    this.sessionSecret = null;
    this.status = {
      ...this.status,
      connected: false,
      waitingForPeer: false
    };
  }

  getStatus(relayBaseUrl = ""): RemoteStatus {
    const identity = this.relayIdentity();
    let pairingUrl: string | undefined;
    if (this.status.configured && relayBaseUrl) {
      const relayUrl = this.createRelayUrl(relayBaseUrl, "iphone");
      const encodedRelay = Buffer.from(relayUrl.toString(), "utf8").toString("base64url");
      pairingUrl =
        `pocketdock://pair?relay=${encodedRelay}&code=${this.pairingPin()}` +
        `#key=${this.transferSecret()}`;
    }
    return { ...this.status, pairingUrl };
  }

  private connect(relayBaseUrl: string): void {
    if (this.stopped) return;
    const generation = ++this.connectionGeneration;
    let url: URL;
    try {
      url = this.createRelayUrl(relayBaseUrl, "pc");
      if (
        url.protocol !== "wss:" &&
        !(url.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(url.hostname))
      ) {
        throw new Error("Use a secure wss:// relay URL.");
      }
    } catch (error) {
      this.setError(error);
      return;
    }
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.status = {
        ...this.status,
        connected: true,
        waitingForPeer: true,
        lastConnectedAt: new Date().toISOString(),
        lastError: undefined,
        forwardSecrecyActive: false
      };
      this.onStatus();
    });
    socket.addEventListener("message", (event) => {
      if (!this.isCurrentConnection(socket, generation)) return;
      if (typeof event.data !== "string") return;
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.socket = null;
      this.status = { ...this.status, connected: false, waitingForPeer: false };
      this.onStatus();
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          if (this.stopped || this.connectionGeneration !== generation) return;
          this.reconnectTimer = null;
          this.connect(relayBaseUrl);
        }, 3_000);
      }
    });
    socket.addEventListener("error", () => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.status = {
        ...this.status,
        lastError: "The relay connection failed."
      };
      this.onStatus();
    });
  }

  private isCurrentConnection(socket: WebSocket, generation: number): boolean {
    return (
      !this.stopped &&
      this.connectionGeneration === generation &&
      this.socket === socket
    );
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: RemoteTunnelEnvelope | RelayControl | RelayKeyExchange;
    try {
      parsed = JSON.parse(raw) as RemoteTunnelEnvelope | RelayControl | RelayKeyExchange;
    } catch {
      return;
    }
    if (parsed.type === "paired") {
      this.status = {
        ...this.status,
        waitingForPeer: false,
        lastPeerAt: new Date().toISOString()
      };
      this.ephemeral = createRemoteEphemeralKeyPair();
      this.sessionSecret = null;
      this.socket?.send(JSON.stringify({
        type: "key-exchange",
        version: 2,
        publicKey: this.ephemeral.publicKey
      }));
      this.onStatus();
      return;
    }
    if (parsed.type === "waiting" || parsed.type === "peer-left") {
      this.status = { ...this.status, waitingForPeer: true };
      this.onStatus();
      return;
    }
    if (parsed.type === "key-exchange") {
      if (!this.ephemeral || parsed.version !== 2) return;
      try {
        this.sessionSecret = deriveRemoteSessionSecret(
          this.ephemeral.privateKey,
          parsed.publicKey,
          this.transferSecret()
        );
        this.status = { ...this.status, forwardSecrecyActive: true };
        this.onStatus();
      } catch {
        this.sessionSecret = null;
      }
      return;
    }
    if (parsed.type !== "tunnel") return;
    try {
      if (parsed.version !== 2 || !this.sessionSecret) return;
      const request = decryptRemoteTunnel<RelayRequest>(
        this.sessionSecret,
        parsed,
        "request"
      );
      if (request.type !== "request" || !request.id) return;
      if (!this.replayGuard.accept(request.id)) {
        this.status = {
          ...this.status,
          rejectedReplayCount: (this.status.rejectedReplayCount ?? 0) + 1
        };
        this.onStatus();
        return;
      }
      await this.proxyRequest(request);
    } catch {
      // Do not answer malformed or plaintext tunnel traffic. The native client
      // must possess the transfer key before any API metadata is accepted.
    }
  }

  private async proxyRequest(request: RelayRequest): Promise<void> {
    const socket = this.socket;
    const baseUrl = this.localBaseUrl();
    if (!socket || socket.readyState !== WebSocket.OPEN || !baseUrl) return;
    try {
      const path = new URL(request.path, "http://pocketdock.invalid");
      if (!path.pathname.startsWith("/api/")) throw new Error("Only PocketDock API routes are allowed.");
      const headers = new Headers();
      const allowedHeaders = new Set([
        "authorization",
        "content-type",
        "x-pocketdock-iv",
        "x-pocketdock-plain-length"
      ]);
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (allowedHeaders.has(name.toLowerCase())) headers.set(name, value);
      }
      // This header is added by the trusted PC-side bridge, never accepted from
      // the relay peer. The local API uses it to enforce per-device remote access.
      headers.set("X-PocketDock-Remote", "1");
      const payload = request.body ? Buffer.from(request.body, "base64") : undefined;
      if (payload && payload.length > 8_500_000) throw new Error("Remote request is too large.");
      const response = await fetch(new URL(path.pathname + path.search, baseUrl), {
        method: request.method,
        headers,
        body: payload ? Uint8Array.from(payload).buffer : undefined
      });
      const body = Buffer.from(await response.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      for (const name of [
        "content-type",
        "x-pocketdock-iv",
        "x-pocketdock-plain-length",
        "retry-after"
      ]) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      this.sendResponse(socket, {
        type: "response",
        id: request.id,
        status: response.status,
        headers: responseHeaders,
        body: body.toString("base64")
      });
    } catch (error) {
      this.sendResponse(socket, {
        type: "response",
        id: request.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Remote bridge failed."
          })
        ).toString("base64")
      });
    }
  }

  private sendResponse(socket: WebSocket, response: object): void {
    const envelope = encryptRemoteTunnel(
      this.sessionSecret!,
      response,
      "response",
      2
    );
    socket.send(JSON.stringify(envelope));
  }

  private createRelayUrl(relayBaseUrl: string, role: "pc" | "iphone"): URL {
    const identity = this.relayIdentity();
    const url = new URL(relayBaseUrl);
    if (!url.pathname || url.pathname === "/") url.pathname = "/v2/relay";
    url.searchParams.set("room", identity.roomId);
    url.searchParams.set("role", role);
    url.searchParams.set("secret", identity.secret);
    return url;
  }

  private setError(error: unknown): void {
    this.status = {
      ...this.status,
      connected: false,
      waitingForPeer: false,
      lastError: error instanceof Error ? error.message : "Relay configuration is invalid."
    };
    this.onStatus();
  }
}
