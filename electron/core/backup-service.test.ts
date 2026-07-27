import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService } from "./backup-service.js";
import { StateStore } from "./store.js";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("BackupService", () => {
  it("deduplicates restore objects and restores verified versions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-backup-"));
    const destination = path.join(root, "incoming");
    const source = path.join(root, "song.wav");
    await writeFile(source, "version one");
    const digest = crypto.createHash("sha256").update("version one").digest("hex");
    const store = new StateStore(path.join(root, "state"));
    stores.push(store);
    await store.load();
    await store.updateSettings({ destinationDirectory: destination });
    await store.upsertTransfer({
      id: crypto.randomUUID(),
      direction: "iphone-to-pc",
      fileName: "song.wav",
      size: 11,
      mimeType: "audio/wav",
      status: "completed",
      sourceDevice: "iPhone",
      createdAt: new Date().toISOString(),
      savedPath: source,
      sha256: digest,
      verified: true
    });
    const service = new BackupService(store, root, () => true);
    const first = await service.create("manual");
    const second = await service.create("manual");
    expect(first.uniqueBytes).toBe(11);
    expect(second.uniqueBytes).toBe(0);
    const restored = await service.restore(first.id);
    expect(await readFile(path.join(restored, "song.wav"), "utf8")).toBe("version one");
  });

  it("hashes the source bytes again when a file changed before the snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-backup-"));
    const destination = path.join(root, "incoming");
    const source = path.join(root, "song.wav");
    await writeFile(source, "version one");
    const staleDigest = crypto.createHash("sha256").update("version one").digest("hex");
    const currentDigest = crypto.createHash("sha256").update("version two").digest("hex");
    const store = new StateStore(path.join(root, "state"));
    stores.push(store);
    await store.load();
    await store.updateSettings({ destinationDirectory: destination });
    await store.upsertTransfer({
      id: crypto.randomUUID(),
      direction: "iphone-to-pc",
      fileName: "song.wav",
      size: 11,
      mimeType: "audio/wav",
      status: "completed",
      sourceDevice: "iPhone",
      createdAt: new Date().toISOString(),
      savedPath: source,
      sha256: staleDigest,
      verified: true
    });
    await writeFile(source, "version two");

    const service = new BackupService(store, root, () => true);
    const snapshot = await service.create("manual");

    expect(snapshot.entries[0]?.sha256).toBe(currentDigest);
    const restored = await service.restore(snapshot.id);
    expect(await readFile(path.join(restored, "song.wav"), "utf8")).toBe("version two");
  });

  it("keeps a snapshot unchanged when its live source is edited later", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-backup-"));
    const destination = path.join(root, "incoming");
    const source = path.join(root, "song.wav");
    await writeFile(source, "version one");
    const digest = crypto.createHash("sha256").update("version one").digest("hex");
    const store = new StateStore(path.join(root, "state"));
    stores.push(store);
    await store.load();
    await store.updateSettings({ destinationDirectory: destination });
    await store.upsertTransfer({
      id: crypto.randomUUID(),
      direction: "iphone-to-pc",
      fileName: "song.wav",
      size: 11,
      mimeType: "audio/wav",
      status: "completed",
      sourceDevice: "iPhone",
      createdAt: new Date().toISOString(),
      savedPath: source,
      sha256: digest,
      verified: true
    });

    const service = new BackupService(store, root, () => true);
    const snapshot = await service.create("manual");
    await writeFile(source, "version two");

    const restored = await service.restore(snapshot.id);
    expect(await readFile(path.join(restored, "song.wav"), "utf8")).toBe("version one");
  });
});
