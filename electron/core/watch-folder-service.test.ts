import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "./store.js";
import type { WatchFolder } from "./types.js";
import { WatchFolderService } from "./watch-folder-service.js";

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createFixture(): Promise<{
  root: string;
  stateDirectory: string;
  watchDirectory: string;
  watchedFile: string;
  folder: WatchFolder;
  store: StateStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-watch-"));
  temporaryDirectories.push(root);
  const stateDirectory = path.join(root, "state");
  const watchDirectory = path.join(root, "watched");
  const watchedFile = path.join(watchDirectory, "mix.wav");
  await mkdir(watchDirectory, { recursive: true });
  await writeFile(watchedFile, "first mix");

  const store = new StateStore(stateDirectory);
  openStores.push(store);
  await store.load();
  const folder: WatchFolder = {
    id: "watch-1",
    name: "Mixes",
    directory: watchDirectory,
    mode: "share",
    enabled: true,
    recursive: true,
    includeExtensions: ["wav"],
    expiresMinutes: 0,
    createdAt: new Date().toISOString()
  };
  await store.upsertWatchFolder(folder);
  return { root, stateDirectory, watchDirectory, watchedFile, folder, store };
}

describe("watch folder checkpoints", () => {
  it("baselines existing files when added and processes only later changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-watch-create-"));
    temporaryDirectories.push(root);
    const watchDirectory = path.join(root, "existing-beats");
    const watchedFile = path.join(watchDirectory, "existing.wav");
    await mkdir(watchDirectory, { recursive: true });
    await writeFile(watchedFile, "existing");
    const store = new StateStore(path.join(root, "state"));
    openStores.push(store);
    await store.load();
    const processFiles = vi.fn(async () => undefined);
    const service = new WatchFolderService(store, processFiles);

    const folder = await service.create(watchDirectory);
    expect(processFiles).not.toHaveBeenCalled();
    expect(store.getWatchFolderFingerprints(folder.id).size).toBe(1);

    await writeFile(watchedFile, "changed and larger");
    await service.scanNow(folder.id);
    expect(processFiles).toHaveBeenCalledWith([watchedFile], expect.any(Object));
  });

  it("retries unchanged files when processing the prior scan failed", async () => {
    const { folder, watchedFile, store } = await createFixture();
    const processFiles = vi
      .fn<(paths: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("share registration failed"))
      .mockResolvedValue(undefined);
    const service = new WatchFolderService(store, processFiles);

    await expect(service.scan(folder.id)).rejects.toThrow(
      "share registration failed"
    );
    expect(processFiles).toHaveBeenCalledWith([watchedFile], expect.any(Object));
    expect(store.getWatchFolderFingerprints(folder.id)).toEqual(new Map());

    await service.scan(folder.id);
    await service.scan(folder.id);

    expect(processFiles).toHaveBeenCalledTimes(2);
    expect(store.getWatchFolderFingerprints(folder.id).get(watchedFile)).toMatch(
      /^\d+:\d+(?:\.\d+)?$/
    );
  });

  it("does not reprocess unchanged files after the service and store restart", async () => {
    const { stateDirectory, folder, store } = await createFixture();
    const firstProcessor = vi.fn(async () => undefined);
    const firstService = new WatchFolderService(store, firstProcessor);
    await firstService.scan(folder.id);
    expect(firstProcessor).toHaveBeenCalledOnce();

    store.close();
    const restartedStore = new StateStore(stateDirectory);
    openStores.push(restartedStore);
    await restartedStore.load();
    const restartedProcessor = vi.fn(async () => undefined);
    const restartedService = new WatchFolderService(
      restartedStore,
      restartedProcessor
    );

    await restartedService.scan(folder.id);

    expect(restartedProcessor).not.toHaveBeenCalled();
  });

  it("removes persisted checkpoints with their watch folder", async () => {
    const { folder, store } = await createFixture();
    const service = new WatchFolderService(store, async () => undefined);
    await service.scan(folder.id);
    expect(store.getWatchFolderFingerprints(folder.id).size).toBe(1);

    await service.remove(folder.id);

    expect(store.getWatchFolderFingerprints(folder.id)).toEqual(new Map());
  });

  it("bounds persisted checkpoints per watch folder", async () => {
    const { folder, store } = await createFixture();
    const fingerprints = new Map(
      Array.from({ length: 25_001 }, (_, index) => [
        `file-${index}`,
        `fingerprint-${index}`
      ])
    );

    await store.setWatchFolderFingerprints(folder.id, fingerprints);

    const persisted = store.getWatchFolderFingerprints(folder.id);
    expect(persisted.size).toBe(25_000);
    expect(persisted.has("file-25_000")).toBe(false);
  });
});
