import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "./store.js";
import { VaultService } from "./vault-service.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("VaultService", () => {
  it("encrypts at rest, rejects a wrong passphrase, and verifies the exported file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-vault-"));
    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => store.close());

    const original = path.join(root, "master.wav");
    const bytes = Buffer.from("PocketDock vault plaintext must never appear in the vault file.");
    await writeFile(original, bytes);
    const vault = new VaultService(store, path.join(root, "vault"));
    await vault.initialize("correct horse battery staple");
    await vault.addFiles([original]);
    const item = store.getVaultItems()[0];
    expect(item).toBeTruthy();
    expect((await readFile(item.encryptedPath)).includes(bytes)).toBe(false);

    vault.lock();
    expect(() => vault.unlock("this passphrase is wrong")).toThrow(/incorrect/i);
    vault.unlock("correct horse battery staple");
    const exported = await vault.exportItem(item.id, path.join(root, "export"));
    expect(await readFile(exported)).toEqual(bytes);
  });

  it("does not leave plaintext behind when an encrypted item is tampered with", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-vault-tamper-"));
    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => store.close());

    const original = path.join(root, "notes.txt");
    await writeFile(original, "private notes");
    const vault = new VaultService(store, path.join(root, "vault"));
    await vault.initialize("a very strong vault passphrase");
    await vault.addFiles([original]);
    const item = store.getVaultItems()[0];
    const encrypted = await readFile(item.encryptedPath);
    encrypted[20] ^= 0xff;
    await writeFile(item.encryptedPath, encrypted);
    await expect(vault.exportItem(item.id, path.join(root, "export"))).rejects.toThrow();
  });
});
