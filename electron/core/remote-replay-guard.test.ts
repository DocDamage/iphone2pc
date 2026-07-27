import { describe, expect, it } from "vitest";
import { RemoteReplayGuard } from "./remote-replay-guard.js";

describe("remote replay guard", () => {
  it("rejects duplicate and malformed request identifiers", () => {
    const guard = new RemoteReplayGuard();
    expect(guard.accept("request-0001", 1_000)).toBe(true);
    expect(guard.accept("request-0001", 1_001)).toBe(false);
    expect(guard.accept("../bad", 1_002)).toBe(false);
  });

  it("expires old identifiers and bounds memory", () => {
    const guard = new RemoteReplayGuard(100, 2);
    expect(guard.accept("request-0001", 1_000)).toBe(true);
    expect(guard.accept("request-0002", 1_010)).toBe(true);
    expect(guard.accept("request-0003", 1_020)).toBe(true);
    expect(guard.accept("request-0001", 1_030)).toBe(true);
    expect(guard.accept("request-0001", 1_200)).toBe(true);
  });
});
