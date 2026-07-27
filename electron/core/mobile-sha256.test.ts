import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface BrowserHasher {
  update(input: Uint8Array): BrowserHasher;
  digestHex(): string;
}

async function browserHasher(): Promise<new () => BrowserHasher> {
  const source = await readFile("public/mobile/mobile.js", "utf8");
  const start = source.indexOf("  const SHA256_CONSTANTS");
  const end = source.indexOf("\n  const fragmentKey");
  if (start < 0 || end < 0) throw new Error("Could not locate the browser SHA-256 implementation.");
  return Function(`${source.slice(start, end)}\nreturn Sha256;`)() as new () => BrowserHasher;
}

describe("iPhone browser SHA-256", () => {
  it("matches standard vectors across uneven chunks", async () => {
    const Sha256 = await browserHasher();
    const input = crypto.randomBytes(1_000_003);
    const hasher = new Sha256();
    hasher.update(input.subarray(0, 1));
    hasher.update(input.subarray(1, 777_777));
    hasher.update(input.subarray(777_777));
    expect(hasher.digestHex()).toBe(crypto.createHash("sha256").update(input).digest("hex"));
  });

  it("matches the empty digest", async () => {
    const Sha256 = await browserHasher();
    expect(new Sha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
