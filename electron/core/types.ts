export type ThemePreference = "system" | "light" | "dark";
export type ConflictPolicy = "rename" | "replace" | "skip";
export type TransferDirection = "iphone-to-pc" | "pc-to-iphone";
export type TransferStatus = "active" | "completed" | "failed" | "cancelled";
export type OrganizeMode = "none" | "date" | "type" | "device" | "rules";
export type DuplicatePolicy = "keep" | "skip-identical";
export type RuleMatcher = "all" | "extension" | "mime" | "name-contains";
export type AppLanguage = "system" | "en" | "es";
export type SyncDirection = "iphone-to-pc" | "pc-to-iphone" | "two-way";
export type DeletionPolicy = "ignore" | "archive";
export type WatchFolderMode = "share" | "producer";
export type InterfaceDensity = "compact" | "comfortable" | "spacious";
export type ConnectionStrategy =
  | "automatic"
  | "lan-first"
  | "relay-first"
  /** @deprecated Migrated to automatic. USB is a Camera Roll import capability, not a transport. */
  | "usb-first";
export type AutomationAction = "move" | "tag" | "share" | "vault" | "producer";

export interface DevicePermissions {
  sendToPc: boolean;
  receiveFromPc: boolean;
  clipboard: boolean;
  automaticBackup: boolean;
  remoteAccess: boolean;
  browseFiles: boolean;
  fileProvider: boolean;
  fileRequests: boolean;
}

export interface AppSettings {
  destinationDirectory: string;
  /** Additional user-selected Windows folders included in the desktop music index. */
  customMusicDirectories: string[];
  port: number;
  deviceName: string;
  conflictPolicy: ConflictPolicy;
  maxConcurrentUploads: number;
  showNotifications: boolean;
  runAtLogin: boolean;
  minimizeToTray: boolean;
  keepPairingActive: boolean;
  theme: ThemePreference;
  verifyIntegrity: boolean;
  encryptTransfers: boolean;
  trustedDeviceAutoConnect: boolean;
  duplicatePolicy: DuplicatePolicy;
  organizeMode: OrganizeMode;
  bandwidthLimitMbps: number;
  clipboardSharing: boolean;
  allowUsbImport: boolean;
  autoUpdate: boolean;
  updateFeedUrl: string;
  remoteAccessEnabled: boolean;
  remoteRelayUrl: string;
  language: AppLanguage;
  vaultAutoLockMinutes: number;
  diagnosticsRetentionDays: number;
  pauseBackupOnBattery: boolean;
  pauseBackupOnMeteredNetwork: boolean;
  backgroundServiceEnabled: boolean;
  automaticClipboardSync: boolean;
  backupScheduleEnabled: boolean;
  backupWindowStart: string;
  backupWindowEnd: string;
  backupRetentionDays: number;
  backupWeeklyVersions: number;
  backupMonthlyVersions: number;
  remoteBrowseEnabled: boolean;
  remoteBrowseRoot: string;
  remoteApprovalRequired: boolean;
  connectionStrategy: ConnectionStrategy;
  interfaceDensity: InterfaceDensity;
  interfaceScale: number;
  highContrast: boolean;
}

export interface TransferRecord {
  id: string;
  fileName: string;
  size: number;
  mimeType: string;
  direction: TransferDirection;
  status: TransferStatus;
  createdAt: string;
  completedAt?: string;
  sourceDevice: string;
  savedPath?: string;
  error?: string;
  sha256?: string;
  verified?: boolean;
  averageBytesPerSecond?: number;
  relativePath?: string;
  duplicateOf?: string;
  favorite?: boolean;
  tags?: string[];
  note?: string;
}

export interface TransferMetadataPatch {
  favorite?: boolean;
  tags?: string[];
  note?: string;
}

export interface SharedFile {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  createdAt: string;
  sha256?: string;
  expiresAt?: string;
  source?: "manual" | "watch" | "sync" | "producer";
}

export interface ActiveTransfer {
  id: string;
  fileName: string;
  size: number;
  received: number;
  sourceDevice: string;
  createdAt: string;
  paused: boolean;
  encrypted: boolean;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
}

export interface TrustedDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  lastAddress: string;
  revoked: boolean;
  platform?: "chrome" | "safari" | "edge" | "firefox" | "browser" | "ios" | "unknown";
  permissions: DevicePermissions;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  matcher: RuleMatcher;
  value: string;
  destinationSubfolder: string;
  action?: AutomationAction;
  actionValue?: string;
}

export interface ClipboardEntry {
  id: string;
  kind: "text" | "url" | "image" | "file";
  content: string;
  sourceDevice: string;
  createdAt: string;
  pinned?: boolean;
  expiresAt?: string;
  fileName?: string;
}

export interface UsbDevice {
  id: string;
  name: string;
  status: "connected" | "unavailable";
  description: string;
  diagnosticCode:
    | "dcim-ready"
    | "trust-required"
    | "driver-only"
    | "dcim-missing"
    | "driver-error"
    | "scan-error";
  driverDetected: boolean;
  shellDetected: boolean;
  storageDetected: boolean;
  dcimDetected: boolean;
  recommendedAction: string;
}

export interface MusicLibraryItem {
  /** Opaque, stable identifier. Local filesystem paths never cross the preload boundary. */
  id: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds?: number;
  trackNumber?: number;
  year?: number;
  format: string;
  size: number;
  modifiedAt: string;
  source:
    | "Windows Music"
    | "Windows Documents"
    | "Windows Custom"
    | "PocketDock Received"
    | "Apple Music"
    | "iPhone Music";
  /** Folder relative to the named source root; never an absolute filesystem path. */
  relativeFolder: string;
}

export type PhoneMusicAuthorization =
  | "authorized"
  | "denied"
  | "restricted"
  | "not-determined";

/** Metadata-only MusicKit entry. This never represents transferable audio bytes. */
export interface PhoneMusicTrack {
  externalId: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
  track?: number;
  disc?: number;
  year?: number;
  genre?: string;
  isDownloaded?: boolean;
}

/** Metadata-only MusicKit collection, currently a user-library playlist. */
export interface PhoneMusicCollection {
  externalId: string;
  name: string;
  kind: "playlist" | string;
  itemCount: number;
  /** MusicKit song IDs in playlist order when the entries relationship is available. */
  trackExternalIds: string[];
}

/** An inventory entry for a real file in PocketDock's iPhone Documents container. */
export interface PhoneDocumentFile {
  externalId: string;
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  contentType?: string;
  isAudio?: boolean;
}

export interface PhoneMusicLibrary {
  /** Both identity fields are supplied by the authenticated desktop session. */
  deviceId: string;
  deviceName: string;
  generationId: string;
  /** Persisted logical clock supplied by the native app. */
  generationSequence: number;
  generatedAt: string;
  receivedAt: string;
  authorization: PhoneMusicAuthorization;
  complete: boolean;
  /** Authoritative desktop-derived freshness signal. */
  stale: boolean;
  music: PhoneMusicTrack[];
  collections: PhoneMusicCollection[];
  files: PhoneDocumentFile[];
}

export interface UsbImportResult {
  imported: number;
  skipped: number;
  failed: number;
  bytes: number;
  destination: string;
  failures: string[];
}

export interface SyncProfile {
  id: string;
  name: string;
  localDirectory: string;
  iphoneDirectory: string;
  direction: SyncDirection;
  deletionPolicy: DeletionPolicy;
  enabled: boolean;
  includeExtensions: string[];
  lastRunAt?: string;
  createdAt: string;
}

export interface WatchFolder {
  id: string;
  name: string;
  directory: string;
  mode: WatchFolderMode;
  enabled: boolean;
  recursive: boolean;
  includeExtensions: string[];
  expiresMinutes: number;
  createdAt: string;
  lastScanAt?: string;
}

export interface PrivateShareLink {
  id: string;
  name: string;
  sharedFileIds: string[];
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number;
  downloads: number;
  revoked: boolean;
  allowRelay: boolean;
  url?: string;
}

export interface VaultItem {
  id: string;
  name: string;
  encryptedPath: string;
  size: number;
  mimeType: string;
  sha256: string;
  createdAt: string;
  sourcePath?: string;
}

export interface ProducerPackage {
  id: string;
  title: string;
  artist: string;
  bpm?: number;
  musicalKey?: string;
  notes: string;
  fileCount: number;
  size: number;
  path: string;
  createdAt: string;
  version?: number;
  clientName?: string;
  licenseName?: string;
  approvalStatus?: "draft" | "sent" | "approved" | "changes-requested";
  clientNote?: string;
  portalLinkId?: string;
  downloadCount?: number;
  artwork?: ProducerArtwork;
  tracks?: Array<{
    name: string;
    role: string;
    size: number;
    sha256: string;
  }>;
  /** Local-only source lookup for authenticated Studio previews. Never returned by mobile APIs. */
  trackSources?: Record<string, string>;
}

export interface ProducerArtwork {
  status: "provided" | "embedded" | "matched" | "review" | "not-found";
  source: string;
  confidence: number;
  requestedTitle: string;
  requestedArtist: string;
  matchedTitle?: string;
  matchedArtist?: string;
  releaseGroupId?: string;
  queryVariants: string[];
  matchReason?: string;
}

export interface FileRequest {
  id: string;
  name: string;
  destinationSubfolder: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  maxFileSize: number;
  maxFiles: number;
  receivedCount: number;
  requiresApproval: boolean;
  revoked: boolean;
  url?: string;
}

export interface FileRequestUpload {
  id: string;
  requestId: string;
  fileName: string;
  size: number;
  mimeType: string;
  sha256: string;
  receivedAt: string;
  status: "pending" | "approved" | "rejected";
  pendingPath?: string;
  savedPath?: string;
  sourceAddress?: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  relativePath: string;
  kind: "folder" | "file";
  size: number;
  modifiedAt: string;
  mimeType: string;
}

export interface DuplicateGroup {
  id: string;
  kind: "exact" | "name-and-size";
  label: string;
  reclaimableBytes: number;
  items: Array<{
    transferId: string;
    fileName: string;
    savedPath: string;
    size: number;
    createdAt: string;
  }>;
}

export interface RecoveryIssue {
  id: string;
  kind: "staging" | "missing-file" | "expired-share" | "database" | "destination";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  recoverable: boolean;
}

export interface BackgroundServiceStatus {
  supported: boolean;
  installed: boolean;
  active: boolean;
  detail: string;
}

export interface BackupSnapshot {
  id: string;
  createdAt: string;
  reason: "scheduled" | "manual";
  fileCount: number;
  totalBytes: number;
  uniqueBytes: number;
  entries: Array<{
    fileName: string;
    relativePath: string;
    sourcePath: string;
    objectKey: string;
    sha256: string;
    size: number;
  }>;
}

export interface TransportStatus {
  selected: "lan" | "relay" | "offline";
  strategy: ConnectionStrategy;
  available: Array<"lan" | "relay">;
  reason: string;
}

export interface MusicFileMetadata {
  durationSeconds?: number;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  bpm?: number;
  musicalKey?: string;
}

export interface MediaPreview {
  transferId: string;
  kind: "image" | "video" | "audio" | "gif" | "document" | "other";
  dataUrl?: string;
  waveform?: number[];
  music?: MusicFileMetadata;
}

export interface RemoteStatus {
  configured: boolean;
  connected: boolean;
  waitingForPeer: boolean;
  lastError?: string;
  pairingUrl?: string;
  lastConnectedAt?: string;
  lastPeerAt?: string;
  rejectedReplayCount?: number;
  forwardSecrecyActive?: boolean;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface DiagnosticReport {
  generatedAt: string;
  appVersion: string;
  platform: string;
  checks: DiagnosticCheck[];
  redactedSettings: Partial<AppSettings>;
}

export interface ConnectionInfo {
  running: boolean;
  url: string | null;
  pin: string;
  port: number | null;
  addresses: string[];
  connectedDevices: number;
  encryptionAvailable: boolean;
  trustedDevices: number;
}

export interface StorageInfo {
  total: number;
  free: number;
  used: number;
}

export interface AppSnapshot {
  settings: AppSettings;
  connection: ConnectionInfo;
  history: TransferRecord[];
  activeTransfers: ActiveTransfer[];
  sharedFiles: SharedFile[];
  trustedDevices: TrustedDevice[];
  automationRules: AutomationRule[];
  clipboardEntries: ClipboardEntry[];
  usbDevices: UsbDevice[];
  musicLibrary: MusicLibraryItem[];
  phoneMusicLibraries: PhoneMusicLibrary[];
  syncProfiles: SyncProfile[];
  watchFolders: WatchFolder[];
  privateShareLinks: PrivateShareLink[];
  vaultItems: VaultItem[];
  vaultInitialized: boolean;
  vaultUnlocked: boolean;
  producerPackages: ProducerPackage[];
  fileRequests: FileRequest[];
  fileRequestUploads: FileRequestUpload[];
  duplicateGroups: DuplicateGroup[];
  recoveryIssues: RecoveryIssue[];
  backupSnapshots: BackupSnapshot[];
  backgroundService: BackgroundServiceStatus;
  transportStatus: TransportStatus;
  remoteStatus: RemoteStatus;
  storage: StorageInfo | null;
  version: string;
}

export interface TransferEvent {
  type:
    | "snapshot"
    | "upload-started"
    | "upload-progress"
    | "upload-completed"
    | "upload-failed"
    | "upload-cancelled"
    | "share-updated"
    | "clipboard-updated"
    | "usb-updated"
    | "music-updated"
    | "connection-updated";
  payload?: unknown;
}

export interface PocketDockApi {
  getSnapshot(): Promise<AppSnapshot>;
  getQrCode(): Promise<string>;
  getRemoteQrCode(): Promise<string | null>;
  copyConnectionLink(): Promise<void>;
  refreshPairingCode(): Promise<AppSnapshot>;
  chooseDestination(): Promise<AppSnapshot | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot>;
  shareFiles(expiresMinutes?: number): Promise<AppSnapshot | null>;
  shareDroppedFiles(files: File[], expiresMinutes?: number): Promise<AppSnapshot>;
  removeSharedFile(id: string): Promise<AppSnapshot>;
  clearHistory(): Promise<AppSnapshot>;
  updateTransferMetadata(id: string, patch: TransferMetadataPatch): Promise<AppSnapshot>;
  updateTransfersMetadata(ids: string[], patch: TransferMetadataPatch): Promise<AppSnapshot>;
  addTagToTransfers(ids: string[], tag: string): Promise<AppSnapshot>;
  shareTransfers(ids: string[], expiresMinutes?: number): Promise<AppSnapshot>;
  vaultTransfers(ids: string[]): Promise<AppSnapshot>;
  revealTransfer(id: string): Promise<void>;
  openDestination(): Promise<void>;
  pauseTransfer(id: string): Promise<AppSnapshot>;
  resumeTransfer(id: string): Promise<AppSnapshot>;
  cancelTransfer(id: string): Promise<AppSnapshot>;
  addAutomationRule(rule: Omit<AutomationRule, "id">): Promise<AppSnapshot>;
  removeAutomationRule(id: string): Promise<AppSnapshot>;
  revokeTrustedDevice(id: string): Promise<AppSnapshot>;
  updateTrustedDevicePermissions(
    id: string,
    permissions: DevicePermissions
  ): Promise<AppSnapshot>;
  copyClipboardEntry(id: string): Promise<void>;
  sendClipboardText(content?: string): Promise<AppSnapshot>;
  clearClipboard(): Promise<AppSnapshot>;
  refreshUsbDevices(): Promise<AppSnapshot>;
  refreshMusicLibrary(): Promise<AppSnapshot>;
  addMusicDirectory(): Promise<AppSnapshot | null>;
  removeMusicDirectory(directory: string): Promise<AppSnapshot>;
  revealMusicFile(id: string): Promise<void>;
  /** Returns a session-scoped stream URL for a currently indexed local track. */
  getMusicPlaybackUrl(id: string): Promise<string>;
  /** Returns a session-scoped stream URL for an eligible completed Gallery transfer. */
  getTransferPlaybackUrl(id: string): Promise<string>;
  importUsbPhotos(deviceId: string): Promise<{
    snapshot: AppSnapshot;
    result: UsbImportResult;
  }>;
  openAppleDevices(): Promise<string>;
  installExplorerIntegration(): Promise<boolean>;
  configureFirewall(): Promise<string>;
  checkForUpdates(): Promise<string>;
  addSyncProfile(): Promise<AppSnapshot | null>;
  updateSyncProfile(id: string, patch: Partial<SyncProfile>): Promise<AppSnapshot>;
  removeSyncProfile(id: string): Promise<AppSnapshot>;
  runSyncProfile(id: string): Promise<AppSnapshot>;
  addWatchFolder(): Promise<AppSnapshot | null>;
  updateWatchFolder(id: string, patch: Partial<WatchFolder>): Promise<AppSnapshot>;
  removeWatchFolder(id: string): Promise<AppSnapshot>;
  scanWatchFolders(): Promise<AppSnapshot>;
  createPrivateShareLink(
    name: string,
    sharedFileIds: string[],
    expiresHours: number,
    maxDownloads: number
  ): Promise<AppSnapshot>;
  revokePrivateShareLink(id: string): Promise<AppSnapshot>;
  copyPrivateShareLink(id: string): Promise<void>;
  getPrivateShareQrCode(id: string): Promise<string>;
  savePrivateShareQrCode(id: string): Promise<string>;
  initializeVault(passphrase: string): Promise<AppSnapshot>;
  unlockVault(passphrase: string): Promise<AppSnapshot>;
  lockVault(): Promise<AppSnapshot>;
  addFilesToVault(): Promise<AppSnapshot | null>;
  exportVaultItem(id: string): Promise<boolean>;
  removeVaultItem(id: string): Promise<AppSnapshot>;
  getMediaPreview(transferId: string): Promise<MediaPreview | null>;
  createProducerPackage(details: {
    title: string;
    artist: string;
    bpm?: number;
    musicalKey?: string;
    notes: string;
    clientName?: string;
    licenseName?: string;
  }): Promise<AppSnapshot | null>;
  chooseRemoteBrowseRoot(): Promise<AppSnapshot | null>;
  browseDrive(relativePath?: string): Promise<DriveEntry[]>;
  revealDriveEntry(relativePath: string): Promise<void>;
  createDriveFolder(relativePath: string): Promise<AppSnapshot>;
  renameDriveEntry(relativePath: string, newName: string): Promise<AppSnapshot>;
  archiveDriveEntry(relativePath: string): Promise<AppSnapshot>;
  createFileRequest(details: {
    name: string;
    destinationSubfolder: string;
    expiresHours: number;
    maxFileSize: number;
    maxFiles: number;
    requiresApproval: boolean;
  }): Promise<AppSnapshot>;
  revokeFileRequest(id: string): Promise<AppSnapshot>;
  copyFileRequestLink(id: string): Promise<void>;
  getFileRequestQrCode(id: string): Promise<string>;
  saveFileRequestQrCode(id: string): Promise<string>;
  approveFileRequestUpload(id: string): Promise<AppSnapshot>;
  rejectFileRequestUpload(id: string): Promise<AppSnapshot>;
  refreshDuplicateGroups(): Promise<AppSnapshot>;
  trashDuplicateTransfers(ids: string[]): Promise<{
    snapshot: AppSnapshot;
    trashed: number;
    failed: string[];
  }>;
  refreshRecoveryIssues(): Promise<AppSnapshot>;
  resolveRecoveryIssue(id: string): Promise<AppSnapshot>;
  createBackupSnapshot(): Promise<AppSnapshot>;
  restoreBackupSnapshot(id: string): Promise<AppSnapshot>;
  setBackgroundService(enabled: boolean): Promise<AppSnapshot>;
  rotateRemoteIdentity(): Promise<AppSnapshot>;
  exportDiagnostics(): Promise<string>;
  runDiagnostics(): Promise<DiagnosticReport>;
  setOnboardingComplete(): Promise<void>;
  getOnboardingComplete(): Promise<boolean>;
  onTransferEvent(callback: (event: TransferEvent) => void): () => void;
}
