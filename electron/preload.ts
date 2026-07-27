import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  DevicePermissions,
  PocketDockApi,
  SyncProfile,
  TransferMetadataPatch,
  TransferEvent,
  WatchFolder
} from "./core/types.js";

const api: PocketDockApi = {
  getSnapshot: () => ipcRenderer.invoke("pocketdock:get-snapshot"),
  getQrCode: () => ipcRenderer.invoke("pocketdock:get-qr"),
  getRemoteQrCode: () => ipcRenderer.invoke("pocketdock:get-remote-qr"),
  copyConnectionLink: () => ipcRenderer.invoke("pocketdock:copy-link"),
  refreshPairingCode: () => ipcRenderer.invoke("pocketdock:refresh-pairing"),
  chooseDestination: () => ipcRenderer.invoke("pocketdock:choose-destination"),
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke("pocketdock:update-settings", patch),
  shareFiles: (expiresMinutes = 0) =>
    ipcRenderer.invoke("pocketdock:share-files", expiresMinutes),
  shareDroppedFiles: (files: File[], expiresMinutes = 0) =>
    ipcRenderer.invoke(
      "pocketdock:share-dropped-files",
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
      expiresMinutes
    ),
  removeSharedFile: (id: string) =>
    ipcRenderer.invoke("pocketdock:remove-shared-file", id),
  clearHistory: () => ipcRenderer.invoke("pocketdock:clear-history"),
  updateTransferMetadata: (id: string, patch: TransferMetadataPatch) =>
    ipcRenderer.invoke("pocketdock:update-transfer-metadata", id, patch),
  updateTransfersMetadata: (ids: string[], patch: TransferMetadataPatch) =>
    ipcRenderer.invoke("pocketdock:update-transfers-metadata", ids, patch),
  addTagToTransfers: (ids: string[], tag: string) =>
    ipcRenderer.invoke("pocketdock:add-tag-to-transfers", ids, tag),
  shareTransfers: (ids: string[], expiresMinutes = 0) =>
    ipcRenderer.invoke("pocketdock:share-transfers", ids, expiresMinutes),
  vaultTransfers: (ids: string[]) =>
    ipcRenderer.invoke("pocketdock:vault-transfers", ids),
  revealTransfer: (id: string) => ipcRenderer.invoke("pocketdock:reveal-transfer", id),
  openDestination: () => ipcRenderer.invoke("pocketdock:open-destination"),
  pauseTransfer: (id: string) => ipcRenderer.invoke("pocketdock:pause-transfer", id),
  resumeTransfer: (id: string) => ipcRenderer.invoke("pocketdock:resume-transfer", id),
  cancelTransfer: (id: string) => ipcRenderer.invoke("pocketdock:cancel-transfer", id),
  addAutomationRule: (rule) =>
    ipcRenderer.invoke("pocketdock:add-automation-rule", rule),
  removeAutomationRule: (id: string) =>
    ipcRenderer.invoke("pocketdock:remove-automation-rule", id),
  revokeTrustedDevice: (id: string) =>
    ipcRenderer.invoke("pocketdock:revoke-trusted-device", id),
  updateTrustedDevicePermissions: (id: string, permissions: DevicePermissions) =>
    ipcRenderer.invoke("pocketdock:update-trusted-device-permissions", id, permissions),
  copyClipboardEntry: (id: string) =>
    ipcRenderer.invoke("pocketdock:copy-clipboard-entry", id),
  sendClipboardText: (content?: string) =>
    ipcRenderer.invoke("pocketdock:send-clipboard-text", content),
  clearClipboard: () => ipcRenderer.invoke("pocketdock:clear-clipboard"),
  refreshUsbDevices: () => ipcRenderer.invoke("pocketdock:refresh-usb-devices"),
  refreshMusicLibrary: () => ipcRenderer.invoke("pocketdock:refresh-music-library"),
  addMusicDirectory: () => ipcRenderer.invoke("pocketdock:add-music-directory"),
  removeMusicDirectory: (directory: string) =>
    ipcRenderer.invoke("pocketdock:remove-music-directory", directory),
  revealMusicFile: (id: string) => ipcRenderer.invoke("pocketdock:reveal-music-file", id),
  getMusicPlaybackUrl: (id: string) =>
    ipcRenderer.invoke("pocketdock:get-music-playback-url", id),
  getTransferPlaybackUrl: (id: string) =>
    ipcRenderer.invoke("pocketdock:get-transfer-playback-url", id),
  importUsbPhotos: (deviceId: string) =>
    ipcRenderer.invoke("pocketdock:import-usb-photos", deviceId),
  openAppleDevices: () => ipcRenderer.invoke("pocketdock:open-apple-devices"),
  installExplorerIntegration: () =>
    ipcRenderer.invoke("pocketdock:install-explorer-integration"),
  configureFirewall: () => ipcRenderer.invoke("pocketdock:configure-firewall"),
  checkForUpdates: () => ipcRenderer.invoke("pocketdock:check-for-updates"),
  addSyncProfile: () => ipcRenderer.invoke("pocketdock:add-sync-profile"),
  updateSyncProfile: (id: string, patch: Partial<SyncProfile>) =>
    ipcRenderer.invoke("pocketdock:update-sync-profile", id, patch),
  removeSyncProfile: (id: string) =>
    ipcRenderer.invoke("pocketdock:remove-sync-profile", id),
  runSyncProfile: (id: string) =>
    ipcRenderer.invoke("pocketdock:run-sync-profile", id),
  addWatchFolder: () => ipcRenderer.invoke("pocketdock:add-watch-folder"),
  updateWatchFolder: (id: string, patch: Partial<WatchFolder>) =>
    ipcRenderer.invoke("pocketdock:update-watch-folder", id, patch),
  removeWatchFolder: (id: string) =>
    ipcRenderer.invoke("pocketdock:remove-watch-folder", id),
  scanWatchFolders: () => ipcRenderer.invoke("pocketdock:scan-watch-folders"),
  createPrivateShareLink: (
    name: string,
    sharedFileIds: string[],
    expiresHours: number,
    maxDownloads: number
  ) =>
    ipcRenderer.invoke(
      "pocketdock:create-private-share-link",
      name,
      sharedFileIds,
      expiresHours,
      maxDownloads
    ),
  revokePrivateShareLink: (id: string) =>
    ipcRenderer.invoke("pocketdock:revoke-private-share-link", id),
  copyPrivateShareLink: (id: string) =>
    ipcRenderer.invoke("pocketdock:copy-private-share-link", id),
  getPrivateShareQrCode: (id: string) =>
    ipcRenderer.invoke("pocketdock:get-private-share-qr", id),
  savePrivateShareQrCode: (id: string) =>
    ipcRenderer.invoke("pocketdock:save-private-share-qr", id),
  initializeVault: (passphrase: string) =>
    ipcRenderer.invoke("pocketdock:initialize-vault", passphrase),
  unlockVault: (passphrase: string) =>
    ipcRenderer.invoke("pocketdock:unlock-vault", passphrase),
  lockVault: () => ipcRenderer.invoke("pocketdock:lock-vault"),
  addFilesToVault: () => ipcRenderer.invoke("pocketdock:add-files-to-vault"),
  exportVaultItem: (id: string) =>
    ipcRenderer.invoke("pocketdock:export-vault-item", id),
  removeVaultItem: (id: string) =>
    ipcRenderer.invoke("pocketdock:remove-vault-item", id),
  getMediaPreview: (transferId: string) =>
    ipcRenderer.invoke("pocketdock:get-media-preview", transferId),
  createProducerPackage: (details) =>
    ipcRenderer.invoke("pocketdock:create-producer-package", details),
  chooseRemoteBrowseRoot: () =>
    ipcRenderer.invoke("pocketdock:choose-remote-browse-root"),
  browseDrive: (relativePath = "") =>
    ipcRenderer.invoke("pocketdock:browse-drive", relativePath),
  revealDriveEntry: (relativePath: string) =>
    ipcRenderer.invoke("pocketdock:reveal-drive-entry", relativePath),
  createDriveFolder: (relativePath: string) =>
    ipcRenderer.invoke("pocketdock:create-drive-folder", relativePath),
  renameDriveEntry: (relativePath: string, newName: string) =>
    ipcRenderer.invoke("pocketdock:rename-drive-entry", relativePath, newName),
  archiveDriveEntry: (relativePath: string) =>
    ipcRenderer.invoke("pocketdock:archive-drive-entry", relativePath),
  createFileRequest: (details) =>
    ipcRenderer.invoke("pocketdock:create-file-request", details),
  revokeFileRequest: (id: string) =>
    ipcRenderer.invoke("pocketdock:revoke-file-request", id),
  copyFileRequestLink: (id: string) =>
    ipcRenderer.invoke("pocketdock:copy-file-request-link", id),
  getFileRequestQrCode: (id: string) =>
    ipcRenderer.invoke("pocketdock:get-file-request-qr", id),
  saveFileRequestQrCode: (id: string) =>
    ipcRenderer.invoke("pocketdock:save-file-request-qr", id),
  approveFileRequestUpload: (id: string) =>
    ipcRenderer.invoke("pocketdock:approve-file-request-upload", id),
  rejectFileRequestUpload: (id: string) =>
    ipcRenderer.invoke("pocketdock:reject-file-request-upload", id),
  refreshDuplicateGroups: () =>
    ipcRenderer.invoke("pocketdock:refresh-duplicates"),
  trashDuplicateTransfers: (ids: string[]) =>
    ipcRenderer.invoke("pocketdock:trash-duplicate-transfers", ids),
  refreshRecoveryIssues: () =>
    ipcRenderer.invoke("pocketdock:refresh-recovery"),
  resolveRecoveryIssue: (id: string) =>
    ipcRenderer.invoke("pocketdock:resolve-recovery", id),
  createBackupSnapshot: () =>
    ipcRenderer.invoke("pocketdock:create-backup-snapshot"),
  restoreBackupSnapshot: (id: string) =>
    ipcRenderer.invoke("pocketdock:restore-backup-snapshot", id),
  setBackgroundService: (enabled: boolean) =>
    ipcRenderer.invoke("pocketdock:set-background-service", enabled),
  rotateRemoteIdentity: () =>
    ipcRenderer.invoke("pocketdock:rotate-remote-identity"),
  exportDiagnostics: () => ipcRenderer.invoke("pocketdock:export-diagnostics"),
  runDiagnostics: () => ipcRenderer.invoke("pocketdock:run-diagnostics"),
  setOnboardingComplete: () =>
    ipcRenderer.invoke("pocketdock:set-onboarding-complete"),
  getOnboardingComplete: () =>
    ipcRenderer.invoke("pocketdock:get-onboarding-complete"),
  onTransferEvent: (callback: (event: TransferEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TransferEvent) =>
      callback(payload);
    ipcRenderer.on("pocketdock:event", listener);
    return () => ipcRenderer.removeListener("pocketdock:event", listener);
  }
};

contextBridge.exposeInMainWorld("pocketdock", api);
