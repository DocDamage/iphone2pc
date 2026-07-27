import crypto from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";
import { describe, expect, it } from "vitest";
import { decryptTransferChunk, encryptTransferChunk } from "./crypto-utils.js";

describe("iPhone browser portable AES-GCM compatibility", () => {
  it("encrypts bytes that the desktop service can authenticate and decrypt", () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = Buffer.from("PocketDock iPhone browser fallback");
    const identifier = crypto.randomUUID();
    const aad = Buffer.from(`${identifier}:0:${plaintext.length}`);
    const payload = gcm(key, nonce, aad).encrypt(plaintext);

    expect(
      decryptTransferChunk(
        key.toString("base64url"),
        identifier,
        0,
        plaintext.length,
        nonce.toString("base64url"),
        Buffer.from(payload)
      )
    ).toEqual(plaintext);
  });

  it("decrypts desktop chunks with the portable browser implementation", () => {
    const key = crypto.randomBytes(32);
    const keyText = key.toString("base64url");
    const plaintext = Buffer.from("PocketDock desktop payload");
    const identifier = crypto.randomUUID();
    const encrypted = encryptTransferChunk(keyText, identifier, 0, plaintext);
    const aad = Buffer.from(`${identifier}:0:${plaintext.length}`);

    expect(
      Buffer.from(
        gcm(
          key,
          Buffer.from(encrypted.iv, "base64url"),
          aad
        ).decrypt(encrypted.payload)
      )
    ).toEqual(plaintext);
  });
});
