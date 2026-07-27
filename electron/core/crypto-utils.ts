import crypto from "node:crypto";
import { createReadStream } from "node:fs";

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function secureHexEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected.toLowerCase());
  const right = Buffer.from(actual.toLowerCase());
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function decryptTransferChunk(
  transferSecret: string,
  uploadId: string,
  offset: number,
  plainLength: number,
  iv: string,
  payload: Buffer
): Buffer {
  if (payload.length < 16) throw new Error("Encrypted chunk is incomplete.");
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  if (ciphertext.length !== plainLength) {
    throw new Error("Encrypted chunk length does not match its metadata.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(transferSecret, "base64url"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(Buffer.from(`${uploadId}:${offset}:${plainLength}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptTransferChunk(
  transferSecret: string,
  shareId: string,
  offset: number,
  plaintext: Buffer
): { iv: string; payload: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(transferSecret, "base64url"),
    iv
  );
  cipher.setAAD(Buffer.from(`${shareId}:${offset}:${plaintext.length}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    payload: Buffer.concat([ciphertext, cipher.getAuthTag()])
  };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function readRequestBody(
  request: NodeJS.ReadableStream,
  maximumBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maximumBytes) throw new Error("Request body exceeds the chunk limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
