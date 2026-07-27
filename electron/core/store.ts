import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { access, copyFile, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ensureDirectory } from "./file-utils.js";
import type {
  AppSettings,
  AutomationRule,
  BackupSnapshot,
  ClipboardEntry,
  DevicePermissions,
  FileRequest,
  FileRequestUpload,
  PhoneMusicLibrary,
  PrivateShareLink,
  ProducerPackage,
  SharedFile,
  SyncProfile,
  TransferMetadataPatch,
  TransferRecord,
  TrustedDevice,
  VaultItem,
  WatchFolder
} from "./types.js";

interface LegacyState {
  settings?: Partial<AppSettings>;
  history?: TransferRecord[];
  sharedFiles?: SharedFile[];
  onboardingComplete?: boolean;
}

const MAX_WATCH_FOLDER_FINGERPRINTS = 25_000;
export const PHONE_MUSIC_LIBRARY_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

function defaultDownloadsDirectory(): string {
  return path.join(os.homedir(), "Downloads", "PocketDock");
}

function normalizeClock(value: string, fallback: string): string {
  const match = String(value ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : fallback;
}

function normalizePhoneMusicLibrary(library: PhoneMusicLibrary): PhoneMusicLibrary {
  return {
    ...library,
    music: Array.isArray(library.music) ? library.music : [],
    collections: Array.isArray(library.collections) ? library.collections : [],
    files: Array.isArray(library.files) ? library.files : []
  };
}

export function defaultSettings(): AppSettings {
  return {
    destinationDirectory: defaultDownloadsDirectory(),
    customMusicDirectories: [],
    port: 42_890,
    deviceName: `${os.hostname()} PC`,
    conflictPolicy: "rename",
    maxConcurrentUploads: 2,
    showNotifications: true,
    runAtLogin: false,
    minimizeToTray: true,
    keepPairingActive: true,
    theme: "system",
    verifyIntegrity: true,
    encryptTransfers: true,
    trustedDeviceAutoConnect: true,
    duplicatePolicy: "skip-identical",
    organizeMode: "none",
    bandwidthLimitMbps: 0,
    clipboardSharing: true,
    allowUsbImport: true,
    autoUpdate: true,
    updateFeedUrl: "",
    remoteAccessEnabled: false,
    remoteRelayUrl: "",
    language: "system",
    vaultAutoLockMinutes: 15,
    diagnosticsRetentionDays: 14,
    pauseBackupOnBattery: true,
    pauseBackupOnMeteredNetwork: true,
    backgroundServiceEnabled: false,
    automaticClipboardSync: false,
    backupScheduleEnabled: false,
    backupWindowStart: "22:00",
    backupWindowEnd: "07:00",
    backupRetentionDays: 30,
    backupWeeklyVersions: 8,
    backupMonthlyVersions: 12,
    remoteBrowseEnabled: false,
    remoteBrowseRoot: defaultDownloadsDirectory(),
    remoteApprovalRequired: true,
    connectionStrategy: "automatic",
    interfaceDensity: "comfortable",
    interfaceScale: 1,
    highContrast: false
  };
}

export function defaultDevicePermissions(): DevicePermissions {
  return {
    sendToPc: true,
    receiveFromPc: true,
    clipboard: true,
    automaticBackup: false,
    remoteAccess: false,
    browseFiles: false,
    fileProvider: false,
    fileRequests: true
  };
}

export class StateStore {
  private readonly databasePath: string;
  private readonly legacyStatePath: string;
  private database: DatabaseSync | null = null;

  constructor(private readonly baseDirectory: string) {
    this.databasePath = path.join(baseDirectory, "pocketdock.db");
    this.legacyStatePath = path.join(baseDirectory, "state.json");
  }

  async load(): Promise<void> {
    await ensureDirectory(this.baseDirectory);
    try {
      await access(this.databasePath);
      const backupPath = path.join(this.baseDirectory, "pocketdock.pre-v2.5.db");
      try {
        await access(backupPath);
      } catch {
        await copyFile(this.databasePath, backupPath);
      }
    } catch {
      // First launch has no database to back up.
    }
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfers_created_at
        ON transfers(created_at DESC);
      CREATE TABLE IF NOT EXISTS shared_files (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clipboard_entries (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_profiles (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_folders (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_folder_fingerprints (
        folder_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY(folder_id, file_path),
        FOREIGN KEY(folder_id) REFERENCES watch_folders(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS private_share_links (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_items (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS producer_packages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_requests (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_request_uploads (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backup_snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_snapshots (
        profile_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(profile_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS phone_music_libraries (
        device_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY(device_id) REFERENCES trusted_devices(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS phone_music_libraries_received_at
        ON phone_music_libraries(received_at DESC);
      PRAGMA user_version = 7;
    `);

    if (!this.getKv<AppSettings>("settings")) {
      await this.importLegacyState();
    }
    if (!this.getKv<AppSettings>("settings")) {
      this.setKv("settings", defaultSettings());
    }
    if (!this.getKv<string>("transferSecret")) {
      this.setKv("transferSecret", crypto.randomBytes(32).toString("base64url"));
    }
  }

  getSettings(): AppSettings {
    const settings = {
      ...defaultSettings(),
      ...(this.getKv<Partial<AppSettings>>("settings") ?? {})
    };
    if (settings.connectionStrategy === "usb-first") {
      settings.connectionStrategy = "automatic";
    }
    return settings;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...this.getSettings(), ...patch };
    if (next.connectionStrategy === "usb-first") {
      next.connectionStrategy = "automatic";
    }
    next.port = Math.min(65_535, Math.max(1_024, Math.round(next.port)));
    next.maxConcurrentUploads = Math.min(4, Math.max(1, Math.round(next.maxConcurrentUploads)));
    next.bandwidthLimitMbps = Math.min(
      10_000,
      Math.max(0, Number(next.bandwidthLimitMbps) || 0)
    );
    next.deviceName = String(next.deviceName || defaultSettings().deviceName).slice(0, 80);
    next.remoteRelayUrl = String(next.remoteRelayUrl || "").slice(0, 2_048);
    next.updateFeedUrl = String(next.updateFeedUrl || "").slice(0, 2_048);
    next.vaultAutoLockMinutes = Math.min(
      240,
      Math.max(1, Math.round(Number(next.vaultAutoLockMinutes) || 15))
    );
    next.diagnosticsRetentionDays = Math.min(
      90,
      Math.max(1, Math.round(Number(next.diagnosticsRetentionDays) || 14))
    );
    next.backupRetentionDays = Math.min(
      3_650,
      Math.max(1, Math.round(Number(next.backupRetentionDays) || 30))
    );
    next.backupWeeklyVersions = Math.min(
      104,
      Math.max(0, Math.round(Number(next.backupWeeklyVersions) || 0))
    );
    next.backupMonthlyVersions = Math.min(
      120,
      Math.max(0, Math.round(Number(next.backupMonthlyVersions) || 0))
    );
    next.backupWindowStart = normalizeClock(next.backupWindowStart, "22:00");
    next.backupWindowEnd = normalizeClock(next.backupWindowEnd, "07:00");
    next.remoteBrowseRoot = String(
      next.remoteBrowseRoot || next.destinationDirectory
    ).slice(0, 4_096);
    next.customMusicDirectories = [
      ...new Set(
        (Array.isArray(next.customMusicDirectories) ? next.customMusicDirectories : [])
          .map((directory) => path.resolve(String(directory)).slice(0, 4_096))
          .filter(Boolean)
      )
    ].slice(0, 32);
    next.interfaceScale = Math.min(
      1.4,
      Math.max(0.85, Number(next.interfaceScale) || 1)
    );
    this.setKv("settings", next);
    return this.getSettings();
  }

  getTransferSecret(): string {
    const existing = this.getKv<string>("transferSecret");
    if (existing) return existing;
    const created = crypto.randomBytes(32).toString("base64url");
    this.setKv("transferSecret", created);
    return created;
  }

  rotateTransferSecret(): string {
    const created = crypto.randomBytes(32).toString("base64url");
    this.setKv("transferSecret", created);
    return created;
  }

  getHistory(): TransferRecord[] {
    return this.allJson<TransferRecord>(
      "SELECT data FROM transfers ORDER BY created_at DESC LIMIT 5000"
    );
  }

  async upsertTransfer(record: TransferRecord): Promise<void> {
    this.requireDatabase()
      .prepare(`
        INSERT INTO transfers(id, created_at, data)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          created_at = excluded.created_at,
          data = excluded.data
      `)
      .run(record.id, record.createdAt, JSON.stringify(record));
    this.requireDatabase().exec(`
      DELETE FROM transfers
      WHERE id NOT IN (
        SELECT id FROM transfers ORDER BY created_at DESC LIMIT 5000
      )
    `);
  }

  async updateTransferMetadata(
    id: string,
    patch: TransferMetadataPatch
  ): Promise<TransferRecord> {
    const existing = this.getHistory().find((record) => record.id === id);
    if (!existing) throw new Error("Transfer not found.");
    const tags = (patch.tags ?? existing.tags ?? [])
      .map((tag) => String(tag).trim().replace(/\s+/g, " ").slice(0, 32))
      .filter(Boolean)
      .filter((tag, index, values) => values.indexOf(tag) === index)
      .slice(0, 12);
    const updated: TransferRecord = {
      ...existing,
      favorite: patch.favorite ?? existing.favorite ?? false,
      tags,
      note: String(patch.note ?? existing.note ?? "").trim().slice(0, 2_000)
    };
    await this.upsertTransfer(updated);
    return updated;
  }

  async updateTransfersMetadata(
    ids: string[],
    patch: TransferMetadataPatch
  ): Promise<TransferRecord[]> {
    const selected = [...new Set(ids)].slice(0, 5_000);
    const updated: TransferRecord[] = [];
    for (const id of selected) {
      updated.push(await this.updateTransferMetadata(id, patch));
    }
    return updated;
  }

  async addTagToTransfers(ids: string[], tag: string): Promise<TransferRecord[]> {
    const normalized = String(tag).trim().replace(/\s+/g, " ").slice(0, 32);
    if (!normalized) throw new Error("Enter a tag first.");
    const selected = new Set(ids.slice(0, 5_000));
    const updated: TransferRecord[] = [];
    for (const record of this.getHistory()) {
      if (!selected.has(record.id)) continue;
      updated.push(
        await this.updateTransferMetadata(record.id, {
          tags: [...(record.tags ?? []), normalized]
        })
      );
    }
    return updated;
  }

  findTransferByHash(sha256: string, size: number): TransferRecord | null {
    const records = this.getHistory();
    return (
      records.find(
        (record) =>
          record.status === "completed" &&
          record.sha256 === sha256 &&
          record.size === size &&
          record.savedPath
      ) ?? null
    );
  }

  async clearHistory(): Promise<void> {
    this.requireDatabase().exec("DELETE FROM transfers");
  }

  async removeTransfers(ids: string[]): Promise<void> {
    const statement = this.requireDatabase().prepare("DELETE FROM transfers WHERE id = ?");
    for (const id of [...new Set(ids)].slice(0, 5_000)) statement.run(id);
  }

  getSharedFiles(): SharedFile[] {
    return this.allJson<SharedFile>(
      "SELECT data FROM shared_files ORDER BY created_at DESC"
    );
  }

  async setSharedFiles(files: SharedFile[]): Promise<void> {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DELETE FROM shared_files");
      const insert = database.prepare(
        "INSERT INTO shared_files(id, created_at, data) VALUES (?, ?, ?)"
      );
      for (const file of files) insert.run(file.id, file.createdAt, JSON.stringify(file));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  getTrustedDevices(): TrustedDevice[] {
    return this.allJson<TrustedDevice>(
      "SELECT data FROM trusted_devices ORDER BY last_seen_at DESC"
    ).map((device) => ({
      ...device,
      permissions: { ...defaultDevicePermissions(), ...(device.permissions ?? {}) }
    }));
  }

  async upsertTrustedDevice(device: TrustedDevice): Promise<void> {
    this.requireDatabase()
      .prepare(`
        INSERT INTO trusted_devices(id, last_seen_at, data)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          data = excluded.data
      `)
      .run(device.id, device.lastSeenAt, JSON.stringify(device));
  }

  async revokeTrustedDevice(id: string): Promise<void> {
    const existing = this.getTrustedDevices().find((device) => device.id === id);
    if (!existing) return;
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const revoked = { ...existing, revoked: true };
      database
        .prepare(`
          UPDATE trusted_devices
          SET last_seen_at = ?, data = ?
          WHERE id = ?
        `)
        .run(revoked.lastSeenAt, JSON.stringify(revoked), id);
      // A phone's cached manifest contains private titles and relative file paths.
      // Forget it at the same time as the trust relationship so re-pairing cannot
      // make an old inventory visible again.
      database
        .prepare("DELETE FROM phone_music_libraries WHERE device_id = ?")
        .run(id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteTrustedDevice(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM trusted_devices WHERE id = ?").run(id);
  }

  getAutomationRules(): AutomationRule[] {
    return this.allJson<AutomationRule>(
      "SELECT data FROM automation_rules ORDER BY rowid"
    );
  }

  async addAutomationRule(rule: Omit<AutomationRule, "id">): Promise<AutomationRule> {
    const created: AutomationRule = { ...rule, id: crypto.randomUUID() };
    this.requireDatabase()
      .prepare("INSERT INTO automation_rules(id, data) VALUES (?, ?)")
      .run(created.id, JSON.stringify(created));
    return created;
  }

  async removeAutomationRule(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
  }

  getClipboardEntries(): ClipboardEntry[] {
    const now = Date.now();
    return this.allJson<ClipboardEntry>(
      "SELECT data FROM clipboard_entries ORDER BY created_at DESC LIMIT 100"
    )
      .filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now)
      .sort((left, right) => {
        if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
        return right.createdAt.localeCompare(left.createdAt);
      });
  }

  async addClipboardEntry(entry: ClipboardEntry): Promise<void> {
    this.requireDatabase()
      .prepare("INSERT OR REPLACE INTO clipboard_entries(id, created_at, data) VALUES (?, ?, ?)")
      .run(entry.id, entry.createdAt, JSON.stringify(entry));
    this.requireDatabase().exec(`
      DELETE FROM clipboard_entries
      WHERE id NOT IN (
        SELECT id FROM clipboard_entries ORDER BY created_at DESC LIMIT 100
      )
    `);
  }

  async updateClipboardEntry(
    id: string,
    update: { pinned?: boolean; expiresAt?: string | null }
  ): Promise<ClipboardEntry | null> {
    const current = this.getClipboardEntries().find((entry) => entry.id === id);
    if (!current) return null;
    const next: ClipboardEntry = {
      ...current,
      ...(update.pinned === undefined ? {} : { pinned: update.pinned })
    };
    if ("expiresAt" in update) next.expiresAt = update.expiresAt ?? undefined;
    await this.addClipboardEntry(next);
    return next;
  }

  async removeClipboardEntry(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM clipboard_entries WHERE id = ?").run(id);
  }

  async clearClipboard(): Promise<void> {
    this.requireDatabase().exec("DELETE FROM clipboard_entries");
  }

  getSyncProfiles(): SyncProfile[] {
    return this.allJson<SyncProfile>(
      "SELECT data FROM sync_profiles ORDER BY created_at DESC"
    );
  }

  async upsertSyncProfile(profile: SyncProfile): Promise<void> {
    this.upsertJson("sync_profiles", profile.id, profile.createdAt, profile);
  }

  async removeSyncProfile(id: string): Promise<void> {
    const database = this.requireDatabase();
    database.prepare("DELETE FROM sync_profiles WHERE id = ?").run(id);
    database.prepare("DELETE FROM sync_snapshots WHERE profile_id = ?").run(id);
  }

  getWatchFolders(): WatchFolder[] {
    return this.allJson<WatchFolder>(
      "SELECT data FROM watch_folders ORDER BY created_at DESC"
    );
  }

  async upsertWatchFolder(folder: WatchFolder): Promise<void> {
    this.upsertJson("watch_folders", folder.id, folder.createdAt, folder);
  }

  getWatchFolderFingerprints(id: string): Map<string, string> {
    const rows = this.requireDatabase()
      .prepare(`
        SELECT file_path, fingerprint
        FROM watch_folder_fingerprints
        WHERE folder_id = ?
        ORDER BY rowid
        LIMIT ?
      `)
      .all(id, MAX_WATCH_FOLDER_FINGERPRINTS) as Array<{
        file_path: string;
        fingerprint: string;
      }>;
    return new Map(rows.map((row) => [row.file_path, row.fingerprint]));
  }

  async setWatchFolderFingerprints(
    id: string,
    fingerprints: ReadonlyMap<string, string>
  ): Promise<void> {
    const entries = [...fingerprints.entries()].slice(
      0,
      MAX_WATCH_FOLDER_FINGERPRINTS
    );
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("DELETE FROM watch_folder_fingerprints WHERE folder_id = ?")
        .run(id);
      const insert = database.prepare(`
        INSERT INTO watch_folder_fingerprints(folder_id, file_path, fingerprint)
        VALUES (?, ?, ?)
      `);
      for (const [filePath, fingerprint] of entries) {
        insert.run(id, filePath, fingerprint);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async removeWatchFolder(id: string): Promise<void> {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("DELETE FROM watch_folder_fingerprints WHERE folder_id = ?")
        .run(id);
      database.prepare("DELETE FROM watch_folders WHERE id = ?").run(id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  getPrivateShareLinks(): PrivateShareLink[] {
    return this.allJson<PrivateShareLink>(
      "SELECT data FROM private_share_links ORDER BY created_at DESC"
    );
  }

  async upsertPrivateShareLink(link: PrivateShareLink): Promise<void> {
    this.upsertJson("private_share_links", link.id, link.createdAt, link);
  }

  async removePrivateShareLink(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM private_share_links WHERE id = ?").run(id);
  }

  getVaultItems(): VaultItem[] {
    return this.allJson<VaultItem>(
      "SELECT data FROM vault_items ORDER BY created_at DESC"
    );
  }

  async upsertVaultItem(item: VaultItem): Promise<void> {
    this.upsertJson("vault_items", item.id, item.createdAt, item);
  }

  async removeVaultItem(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM vault_items WHERE id = ?").run(id);
  }

  getProducerPackages(): ProducerPackage[] {
    return this.allJson<ProducerPackage>(
      "SELECT data FROM producer_packages ORDER BY created_at DESC"
    );
  }

  async upsertProducerPackage(item: ProducerPackage): Promise<void> {
    this.upsertJson("producer_packages", item.id, item.createdAt, item);
  }

  getFileRequests(): FileRequest[] {
    return this.allJson<FileRequest>(
      "SELECT data FROM file_requests ORDER BY created_at DESC"
    );
  }

  async upsertFileRequest(item: FileRequest): Promise<void> {
    this.upsertJson("file_requests", item.id, item.createdAt, item);
  }

  async removeFileRequest(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM file_requests WHERE id = ?").run(id);
  }

  getFileRequestUploads(): FileRequestUpload[] {
    return this.allJson<FileRequestUpload>(
      "SELECT data FROM file_request_uploads ORDER BY created_at DESC"
    );
  }

  async upsertFileRequestUpload(item: FileRequestUpload): Promise<void> {
    this.upsertJson("file_request_uploads", item.id, item.receivedAt, item);
  }

  async removeFileRequestUpload(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM file_request_uploads WHERE id = ?").run(id);
  }

  getPhoneMusicLibraries(now = Date.now()): PhoneMusicLibrary[] {
    const activeDeviceIds = new Set(
      this.getTrustedDevices()
        .filter((device) => !device.revoked)
        .map((device) => device.id)
    );
    return this.allJson<PhoneMusicLibrary>(
      "SELECT data FROM phone_music_libraries ORDER BY received_at DESC"
    )
      .filter((library) => activeDeviceIds.has(library.deviceId))
      .map((storedLibrary) => {
        const library = normalizePhoneMusicLibrary(storedLibrary);
        return {
        ...library,
        stale:
          !library.complete ||
          !Number.isFinite(Date.parse(library.receivedAt)) ||
          now - Date.parse(library.receivedAt) > PHONE_MUSIC_LIBRARY_STALE_AFTER_MS
        };
      });
  }

  async replacePhoneMusicLibrary(library: PhoneMusicLibrary): Promise<{
    saved: boolean;
    reason?: "duplicate" | "stale";
    current: PhoneMusicLibrary;
  }> {
    // The freshness check and row replacement share one immediate transaction. A
    // reconnect therefore cannot race a newer manifest and roll it back.
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare("SELECT data FROM phone_music_libraries WHERE device_id = ?")
        .get(library.deviceId) as { data?: string } | undefined;
      let existing: PhoneMusicLibrary | null = null;
      if (row?.data) {
        try {
          existing = normalizePhoneMusicLibrary(JSON.parse(row.data) as PhoneMusicLibrary);
        } catch {
          // A corrupt legacy row is safely replaced by the next validated manifest.
        }
      }
      if (existing?.generationId === library.generationId) {
        database.exec("COMMIT");
        return { saved: false, reason: "duplicate", current: existing };
      }
      if (existing) {
        const existingSequence = Number(existing.generationSequence);
        const incomingSequence = Number(library.generationSequence);
        const hasComparableSequences =
          Number.isSafeInteger(existingSequence) &&
          existingSequence >= 0 &&
          Number.isSafeInteger(incomingSequence) &&
          incomingSequence >= 0;
        const isStale = hasComparableSequences
          ? existingSequence >= incomingSequence
          : Number.isFinite(Date.parse(existing.generatedAt)) &&
            Date.parse(existing.generatedAt) >= Date.parse(library.generatedAt);
        if (isStale) {
          database.exec("COMMIT");
          return { saved: false, reason: "stale", current: existing };
        }
      }

      const normalizedLibrary = normalizePhoneMusicLibrary(library);
      database
        .prepare(`
          INSERT INTO phone_music_libraries(device_id, received_at, data)
          VALUES (?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            received_at = excluded.received_at,
            data = excluded.data
        `)
        .run(
          normalizedLibrary.deviceId,
          normalizedLibrary.receivedAt,
          JSON.stringify(normalizedLibrary)
        );
      database.exec("COMMIT");
      return { saved: true, current: normalizedLibrary };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  getBackupSnapshots(): BackupSnapshot[] {
    return this.allJson<BackupSnapshot>(
      "SELECT data FROM backup_snapshots ORDER BY created_at DESC"
    );
  }

  async upsertBackupSnapshot(snapshot: BackupSnapshot): Promise<void> {
    this.upsertJson("backup_snapshots", snapshot.id, snapshot.createdAt, snapshot);
  }

  async removeBackupSnapshot(id: string): Promise<void> {
    this.requireDatabase().prepare("DELETE FROM backup_snapshots WHERE id = ?").run(id);
  }

  getSyncSnapshot(profileId: string): Record<string, {
    size: number;
    modifiedAt: number;
    sha256?: string;
  }> {
    const rows = this.requireDatabase()
      .prepare("SELECT relative_path, data FROM sync_snapshots WHERE profile_id = ?")
      .all(profileId) as Array<{ relative_path: string; data: string }>;
    return Object.fromEntries(
      rows.flatMap((row) => {
        try {
          return [[row.relative_path, JSON.parse(row.data)]];
        } catch {
          return [];
        }
      })
    );
  }

  async setSyncSnapshot(
    profileId: string,
    entries: Record<string, { size: number; modifiedAt: number; sha256?: string }>
  ): Promise<void> {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM sync_snapshots WHERE profile_id = ?").run(profileId);
      const insert = database.prepare(
        "INSERT INTO sync_snapshots(profile_id, relative_path, data) VALUES (?, ?, ?)"
      );
      for (const [relativePath, data] of Object.entries(entries)) {
        insert.run(profileId, relativePath, JSON.stringify(data));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  getVaultMetadata(): { salt: string; keyCheck: string } | null {
    return this.getKv<{ salt: string; keyCheck: string }>("vaultMetadata");
  }

  setVaultMetadata(metadata: { salt: string; keyCheck: string }): void {
    this.setKv("vaultMetadata", metadata);
  }

  getRemoteIdentity(): { roomId: string; secret: string } {
    const existing = this.getKv<{ roomId: string; secret: string }>("remoteIdentity");
    if (existing) return existing;
    const created = {
      roomId: crypto.randomBytes(24).toString("base64url"),
      secret: crypto.randomBytes(32).toString("base64url")
    };
    this.setKv("remoteIdentity", created);
    return created;
  }

  rotateRemoteIdentity(): { roomId: string; secret: string } {
    const created = {
      roomId: crypto.randomBytes(24).toString("base64url"),
      secret: crypto.randomBytes(32).toString("base64url")
    };
    this.setKv("remoteIdentity", created);
    return created;
  }

  databaseIntegrityCheck(): string {
    const row = this.requireDatabase()
      .prepare("PRAGMA quick_check")
      .get() as Record<string, string> | undefined;
    return row ? Object.values(row)[0] ?? "unknown" : "unknown";
  }

  databaseSchemaVersion(): number {
    const row = this.requireDatabase()
      .prepare("PRAGMA user_version")
      .get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  getOnboardingComplete(): boolean {
    return this.getKv<boolean>("onboardingComplete") ?? false;
  }

  async setOnboardingComplete(): Promise<void> {
    this.setKv("onboardingComplete", true);
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("PocketDock database is not loaded.");
    return this.database;
  }

  private getKv<T>(key: string): T | null {
    if (!this.database) return null;
    const row = this.database
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private setKv(key: string, value: unknown): void {
    this.requireDatabase()
      .prepare(`
        INSERT INTO kv(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, JSON.stringify(value));
  }

  private allJson<T>(sql: string): T[] {
    return (
      this.requireDatabase().prepare(sql).all() as Array<{ data?: string }>
    ).flatMap((row) => {
      if (!row.data) return [];
      try {
        return [JSON.parse(row.data) as T];
      } catch {
        return [];
      }
    });
  }

  private upsertJson(
    table: string,
    id: string,
    createdAt: string,
    value: unknown
  ): void {
    const allowed = new Set([
      "sync_profiles",
      "watch_folders",
      "private_share_links",
      "vault_items",
      "producer_packages",
      "file_requests",
      "file_request_uploads",
      "backup_snapshots"
    ]);
    if (!allowed.has(table)) throw new Error("Unsupported PocketDock table.");
    this.requireDatabase()
      .prepare(`
        INSERT INTO ${table}(id, created_at, data)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          created_at = excluded.created_at,
          data = excluded.data
      `)
      .run(id, createdAt, JSON.stringify(value));
  }

  private async importLegacyState(): Promise<void> {
    try {
      const legacy = JSON.parse(await readFile(this.legacyStatePath, "utf8")) as LegacyState;
      this.setKv("settings", { ...defaultSettings(), ...(legacy.settings ?? {}) });
      this.setKv("onboardingComplete", Boolean(legacy.onboardingComplete));
      for (const transfer of legacy.history ?? []) await this.upsertTransfer(transfer);
      await this.setSharedFiles(legacy.sharedFiles ?? []);
      this.setKv("migratedFromV1", new Date().toISOString());
    } catch {
      // A missing legacy file is the normal first-run path.
    }
  }
}
