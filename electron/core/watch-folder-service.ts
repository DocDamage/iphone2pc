import crypto from "node:crypto";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { ensureDirectory, isPathInside } from "./file-utils.js";
import { StateStore } from "./store.js";
import type { WatchFolder } from "./types.js";

type ProcessFiles = (paths: string[], folder: WatchFolder) => Promise<void>;

function fingerprintsMatch(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [filePath, fingerprint] of left) {
    if (right.get(filePath) !== fingerprint) return false;
  }
  return true;
}

async function scanFiles(folder: WatchFolder): Promise<string[]> {
  const extensions = new Set(
    folder.includeExtensions.map((value) => value.toLowerCase().replace(/^\./, ""))
  );
  const files: string[] = [];
  const pending = [folder.directory];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (!isPathInside(folder.directory, fullPath)) continue;
      if (entry.isDirectory() && folder.recursive) pending.push(fullPath);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase().replace(/^\./, "");
        if (!extensions.size || extensions.has(extension)) files.push(fullPath);
        if (files.length >= 25_000) return files;
      }
    }
  }
  return files;
}

export class WatchFolderService {
  private interval: NodeJS.Timeout | null = null;
  private readonly fingerprints = new Map<string, Map<string, string>>();

  constructor(
    private readonly store: StateStore,
    private readonly processFiles: ProcessFiles,
    private readonly canProcess: () => boolean = () => true
  ) {}

  async create(directory: string): Promise<WatchFolder> {
    await ensureDirectory(directory);
    const folder: WatchFolder = {
      id: crypto.randomUUID(),
      name: path.basename(directory) || "Watch folder",
      directory,
      mode: "share",
      enabled: true,
      recursive: true,
      includeExtensions: [],
      expiresMinutes: 0,
      createdAt: new Date().toISOString()
    };
    // Establish a baseline without processing existing contents. Adding a watch
    // folder means "watch future changes" and must never silently publish every
    // file already in the directory.
    const baseline = new Map<string, string>();
    for (const filePath of await scanFiles(folder)) {
      try {
        const info = await stat(filePath);
        baseline.set(filePath, `${info.size}:${info.mtimeMs}`);
      } catch {
        // A file that changes during baseline creation will be picked up later.
      }
    }
    const initialized = { ...folder, lastScanAt: new Date().toISOString() };
    await this.store.upsertWatchFolder(initialized);
    await this.store.setWatchFolderFingerprints(folder.id, baseline);
    this.fingerprints.set(folder.id, baseline);
    return initialized;
  }

  async update(id: string, patch: Partial<WatchFolder>): Promise<void> {
    const existing = this.requireFolder(id);
    const expiresMinutes = Math.min(
      365 * 24 * 60,
      Math.max(
        0,
        Math.round(Number(patch.expiresMinutes ?? existing.expiresMinutes) || 0)
      )
    );
    await this.store.upsertWatchFolder({
      ...existing,
      ...patch,
      id: existing.id,
      directory: existing.directory,
      createdAt: existing.createdAt,
      expiresMinutes,
      includeExtensions: (patch.includeExtensions ?? existing.includeExtensions)
        .map((value) => value.toLowerCase().replace(/^\./, "").trim())
        .filter(Boolean)
        .slice(0, 100)
    });
  }

  async remove(id: string): Promise<void> {
    await this.store.removeWatchFolder(id);
    this.fingerprints.delete(id);
  }

  async scan(id?: string): Promise<void> {
    if (!this.canProcess()) return;
    const folders = id
      ? [this.requireFolder(id)]
      : this.store.getWatchFolders().filter((folder) => folder.enabled);
    for (const folder of folders) {
      if (!this.canProcess()) return;
      if (!folder.enabled) continue;
      const paths = await scanFiles(folder);
      const previous =
        this.fingerprints.get(folder.id) ??
        this.store.getWatchFolderFingerprints(folder.id);
      const current = new Map<string, string>();
      const changed: string[] = [];
      for (const filePath of paths) {
        const info = await stat(filePath);
        const fingerprint = `${info.size}:${info.mtimeMs}`;
        current.set(filePath, fingerprint);
        if (previous.get(filePath) !== fingerprint) changed.push(filePath);
      }
      if (changed.length) await this.processFiles(changed, folder);
      if (!fingerprintsMatch(previous, current)) {
        await this.store.setWatchFolderFingerprints(folder.id, current);
      }
      this.fingerprints.set(folder.id, current);
      await this.store.upsertWatchFolder({
        ...folder,
        lastScanAt: new Date().toISOString()
      });
    }
  }

  async scanNow(id?: string): Promise<void> {
    if (!this.canProcess()) {
      throw new Error("Watch-folder processing is paused by the configured backup schedule.");
    }
    await this.scan(id);
  }

  start(): void {
    if (this.interval) return;
    void this.scan();
    this.interval = setInterval(() => void this.scan(), 30_000);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private requireFolder(id: string): WatchFolder {
    const folder = this.store.getWatchFolders().find((entry) => entry.id === id);
    if (!folder) throw new Error("Watch folder not found.");
    return folder;
  }
}
