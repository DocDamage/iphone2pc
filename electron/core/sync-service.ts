import crypto from "node:crypto";
import path from "node:path";
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import {
  ensureDirectory,
  isPathInside,
  resolvePathInsideRealRoot,
  sanitizeRelativeDirectory
} from "./file-utils.js";
import { sha256File } from "./crypto-utils.js";
import { StateStore } from "./store.js";
import type { SyncProfile } from "./types.js";

export interface SyncManifestEntry {
  relativePath: string;
  size: number;
  modifiedAt: number;
  sha256: string;
}

async function walkFiles(
  root: string,
  includeExtensions: string[],
  limit = 50_000
): Promise<{ root: string; files: string[] }> {
  const normalizedExtensions = new Set(
    includeExtensions.map((value) => value.trim().toLowerCase().replace(/^\./, "")).filter(Boolean)
  );
  const realRoot = (await resolvePathInsideRealRoot(root, root)).root;
  const files: string[] = [];
  const pending = [realRoot];
  while (pending.length) {
    let directory: string;
    try {
      directory = (await resolvePathInsideRealRoot(realRoot, pending.pop()!)).target;
    } catch {
      continue;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".pocketdock-archive") continue;
      if (entry.isSymbolicLink()) continue;
      let fullPath: string;
      try {
        fullPath = (await resolvePathInsideRealRoot(
          realRoot,
          path.join(directory, entry.name)
        )).target;
      } catch {
        continue;
      }
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase().replace(/^\./, "");
        if (!normalizedExtensions.size || normalizedExtensions.has(extension)) files.push(fullPath);
        if (files.length >= limit) throw new Error("A sync profile is limited to 50,000 files.");
      }
    }
  }
  return { root: realRoot, files };
}

export class SyncService {
  constructor(private readonly store: StateStore) {}

  async createProfile(localDirectory: string, name?: string): Promise<SyncProfile> {
    await ensureDirectory(localDirectory);
    const now = new Date().toISOString();
    const profile: SyncProfile = {
      id: crypto.randomUUID(),
      name: name?.trim() || path.basename(localDirectory) || "PocketDock Sync",
      localDirectory,
      iphoneDirectory: profileSafeName(name || path.basename(localDirectory) || "PocketDock"),
      direction: "two-way",
      deletionPolicy: "archive",
      enabled: true,
      includeExtensions: [],
      createdAt: now
    };
    await this.store.upsertSyncProfile(profile);
    return profile;
  }

  async updateProfile(id: string, patch: Partial<SyncProfile>): Promise<void> {
    const existing = this.requireProfile(id);
    const next: SyncProfile = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      localDirectory: existing.localDirectory,
      includeExtensions: (patch.includeExtensions ?? existing.includeExtensions)
        .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean)
        .slice(0, 100)
    };
    await this.store.upsertSyncProfile(next);
  }

  async removeProfile(id: string): Promise<void> {
    await this.store.removeSyncProfile(id);
  }

  async manifest(id: string): Promise<SyncManifestEntry[]> {
    const profile = this.requireProfile(id, true);
    if (profile.direction === "iphone-to-pc") return [];
    const { root, files } = await walkFiles(profile.localDirectory, profile.includeExtensions);
    const previous = this.store.getSyncSnapshot(id);
    const entries: SyncManifestEntry[] = [];
    const snapshot: Record<string, { size: number; modifiedAt: number; sha256: string }> = {};
    for (const filePath of files) {
      const safeFilePath = (await resolvePathInsideRealRoot(root, filePath)).target;
      const info = await stat(safeFilePath);
      const relativePath = path.relative(root, safeFilePath).split(path.sep).join("/");
      const prior = previous[relativePath];
      const sha256 =
        prior && prior.size === info.size && prior.modifiedAt === info.mtimeMs && prior.sha256
          ? prior.sha256
          : await sha256File(safeFilePath);
      entries.push({ relativePath, size: info.size, modifiedAt: info.mtimeMs, sha256 });
      snapshot[relativePath] = { size: info.size, modifiedAt: info.mtimeMs, sha256 };
    }
    await this.store.setSyncSnapshot(id, snapshot);
    return entries;
  }

  async run(id: string): Promise<SyncManifestEntry[]> {
    const profile = this.requireProfile(id, true);
    const entries = await this.manifest(id);
    await this.store.upsertSyncProfile({
      ...profile,
      lastRunAt: new Date().toISOString()
    });
    return entries;
  }

  async localFiles(id: string): Promise<string[]> {
    const profile = this.requireProfile(id, true);
    if (profile.direction === "iphone-to-pc") return [];
    return (await walkFiles(profile.localDirectory, profile.includeExtensions)).files;
  }

  async localFilePath(id: string, relativePath: string): Promise<string> {
    const profile = this.requireProfile(id, true);
    if (profile.direction === "iphone-to-pc") {
      throw new Error("This sync profile does not send PC files.");
    }
    validateSyncRelativePath(relativePath);
    const safe = sanitizeRelativeDirectory(relativePath);
    const filePath = path.join(profile.localDirectory, safe);
    if (!safe || !isPathInside(profile.localDirectory, filePath)) {
      throw new Error("Unsafe sync file path.");
    }
    return (await resolvePathInsideRealRoot(profile.localDirectory, filePath)).target;
  }

  async incomingDestination(id: string, relativePath: string): Promise<string> {
    const profile = this.requireProfile(id, true);
    if (profile.direction === "pc-to-iphone") {
      throw new Error("This sync profile does not accept iPhone changes.");
    }
    validateSyncRelativePath(relativePath, true);
    const safeRelative = sanitizeRelativeDirectory(relativePath);
    const destination = path.join(profile.localDirectory, safeRelative);
    if (!isPathInside(profile.localDirectory, destination)) {
      throw new Error("Unsafe sync destination.");
    }
    return (await resolvePathInsideRealRoot(profile.localDirectory, destination)).target;
  }

  async archiveDeleted(id: string, relativePaths: string[]): Promise<void> {
    const profile = this.requireProfile(id, true);
    if (profile.deletionPolicy !== "archive") return;
    const archiveRoot = path.join(
      profile.localDirectory,
      ".pocketdock-archive",
      new Date().toISOString().replace(/[:.]/g, "-")
    );
    for (const relativePath of relativePaths.slice(0, 10_000)) {
      const source = await this.incomingDestination(id, relativePath);
      const sourceInfo = await stat(source).catch(() => null);
      if (!sourceInfo) {
        // A file already removed by the user needs no archive action.
        continue;
      }
      if (!sourceInfo.isFile()) continue;
      const destination = (await resolvePathInsideRealRoot(
        profile.localDirectory,
        path.join(archiveRoot, sanitizeRelativeDirectory(relativePath))
      )).target;
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(source, destination);
      } catch {
        await copyFile(source, destination);
        await unlink(source);
      }
    }
  }

  private requireProfile(id: string, requireEnabled = false): SyncProfile {
    const profile = this.store.getSyncProfiles().find((entry) => entry.id === id);
    if (!profile) throw new Error("Sync profile not found.");
    if (requireEnabled && !profile.enabled) {
      throw new Error("This sync profile is disabled.");
    }
    return profile;
  }
}

function profileSafeName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim()
    .slice(0, 80) || "PocketDock";
}

function validateSyncRelativePath(value: string, allowEmpty = false): void {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    (!allowEmpty && !normalized) ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..") ||
    normalized.includes("\0")
  ) {
    throw new Error("Unsafe sync file path.");
  }
}
