import crypto from "node:crypto";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { ensureDirectory, sanitizeFileName, uniqueFilePath } from "./file-utils.js";
import { sha256File } from "./crypto-utils.js";
import { StateStore } from "./store.js";
import type { VaultItem } from "./types.js";

const MAGIC = Buffer.from("PDVAULT1", "ascii");
const HEADER_SIZE = MAGIC.length + 12;
const TAG_SIZE = 16;

function mimeTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".heic": "image/heic",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain"
  };
  return types[extension] ?? "application/octet-stream";
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 10) throw new Error("Use a vault passphrase with at least 10 characters.");
  return crypto.scryptSync(passphrase, salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
}

function keyCheck(key: Buffer): string {
  return crypto.createHmac("sha256", key).update("PocketDock Vault 2.5").digest("base64url");
}

export class VaultService {
  private key: Buffer | null = null;
  private unlockedUntil = 0;

  constructor(
    private readonly store: StateStore,
    private readonly vaultDirectory: string
  ) {}

  async initialize(passphrase: string): Promise<void> {
    if (this.store.getVaultMetadata()) throw new Error("The vault is already initialized.");
    const salt = crypto.randomBytes(16);
    const key = deriveKey(passphrase, salt);
    await ensureDirectory(this.vaultDirectory);
    this.store.setVaultMetadata({
      salt: salt.toString("base64url"),
      keyCheck: keyCheck(key)
    });
    this.setUnlockedKey(key);
  }

  unlock(passphrase: string): void {
    const metadata = this.store.getVaultMetadata();
    if (!metadata) throw new Error("Initialize the vault first.");
    const key = deriveKey(passphrase, Buffer.from(metadata.salt, "base64url"));
    const expected = Buffer.from(metadata.keyCheck);
    const actual = Buffer.from(keyCheck(key));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      key.fill(0);
      throw new Error("The vault passphrase is incorrect.");
    }
    this.setUnlockedKey(key);
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.unlockedUntil = 0;
  }

  isUnlocked(): boolean {
    if (!this.key || this.unlockedUntil < Date.now()) {
      this.lock();
      return false;
    }
    return true;
  }

  async addFiles(filePaths: string[]): Promise<void> {
    const key = this.requireKey();
    await ensureDirectory(this.vaultDirectory);
    for (const filePath of filePaths) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      const id = crypto.randomUUID();
      const name = sanitizeFileName(path.basename(filePath));
      const encryptedPath = path.join(this.vaultDirectory, `${id}.pdvault`);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`${id}:${name}:${info.size}`, "utf8"));
      const output = createWriteStream(encryptedPath, { flags: "wx" });
      output.write(Buffer.concat([MAGIC, nonce]));
      try {
        await pipeline(createReadStream(filePath), cipher, output);
        await appendFile(encryptedPath, cipher.getAuthTag());
        const item: VaultItem = {
          id,
          name,
          encryptedPath,
          size: info.size,
          mimeType: mimeTypeFor(name),
          sha256: await sha256File(filePath),
          createdAt: new Date().toISOString(),
          sourcePath: filePath
        };
        await this.store.upsertVaultItem(item);
      } catch (error) {
        await rm(encryptedPath, { force: true });
        throw error;
      }
    }
    this.refreshAutoLock();
  }

  async exportItem(id: string, destinationDirectory: string): Promise<string> {
    const key = this.requireKey();
    const item = this.store.getVaultItems().find((entry) => entry.id === id);
    if (!item) throw new Error("Vault item not found.");
    await ensureDirectory(destinationDirectory);
    const destination = await uniqueFilePath(path.join(destinationDirectory, item.name));
    const info = await stat(item.encryptedPath);
    if (info.size < HEADER_SIZE + TAG_SIZE) throw new Error("Vault item is incomplete.");
    const handle = await open(item.encryptedPath, "r");
    const header = Buffer.alloc(HEADER_SIZE);
    const tag = Buffer.alloc(TAG_SIZE);
    try {
      await handle.read(header, 0, HEADER_SIZE, 0);
      await handle.read(tag, 0, TAG_SIZE, info.size - TAG_SIZE);
    } finally {
      await handle.close();
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Vault item has an unknown format.");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.length)
    );
    decipher.setAAD(Buffer.from(`${item.id}:${item.name}:${item.size}`, "utf8"));
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(item.encryptedPath, {
          start: HEADER_SIZE,
          end: info.size - TAG_SIZE - 1
        }),
        decipher,
        createWriteStream(destination, { flags: "wx" })
      );
      const digest = await sha256File(destination);
      if (digest !== item.sha256) {
        await rm(destination, { force: true });
        throw new Error("Vault export integrity verification failed.");
      }
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    this.refreshAutoLock();
    return destination;
  }

  async removeItem(id: string): Promise<void> {
    this.requireKey();
    const item = this.store.getVaultItems().find((entry) => entry.id === id);
    if (!item) return;
    await rm(item.encryptedPath, { force: true });
    await this.store.removeVaultItem(id);
    this.refreshAutoLock();
  }

  private setUnlockedKey(key: Buffer): void {
    this.lock();
    this.key = Buffer.from(key);
    key.fill(0);
    this.refreshAutoLock();
  }

  private requireKey(): Buffer {
    if (!this.isUnlocked() || !this.key) throw new Error("Unlock the vault first.");
    this.refreshAutoLock();
    return this.key;
  }

  private refreshAutoLock(): void {
    const minutes = this.store.getSettings().vaultAutoLockMinutes;
    this.unlockedUntil = Date.now() + minutes * 60_000;
  }
}
