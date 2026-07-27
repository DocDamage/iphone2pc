import { describe, expect, it } from "vitest";
import {
  decryptRemoteTunnel,
  createRemoteEphemeralKeyPair,
  deriveRemoteSessionSecret,
  encryptRemoteTunnel,
  type RemoteTunnelEnvelope
} from "./remote-tunnel.js";

const secret = Buffer.alloc(32, 7).toString("base64url");

describe("remote tunnel", () => {
  it("round-trips an opaque request envelope", () => {
    const request = {
      type: "request",
      id: "request-1",
      method: "GET",
      path: "/api/shares?private=true",
      headers: { authorization: "Bearer private-token" }
    };
    const encrypted = encryptRemoteTunnel(secret, request, "request");
    const serialized = JSON.stringify(encrypted);

    expect(serialized).not.toContain("/api/shares");
    expect(serialized).not.toContain("private-token");
    expect(decryptRemoteTunnel(secret, encrypted, "request")).toEqual(request);
  });

  it("binds ciphertext to its direction", () => {
    const encrypted = encryptRemoteTunnel(secret, { id: "request-2" }, "request");
    expect(() => decryptRemoteTunnel(secret, encrypted, "response")).toThrow();
  });

  it("rejects tampering", () => {
    const encrypted = encryptRemoteTunnel(secret, { id: "request-3" }, "request");
    const payload = Buffer.from(encrypted.payload, "base64");
    payload[0] ^= 1;
    const tampered: RemoteTunnelEnvelope = {
      ...encrypted,
      payload: payload.toString("base64")
    };
    expect(() => decryptRemoteTunnel(secret, tampered, "request")).toThrow();
  });

  it("derives a forward-secret session key shared by both peers", () => {
    const pc = createRemoteEphemeralKeyPair();
    const iphone = createRemoteEphemeralKeyPair();
    const pcSecret = deriveRemoteSessionSecret(pc.privateKey, iphone.publicKey, secret);
    const iphoneSecret = deriveRemoteSessionSecret(iphone.privateKey, pc.publicKey, secret);
    expect(pcSecret).toBe(iphoneSecret);
    expect(pcSecret).not.toBe(secret);
    const encrypted = encryptRemoteTunnel(
      pcSecret,
      { id: "forward-secret-request" },
      "request",
      2
    );
    expect(encrypted.version).toBe(2);
    expect(decryptRemoteTunnel(iphoneSecret, encrypted, "request")).toEqual({
      id: "forward-secret-request"
    });
  });
});
