import { describe, expect, it } from "vitest";
import { PairingManager } from "./security.js";

describe("PairingManager", () => {
  it("creates a six-digit code and validates a paired session", () => {
    const pairing = new PairingManager();
    expect(pairing.getPin()).toMatch(/^\d{6}$/);

    const result = pairing.pair(pairing.getPin(), "Doc’s iPhone", "192.168.1.3");
    expect(result?.token).toBeTruthy();
    expect(pairing.validate(result?.token)?.deviceName).toBe("Doc’s iPhone");
    expect(pairing.connectedDeviceCount()).toBe(1);
  });

  it("rejects a wrong code and revokes sessions", () => {
    const pairing = new PairingManager();
    expect(pairing.pair("000000", "Unknown", "192.168.1.8")).toBeNull();
    const result = pairing.pair(pairing.getPin(), "iPhone", "192.168.1.8");
    expect(result).not.toBeNull();
    pairing.revokeAll();
    expect(pairing.validate(result?.token)).toBeNull();
  });

  it("rotates the pairing code without keeping the previous code", () => {
    const pairing = new PairingManager();
    const oldPin = pairing.getPin();
    let newPin = pairing.rotatePin();
    while (newPin === oldPin) newPin = pairing.rotatePin();
    expect(pairing.pair(oldPin, "iPhone", "192.168.1.2")).toBeNull();
    expect(pairing.pair(newPin, "iPhone", "192.168.1.2")).not.toBeNull();
  });
});
