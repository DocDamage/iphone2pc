import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteBridge } from "./remote-bridge.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(): void {}

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("RemoteBridge", () => {
  it("ignores delayed callbacks from a socket replaced by reconfiguration", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const bridge = new RemoteBridge(
      () => "http://127.0.0.1:1234",
      () => ({ roomId: "room", secret: "relay-secret" }),
      () => "transfer-secret",
      () => "123456",
      vi.fn()
    );

    bridge.configure(true, "wss://first-relay.example");
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emitOpen();

    bridge.configure(true, "wss://second-relay.example");
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.emitOpen();
    expect(bridge.getStatus()).toMatchObject({ connected: true, lastError: undefined });

    firstSocket.emitError();
    firstSocket.emitClose();
    vi.advanceTimersByTime(3_000);

    expect(bridge.getStatus()).toMatchObject({ connected: true, lastError: undefined });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(secondSocket.url).toContain("second-relay.example");
    bridge.stop();
  });
});
