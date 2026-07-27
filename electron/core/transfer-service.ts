import crypto from "node:crypto";
import path from "node:path";
import http from "node:http";
import { createReadStream } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import Bonjour from "bonjour-service";
import { PairingManager, type SessionInfo } from "./security.js";
import { getLanAddresses, makeConnectionUrl } from "./network.js";
import {
  contentDispositionFileName,
  ensureDirectory,
  getFileSize,
  resolveDestinationPath,
  sanitizeFileName,
  sanitizeRelativeDirectory,
  uniqueFilePath
} from "./file-utils.js";
import {
  decryptTransferChunk,
  encryptTransferChunk,
  hashSecret,
  readRequestBody,
  secureHexEqual,
  sha256File
} from "./crypto-utils.js";
import { defaultDevicePermissions, StateStore } from "./store.js";
import { SyncService } from "./sync-service.js";
import type { ProductivityService } from "./productivity-service.js";
import type {
  ActiveTransfer,
  AppSettings,
  AutomationRule,
  ClipboardEntry,
  ConnectionInfo,
  DevicePermissions,
  FileRequest,
  FileRequestUpload,
  PrivateShareLink,
  SharedFile,
  StorageInfo,
  TransferEvent,
  TransferRecord,
  TrustedDevice
} from "./types.js";

interface PendingUpload {
  id: string;
  fingerprint: string;
  fileName: string;
  size: number;
  mimeType: string;
  lastModified: number;
  relativeDirectory: string;
  conflictPolicy: AppSettings["conflictPolicy"];
  sourceDevice: string;
  deviceId: string;
  syncProfileId?: string;
  createdAt: string;
  received: number;
  encrypted: boolean;
  protocolVersion: number;
  paused: boolean;
  speedBytesPerSecond: number;
  tempPath: string;
  finalPath: string;
  metaPath: string;
}

const uploadStartSchema = z.object({
  name: z.string().min(1).max(1_024),
  size: z.number().int().nonnegative().max(2 ** 53 - 1),
  type: z.string().max(512).optional().default("application/octet-stream"),
  lastModified: z.number().int().nonnegative().optional().default(0),
  relativePath: z.string().max(4_096).optional().default(""),
  encrypted: z.boolean().optional().default(false),
  protocolVersion: z.number().int().min(1).max(2).optional().default(1),
  syncProfileId: z.string().uuid().optional()
});

const completeUploadSchema = z.object({
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
});

const pairSchema = z.object({
  pin: z.string().length(6),
  deviceName: z.string().min(1).max(80).optional().default("iPhone"),
  deviceId: z.string().uuid().optional(),
  platform: z
    .enum(["chrome", "safari", "edge", "firefox", "browser", "ios", "unknown"])
    .optional()
    .default("browser")
});

const reconnectSchema = z.object({
  deviceId: z.string().uuid(),
  refreshToken: z.string().min(32).max(256)
});

const clipboardSchema = z.object({
  kind: z.enum(["text", "url", "image", "file"]),
  content: z.string().min(1).max(250_000),
  pinned: z.boolean().optional().default(false),
  expiresMinutes: z.number().int().min(0).max(43_200).optional().default(0),
  fileName: z.string().min(1).max(1_024).optional()
});

const clipboardUpdateSchema = z.object({
  pinned: z.boolean(),
  expiresMinutes: z.number().int().min(0).max(43_200).optional()
});

const studioReviewSchema = z.object({
  status: z.enum(["approved", "changes-requested"]),
  note: z.string().max(2_000).optional().default("")
});

export const MAX_PHONE_MUSIC_INVENTORY_PLAIN_BYTES = 8 * 1024 * 1024 - 16;
export const MAX_PHONE_MUSIC_TRACKS = 50_000;
export const MAX_PHONE_MUSIC_COLLECTIONS = 10_000;
export const MAX_PHONE_DOCUMENT_FILES = 50_000;
const MAX_PHONE_MUSIC_INVENTORY_ENCRYPTED_BYTES =
  MAX_PHONE_MUSIC_INVENTORY_PLAIN_BYTES + 16;
const MAX_PHONE_MUSIC_INVENTORY_CLOCK_SKEW_MS = 10 * 60 * 1_000;

const externalMusicIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), {
    message: "External IDs must be opaque text without surrounding whitespace."
  });

const phoneMusicTrackSchema = z.object({
  externalId: externalMusicIdSchema,
  title: z.string().min(1).max(1_024),
  artist: z.string().max(1_024),
  album: z.string().max(1_024),
  duration: z.number().nonnegative().max(31_536_000).optional(),
  track: z.number().int().positive().max(10_000).optional(),
  disc: z.number().int().positive().max(1_000).optional(),
  year: z.number().int().min(1_000).max(9_999).optional(),
  genre: z.string().max(256).optional(),
  isDownloaded: z.boolean().optional()
}).strict();

const phoneMusicCollectionSchema = z.object({
  externalId: externalMusicIdSchema,
  name: z.string().min(1).max(1_024),
  kind: z.string().min(1).max(64),
  itemCount: z.number().int().nonnegative().max(MAX_PHONE_MUSIC_TRACKS),
  trackExternalIds: z.array(externalMusicIdSchema).max(MAX_PHONE_MUSIC_TRACKS)
}).strict();

const phoneRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }, { message: "Document paths must be safe relative paths." });

const phoneDocumentFileSchema = z.object({
  externalId: externalMusicIdSchema,
  name: z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => !/[\\/\u0000]/.test(value), {
      message: "Document names cannot contain path separators."
    }),
  relativePath: phoneRelativePathSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: z.string().datetime({ offset: true }),
  contentType: z.string().min(1).max(512).optional(),
  isAudio: z.boolean().optional()
}).strict().superRefine((file, context) => {
  if (file.relativePath.split("/").at(-1) !== file.name) {
    context.addIssue({
      code: "custom",
      path: ["relativePath"],
      message: "Document paths must end with the declared file name."
    });
  }
});

const phoneMusicInventorySchema = z.object({
  generationId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  generationSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  generatedAt: z.string().datetime({ offset: true }),
  authorization: z.enum(["authorized", "denied", "restricted", "not-determined"]),
  complete: z.literal(true),
  music: z.array(phoneMusicTrackSchema).max(MAX_PHONE_MUSIC_TRACKS),
  collections: z
    .array(phoneMusicCollectionSchema)
    .max(MAX_PHONE_MUSIC_COLLECTIONS)
    .optional()
    .default([]),
  files: z.array(phoneDocumentFileSchema).max(MAX_PHONE_DOCUMENT_FILES)
}).strict().superRefine((inventory, context) => {
  const musicIds = new Set<string>();
  inventory.music.forEach((track, index) => {
    if (musicIds.has(track.externalId)) {
      context.addIssue({
        code: "custom",
        path: ["music", index, "externalId"],
        message: "Music external IDs must be unique within a complete inventory."
      });
    }
    musicIds.add(track.externalId);
  });
  const collectionIds = new Set<string>();
  inventory.collections.forEach((collection, index) => {
    if (collectionIds.has(collection.externalId)) {
      context.addIssue({
        code: "custom",
        path: ["collections", index, "externalId"],
        message: "Collection external IDs must be unique within a complete inventory."
      });
    }
    collectionIds.add(collection.externalId);
  });
  const fileIds = new Set<string>();
  const filePaths = new Set<string>();
  inventory.files.forEach((file, index) => {
    if (fileIds.has(file.externalId)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "externalId"],
        message: "Document external IDs must be unique within a complete inventory."
      });
    }
    if (filePaths.has(file.relativePath)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "relativePath"],
        message: "Document paths must be unique within a complete inventory."
      });
    }
    fileIds.add(file.externalId);
    filePaths.add(file.relativePath);
  });
});

type TransferEventHandler = (event: TransferEvent) => void;
type AutomationHandler = (
  rule: AutomationRule,
  filePath: string,
  record: TransferRecord
) => Promise<void>;

function getCookie(request: Request, key: string): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const pair of cookie.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === key) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function getBearer(request: Request): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown transfer error.";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mimeTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".json": "application/json"
  };
  return types[extension] ?? "application/octet-stream";
}

function fileCategory(fileName: string, mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Photos";
  if (mimeType.startsWith("video/")) return "Videos";
  if (mimeType.startsWith("audio/")) return "Audio";
  const extension = path.extname(fileName).toLowerCase();
  if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(extension)) return "Archives";
  if ([".pdf", ".txt", ".rtf", ".doc", ".docx", ".xls", ".xlsx", ".md"].includes(extension)) {
    return "Documents";
  }
  return "Other";
}

function matchingRule(
  rules: AutomationRule[],
  fileName: string,
  mimeType: string
): AutomationRule | undefined {
  const lowerName = fileName.toLowerCase();
  const extension = path.extname(lowerName).replace(/^\./, "");
  return rules.find((rule) => {
    if (!rule.enabled) return false;
    const value = rule.value.trim().toLowerCase();
    if (rule.matcher === "all") return true;
    if (rule.matcher === "extension") return extension === value.replace(/^\./, "");
    if (rule.matcher === "mime") return mimeType.toLowerCase().startsWith(value);
    return lowerName.includes(value);
  });
}

export class TransferService {
  private readonly pairing = new PairingManager();
  private readonly uploads = new Map<string, PendingUpload>();
  private readonly writingUploads = new Set<string>();
  private readonly fileRequestReservations = new Map<string, number>();
  private readonly stagingDirectory: string;
  private readonly fallbackDirectory: string;
  private server: http.Server | null = null;
  private bonjour: Bonjour | null = null;
  private advertisedService: ReturnType<Bonjour["publish"]> | null = null;
  private actualPort: number | null = null;
  private settings: AppSettings;
  private readonly syncService: SyncService;
  private productivityService: ProductivityService | null = null;
  private readonly requestInboxDirectory: string;
  private onEvent: TransferEventHandler = () => undefined;
  private onAutomation: AutomationHandler = async () => undefined;

  constructor(
    private readonly store: StateStore,
    private readonly mobileDirectory: string,
    userDataDirectory: string
  ) {
    this.settings = store.getSettings();
    this.syncService = new SyncService(store);
    this.stagingDirectory = path.join(userDataDirectory, "staging");
    this.requestInboxDirectory = path.join(userDataDirectory, "request-inbox");
    this.fallbackDirectory = path.join(userDataDirectory, "Received");
  }

  setProductivityService(service: ProductivityService): void {
    this.productivityService = service;
  }

  setEventHandler(handler: TransferEventHandler): void {
    this.onEvent = handler;
  }

  setAutomationHandler(handler: AutomationHandler): void {
    this.onAutomation = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.settings = this.store.getSettings();
    try {
      await ensureDirectory(this.settings.destinationDirectory);
    } catch {
      await ensureDirectory(this.fallbackDirectory);
      this.settings = await this.store.updateSettings({
        destinationDirectory: this.fallbackDirectory
      });
    }
    await ensureDirectory(this.stagingDirectory);
    await ensureDirectory(this.requestInboxDirectory);
    await this.loadPendingUploads();

    const app = this.createApp();
    this.server = http.createServer(app);
    this.actualPort = await this.listen(this.server, this.settings.port);
    if (getLanAddresses().length > 0) {
      this.bonjour = new Bonjour();
      this.advertisedService = this.bonjour.publish({
        name: this.settings.deviceName,
        type: "pocketdock",
        protocol: "tcp",
        port: this.actualPort,
        txt: { version: "2", encryption: "aes-256-gcm" }
      });
    }
    this.emit({ type: "connection-updated" });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    try {
      this.advertisedService?.stop();
      this.bonjour?.destroy();
    } catch {
      // Network adapters can disappear while Windows is sleeping or changing networks.
    }
    this.advertisedService = null;
    this.bonjour = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.emit({ type: "connection-updated" });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  rotatePairingCode(): void {
    this.pairing.rotatePin();
    this.emit({ type: "connection-updated" });
  }

  async revokeTrustedDevice(id: string): Promise<void> {
    this.pairing.revokeDevice(id);
    this.pairing.rotatePin();
    await this.store.revokeTrustedDevice(id);
    this.emit({ type: "connection-updated" });
  }

  async updateTrustedDevicePermissions(
    id: string,
    permissions: DevicePermissions
  ): Promise<void> {
    const device = this.store.getTrustedDevices().find((entry) => entry.id === id);
    if (!device) throw new Error("Trusted device not found.");
    await this.store.upsertTrustedDevice({
      ...device,
      permissions: { ...defaultDevicePermissions(), ...permissions }
    });
    this.emit({ type: "connection-updated" });
  }

  getPrivateShareLinks(): PrivateShareLink[] {
    const baseUrl = this.localBaseUrl();
    return this.store.getPrivateShareLinks().map((link) => ({
      ...link,
      tokenHash: "",
      url: undefined,
      ...(baseUrl && !link.revoked && new Date(link.expiresAt).getTime() > Date.now()
        ? { url: this.privateShareUrl(link.id) }
        : {})
    }));
  }

  getFileRequests(): FileRequest[] {
    const baseUrl = this.localBaseUrl();
    return this.store.getFileRequests().map((request) => ({
      ...request,
      tokenHash: "",
      url:
        baseUrl && !request.revoked && new Date(request.expiresAt).getTime() > Date.now()
          ? this.fileRequestUrl(request.id)
          : undefined
    }));
  }

  async createFileRequest(details: {
    name: string;
    destinationSubfolder: string;
    expiresHours: number;
    maxFileSize: number;
    maxFiles: number;
    requiresApproval: boolean;
  }): Promise<FileRequest> {
    const id = crypto.randomUUID();
    const token = this.fileRequestToken(id);
    const request: FileRequest = {
      id,
      name: String(details.name || "PocketDock file request").trim().slice(0, 120),
      destinationSubfolder: sanitizeRelativeDirectory(details.destinationSubfolder).slice(0, 1_024),
      tokenHash: hashSecret(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + Math.min(30 * 24, Math.max(1, details.expiresHours)) * 60 * 60 * 1_000
      ).toISOString(),
      maxFileSize: Math.min(2 * 1024 ** 3, Math.max(1024, Math.round(details.maxFileSize))),
      maxFiles: Math.min(1_000, Math.max(1, Math.round(details.maxFiles))),
      receivedCount: 0,
      requiresApproval: Boolean(details.requiresApproval),
      revoked: false
    };
    await this.store.upsertFileRequest(request);
    this.emit({ type: "share-updated" });
    return { ...request, tokenHash: "", url: this.fileRequestUrl(id) };
  }

  async revokeFileRequest(id: string): Promise<void> {
    const request = this.store.getFileRequests().find((item) => item.id === id);
    if (!request) return;
    await this.store.upsertFileRequest({ ...request, revoked: true });
    this.emit({ type: "share-updated" });
  }

  async approveFileRequestUpload(id: string): Promise<void> {
    const upload = this.store.getFileRequestUploads().find((item) => item.id === id);
    if (!upload || upload.status !== "pending" || !upload.pendingPath) {
      throw new Error("This request upload is no longer pending.");
    }
    const request = this.store.getFileRequests().find((item) => item.id === upload.requestId);
    const directory = path.join(
      this.settings.destinationDirectory,
      sanitizeRelativeDirectory(request?.destinationSubfolder || "File Requests")
    );
    await ensureDirectory(directory);
    const destination = await uniqueFilePath(path.join(directory, sanitizeFileName(upload.fileName)));
    await rename(upload.pendingPath, destination);
    const approved: FileRequestUpload = {
      ...upload,
      status: "approved",
      pendingPath: undefined,
      savedPath: destination
    };
    await this.store.upsertFileRequestUpload(approved);
    await this.recordFileRequestTransfer(approved);
    this.emit({ type: "upload-completed", payload: { fileName: approved.fileName } });
  }

  async rejectFileRequestUpload(id: string): Promise<void> {
    const upload = this.store.getFileRequestUploads().find((item) => item.id === id);
    if (!upload || upload.status !== "pending") return;
    if (upload.pendingPath) await rm(upload.pendingPath, { force: true });
    await this.store.upsertFileRequestUpload({
      ...upload,
      status: "rejected",
      pendingPath: undefined
    });
    this.emit({ type: "share-updated" });
  }

  getSharedFiles(): SharedFile[] {
    const now = Date.now();
    return this.store.getSharedFiles().filter(
      (file) => !file.expiresAt || new Date(file.expiresAt).getTime() > now
    );
  }

  async createPrivateShareLink(
    name: string,
    sharedFileIds: string[],
    expiresHours: number,
    maxDownloads: number
  ): Promise<PrivateShareLink> {
    const availableIds = new Set(this.getSharedFiles().map((file) => file.id));
    const selected = [...new Set(sharedFileIds)].filter((id) => availableIds.has(id));
    if (!selected.length) throw new Error("Choose at least one shared file.");
    const id = crypto.randomUUID();
    const token = this.privateLinkToken(id);
    const link: PrivateShareLink = {
      id,
      name: String(name || "PocketDock share").trim().slice(0, 120),
      sharedFileIds: selected,
      tokenHash: hashSecret(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + Math.min(30 * 24, Math.max(1, expiresHours)) * 60 * 60 * 1000
      ).toISOString(),
      maxDownloads: Math.min(10_000, Math.max(1, Math.round(maxDownloads))),
      downloads: 0,
      revoked: false,
      allowRelay: false
    };
    await this.store.upsertPrivateShareLink(link);
    this.emit({ type: "share-updated" });
    return { ...link, tokenHash: "", url: this.privateShareUrl(id) };
  }

  async revokePrivateShareLink(id: string): Promise<void> {
    const link = this.store.getPrivateShareLinks().find((entry) => entry.id === id);
    if (!link) return;
    await this.store.upsertPrivateShareLink({ ...link, revoked: true });
    this.emit({ type: "share-updated" });
  }

  getConnectionInfo(): ConnectionInfo {
    const addresses = getLanAddresses();
    const primary = addresses[0];
    const baseUrl =
      primary && this.actualPort
        ? makeConnectionUrl(primary, this.actualPort, this.pairing.getPin())
        : null;
    return {
      running: Boolean(this.server),
      url: baseUrl ? `${baseUrl}#key=${this.store.getTransferSecret()}` : null,
      pin: this.pairing.getPin(),
      port: this.actualPort,
      addresses,
      connectedDevices: this.pairing.connectedDeviceCount(),
      encryptionAvailable: true,
      trustedDevices: this.store.getTrustedDevices().filter((device) => !device.revoked).length
    };
  }

  getActiveTransfers(): ActiveTransfer[] {
    return [...this.uploads.values()].map((upload) => this.toActiveTransfer(upload));
  }

  async pauseTransfer(id: string): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload) return;
    upload.paused = true;
    await this.saveUpload(upload);
    this.emit({ type: "upload-progress", payload: this.toActiveTransfer(upload) });
  }

  async resumeTransfer(id: string): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload) return;
    upload.paused = false;
    await this.saveUpload(upload);
    this.emit({ type: "upload-progress", payload: this.toActiveTransfer(upload) });
  }

  async cancelTransfer(id: string): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload) return;
    await Promise.all([
      rm(upload.tempPath, { force: true }),
      rm(upload.metaPath, { force: true })
    ]);
    this.uploads.delete(upload.id);
    await this.store.upsertTransfer(this.toRecord(upload, "cancelled"));
    this.emit({ type: "upload-cancelled", payload: { id: upload.id, cancelled: true } });
  }

  async getStorageInfo(): Promise<StorageInfo | null> {
    try {
      const data = await statfs(this.settings.destinationDirectory);
      const total = data.blocks * data.bsize;
      const free = data.bavail * data.bsize;
      return { total, free, used: total - free };
    } catch {
      return null;
    }
  }

  async registerSharedFiles(
    paths: string[],
    expiresMinutes = 0,
    source: SharedFile["source"] = "manual"
  ): Promise<void> {
    const lifetimeMinutes = Math.min(
      365 * 24 * 60,
      Math.max(0, Math.round(Number(expiresMinutes) || 0))
    );
    const existing = this.store.getSharedFiles();
    const byPath = new Map(existing.map((file) => [file.path, file]));
    for (const filePath of paths) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      const current = byPath.get(filePath);
      byPath.set(filePath, {
        id: current?.id ?? crypto.randomUUID(),
        name: sanitizeFileName(path.basename(filePath)),
        path: filePath,
        size: info.size,
        mimeType: mimeTypeFor(filePath),
        createdAt: current?.createdAt ?? new Date().toISOString(),
        sha256: this.settings.verifyIntegrity ? await sha256File(filePath) : undefined,
        expiresAt:
          lifetimeMinutes > 0
            ? new Date(Date.now() + lifetimeMinutes * 60_000).toISOString()
            : undefined,
        source
      });
    }
    await this.store.setSharedFiles([...byPath.values()]);
    this.emit({ type: "share-updated" });
  }

  async removeSharedFile(id: string): Promise<void> {
    await this.store.setSharedFiles(this.store.getSharedFiles().filter((file) => file.id !== id));
    this.emit({ type: "share-updated" });
  }

  async addClipboardEntry(
    content: string,
    sourceDevice: string,
    options: {
      kind?: ClipboardEntry["kind"];
      pinned?: boolean;
      expiresMinutes?: number;
      fileName?: string;
    } = {}
  ): Promise<ClipboardEntry | null> {
    const trimmed = content.trim();
    if (!trimmed) return null;
    const entry: ClipboardEntry = {
      id: crypto.randomUUID(),
      kind: options.kind ?? (/^https?:\/\//i.test(trimmed) ? "url" : "text"),
      content: trimmed.slice(0, 250_000),
      sourceDevice,
      createdAt: new Date().toISOString(),
      pinned: options.pinned || undefined,
      expiresAt: options.expiresMinutes
        ? new Date(Date.now() + options.expiresMinutes * 60_000).toISOString()
        : undefined,
      fileName: options.fileName
    };
    await this.store.addClipboardEntry(entry);
    this.emit({ type: "clipboard-updated", payload: entry });
    return entry;
  }

  private createApp(): express.Express {
    const app = express();
    app.disable("x-powered-by");
    app.use((request, response, next) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) {
        response.status(403).json({ error: "Cross-origin requests are blocked." });
        return;
      }
      next();
    });

    app.get("/api/status", (_request, response) => {
      response.json({
        name: this.settings.deviceName,
        version: 2,
        protocolVersion: 2,
        requiresPairing: true,
        encryptionRequired: this.settings.encryptTransfers,
        integrityRequired: this.settings.verifyIntegrity,
        maxChunkSize: 8 * 1024 * 1024,
        maxConcurrentUploads: this.settings.maxConcurrentUploads
      });
    });

    app.post("/api/pair", express.json({ limit: "16kb" }), async (request, response) => {
      const parsed = pairSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Enter the six-digit pairing code." });
        return;
      }
      const address = request.ip || request.socket.remoteAddress || "unknown";
      const deviceId = (parsed.data.deviceId ?? crypto.randomUUID()).toLowerCase();
      const paired = this.pairing.pair(
        parsed.data.pin,
        parsed.data.deviceName,
        address,
        deviceId
      );
      if (!paired) {
        response.status(401).json({ error: "That code is incorrect or pairing is temporarily locked." });
        return;
      }
      const refreshToken = crypto.randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      await this.store.upsertTrustedDevice({
        id: deviceId,
        name: parsed.data.deviceName,
        tokenHash: hashSecret(refreshToken),
        createdAt:
          this.store.getTrustedDevices().find((device) => device.id === deviceId)?.createdAt ?? now,
        lastSeenAt: now,
        lastAddress: address,
        revoked: false,
        platform: parsed.data.platform,
        permissions:
          this.store.getTrustedDevices().find((device) => device.id === deviceId)?.permissions ??
          defaultDevicePermissions()
      });
      this.setSessionCookie(response, paired.token);
      response.json({
        token: paired.token,
        refreshToken,
        deviceId,
        expiresAt: paired.expiresAt,
        pcName: this.settings.deviceName,
        encryptionRequired: this.settings.encryptTransfers,
        integrityRequired: this.settings.verifyIntegrity
      });
      this.emit({ type: "connection-updated" });
    });

    app.post("/api/reconnect", express.json({ limit: "16kb" }), async (request, response) => {
      const parsed = reconnectSchema.safeParse(request.body);
      if (!parsed.success || !this.settings.trustedDeviceAutoConnect) {
        response.status(401).json({ error: "Scan PocketDock again to reconnect." });
        return;
      }
      const deviceId = parsed.data.deviceId.toLowerCase();
      const trusted = this.store
        .getTrustedDevices()
        .find((device) => device.id === deviceId && !device.revoked);
      if (!trusted || !secureHexEqual(trusted.tokenHash, hashSecret(parsed.data.refreshToken))) {
        response.status(401).json({ error: "This device is no longer trusted." });
        return;
      }
      const address = request.ip || request.socket.remoteAddress || "unknown";
      const session = this.pairing.createSession(trusted.name, address, trusted.id);
      await this.store.upsertTrustedDevice({
        ...trusted,
        lastSeenAt: new Date().toISOString(),
        lastAddress: address
      });
      this.setSessionCookie(response, session.token);
      response.json({
        token: session.token,
        expiresAt: session.expiresAt,
        pcName: this.settings.deviceName,
        encryptionRequired: this.settings.encryptTransfers,
        integrityRequired: this.settings.verifyIntegrity
      });
      this.emit({ type: "connection-updated" });
    });

    app.get("/api/public-links/:id", async (request, response) => {
      const link = this.validatePrivateLink(request);
      if (!link) {
        response.status(401).json({ error: "This private link is invalid or has expired." });
        return;
      }
      const files = this
        .getSharedFiles()
        .filter((file) => link.sharedFileIds.includes(file.id));
      const available = [];
      for (const file of files) {
        if (await fileExists(file.path)) {
          available.push({
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            sha256: file.sha256,
            chunkUrl: `/api/public-links/${link.id}/files/${file.id}/chunk`
          });
        }
      }
      const delivery = this.store
        .getProducerPackages()
        .find((item) => item.portalLinkId === link.id);
      response.json({
        id: link.id,
        name: link.name,
        expiresAt: link.expiresAt,
        remainingDownloads: Math.max(0, link.maxDownloads - link.downloads),
        files: available,
        delivery: delivery ? {
          title: delivery.title,
          artist: delivery.artist,
          bpm: delivery.bpm,
          musicalKey: delivery.musicalKey,
          notes: delivery.notes,
          version: delivery.version,
          clientName: delivery.clientName,
          licenseName: delivery.licenseName,
          approvalStatus: delivery.approvalStatus,
          clientNote: delivery.clientNote,
          downloadCount: delivery.downloadCount,
          artwork: delivery.artwork,
          tracks: delivery.tracks
        } : undefined
      });
    });

    app.get("/api/public-links/:id/files/:fileId/chunk", async (request, response) => {
      const link = this.validatePrivateLink(request);
      const file = this
        .getSharedFiles()
        .find(
          (entry) =>
            entry.id === request.params.fileId &&
            link?.sharedFileIds.includes(entry.id)
        );
      if (!link || !file || !(await fileExists(file.path))) {
        response.status(404).json({ error: "The private file is unavailable." });
        return;
      }
      const offset = Number(request.query.offset ?? 0);
      const length = Math.min(Number(request.query.length ?? 4 * 1024 * 1024), 4 * 1024 * 1024);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= file.size ||
        !Number.isSafeInteger(length) ||
        length <= 0
      ) {
        response.status(400).json({ error: "Invalid download range." });
        return;
      }
      const handle = await open(file.path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(length, file.size - offset));
        const result = await handle.read(buffer, 0, buffer.length, offset);
        const plaintext = buffer.subarray(0, result.bytesRead);
        const encrypted = encryptTransferChunk(
          this.privateLinkKey(link.id),
          file.id,
          offset,
          plaintext
        );
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("X-PocketDock-IV", encrypted.iv);
        response.setHeader("X-PocketDock-Plain-Length", plaintext.length.toString());
        response.send(encrypted.payload);
      } finally {
        await handle.close();
      }
    });

    app.post("/api/public-links/:id/files/:fileId/complete", async (request, response) => {
      const link = this.validatePrivateLink(request);
      if (!link || !link.sharedFileIds.includes(request.params.fileId)) {
        response.status(401).json({ error: "This private link is invalid or has expired." });
        return;
      }
      await this.store.upsertPrivateShareLink({
        ...link,
        downloads: Math.min(link.maxDownloads, link.downloads + 1)
      });
      const delivery = this.store
        .getProducerPackages()
        .find((item) => item.portalLinkId === link.id);
      if (delivery) {
        await this.store.upsertProducerPackage({
          ...delivery,
          downloadCount: (delivery.downloadCount ?? 0) + 1
        });
      }
      response.json({ complete: true });
    });

    app.post(
      "/api/public-links/:id/approval",
      express.json({ limit: "16kb" }),
      async (request, response) => {
        const link = this.validatePrivateLink(request);
        const delivery = this.store
          .getProducerPackages()
          .find((item) => item.portalLinkId === link?.id);
        const status = request.body?.status;
        if (
          !link ||
          !delivery ||
          !["approved", "changes-requested"].includes(status)
        ) {
          response.status(400).json({ error: "This delivery cannot accept approval." });
          return;
        }
        await this.store.upsertProducerPackage({
          ...delivery,
          approvalStatus: status,
          clientNote: String(request.body?.note ?? "").trim().slice(0, 2_000)
        });
        response.json({ saved: true });
      }
    );

    app.get("/api/file-requests/:id", (request, response) => {
      const fileRequest = this.validateFileRequest(request);
      if (!fileRequest) {
        response.status(401).json({ error: "This file request is invalid or has expired." });
        return;
      }
      response.json({
        id: fileRequest.id,
        name: fileRequest.name,
        expiresAt: fileRequest.expiresAt,
        maxFileSize: fileRequest.maxFileSize,
        remainingFiles: Math.max(
          0,
          fileRequest.maxFiles -
            fileRequest.receivedCount -
            (this.fileRequestReservations.get(fileRequest.id) ?? 0)
        ),
        requiresApproval: fileRequest.requiresApproval
      });
    });

    app.post("/api/file-requests/:id/files", async (request, response) => {
      const fileRequest = this.validateFileRequest(request);
      if (!fileRequest || fileRequest.receivedCount >= fileRequest.maxFiles) {
        response.status(401).json({ error: "This file request is unavailable or complete." });
        return;
      }
      const fileName = sanitizeFileName(
        decodeURIComponent(String(request.headers["x-pocketdock-file-name"] ?? "Uploaded file"))
      );
      const declaredSize = Number(request.headers["content-length"] ?? 0);
      if (declaredSize > fileRequest.maxFileSize) {
        response.status(413).json({ error: "This file exceeds the request size limit." });
        return;
      }
      if (!this.reserveFileRequestSlot(fileRequest)) {
        response.status(401).json({ error: "This file request is unavailable or complete." });
        return;
      }
      try {
        const id = crypto.randomUUID();
        const temporaryPath = path.join(this.requestInboxDirectory, `${id}.part`);
        const handle = await open(temporaryPath, "wx");
        const hasher = crypto.createHash("sha256");
        let size = 0;
        try {
          for await (const raw of request) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            size += chunk.length;
            if (size > fileRequest.maxFileSize) {
              throw new Error("This file exceeds the request size limit.");
            }
            hasher.update(chunk);
            await handle.write(chunk);
          }
        } catch (error) {
          await handle.close();
          await rm(temporaryPath, { force: true });
          response.status(413).json({ error: formatError(error) });
          return;
        }
        await handle.close();
        if (!size) {
          await rm(temporaryPath, { force: true });
          response.status(400).json({ error: "The uploaded file is empty." });
          return;
        }
        let savedPath: string | undefined;
        let pendingPath: string | undefined = temporaryPath;
        let status: FileRequestUpload["status"] = "pending";
        if (!fileRequest.requiresApproval) {
          const directory = path.join(
            this.settings.destinationDirectory,
            sanitizeRelativeDirectory(fileRequest.destinationSubfolder || "File Requests")
          );
          await ensureDirectory(directory);
          savedPath = await uniqueFilePath(path.join(directory, fileName));
          await rename(temporaryPath, savedPath);
          pendingPath = undefined;
          status = "approved";
        }
        const upload: FileRequestUpload = {
          id,
          requestId: fileRequest.id,
          fileName,
          size,
          mimeType: String(request.headers["content-type"] ?? mimeTypeFor(fileName)).slice(0, 512),
          sha256: hasher.digest("hex"),
          receivedAt: new Date().toISOString(),
          status,
          pendingPath,
          savedPath,
          sourceAddress: request.ip || request.socket.remoteAddress || "unknown"
        };
        await this.store.upsertFileRequestUpload(upload);
        const latestFileRequest = this.store
          .getFileRequests()
          .find((item) => item.id === fileRequest.id);
        if (!latestFileRequest) {
          throw new Error("This file request no longer exists.");
        }
        await this.store.upsertFileRequest({
          ...latestFileRequest,
          receivedCount: latestFileRequest.receivedCount + 1
        });
        if (status === "approved") {
          await this.recordFileRequestTransfer(upload);
          this.emit({ type: "upload-completed", payload: { fileName } });
        } else {
          this.emit({ type: "share-updated", payload: { fileName, pendingApproval: true } });
        }
        response.status(201).json({
          saved: status === "approved",
          pendingApproval: status === "pending"
        });
      } finally {
        this.releaseFileRequestSlot(fileRequest.id);
      }
    });

    app.use("/api", (request, response, next) => this.authenticate(request, response, next));
    app.use("/api/uploads", (_request, response, next) => {
      if (!this.permission(response, "sendToPc")) {
        response.status(403).json({ error: "This device is not allowed to send files." });
        return;
      }
      next();
    });
    app.use("/api/shares", (_request, response, next) => {
      if (!this.permission(response, "receiveFromPc")) {
        response.status(403).json({ error: "This device is not allowed to receive PC files." });
        return;
      }
      next();
    });
    app.use("/api/clipboard", (_request, response, next) => {
      if (!this.permission(response, "clipboard")) {
        response.status(403).json({ error: "Clipboard access is disabled for this device." });
        return;
      }
      next();
    });
    app.use("/api/music", (_request, response, next) => {
      if (!this.permission(response, "sendToPc")) {
        response.status(403).json({ error: "This device is not allowed to publish its library." });
        return;
      }
      next();
    });

    app.use("/api/sync", (_request, response, next) => {
      if (!this.permission(response, "automaticBackup")) {
        response.status(403).json({ error: "Automatic backup is disabled for this device." });
        return;
      }
      next();
    });
    app.use("/api/drive", (_request, response, next) => {
      if (!this.settings.remoteBrowseEnabled || !this.permission(response, "browseFiles")) {
        response.status(403).json({ error: "PocketDock Drive is disabled for this device." });
        return;
      }
      next();
    });
    app.use("/api/studio", (_request, response, next) => {
      if (!this.permission(response, "receiveFromPc")) {
        response.status(403).json({ error: "Producer Studio access is disabled for this device." });
        return;
      }
      next();
    });

    app.get("/api/me", async (_request, response) => {
      const session = response.locals.session as SessionInfo;
      response.json({
        pcName: this.settings.deviceName,
        deviceId: session.deviceId,
        destinationLabel: path.basename(this.settings.destinationDirectory) || "PocketDock",
        encryptionRequired: this.settings.encryptTransfers,
        integrityRequired: this.settings.verifyIntegrity,
        backupSchedule: {
          enabled: this.settings.backupScheduleEnabled,
          start: this.settings.backupWindowStart,
          end: this.settings.backupWindowEnd,
          allowedNow: this.productivityService?.backupAllowed() ?? true
        },
        transport: await this.productivityService?.transportStatus()
      });
    });

    app.put("/api/music/inventory", async (request, response) => {
      const session = response.locals.session as SessionInfo;
      const trusted = this.store
        .getTrustedDevices()
        .find((device) => device.id === session.deviceId && !device.revoked);
      if (!trusted) {
        response.status(401).json({ error: "Pair this iPhone again to publish its library." });
        return;
      }
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) {
        response.status(415).json({ error: "Music inventories must use encrypted binary content." });
        return;
      }

      const declaredLengthHeader = request.headers["content-length"];
      const declaredLength = declaredLengthHeader === undefined
        ? undefined
        : Number(declaredLengthHeader);
      if (
        declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) || declaredLength < 16)
      ) {
        response.status(400).json({ error: "The encrypted inventory length is invalid." });
        return;
      }
      if (
        declaredLength !== undefined &&
        declaredLength > MAX_PHONE_MUSIC_INVENTORY_ENCRYPTED_BYTES
      ) {
        response.status(413).json({ error: "The music inventory is too large." });
        return;
      }

      const plainLength = Number(request.headers["x-pocketdock-plain-length"] ?? Number.NaN);
      const iv = String(request.headers["x-pocketdock-iv"] ?? "");
      if (!Number.isSafeInteger(plainLength) || plainLength <= 0) {
        response.status(400).json({ error: "The music inventory plaintext length is invalid." });
        return;
      }
      if (plainLength > MAX_PHONE_MUSIC_INVENTORY_PLAIN_BYTES) {
        response.status(413).json({ error: "The music inventory is too large." });
        return;
      }
      if (!/^[A-Za-z0-9_-]{16}$/.test(iv)) {
        response.status(400).json({ error: "The music inventory encryption IV is invalid." });
        return;
      }

      try {
        const body = await readRequestBody(
          request,
          MAX_PHONE_MUSIC_INVENTORY_ENCRYPTED_BYTES
        );
        const plaintext = decryptTransferChunk(
          this.store.getTransferSecret(),
          `music-inventory:${session.deviceId}`,
          0,
          plainLength,
          iv,
          body
        );
        const parsed = phoneMusicInventorySchema.safeParse(
          JSON.parse(plaintext.toString("utf8"))
        );
        if (!parsed.success) {
          response.status(400).json({ error: "The complete music inventory is invalid." });
          return;
        }
        if (
          Date.parse(parsed.data.generatedAt) >
          Date.now() + MAX_PHONE_MUSIC_INVENTORY_CLOCK_SKEW_MS
        ) {
          response.status(400).json({ error: "The music inventory timestamp is too far ahead." });
          return;
        }

        const receivedAt = new Date().toISOString();
        const library = {
          ...parsed.data,
          deviceId: session.deviceId,
          deviceName: session.deviceName,
          receivedAt,
          stale: false
        };
        const committed = await this.store.replacePhoneMusicLibrary(library);
        if (!committed.saved) {
          response.status(200).json({
            saved: false,
            reason: committed.reason,
            generationId: committed.current.generationId,
            musicCount: committed.current.music.length,
            collectionCount: committed.current.collections?.length ?? 0,
            fileCount: committed.current.files.length,
            receivedAt: committed.current.receivedAt
          });
          return;
        }
        this.emit({
          type: "music-updated",
          payload: {
            source: "iphone",
            deviceId: session.deviceId,
            generationId: library.generationId,
            musicCount: library.music.length,
            collectionCount: library.collections.length,
            fileCount: library.files.length
          }
        });
        response.status(201).json({
          saved: true,
          generationId: library.generationId,
          musicCount: library.music.length,
          collectionCount: library.collections.length,
          fileCount: library.files.length,
          receivedAt
        });
      } catch (error) {
        const oversized =
          error instanceof Error && error.message.includes("exceeds the chunk limit");
        response.status(oversized ? 413 : 400).json({
          error: oversized
            ? "The music inventory is too large."
            : "The encrypted music inventory could not be verified."
        });
      }
    });

    app.get("/api/drive", async (request, response) => {
      if (!this.productivityService) {
        response.status(503).json({ error: "PocketDock Drive is not ready." });
        return;
      }
      try {
        response.json(await this.productivityService.browse(String(request.query.path ?? "")));
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.get("/api/drive/search", async (request, response) => {
      if (!this.productivityService) {
        response.status(503).json({ error: "PocketDock Drive is not ready." });
        return;
      }
      try {
        response.json(
          await this.productivityService.searchDrive(
            String(request.query.q ?? ""),
            Number(request.query.limit ?? 100)
          )
        );
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.get("/api/diagnostics/mobile", async (_request, response) => {
      const session = response.locals.session as SessionInfo;
      const storage = await this.getStorageInfo();
      const transport = await this.productivityService?.transportStatus();
      response.json({
        generatedAt: new Date().toISOString(),
        pcName: this.settings.deviceName,
        checks: [
          {
            id: "authentication",
            title: "Trusted device",
            status: "pass",
            detail: `${session.deviceName} has a valid, revocable session.`
          },
          {
            id: "encryption",
            title: "Transfer encryption",
            status: this.settings.encryptTransfers ? "pass" : "warning",
            detail: this.settings.encryptTransfers
              ? "AES-256-GCM is required for transfer payloads."
              : "Transfer encryption is disabled by PC policy."
          },
          {
            id: "integrity",
            title: "Integrity verification",
            status: this.settings.verifyIntegrity ? "pass" : "warning",
            detail: this.settings.verifyIntegrity
              ? "Completed transfers require SHA-256 verification."
              : "Integrity verification is disabled by PC policy."
          },
          {
            id: "destination",
            title: "PC destination",
            status: storage && storage.free > 512 * 1024 * 1024 ? "pass" : "warning",
            detail: storage
              ? `${Math.round(storage.free / 1024 / 1024)} MB free at the approved destination.`
              : "The configured destination could not be measured."
          },
          {
            id: "transport",
            title: "Active transport",
            status: transport?.selected === "offline" ? "fail" : "pass",
            detail: transport?.reason ?? "LAN transfer service is ready."
          },
          {
            id: "drive",
            title: "PocketDock Drive",
            status: this.settings.remoteBrowseEnabled ? "pass" : "info",
            detail: this.settings.remoteBrowseEnabled
              ? "Authenticated browsing is enabled inside the approved root."
              : "Remote Drive browsing is disabled by PC policy."
          }
        ]
      });
    });

    app.get("/api/studio/packages", (_request, response) => {
      response.json(
        this.store.getProducerPackages().map(
          ({ path: _path, trackSources: _trackSources, ...item }) => ({
          ...item,
          tracks: item.tracks?.map((track) => ({
            ...track,
            previewAvailable:
              Boolean(_trackSources?.[track.sha256]) ||
              this.store.getHistory().some((record) =>
                  record.status === "completed" &&
                  record.sha256 === track.sha256 &&
                  Boolean(record.savedPath)
                )
          }))
        }))
      );
    });

    app.post(
      "/api/studio/packages/:id/review",
      express.json({ limit: "16kb" }),
      async (request, response) => {
        const parsed = studioReviewSchema.safeParse(request.body);
        const current = this.store
          .getProducerPackages()
          .find((item) => item.id === request.params.id);
        if (!parsed.success || !current) {
          response.status(400).json({ error: "This Producer delivery cannot be reviewed." });
          return;
        }
        const next = {
          ...current,
          approvalStatus: parsed.data.status,
          clientNote: parsed.data.note.trim()
        };
        await this.store.upsertProducerPackage(next);
        response.json({ saved: true });
      }
    );

    app.get("/api/studio/packages/:id/tracks/:sha256", async (request, response) => {
      const packageItem = this.store
        .getProducerPackages()
        .find((item) => item.id === request.params.id);
      const track = packageItem?.tracks?.find(
        (item) => item.sha256.toLowerCase() === request.params.sha256.toLowerCase()
      );
      const sourcePath = track ? packageItem?.trackSources?.[track.sha256] : undefined;
      const record = track && !sourcePath
        ? this.store.getHistory().find(
            (item) =>
              item.status === "completed" &&
              item.sha256?.toLowerCase() === track.sha256.toLowerCase() &&
              item.savedPath
          )
        : undefined;
      const previewPath = sourcePath ?? record?.savedPath;
      if (!track || !previewPath || !(await fileExists(previewPath))) {
        response.status(404).json({ error: "A verified source preview is not available." });
        return;
      }
      const offset = Number(request.query.offset ?? 0);
      const length = Math.min(Number(request.query.length ?? 4 * 1024 * 1024), 4 * 1024 * 1024);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= track.size || length <= 0) {
        response.status(400).json({ error: "Invalid Studio preview range." });
        return;
      }
      const handle = await open(previewPath, "r");
      try {
        const buffer = Buffer.alloc(Math.min(length, track.size - offset));
        const result = await handle.read(buffer, 0, buffer.length, offset);
        const encrypted = encryptTransferChunk(
          this.store.getTransferSecret(),
          `studio:${packageItem!.id}:${track.sha256}`,
          offset,
          buffer.subarray(0, result.bytesRead)
        );
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("X-PocketDock-IV", encrypted.iv);
        response.setHeader("X-PocketDock-Plain-Length", result.bytesRead.toString());
        response.send(encrypted.payload);
      } finally {
        await handle.close();
      }
    });

    app.get("/api/drive/file", async (request, response) => {
      if (!this.productivityService) {
        response.status(503).json({ error: "PocketDock Drive is not ready." });
        return;
      }
      try {
        const relativePath = String(request.query.path ?? "");
        const filePath = await this.productivityService.driveFilePath(relativePath);
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("Drive file not found.");
        const offset = Number(request.query.offset ?? 0);
        const length = Math.min(Number(request.query.length ?? 4 * 1024 * 1024), 4 * 1024 * 1024);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= info.size || length <= 0) {
          response.status(400).json({ error: "Invalid Drive download range." });
          return;
        }
        const handle = await open(filePath, "r");
        try {
          const buffer = Buffer.alloc(Math.min(length, info.size - offset));
          const result = await handle.read(buffer, 0, buffer.length, offset);
          const encrypted = encryptTransferChunk(
            this.store.getTransferSecret(),
            `drive:${relativePath}`,
            offset,
            buffer.subarray(0, result.bytesRead)
          );
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("X-PocketDock-IV", encrypted.iv);
          response.setHeader("X-PocketDock-Plain-Length", result.bytesRead.toString());
          response.send(encrypted.payload);
        } finally {
          await handle.close();
        }
      } catch (error) {
        response.status(404).json({ error: formatError(error) });
      }
    });

    app.post("/api/drive/folder", express.json({ limit: "32kb" }), async (request, response) => {
      if (!this.productivityService || !this.permission(response, "fileProvider")) {
        response.status(403).json({ error: "Drive changes are disabled for this device." });
        return;
      }
      if (request.headers["x-pocketdock-remote"] === "1" && this.settings.remoteApprovalRequired) {
        response.status(409).json({ error: "Relay-based Drive changes are blocked by PC policy." });
        return;
      }
      try {
        await this.productivityService.createFolder(String(request.body?.path ?? ""));
        response.status(201).json({ created: true });
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.post("/api/drive/rename", express.json({ limit: "32kb" }), async (request, response) => {
      if (!this.productivityService || !this.permission(response, "fileProvider")) {
        response.status(403).json({ error: "Drive changes are disabled for this device." });
        return;
      }
      if (request.headers["x-pocketdock-remote"] === "1" && this.settings.remoteApprovalRequired) {
        response.status(409).json({ error: "Relay-based Drive changes are blocked by PC policy." });
        return;
      }
      try {
        await this.productivityService.renameEntry(
          String(request.body?.path ?? ""),
          String(request.body?.name ?? "")
        );
        response.json({ renamed: true });
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.post("/api/drive/archive", express.json({ limit: "32kb" }), async (request, response) => {
      if (!this.productivityService || !this.permission(response, "fileProvider")) {
        response.status(403).json({ error: "Drive changes are disabled for this device." });
        return;
      }
      if (request.headers["x-pocketdock-remote"] === "1" && this.settings.remoteApprovalRequired) {
        response.status(409).json({ error: "Relay-based Drive changes are blocked by PC policy." });
        return;
      }
      try {
        await this.productivityService.archiveEntry(String(request.body?.path ?? ""));
        response.json({ archived: true });
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.get("/api/sync/profiles", (_request, response) => {
      response.json(
        this.store
          .getSyncProfiles()
          .filter((profile) => profile.enabled)
          .map(({ localDirectory: _localDirectory, ...profile }) => profile)
      );
    });

    app.get("/api/sync/:id/manifest", async (request, response) => {
      try {
        response.json(await this.syncService.run(request.params.id));
      } catch (error) {
        response.status(404).json({ error: formatError(error) });
      }
    });

    app.get("/api/sync/:id/file", async (request, response) => {
      try {
        const relativePath = String(request.query.path ?? "");
        const filePath = await this.syncService.localFilePath(request.params.id, relativePath);
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("Sync file not found.");
        const offset = Number(request.query.offset ?? 0);
        const length = Math.min(Number(request.query.length ?? 4 * 1024 * 1024), 4 * 1024 * 1024);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= info.size ||
          !Number.isSafeInteger(length) ||
          length <= 0
        ) {
          response.status(400).json({ error: "Invalid sync range." });
          return;
        }
        const handle = await open(filePath, "r");
        try {
          const buffer = Buffer.alloc(Math.min(length, info.size - offset));
          const result = await handle.read(buffer, 0, buffer.length, offset);
          const identifier = `sync:${request.params.id}:${relativePath}`;
          const encrypted = encryptTransferChunk(
            this.store.getTransferSecret(),
            identifier,
            offset,
            buffer.subarray(0, result.bytesRead)
          );
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("X-PocketDock-IV", encrypted.iv);
          response.setHeader("X-PocketDock-Plain-Length", result.bytesRead.toString());
          response.send(encrypted.payload);
        } finally {
          await handle.close();
        }
      } catch (error) {
        response.status(404).json({ error: formatError(error) });
      }
    });

    app.post(
      "/api/sync/:id/archive",
      express.json({ limit: "1mb" }),
      async (request, response) => {
        const paths = z.array(z.string().max(4_096)).max(10_000).safeParse(request.body?.paths);
        if (!paths.success) {
          response.status(400).json({ error: "Invalid sync deletion list." });
          return;
        }
        try {
          await this.syncService.archiveDeleted(request.params.id, paths.data);
          response.json({ archived: paths.data.length });
        } catch (error) {
          response.status(400).json({ error: formatError(error) });
        }
      }
    );

    app.post("/api/uploads", express.json({ limit: "32kb" }), async (request, response) => {
      const parsed = uploadStartSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "The selected file has invalid details." });
        return;
      }
      if (this.settings.encryptTransfers && !parsed.data.encrypted) {
        response.status(426).json({
          code: "ENCRYPTION_REQUIRED",
          error: "Rescan PocketDock to start an encrypted transfer."
        });
        return;
      }

      const session = response.locals.session as SessionInfo;
      if (parsed.data.syncProfileId && !this.permission(response, "automaticBackup")) {
        response.status(403).json({
          error: "Automatic backup permission is disabled for this device."
        });
        return;
      }
      try {
        const storage = await this.getStorageInfo();
        if (storage && parsed.data.size > Math.max(0, storage.free - 16 * 1024 * 1024)) {
          response.status(507).json({
            code: "NOT_ENOUGH_SPACE",
            error: "This PC does not have enough free space for that file."
          });
          return;
        }
        const relativeDirectory = path.dirname(parsed.data.relativePath);
        const originalRelative = relativeDirectory === "." ? "" : relativeDirectory;
        const organizedRelative = this.organizedDirectory(
          parsed.data.name,
          parsed.data.type,
          parsed.data.lastModified,
          session.deviceName,
          originalRelative
        );
        const fingerprint = crypto
          .createHash("sha256")
          .update(
            [
              session.deviceId,
              parsed.data.name,
              parsed.data.size,
              parsed.data.lastModified,
              originalRelative
            ].join("\u0000")
          )
          .digest("hex");
        const existing = [...this.uploads.values()].find(
          (upload) => upload.fingerprint === fingerprint && upload.size === parsed.data.size
        );
        if (existing) {
          response.json({
            id: existing.id,
            offset: existing.received,
            resumed: true,
            paused: existing.paused
          });
          return;
        }

        const destinationRoot = parsed.data.syncProfileId
          ? await this.syncService.incomingDestination(parsed.data.syncProfileId, "")
          : this.settings.destinationDirectory;
        const destination = await resolveDestinationPath(
          destinationRoot,
          parsed.data.name,
          organizedRelative,
          this.settings.conflictPolicy
        );
        if (destination.skipped) {
          response.status(409).json({ code: "EXISTS", error: "A file with that name already exists." });
          return;
        }

        const id = crypto.randomUUID();
        const upload: PendingUpload = {
          id,
          fingerprint,
          fileName: sanitizeFileName(parsed.data.name),
          size: parsed.data.size,
          mimeType: parsed.data.type || "application/octet-stream",
          lastModified: parsed.data.lastModified,
          relativeDirectory: organizedRelative,
          sourceDevice: session.deviceName,
          deviceId: session.deviceId,
          syncProfileId: parsed.data.syncProfileId,
          createdAt: new Date().toISOString(),
          received: 0,
          encrypted: parsed.data.encrypted,
          protocolVersion: parsed.data.protocolVersion,
          paused: false,
          speedBytesPerSecond: 0,
          conflictPolicy: this.settings.conflictPolicy,
          tempPath: path.join(this.stagingDirectory, `${id}.part`),
          finalPath: destination.finalPath,
          metaPath: path.join(this.stagingDirectory, `${id}.json`)
        };
        await writeFile(upload.tempPath, new Uint8Array());
        await this.saveUpload(upload);
        this.uploads.set(id, upload);
        await this.store.upsertTransfer(this.toRecord(upload, "active"));
        this.emit({ type: "upload-started", payload: this.toActiveTransfer(upload) });
        response.status(201).json({ id, offset: 0, resumed: false });
      } catch (error) {
        response.status(500).json({ error: formatError(error) });
      }
    });

    app.get("/api/uploads/:id", (request, response) => {
      const upload = this.uploads.get(request.params.id);
      if (!upload) {
        response.status(404).json({ error: "Transfer not found." });
        return;
      }
      response.json({
        id: upload.id,
        offset: upload.received,
        size: upload.size,
        paused: upload.paused,
        readyForVerification: upload.received === upload.size
      });
    });

    app.put("/api/uploads/:id", async (request, response) => {
      const upload = this.uploads.get(request.params.id);
      if (!upload) {
        response.status(404).json({ error: "Transfer not found." });
        return;
      }
      if (upload.paused) {
        response.status(423).json({ code: "PAUSED", error: "Transfer is paused on the PC." });
        return;
      }
      if (this.writingUploads.has(upload.id)) {
        response.setHeader("Retry-After", "1");
        response.status(409).json({
          code: "CHUNK_IN_PROGRESS",
          error: "Another chunk is already being written for this transfer."
        });
        return;
      }
      if (this.writingUploads.size >= this.settings.maxConcurrentUploads) {
        response.setHeader("Retry-After", "1");
        response.status(429).json({ code: "QUEUE_BUSY", error: "The PC transfer queue is full." });
        return;
      }
      const requestedOffset = Number(request.query.offset);
      if (!Number.isSafeInteger(requestedOffset) || requestedOffset !== upload.received) {
        response.status(409).json({
          code: "OFFSET_MISMATCH",
          expectedOffset: upload.received,
          error: "Transfer offset changed."
        });
        return;
      }
      const declaredLength = Number(request.headers["content-length"] ?? 0);
      const plainLength = upload.encrypted
        ? Number(request.headers["x-pocketdock-plain-length"] ?? 0)
        : declaredLength;
      const maximumBody = 8 * 1024 * 1024 + (upload.encrypted ? 16 : 0);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength <= 0 ||
        declaredLength > maximumBody ||
        !Number.isSafeInteger(plainLength) ||
        plainLength <= 0 ||
        plainLength > 8 * 1024 * 1024
      ) {
        response.status(413).json({ error: "Chunk must be between 1 byte and 8 MB." });
        return;
      }
      if (upload.received + plainLength > upload.size) {
        response.status(413).json({ error: "Chunk is larger than the remaining file." });
        return;
      }

      this.writingUploads.add(upload.id);
      const started = Date.now();
      try {
        const payload = await readRequestBody(request, maximumBody);
        const plaintext = upload.encrypted
          ? decryptTransferChunk(
              this.store.getTransferSecret(),
              upload.id,
              upload.received,
              plainLength,
              String(request.headers["x-pocketdock-iv"] ?? ""),
              payload
            )
          : payload;
        await appendFile(upload.tempPath, plaintext);
        upload.received = await getFileSize(upload.tempPath);
        const elapsedSeconds = Math.max(0.001, (Date.now() - new Date(upload.createdAt).getTime()) / 1000);
        upload.speedBytesPerSecond = upload.received / elapsedSeconds;
        await this.saveUpload(upload);
        this.emit({ type: "upload-progress", payload: this.toActiveTransfer(upload) });

        if (this.settings.bandwidthLimitMbps > 0) {
          const expectedMilliseconds =
            (plaintext.length * 8 * 1000) / (this.settings.bandwidthLimitMbps * 1_000_000);
          const remaining = expectedMilliseconds - (Date.now() - started);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        }

        if (upload.protocolVersion < 2 && upload.received === upload.size) {
          const hash = await sha256File(upload.tempPath);
          await this.finalizeUpload(upload, hash);
        }
        response.json({
          id: upload.id,
          offset: upload.received,
          readyForVerification: upload.received === upload.size
        });
      } catch (error) {
        upload.received = await getFileSize(upload.tempPath).catch(() => upload.received);
        await this.saveUpload(upload).catch(() => undefined);
        response.status(500).json({ error: formatError(error), expectedOffset: upload.received });
      } finally {
        this.writingUploads.delete(upload.id);
      }
    });

    app.post(
      "/api/uploads/:id/complete",
      express.json({ limit: "8kb" }),
      async (request, response) => {
        const upload = this.uploads.get(request.params.id);
        if (!upload) {
          response.status(404).json({ error: "Transfer not found." });
          return;
        }
        if (upload.received !== upload.size) {
          response.status(409).json({
            code: "INCOMPLETE",
            expectedOffset: upload.received,
            error: "The file has not fully arrived."
          });
          return;
        }
        const parsed = completeUploadSchema.safeParse(request.body);
        if (!parsed.success || (this.settings.verifyIntegrity && !parsed.data.sha256)) {
          response.status(400).json({ error: "A SHA-256 verification hash is required." });
          return;
        }
        try {
          const serverHash = await sha256File(upload.tempPath);
          if (parsed.data.sha256 && !secureHexEqual(serverHash, parsed.data.sha256)) {
            response.status(422).json({
              code: "HASH_MISMATCH",
              expectedOffset: 0,
              error: "Integrity verification failed. Retry the transfer."
            });
            return;
          }
          const duplicate =
            this.settings.duplicatePolicy === "skip-identical"
              ? this.store.findTransferByHash(serverHash, upload.size)
              : null;
          if (
            duplicate?.savedPath &&
            (await this.fileMatchesHash(duplicate.savedPath, serverHash))
          ) {
            await Promise.all([
              rm(upload.tempPath, { force: true }),
              rm(upload.metaPath, { force: true })
            ]);
            this.uploads.delete(upload.id);
            await this.store.upsertTransfer({
              ...this.toRecord(upload, "completed"),
              savedPath: duplicate.savedPath,
              sha256: serverHash,
              verified: true,
              duplicateOf: duplicate.id
            });
            this.emit({
              type: "upload-completed",
              payload: {
                ...this.toActiveTransfer(upload),
                savedPath: duplicate.savedPath,
                duplicate: true
              }
            });
            response.json({
              complete: true,
              duplicate: true,
              sha256: serverHash,
              savedAs: path.basename(duplicate.savedPath)
            });
            return;
          }
          const finalPath = await this.finalizeUpload(upload, serverHash);
          response.json({
            complete: true,
            duplicate: false,
            sha256: serverHash,
            savedAs: path.basename(finalPath)
          });
        } catch (error) {
          response.status(500).json({ error: formatError(error) });
        }
      }
    );

    app.post("/api/uploads/:id/pause", async (request, response) => {
      await this.pauseTransfer(request.params.id);
      response.status(204).end();
    });

    app.post("/api/uploads/:id/resume", async (request, response) => {
      await this.resumeTransfer(request.params.id);
      response.status(204).end();
    });

    app.delete("/api/uploads/:id", async (request, response) => {
      await this.cancelTransfer(request.params.id);
      response.status(204).end();
    });

    app.get("/api/shares", async (_request, response) => {
      const available: SharedFile[] = [];
      for (const file of this.getSharedFiles()) {
        if (await fileExists(file.path)) available.push(file);
      }
      if (available.length !== this.getSharedFiles().length) {
        await this.store.setSharedFiles(available);
      }
      response.json(
        available.map(({ id, name, size, mimeType, createdAt, sha256 }) => ({
          id,
          name,
          size,
          mimeType,
          createdAt,
          sha256,
          encrypted: this.settings.encryptTransfers,
          chunkUrl: `/api/shares/${id}/chunk`,
          downloadUrl: this.settings.encryptTransfers ? null : `/api/shares/${id}/download`
        }))
      );
    });

    app.get("/api/shares/:id/chunk", async (request, response) => {
      const file = this.getSharedFiles().find((entry) => entry.id === request.params.id);
      if (!file || !(await fileExists(file.path))) {
        response.status(404).json({ error: "This shared file is no longer available." });
        return;
      }
      const offset = Number(request.query.offset ?? 0);
      const length = Math.min(Number(request.query.length ?? 4 * 1024 * 1024), 4 * 1024 * 1024);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size || !Number.isSafeInteger(length) || length <= 0) {
        response.status(400).json({ error: "Invalid download range." });
        return;
      }
      const handle = await open(file.path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(length, file.size - offset));
        const result = await handle.read(buffer, 0, buffer.length, offset);
        const plaintext = buffer.subarray(0, result.bytesRead);
        const encrypted = encryptTransferChunk(
          this.store.getTransferSecret(),
          file.id,
          offset,
          plaintext
        );
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", encrypted.payload.length.toString());
        response.setHeader("X-PocketDock-IV", encrypted.iv);
        response.setHeader("X-PocketDock-Plain-Length", plaintext.length.toString());
        response.send(encrypted.payload);
      } finally {
        await handle.close();
      }
    });

    app.post("/api/shares/:id/complete", async (_request, response) => {
      const file = this.getSharedFiles().find((entry) => entry.id === _request.params.id);
      if (!file) {
        response.status(404).json({ error: "Shared file not found." });
        return;
      }
      const session = response.locals.session as SessionInfo;
      const record: TransferRecord = {
        id: crypto.randomUUID(),
        fileName: file.name,
        size: file.size,
        mimeType: file.mimeType,
        direction: "pc-to-iphone",
        status: "completed",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sourceDevice: session.deviceName,
        sha256: file.sha256,
        verified: Boolean(file.sha256)
      };
      await this.store.upsertTransfer(record);
      this.emit({ type: "upload-completed", payload: { ...record, direction: "pc-to-iphone" } });
      response.json({ complete: true });
    });

    app.get("/api/shares/:id/download", async (request, response) => {
      if (this.settings.encryptTransfers) {
        response.status(426).json({ error: "Use the encrypted PocketDock download button." });
        return;
      }
      const file = this.getSharedFiles().find((entry) => entry.id === request.params.id);
      if (!file || !(await fileExists(file.path))) {
        response.status(404).json({ error: "This shared file is no longer available." });
        return;
      }
      response.setHeader("Content-Disposition", contentDispositionFileName(file.name));
      response.setHeader("Content-Type", file.mimeType);
      response.setHeader("Content-Length", file.size.toString());
      createReadStream(file.path).pipe(response);
    });

    app.get("/api/clipboard", (_request, response) => {
      if (!this.settings.clipboardSharing) {
        response.status(403).json({ error: "Clipboard sharing is disabled." });
        return;
      }
      const session = response.locals.session as SessionInfo;
      const plaintext = Buffer.from(JSON.stringify(this.store.getClipboardEntries()), "utf8");
      const encrypted = encryptTransferChunk(
        this.store.getTransferSecret(),
        `clipboard:${session.deviceId}`,
        0,
        plaintext
      );
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("X-PocketDock-IV", encrypted.iv);
      response.setHeader("X-PocketDock-Plain-Length", plaintext.length.toString());
      response.send(encrypted.payload);
    });

    app.post("/api/clipboard", async (request, response) => {
      if (!this.settings.clipboardSharing) {
        response.status(403).json({ error: "Clipboard sharing is disabled." });
        return;
      }
      const session = response.locals.session as SessionInfo;
      try {
        const body = await readRequestBody(request, 300_016);
        const plainLength = Number(request.headers["x-pocketdock-plain-length"] ?? 0);
        const plaintext = decryptTransferChunk(
          this.store.getTransferSecret(),
          `clipboard:${session.deviceId}`,
          0,
          plainLength,
          String(request.headers["x-pocketdock-iv"] ?? ""),
          body
        );
        const parsed = clipboardSchema.safeParse(JSON.parse(plaintext.toString("utf8")));
        if (!parsed.success) {
          response.status(400).json({ error: "Clipboard content is invalid." });
          return;
        }
        const entry = await this.addClipboardEntry(
          parsed.data.content,
          session.deviceName,
          parsed.data
        );
        if (!entry) {
          response.status(400).json({ error: "Clipboard content cannot be empty." });
          return;
        }
        response.status(201).json({ saved: true });
      } catch (error) {
        response.status(400).json({ error: formatError(error) });
      }
    });

    app.patch(
      "/api/clipboard/:id",
      express.json({ limit: "16kb" }),
      async (request, response) => {
        const parsed = clipboardUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: "Clipboard update is invalid." });
          return;
        }
        const update: { pinned: boolean; expiresAt?: string | null } = {
          pinned: parsed.data.pinned
        };
        if (parsed.data.expiresMinutes !== undefined) {
          update.expiresAt = parsed.data.expiresMinutes
            ? new Date(Date.now() + parsed.data.expiresMinutes * 60_000).toISOString()
            : null;
        }
        const next = await this.store.updateClipboardEntry(request.params.id, update);
        if (!next) {
          response.status(404).json({ error: "Clipboard entry not found." });
          return;
        }
        this.emit({ type: "clipboard-updated", payload: next });
        response.json({ saved: true });
      }
    );

    app.delete("/api/clipboard/:id", async (request, response) => {
      await this.store.removeClipboardEntry(request.params.id);
      this.emit({ type: "clipboard-updated", payload: { id: request.params.id, removed: true } });
      response.status(204).end();
    });

    app.use(
      express.static(this.mobileDirectory, {
        etag: false,
        lastModified: false,
        setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
      })
    );
    app.use((_request, response) => response.status(404).json({ error: "Not found." }));
    app.use(
      (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
        response.status(500).json({ error: formatError(error) });
      }
    );
    return app;
  }

  private authenticate(request: Request, response: Response, next: NextFunction): void {
    const session = this.pairing.validate(getBearer(request) ?? getCookie(request, "pd_session"));
    if (!session) {
      response.status(401).json({ error: "Pair this iPhone again to continue." });
      return;
    }
    const trusted = this.store
      .getTrustedDevices()
      .find((device) => device.id === session.deviceId);
    if (trusted?.revoked) {
      this.pairing.revokeDevice(session.deviceId);
      response.status(401).json({ error: "This device has been revoked." });
      return;
    }
    response.locals.session = session;
    response.locals.permissions = trusted?.permissions ?? defaultDevicePermissions();
    if (
      request.headers["x-pocketdock-remote"] === "1" &&
      !this.permission(response, "remoteAccess")
    ) {
      response.status(403).json({
        error: "Remote access is disabled for this device. Enable it on the PocketDock PC."
      });
      return;
    }
    next();
  }

  private permission(
    response: Response,
    permission: keyof DevicePermissions
  ): boolean {
    const permissions = response.locals.permissions as DevicePermissions | undefined;
    return Boolean((permissions ?? defaultDevicePermissions())[permission]);
  }

  private validatePrivateLink(request: Request): PrivateShareLink | null {
    const link = this.store
      .getPrivateShareLinks()
      .find((entry) => entry.id === request.params.id);
    const token = String(request.headers["x-pocketdock-link-token"] ?? "");
    if (
      !link ||
      link.revoked ||
      new Date(link.expiresAt).getTime() <= Date.now() ||
      link.downloads >= link.maxDownloads ||
      !token ||
      !secureHexEqual(link.tokenHash, hashSecret(token))
    ) {
      return null;
    }
    return link;
  }

  private validateFileRequest(request: Request): FileRequest | null {
    const fileRequest = this.store
      .getFileRequests()
      .find((entry) => entry.id === request.params.id);
    const token = String(request.headers["x-pocketdock-request-token"] ?? "");
    if (
      !fileRequest ||
      fileRequest.revoked ||
      new Date(fileRequest.expiresAt).getTime() <= Date.now() ||
      fileRequest.receivedCount >= fileRequest.maxFiles ||
      !token ||
      !secureHexEqual(fileRequest.tokenHash, hashSecret(token))
    ) {
      return null;
    }
    return fileRequest;
  }

  private reserveFileRequestSlot(fileRequest: FileRequest): boolean {
    const reserved = this.fileRequestReservations.get(fileRequest.id) ?? 0;
    if (fileRequest.receivedCount + reserved >= fileRequest.maxFiles) return false;
    this.fileRequestReservations.set(fileRequest.id, reserved + 1);
    return true;
  }

  private releaseFileRequestSlot(id: string): void {
    const reserved = this.fileRequestReservations.get(id) ?? 0;
    if (reserved <= 1) {
      this.fileRequestReservations.delete(id);
      return;
    }
    this.fileRequestReservations.set(id, reserved - 1);
  }

  private async fileMatchesHash(filePath: string, expectedHash: string): Promise<boolean> {
    try {
      return secureHexEqual(await sha256File(filePath), expectedHash);
    } catch {
      return false;
    }
  }

  private privateLinkToken(id: string): string {
    return crypto
      .createHmac("sha256", Buffer.from(this.store.getTransferSecret(), "base64url"))
      .update(`private-link-token:${id}`)
      .digest("base64url");
  }

  private privateLinkKey(id: string): string {
    return crypto
      .createHmac("sha256", Buffer.from(this.store.getTransferSecret(), "base64url"))
      .update(`private-link-key:${id}`)
      .digest()
      .subarray(0, 32)
      .toString("base64url");
  }

  private fileRequestToken(id: string): string {
    return crypto
      .createHmac("sha256", Buffer.from(this.store.getTransferSecret(), "base64url"))
      .update(`file-request-token:${id}`)
      .digest("base64url");
  }

  private fileRequestUrl(id: string): string | undefined {
    const baseUrl = this.localBaseUrl();
    if (!baseUrl) return undefined;
    const fragment = new URLSearchParams({ token: this.fileRequestToken(id) });
    return `${baseUrl}request.html?id=${encodeURIComponent(id)}#${fragment.toString()}`;
  }

  private privateShareUrl(id: string): string | undefined {
    const baseUrl = this.localBaseUrl();
    if (!baseUrl) return undefined;
    const fragment = new URLSearchParams({
      token: this.privateLinkToken(id),
      key: this.privateLinkKey(id)
    });
    return `${baseUrl}share.html?id=${encodeURIComponent(id)}#${fragment.toString()}`;
  }

  private localBaseUrl(): string | null {
    const address = getLanAddresses()[0];
    return address && this.actualPort ? `http://${address}:${this.actualPort}/` : null;
  }

  private setSessionCookie(response: Response, token: string): void {
    response.setHeader(
      "Set-Cookie",
      `pd_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
    );
  }

  private async recordFileRequestTransfer(upload: FileRequestUpload): Promise<void> {
    const now = new Date().toISOString();
    await this.store.upsertTransfer({
      id: upload.id,
      fileName: upload.fileName,
      size: upload.size,
      mimeType: upload.mimeType,
      direction: "iphone-to-pc",
      status: "completed",
      createdAt: upload.receivedAt,
      completedAt: now,
      sourceDevice: "PocketDock File Request",
      savedPath: upload.savedPath,
      sha256: upload.sha256,
      verified: true,
      tags: ["file request"]
    });
  }

  private organizedDirectory(
    fileName: string,
    mimeType: string,
    lastModified: number,
    deviceName: string,
    originalRelative: string
  ): string {
    if (originalRelative) return sanitizeRelativeDirectory(originalRelative);
    if (this.settings.organizeMode === "date") {
      const date = lastModified ? new Date(lastModified) : new Date();
      return path.join(String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"));
    }
    if (this.settings.organizeMode === "type") return fileCategory(fileName, mimeType);
    if (this.settings.organizeMode === "device") return sanitizeFileName(deviceName);
    if (this.settings.organizeMode === "rules") {
      const rule = matchingRule(this.store.getAutomationRules(), fileName, mimeType);
      return rule ? sanitizeRelativeDirectory(rule.destinationSubfolder) : "";
    }
    return "";
  }

  private async finalizeUpload(upload: PendingUpload, sha256: string): Promise<string> {
    try {
      let finalPath = upload.finalPath;
      const conflictPolicy = upload.conflictPolicy ?? this.settings.conflictPolicy;
      if (conflictPolicy === "rename" && (await fileExists(finalPath))) {
        finalPath = await uniqueFilePath(finalPath);
      }
      await ensureDirectory(path.dirname(finalPath));
      if (conflictPolicy === "replace" && (await fileExists(finalPath))) {
        const backupPath = `${finalPath}.pocketdock-backup-${upload.id}`;
        await rename(finalPath, backupPath);
        try {
          await rename(upload.tempPath, finalPath);
          await rm(backupPath, { force: true });
        } catch (error) {
          if (await fileExists(backupPath)) await rename(backupPath, finalPath);
          throw error;
        }
      } else {
        try {
          await rename(upload.tempPath, finalPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(upload.tempPath, finalPath);
          await rm(upload.tempPath, { force: true });
        }
      }

      upload.finalPath = finalPath;
      await rm(upload.metaPath, { force: true });
      this.uploads.delete(upload.id);
      const record: TransferRecord = {
        ...this.toRecord(upload, "completed"),
        sha256,
        verified: true
      };
      await this.store.upsertTransfer(record);
      const rule = matchingRule(
        this.store.getAutomationRules(),
        upload.fileName,
        upload.mimeType
      );
      if (rule?.action && rule.action !== "move") {
        try {
          await this.onAutomation(rule, finalPath, record);
        } catch (error) {
          await this.store.updateTransferMetadata(record.id, {
            tags: [...(record.tags ?? []), "automation needs attention"],
            note: `Automation “${rule.name}” could not finish: ${formatError(error)}`
          });
        }
      }
      this.emit({
        type: "upload-completed",
        payload: { ...this.toActiveTransfer(upload), savedPath: finalPath, fileName: upload.fileName }
      });
      return finalPath;
    } catch (error) {
      await this.store.upsertTransfer(this.toRecord(upload, "failed", formatError(error)));
      this.emit({ type: "upload-failed", payload: { id: upload.id, error: formatError(error) } });
      throw error;
    }
  }

  private toRecord(
    upload: PendingUpload,
    status: TransferRecord["status"],
    error?: string
  ): TransferRecord {
    return {
      id: upload.id,
      fileName: upload.fileName,
      size: upload.size,
      mimeType: upload.mimeType,
      direction: "iphone-to-pc",
      status,
      createdAt: upload.createdAt,
      completedAt: status === "active" ? undefined : new Date().toISOString(),
      sourceDevice: upload.sourceDevice,
      savedPath: status === "completed" ? upload.finalPath : undefined,
      averageBytesPerSecond: upload.speedBytesPerSecond,
      relativePath: upload.relativeDirectory,
      error
    };
  }

  private toActiveTransfer(upload: PendingUpload): ActiveTransfer {
    const remaining = Math.max(0, upload.size - upload.received);
    return {
      id: upload.id,
      fileName: upload.fileName,
      size: upload.size,
      received: upload.received,
      sourceDevice: upload.sourceDevice,
      createdAt: upload.createdAt,
      paused: upload.paused,
      encrypted: upload.encrypted,
      speedBytesPerSecond: upload.speedBytesPerSecond,
      etaSeconds:
        upload.speedBytesPerSecond > 0 ? Math.ceil(remaining / upload.speedBytesPerSecond) : null
    };
  }

  private async saveUpload(upload: PendingUpload): Promise<void> {
    const temporaryMetaPath = `${upload.metaPath}.tmp`;
    await writeFile(temporaryMetaPath, JSON.stringify(upload), "utf8");
    await rename(temporaryMetaPath, upload.metaPath);
  }

  private async loadPendingUploads(): Promise<void> {
    const names = await readdir(this.stagingDirectory).catch(() => []);
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const metaPath = path.join(this.stagingDirectory, name);
      try {
        const upload = JSON.parse(await readFile(metaPath, "utf8")) as PendingUpload;
        if (!upload.id || !upload.tempPath || !(await fileExists(upload.tempPath))) {
          await rm(metaPath, { force: true });
          continue;
        }
        upload.received = await getFileSize(upload.tempPath);
        upload.metaPath = metaPath;
        upload.paused ??= false;
        upload.encrypted ??= false;
        upload.protocolVersion ??= 1;
        upload.speedBytesPerSecond ??= 0;
        this.uploads.set(upload.id, upload);
      } catch {
        await rm(metaPath, { force: true });
      }
    }
  }

  private listen(server: http.Server, requestedPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && requestedPort !== 0) {
          server.close();
          const replacement = http.createServer(this.createApp());
          this.server = replacement;
          this.listen(replacement, 0).then(resolve, reject);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine the transfer port."));
          return;
        }
        resolve(address.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, "0.0.0.0");
    });
  }

  private emit(event: TransferEvent): void {
    this.onEvent(event);
  }
}
