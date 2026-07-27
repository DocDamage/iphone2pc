import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTransferChunk,
  encryptTransferChunk,
  hashSecret,
  secureHexEqual,
  sha256File
} from "./crypto-utils.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("encrypted transfer primitives", () => {
  it("round-trips AES-256-GCM chunks and authenticates their metadata", () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const plaintext = Buffer.from("A PocketDock file chunk");
    const encrypted = encryptTransferChunk(secret, "upload-1", 4_194_304, plaintext);

    expect(
      decryptTransferChunk(
        secret,
        "upload-1",
        4_194_304,
        plaintext.length,
        encrypted.iv,
        encrypted.payload
      )
    ).toEqual(plaintext);
    expect(() =>
      decryptTransferChunk(
        secret,
        "upload-1",
        0,
        plaintext.length,
        encrypted.iv,
        encrypted.payload
      )
    ).toThrow();
  });

  it("rejects a modified authentication tag", () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const encrypted = encryptTransferChunk(secret, "upload-2", 0, Buffer.from("original"));
    encrypted.payload[encrypted.payload.length - 1] ^= 0xff;
    expect(() =>
      decryptTransferChunk(secret, "upload-2", 0, 8, encrypted.iv, encrypted.payload)
    ).toThrow();
  });

  it("hashes files and compares secret hashes without length leaks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-crypto-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "sample.bin");
    await writeFile(filePath, "abc");
    expect(await sha256File(filePath)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(secureHexEqual(hashSecret("secret"), hashSecret("secret"))).toBe(true);
    expect(secureHexEqual(hashSecret("secret"), hashSecret("other"))).toBe(false);
    expect(secureHexEqual("aa", "aaaa")).toBe(false);
  });
});
