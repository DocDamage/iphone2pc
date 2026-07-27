import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MusicLibraryService,
  type MusicFileMetadata
} from "./music-library-service.js";

const temporaryRoots: string[] = [];

async function temporaryMusicRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-music-"));
  temporaryRoots.push(root);
  return root;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("MusicLibraryService", () => {
  it("recursively indexes supported files, reads tags, and falls back to filenames", async () => {
    const root = await temporaryMusicRoot();
    const album = path.join(root, "Album");
    await mkdir(album);
    await writeFile(path.join(album, "01 - Tagged.mp3"), "tagged");
    await writeFile(path.join(root, "Filename Fallback.wav"), "fallback");
    await writeFile(path.join(root, "cover.jpg"), "not audio");
    try {
      await symlink(album, path.join(root, "Album junction"), "junction");
    } catch {
      // Some Windows policies disallow creating test junctions for unprivileged users.
    }

    const metadataReader = vi.fn(async (filePath: string): Promise<MusicFileMetadata> => {
      if (filePath.endsWith(".wav")) throw new Error("No readable tags");
      return {
        title: "Tagged title",
        artist: "Tagged artist",
        album: "Tagged album",
        durationSeconds: 183.4567,
        trackNumber: 1,
        year: 2026,
        format: "MPEG"
      };
    });
    const onChange = vi.fn();
    const service = new MusicLibraryService([{ directory: root, source: "Windows Music" }], onChange, {
      metadataReader,
      pollIntervalMs: 0
    });

    const items = await service.start();

    expect(items).toHaveLength(2);
    expect(metadataReader).toHaveBeenCalledTimes(2);
    expect(items.find((item) => item.fileName.endsWith(".mp3"))).toMatchObject({
      title: "Tagged title",
      artist: "Tagged artist",
      album: "Tagged album",
      durationSeconds: 183.457,
      trackNumber: 1,
      year: 2026,
      format: "MPEG",
      source: "Windows Music",
      relativeFolder: "Album"
    });
    expect(items.find((item) => item.fileName.endsWith(".wav"))).toMatchObject({
      title: "Filename Fallback",
      artist: "Unknown Artist",
      album: "Unknown Album",
      format: "WAV"
    });
    for (const item of items) {
      expect(item.id).toMatch(/^[a-f0-9]{32}$/);
      expect(item).not.toHaveProperty("path");
      expect(item).not.toHaveProperty("filePath");
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("keeps stable IDs, caches unchanged metadata, and emits only semantic changes", async () => {
    const root = await temporaryMusicRoot();
    await writeFile(path.join(root, "First.flac"), "first");
    const metadataReader = vi.fn(async (): Promise<MusicFileMetadata> => ({
      artist: "Artist"
    }));
    const onChange = vi.fn();
    const service = new MusicLibraryService([{ directory: root, source: "Windows Music" }], onChange, {
      metadataReader,
      pollIntervalMs: 0
    });

    const initial = await service.start();
    const initialId = initial[0]!.id;
    await service.refresh();
    expect(service.getItems()[0]!.id).toBe(initialId);
    expect(metadataReader).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    await writeFile(path.join(root, "Second.m4a"), "second track");
    await service.refresh();
    expect(service.getItems()).toHaveLength(2);
    expect(service.getItems().find((item) => item.fileName === "First.flac")?.id).toBe(initialId);
    expect(metadataReader).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(2);

    const returned = service.getItems();
    returned[0]!.title = "mutated outside the service";
    expect(service.getItems()[0]!.title).not.toBe("mutated outside the service");
    service.stop();
  });

  it("combines multiple source roots and deduplicates overlapping canonical files", async () => {
    const documents = await temporaryMusicRoot();
    const music = path.join(documents, "Music");
    const downloads = path.join(documents, "Downloads");
    await mkdir(music);
    await mkdir(downloads);
    await writeFile(path.join(music, "Music track.mp3"), "music root track");
    await writeFile(path.join(downloads, "Document track.flac"), "documents track");
    const metadataReader = vi.fn(async (): Promise<MusicFileMetadata> => ({}));
    const service = new MusicLibraryService(
      [
        { directory: music, source: "Windows Music" },
        { directory: documents, source: "Windows Documents" }
      ],
      vi.fn(),
      { metadataReader, pollIntervalMs: 0 }
    );

    const items = await service.start();

    expect(items).toHaveLength(2);
    expect(metadataReader).toHaveBeenCalledTimes(2);
    expect(items.find((item) => item.fileName === "Music track.mp3")).toMatchObject({
      source: "Windows Music",
      relativeFolder: ""
    });
    expect(items.find((item) => item.fileName === "Document track.flac")).toMatchObject({
      source: "Windows Documents",
      relativeFolder: "Downloads"
    });
    service.stop();
  });

  it("coalesces scans and ignores a late result after stop", async () => {
    const root = await temporaryMusicRoot();
    await writeFile(path.join(root, "Held.mp3"), "held");
    const heldMetadata = deferred<MusicFileMetadata>();
    const metadataReader = vi.fn(() => heldMetadata.promise);
    const onChange = vi.fn();
    const service = new MusicLibraryService([{ directory: root, source: "Windows Music" }], onChange, {
      metadataReader,
      pollIntervalMs: 0
    });

    const starting = service.start();
    const concurrentRefresh = service.refresh();
    await vi.waitFor(() => expect(metadataReader).toHaveBeenCalledTimes(1));
    service.stop();
    heldMetadata.resolve({ title: "Late title" });

    expect(await starting).toEqual([]);
    expect(await concurrentRefresh).toEqual([]);
    expect(service.getItems()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("runs one trailing scan when a refresh arrives after discovery", async () => {
    const root = await temporaryMusicRoot();
    await writeFile(path.join(root, "Already discovered.mp3"), "first");
    const heldMetadata = deferred<MusicFileMetadata>();
    const metadataReader = vi.fn((filePath: string) =>
      filePath.endsWith("Already discovered.mp3")
        ? heldMetadata.promise
        : Promise.resolve({})
    );
    const service = new MusicLibraryService(
      [{ directory: root, source: "PocketDock Received" }],
      vi.fn(),
      { metadataReader, pollIntervalMs: 0 }
    );

    const starting = service.start();
    await vi.waitFor(() => expect(metadataReader).toHaveBeenCalledTimes(1));
    await writeFile(path.join(root, "Recovered during scan.m4a"), "second");
    const uploadRefresh = service.refresh();
    // More notifications are folded into the same single trailing pass.
    const coalescedRefresh = service.refresh();
    heldMetadata.resolve({});

    await expect(starting).resolves.toHaveLength(2);
    await expect(uploadRefresh).resolves.toHaveLength(2);
    await expect(coalescedRefresh).resolves.toHaveLength(2);
    expect(service.getItems().map((item) => item.fileName).sort()).toEqual([
      "Already discovered.mp3",
      "Recovered during scan.m4a"
    ]);
    expect(metadataReader).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("periodically discovers newly added tracks and stops scheduled scans", async () => {
    vi.useFakeTimers();
    const root = await temporaryMusicRoot();
    const metadataReader = vi.fn(async (): Promise<MusicFileMetadata> => ({}));
    const onChange = vi.fn();
    const service = new MusicLibraryService([{ directory: root, source: "Windows Music" }], onChange, {
      metadataReader,
      pollIntervalMs: 100
    });

    await service.start();
    await writeFile(path.join(root, "Arrived.mp3"), "music");
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(service.getItems()).toHaveLength(1));
    expect(onChange).toHaveBeenCalledTimes(1);

    service.stop();
    await writeFile(path.join(root, "After stop.wav"), "more music");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getItems()).toHaveLength(1);
    expect(metadataReader).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing custom root without blocking healthy music roots", async () => {
    const root = await temporaryMusicRoot();
    const healthyRoot = await temporaryMusicRoot();
    await writeFile(path.join(root, "DocRoshi Beat.wav"), "music");
    await writeFile(path.join(healthyRoot, "Healthy.wav"), "music");
    const service = new MusicLibraryService(
      [
        { directory: healthyRoot, source: "Windows Music" },
        { directory: root, source: "Windows Custom", required: true }
      ],
      vi.fn(),
      { metadataReader: async () => ({}), pollIntervalMs: 0 }
    );
    await service.start();
    expect(service.getItems()).toHaveLength(2);

    await rm(root, { recursive: true, force: true });
    expect(await service.refresh()).toHaveLength(1);
    await expect(service.refreshOrThrow()).rejects.toThrow("Music folder unavailable");
    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]?.fileName).toBe("Healthy.wav");
    service.stop();
  });

  it("keeps stable IDs distinct for identical relative paths in custom roots", async () => {
    const firstRoot = await temporaryMusicRoot();
    const secondRoot = await temporaryMusicRoot();
    const firstPath = path.join(firstRoot, "Beat.wav");
    const secondPath = path.join(secondRoot, "Beat.wav");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    const service = new MusicLibraryService(
      [
        { directory: firstRoot, source: "Windows Custom", required: true },
        { directory: secondRoot, source: "Windows Custom", required: true }
      ],
      vi.fn(),
      { metadataReader: async () => ({}), pollIntervalMs: 0 }
    );

    const items = await service.start();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(new Set(items.map((item) => service.getFilePath(item.id)))).toEqual(
      new Set([firstPath, secondPath])
    );
    service.stop();
  });
});
