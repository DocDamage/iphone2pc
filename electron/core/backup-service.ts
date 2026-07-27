import crypto from "node:crypto";
import path from "node:path";
import {
  copyFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { sha256File } from "./crypto-utils.js";
import {
  ensureDirectory,
  isPathInside,
  sanitizeRelativeDirectory,
  uniqueFilePath
} from "./file-utils.js";
import { StateStore } from "./store.js";
import type { BackupSnapshot } from "./types.js";

export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly objectsDirectory: string;

  constructor(
    private readonly store: StateStore,
    baseDirectory: string,
    private readonly backupAllowed: () => boolean
  ) {
    this.objectsDirectory = path.join(baseDirectory, "backup-versions", "objects");
  }

  start(): void {
    if (this.timer) return;
    void this.runScheduled();
    this.timer = setInterval(() => void this.runScheduled(), 15 * 60 * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runScheduled(): Promise<BackupSnapshot | null> {
    const settings = this.store.getSettings();
    if (
      this.running ||
      !settings.backupScheduleEnabled ||
      !this.backupAllowed()
    ) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (this.store.getBackupSnapshots().some(
      (snapshot) => snapshot.createdAt.slice(0, 10) === today
    )) return null;
    return this.create("scheduled");
  }

  async create(reason: BackupSnapshot["reason"]): Promise<BackupSnapshot> {
    if (this.running) throw new Error("A restore point is already being created.");
    this.running = true;
    try {
      await ensureDirectory(this.objectsDirectory);
      const destinationRoot = path.resolve(this.store.getSettings().destinationDirectory);
      const entries: BackupSnapshot["entries"] = [];
      let uniqueBytes = 0;
      const seenPaths = new Set<string>();
      for (const transfer of this.store.getHistory().slice(0, 10_000)) {
        if (
          transfer.status !== "completed" ||
          !transfer.savedPath ||
          seenPaths.has(path.resolve(transfer.savedPath))
        ) continue;
        try {
          const info = await stat(transfer.savedPath);
          if (!info.isFile()) continue;
          seenPaths.add(path.resolve(transfer.savedPath));
          const captured = await this.captureObject(transfer.savedPath);
          if (captured.created) uniqueBytes += captured.size;
          const insideDestination = isPathInside(destinationRoot, transfer.savedPath);
          entries.push({
            fileName: transfer.fileName,
            relativePath: insideDestination
              ? path.relative(destinationRoot, transfer.savedPath).split(path.sep).join("/")
              : transfer.fileName,
            sourcePath: transfer.savedPath,
            objectKey: captured.objectKey,
            sha256: captured.objectKey,
            size: captured.size
          });
        } catch {
          // Recovery Center reports source files that disappeared during snapshotting.
        }
      }
      const snapshot: BackupSnapshot = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        reason,
        fileCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
        uniqueBytes,
        entries
      };
      await this.store.upsertBackupSnapshot(snapshot);
      await this.applyRetention();
      return snapshot;
    } finally {
      this.running = false;
    }
  }

  async restore(id: string): Promise<string> {
    const snapshot = this.store.getBackupSnapshots().find((item) => item.id === id);
    if (!snapshot) throw new Error("That restore point is no longer available.");
    const restoreRoot = path.join(
      this.store.getSettings().destinationDirectory,
      "PocketDock Restores",
      snapshot.createdAt.replace(/[:.]/g, "-")
    );
    await ensureDirectory(restoreRoot);
    for (const entry of snapshot.entries) {
      const source = this.objectPath(entry.objectKey);
      if (await sha256File(source) !== entry.sha256) {
        throw new Error(`Restore object failed integrity verification: ${entry.fileName}`);
      }
      const safeRelative = sanitizeRelativeDirectory(entry.relativePath);
      const desired = path.join(restoreRoot, safeRelative || entry.fileName);
      if (!isPathInside(restoreRoot, desired)) {
        throw new Error("A restore entry contained an unsafe path.");
      }
      await ensureDirectory(path.dirname(desired));
      await copyFile(source, await uniqueFilePath(desired));
    }
    return restoreRoot;
  }

  private async applyRetention(): Promise<void> {
    const settings = this.store.getSettings();
    const snapshots = this.store.getBackupSnapshots();
    const now = Date.now();
    const dailyCutoff = now - settings.backupRetentionDays * 24 * 60 * 60 * 1_000;
    const keep = new Set(
      snapshots
        .filter((snapshot) => new Date(snapshot.createdAt).getTime() >= dailyCutoff)
        .map((snapshot) => snapshot.id)
    );
    keepBuckets(snapshots, keep, weekKey, settings.backupWeeklyVersions);
    keepBuckets(snapshots, keep, monthKey, settings.backupMonthlyVersions);
    for (const snapshot of snapshots) {
      if (!keep.has(snapshot.id)) await this.store.removeBackupSnapshot(snapshot.id);
    }
    await this.collectUnusedObjects();
  }

  private async collectUnusedObjects(): Promise<void> {
    const referenced = new Set(
      this.store.getBackupSnapshots().flatMap((snapshot) =>
        snapshot.entries.map((entry) => entry.objectKey)
      )
    );
    for (const prefix of await readdir(this.objectsDirectory).catch(() => [])) {
      const directory = path.join(this.objectsDirectory, prefix);
      for (const objectKey of await readdir(directory).catch(() => [])) {
        if (/^[a-f0-9]{64}$/.test(objectKey) && !referenced.has(objectKey)) {
          await rm(path.join(directory, objectKey), { force: true });
        }
      }
    }
  }

  private async captureObject(
    sourcePath: string
  ): Promise<{ objectKey: string; size: number; created: boolean }> {
    const stagingPath = path.join(
      this.objectsDirectory,
      `.capture-${crypto.randomUUID()}.tmp`
    );
    try {
      // Snapshot into private storage first. Hashing the staged bytes makes the
      // content key describe the exact immutable bytes that will be restored,
      // even if the live source changes while a restore point is being made.
      await copyFile(sourcePath, stagingPath);
      const [objectKey, stagedInfo] = await Promise.all([
        sha256File(stagingPath),
        stat(stagingPath)
      ]);
      const objectPath = this.objectPath(objectKey);
      await ensureDirectory(path.dirname(objectPath));

      let existingInfo: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        existingInfo = await stat(objectPath);
      } catch {
        // The object is new.
      }

      if (
        existingInfo?.isFile() &&
        existingInfo.nlink <= 1 &&
        await sha256File(objectPath).catch(() => "") === objectKey
      ) {
        return { objectKey, size: stagedInfo.size, created: false };
      }

      // A same-filesystem rename publishes only a complete object. Replacing
      // legacy hard-linked or corrupt objects also detaches them from live files.
      await rename(stagingPath, objectPath);
      return {
        objectKey,
        size: stagedInfo.size,
        created: existingInfo === null
      };
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  }

  private objectPath(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid restore object key.");
    return path.join(this.objectsDirectory, key.slice(0, 2), key);
  }
}

function keepBuckets(
  snapshots: BackupSnapshot[],
  keep: Set<string>,
  bucket: (date: Date) => string,
  limit: number
): void {
  const used = new Set<string>();
  for (const snapshot of snapshots) {
    const key = bucket(new Date(snapshot.createdAt));
    if (used.has(key) || used.size >= limit) continue;
    used.add(key);
    keep.add(snapshot.id);
  }
}

function weekKey(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
