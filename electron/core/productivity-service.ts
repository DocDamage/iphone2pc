import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import {
  ensureDirectory,
  isPathInside,
  resolvePathInsideRealRoot,
  sanitizeFileName,
  sanitizeRelativeDirectory,
  uniqueFilePath
} from "./file-utils.js";
import { StateStore } from "./store.js";
import type {
  ConnectionInfo,
  DriveEntry,
  DuplicateGroup,
  RecoveryIssue,
  TransportStatus
} from "./types.js";

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
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".json": "application/json"
  };
  return types[extension] ?? "application/octet-stream";
}

export function isInsideBackupWindow(
  start: string,
  end: string,
  date = new Date()
): boolean {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const from = startHour * 60 + startMinute;
  const until = endHour * 60 + endMinute;
  if (from === until) return true;
  return from < until
    ? minutes >= from && minutes < until
    : minutes >= from || minutes < until;
}

export class ProductivityService {
  constructor(
    private readonly store: StateStore,
    private readonly stagingDirectory: string,
    private readonly connectionInfo: () => ConnectionInfo
  ) {}

  backupAllowed(date = new Date()): boolean {
    const settings = this.store.getSettings();
    return !settings.backupScheduleEnabled ||
      isInsideBackupWindow(settings.backupWindowStart, settings.backupWindowEnd, date);
  }

  async browse(relativePath = ""): Promise<DriveEntry[]> {
    const { root, target } = await this.resolveDrivePath(relativePath);
    const entries = await readdir(target, { withFileTypes: true });
    const result: DriveEntry[] = [];
    for (const entry of entries.slice(0, 5_000)) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      let fullPath: string;
      try {
        fullPath = (await resolvePathInsideRealRoot(root, path.join(target, entry.name))).target;
      } catch {
        continue;
      }
      const info = await stat(fullPath);
      const itemPath = path.relative(root, fullPath).split(path.sep).join("/");
      result.push({
        id: crypto.createHash("sha256").update(itemPath).digest("hex").slice(0, 24),
        name: entry.name,
        relativePath: itemPath,
        kind: entry.isDirectory() ? "folder" : "file",
        size: entry.isDirectory() ? 0 : info.size,
        modifiedAt: info.mtime.toISOString(),
        mimeType: entry.isDirectory() ? "inode/directory" : mimeTypeFor(entry.name)
      });
    }
    return result.sort((left, right) =>
      left.kind === right.kind
        ? left.name.localeCompare(right.name, undefined, { numeric: true })
        : left.kind === "folder" ? -1 : 1
    );
  }

  /** Resolve a renderer-selected Drive entry without exposing the configured root. */
  async localDriveEntryPath(relativePath: string): Promise<string> {
    const { target } = await this.resolveDrivePath(relativePath);
    const info = await stat(target);
    if (!info.isFile() && !info.isDirectory()) throw new Error("Drive entry is unavailable.");
    return target;
  }

  async searchDrive(query: string, limit = 100): Promise<DriveEntry[]> {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return [];
    const { root } = await this.resolveDrivePath("");
    const queue = [root];
    const result: DriveEntry[] = [];
    let visited = 0;
    while (queue.length && result.length < Math.min(Math.max(limit, 1), 250) && visited < 20_000) {
      let directory: string;
      try {
        directory = (await resolvePathInsideRealRoot(root, queue.shift()!)).target;
      } catch {
        continue;
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        visited += 1;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        let fullPath: string;
        try {
          fullPath = (await resolvePathInsideRealRoot(root, path.join(directory, entry.name))).target;
        } catch {
          continue;
        }
        if (entry.isDirectory() && entry.name !== ".PocketDock Archive") queue.push(fullPath);
        if (!entry.name.toLocaleLowerCase().includes(term)) continue;
        const info = await stat(fullPath).catch(() => null);
        if (!info) continue;
        const itemPath = path.relative(root, fullPath).split(path.sep).join("/");
        result.push({
          id: crypto.createHash("sha256").update(itemPath).digest("hex").slice(0, 24),
          name: entry.name,
          relativePath: itemPath,
          kind: entry.isDirectory() ? "folder" : "file",
          size: entry.isDirectory() ? 0 : info.size,
          modifiedAt: info.mtime.toISOString(),
          mimeType: entry.isDirectory() ? "inode/directory" : mimeTypeFor(entry.name)
        });
        if (result.length >= Math.min(Math.max(limit, 1), 250)) break;
      }
    }
    return result.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true })
    );
  }

  async driveFilePath(relativePath: string): Promise<string> {
    const { target } = await this.resolveDrivePath(relativePath);
    return target;
  }

  async createFolder(relativePath: string): Promise<void> {
    const { target } = await this.resolveDrivePath(relativePath);
    await mkdir(target, { recursive: false });
  }

  async renameEntry(relativePath: string, newName: string): Promise<void> {
    const { root, target } = await this.resolveDrivePath(relativePath);
    if (path.resolve(target) === path.resolve(root)) throw new Error("The Drive root cannot be renamed.");
    const destination = (await resolvePathInsideRealRoot(
      root,
      path.join(path.dirname(target), sanitizeFileName(newName))
    )).target;
    await rename(target, destination);
  }

  async archiveEntry(relativePath: string): Promise<void> {
    const { root, target } = await this.resolveDrivePath(relativePath);
    if (path.resolve(target) === path.resolve(root)) throw new Error("The Drive root cannot be archived.");
    const archiveRoot = path.join(root, ".PocketDock Archive", new Date().toISOString().slice(0, 10));
    const desired = (await resolvePathInsideRealRoot(
      root,
      path.join(archiveRoot, path.relative(root, target))
    )).target;
    if (!isPathInside(archiveRoot, desired)) throw new Error("Unsafe archive path.");
    await ensureDirectory(path.dirname(desired));
    const uniqueDesired = await uniqueFilePath(desired);
    const destination = (await resolvePathInsideRealRoot(root, uniqueDesired)).target;
    await rename(target, destination);
  }

  async duplicateGroups(): Promise<DuplicateGroup[]> {
    const existing = [];
    for (const record of this.store.getHistory()) {
      if (record.status !== "completed" || !record.savedPath) continue;
      try {
        const info = await stat(record.savedPath);
        if (info.isFile()) existing.push(record);
      } catch {
        // Moved history entries are handled by Recovery Center.
      }
    }
    const groups = new Map<string, typeof existing>();
    for (const record of existing) {
      const key = record.sha256
        ? `hash:${record.sha256}:${record.size}`
        : `name:${record.fileName.toLocaleLowerCase()}:${record.size}`;
      const values = groups.get(key) ?? [];
      values.push(record);
      groups.set(key, values);
    }
    return [...groups.entries()].flatMap(([key, records]) => {
      const uniquePaths = new Map(records.map((record) => [record.savedPath!, record]));
      const items = [...uniquePaths.values()];
      if (items.length < 2) return [];
      const kind = key.startsWith("hash:") ? "exact" as const : "name-and-size" as const;
      return [{
        id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 24),
        kind,
        label: kind === "exact" ? items[0].fileName : `${items[0].fileName} candidates`,
        reclaimableBytes: items.slice(1).reduce((total, item) => total + item.size, 0),
        items: items.map((item) => ({
          transferId: item.id,
          fileName: item.fileName,
          savedPath: item.savedPath!,
          size: item.size,
          createdAt: item.createdAt
        }))
      }];
    });
  }

  async recoveryIssues(): Promise<RecoveryIssue[]> {
    const issues: RecoveryIssue[] = [];
    try {
      await access(this.store.getSettings().destinationDirectory);
    } catch {
      issues.push({
        id: "destination",
        kind: "destination",
        severity: "critical",
        title: "Save destination is unavailable",
        detail: "PocketDock cannot access the configured incoming-file destination.",
        recoverable: true
      });
    }
    const staging = (await readdir(this.stagingDirectory).catch(() => []))
      .filter((name) => name.endsWith(".part") || name.endsWith(".json"));
    if (staging.length) {
      issues.push({
        id: "staging",
        kind: "staging",
        severity: "warning",
        title: `${staging.length} interrupted transfer artifact${staging.length === 1 ? "" : "s"}`,
        detail: "These files are retained for resume. Clean them only if the sending device will not reconnect.",
        recoverable: true
      });
    }
    for (const record of this.store.getHistory().slice(0, 1_000)) {
      if (!record.savedPath || record.status !== "completed") continue;
      try {
        await access(record.savedPath);
      } catch {
        issues.push({
          id: `missing:${record.id}`,
          kind: "missing-file",
          severity: "info",
          title: `${record.fileName} was moved`,
          detail: "The history entry points to a path that is no longer available.",
          recoverable: true
        });
      }
      if (issues.length >= 100) break;
    }
    const expired = this.store.getSharedFiles().filter(
      (item) => item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()
    );
    if (expired.length) {
      issues.push({
        id: "expired-shares",
        kind: "expired-share",
        severity: "info",
        title: `${expired.length} expired share record${expired.length === 1 ? "" : "s"}`,
        detail: "The files are already unavailable to iPhone and can be removed from the share database.",
        recoverable: true
      });
    }
    const integrity = this.store.databaseIntegrityCheck();
    if (integrity !== "ok") {
      issues.push({
        id: "database",
        kind: "database",
        severity: "critical",
        title: "SQLite integrity check failed",
        detail: integrity,
        recoverable: false
      });
    }
    return issues;
  }

  async resolveRecoveryIssue(id: string): Promise<void> {
    if (id === "destination") {
      await ensureDirectory(this.store.getSettings().destinationDirectory);
      return;
    }
    if (id === "staging") {
      for (const name of await readdir(this.stagingDirectory).catch(() => [])) {
        if (name.endsWith(".part") || name.endsWith(".json")) {
          await rm(path.join(this.stagingDirectory, name), { force: true });
        }
      }
      return;
    }
    if (id === "expired-shares") {
      await this.store.setSharedFiles(this.store.getSharedFiles().filter(
        (item) => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()
      ));
      return;
    }
    if (id.startsWith("missing:")) {
      await this.store.removeTransfers([id.slice("missing:".length)]);
      return;
    }
    throw new Error("This recovery item requires manual repair.");
  }

  async transportStatus(): Promise<TransportStatus> {
    const settings = this.store.getSettings();
    const connection = this.connectionInfo();
    const available: Array<"lan" | "relay"> = [];
    if (connection.addresses.length) available.push("lan");
    if (settings.remoteAccessEnabled && settings.remoteRelayUrl) available.push("relay");
    const priorities: Record<typeof settings.connectionStrategy, Array<"lan" | "relay">> = {
      automatic: ["lan", "relay"],
      "lan-first": ["lan", "relay"],
      "usb-first": ["lan", "relay"],
      "relay-first": ["relay", "lan"]
    };
    const selected = priorities[settings.connectionStrategy].find((item) => available.includes(item))
      ?? "offline";
    return {
      selected,
      strategy: settings.connectionStrategy,
      available,
      reason: selected === "offline"
        ? "No LAN or private-relay transfer path is available. USB Camera Roll import is separate."
        : `${selected.toUpperCase()} is the highest-priority file-transfer path. USB remains a separate Camera Roll import capability.`
    };
  }

  private async resolveDrivePath(relativePath: string): Promise<{ root: string; target: string }> {
    const settings = this.store.getSettings();
    const root = path.resolve(settings.remoteBrowseRoot || settings.destinationDirectory);
    await ensureDirectory(root);
    const safe = sanitizeRelativeDirectory(relativePath);
    const target = path.resolve(root, safe);
    if (!isPathInside(root, target)) throw new Error("Unsafe PocketDock Drive path.");
    return resolvePathInsideRealRoot(root, target);
  }
}
