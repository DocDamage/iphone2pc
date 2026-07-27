import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MessageBoxOptions
} from "electron";
import { autoUpdater } from "electron-updater";
import QRCode from "qrcode";
import { StateStore } from "./core/store.js";
import { TransferService } from "./core/transfer-service.js";
import { UsbService } from "./core/usb-service.js";
import { UsbDeviceMonitor } from "./core/usb-device-monitor.js";
import { MusicLibraryService } from "./core/music-library-service.js";
import {
  MUSIC_PLAYBACK_SCHEME,
  MusicPlaybackService
} from "./core/music-playback-service.js";
import { DiagnosticService } from "./core/diagnostic-service.js";
import { MediaService } from "./core/media-service.js";
import { ProducerService } from "./core/producer-service.js";
import { ProductivityService } from "./core/productivity-service.js";
import { RemoteBridge } from "./core/remote-bridge.js";
import { SyncService } from "./core/sync-service.js";
import { VaultService } from "./core/vault-service.js";
import { WatchFolderService } from "./core/watch-folder-service.js";
import { BackupService } from "./core/backup-service.js";
import { isTrustedRendererUrl } from "./core/renderer-security.js";
import { sha256File } from "./core/crypto-utils.js";
import type {
  AppSettings,
  AppSnapshot,
  AutomationRule,
  BackgroundServiceStatus,
  DevicePermissions,
  DuplicateGroup,
  RecoveryIssue,
  SyncProfile,
  TransferEvent,
  TransferMetadataPatch,
  TransferRecord,
  WatchFolder
} from "./core/types.js";

// Custom schemes must be privileged before Electron becomes ready. `stream` lets
// Chromium seek without buffering an entire track, while CORS support covers both
// the packaged file:// renderer and the loopback development renderer.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MUSIC_PLAYBACK_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let store: StateStore;
let transferService: TransferService;
let usbService: UsbService;
let usbDeviceMonitor: UsbDeviceMonitor;
let musicLibraryService: MusicLibraryService;
let musicPlaybackService: MusicPlaybackService;
let diagnosticService: DiagnosticService;
let mediaService: MediaService;
let producerService: ProducerService;
let productivityService: ProductivityService;
let remoteBridge: RemoteBridge;
let syncService: SyncService;
let vaultService: VaultService;
let watchFolderService: WatchFolderService;
let backupService: BackupService;
let networkWatcher: NodeJS.Timeout | null = null;
let updaterEventsRegistered = false;
let configuredUpdateFeed = "";
let duplicateGroups: DuplicateGroup[] = [];
let recoveryIssues: RecoveryIssue[] = [];
let clipboardWatcher: NodeJS.Timeout | null = null;
let lastClipboardText = "";
let initializationPromise: Promise<void> | null = null;
const execFileAsync = promisify(execFile);

function createMusicLibraryService(settings: AppSettings): MusicLibraryService {
  return new MusicLibraryService(
    [
      {
        directory: settings.destinationDirectory,
        source: "PocketDock Received",
        required: true
      },
      ...settings.customMusicDirectories.map((directory) => ({
        directory,
        source: "Windows Custom" as const,
        required: true
      })),
      { directory: app.getPath("music"), source: "Windows Music" },
      { directory: app.getPath("documents"), source: "Windows Documents" }
    ],
    (items) => void broadcast({ type: "music-updated", payload: { items } })
  );
}

async function restartMusicLibrary(settings = store.getSettings()): Promise<void> {
  musicLibraryService.stop();
  musicLibraryService = createMusicLibraryService(settings);
  await musicLibraryService.start();
}

function appAssetPath(...segments: string[]): string {
  return path.join(app.getAppPath(), ...segments);
}

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", "build", "icon.png")
    : appAssetPath("build", "icon.png");
}

function mobilePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "mobile")
    : appAssetPath("public", "mobile");
}

function rendererEntryUrl(): string {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  return devServer
    ? new URL(devServer).href
    : pathToFileURL(appAssetPath("dist", "index.html")).href;
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const senderFrame = event.senderFrame;
  const trustedEntryUrl = rendererEntryUrl();
  return Boolean(
    senderFrame &&
      senderFrame === event.sender.mainFrame &&
      isTrustedRendererUrl(event.sender.getURL(), trustedEntryUrl) &&
      isTrustedRendererUrl(senderFrame.url, trustedEntryUrl)
  );
}

const ipcMain = {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any
  ): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event)) {
        throw new Error("PocketDock blocked an IPC request from an untrusted renderer.");
      }
      return listener(event, ...args);
    });
  }
};

async function getSnapshot(): Promise<AppSnapshot> {
  const settings = store.getSettings();
  return {
    settings,
    connection: transferService.getConnectionInfo(),
    history: store.getHistory(),
    activeTransfers: transferService.getActiveTransfers(),
    sharedFiles: transferService.getSharedFiles(),
    trustedDevices: store.getTrustedDevices().map((device) => ({
      ...device,
      tokenHash: ""
    })),
    automationRules: store.getAutomationRules(),
    clipboardEntries: store.getClipboardEntries(),
    usbDevices: usbDeviceMonitor.getDevices(),
    musicLibrary: musicLibraryService.getItems(),
    phoneMusicLibraries: store.getPhoneMusicLibraries(),
    syncProfiles: store.getSyncProfiles(),
    watchFolders: store.getWatchFolders(),
    privateShareLinks: transferService.getPrivateShareLinks(),
    vaultItems: store.getVaultItems(),
    vaultInitialized: Boolean(store.getVaultMetadata()),
    vaultUnlocked: vaultService.isUnlocked(),
    producerPackages: store.getProducerPackages(),
    fileRequests: transferService.getFileRequests(),
    fileRequestUploads: store.getFileRequestUploads(),
    duplicateGroups,
    recoveryIssues,
    backupSnapshots: store.getBackupSnapshots(),
    backgroundService: await getBackgroundServiceStatus(),
    transportStatus: await productivityService.transportStatus(),
    remoteStatus: remoteBridge.getStatus(settings.remoteRelayUrl),
    storage: await transferService.getStorageInfo(),
    version: app.getVersion()
  };
}

async function getBackgroundServiceStatus(): Promise<BackgroundServiceStatus> {
  if (process.platform !== "win32") {
    return {
      supported: false,
      installed: false,
      active: false,
      detail: "The background agent is available in the Windows build."
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "schtasks.exe",
      ["/Query", "/TN", "PocketDock Background Service", "/FO", "LIST"],
      { windowsHide: true, timeout: 10_000 }
    );
    return {
      supported: true,
      installed: true,
      active: /Running|Ready/i.test(stdout),
      detail: /Running/i.test(stdout)
        ? "The Windows background agent is running."
        : "The Windows background agent starts automatically at sign-in."
    };
  } catch {
    return {
      supported: true,
      installed: false,
      active: false,
      detail: "The Windows background agent is not installed."
    };
  }
}

async function setBackgroundService(enabled: boolean): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The background service can be installed from the Windows build.");
  }
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(windowsScriptsPath(), "Manage-PocketDockBackground.ps1"),
      "-Action",
      enabled ? "Install" : "Uninstall",
      "-ExecutablePath",
      process.execPath
    ],
    { windowsHide: true, timeout: 120_000 }
  );
  await store.updateSettings({ backgroundServiceEnabled: enabled });
}

function configureClipboardWatcher(): void {
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  clipboardWatcher = null;
  lastClipboardText = clipboard.readText();
  if (!store.getSettings().automaticClipboardSync) return;
  clipboardWatcher = setInterval(() => {
    const current = clipboard.readText().trim();
    if (!current || current === lastClipboardText) return;
    lastClipboardText = current;
    void transferService
      .addClipboardEntry(current, "This PC")
      .then(() => broadcast({ type: "clipboard-updated" }));
  }, 1_500);
  clipboardWatcher.unref();
}

async function broadcast(event: TransferEvent): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pocketdock:event", event);
    const active = transferService.getActiveTransfers();
    const total = active.reduce((sum, item) => sum + item.size, 0);
    const received = active.reduce((sum, item) => sum + item.received, 0);
    mainWindow.setProgressBar(total > 0 ? received / total : -1, {
      mode: active.some((item) => item.paused) ? "paused" : "normal"
    });
  }
  if (event.type === "upload-completed" && musicLibraryService) {
    // Incoming recovered audio is already committed when this event fires. Refresh now so
    // it appears without making the user wait for the next filesystem poll.
    void musicLibraryService.refresh();
  }
  if (event.type === "upload-completed" && store.getSettings().showNotifications) {
    const payload = event.payload as { fileName?: string; direction?: string } | undefined;
    new Notification({
      title: "Transfer complete",
      body:
        payload?.direction === "pc-to-iphone"
          ? `${payload.fileName ?? "Your file"} was downloaded to your iPhone.`
          : payload?.fileName
            ? `${payload.fileName} is now on this PC.`
            : "Your file is now on this PC.",
      icon: iconPath()
    }).show();
  }
}

function applySystemSettings(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme;
  app.setLoginItemSettings({
    openAtLogin: settings.runAtLogin,
    path: process.execPath
  });
}

function windowsScriptsPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "windows-scripts")
    : appAssetPath("scripts", "windows");
}

async function registerExplorerIntegration(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const executable = process.execPath;
  const command = `"${executable}" --share "%1"`;
  const targets = [
    ["HKCU\\Software\\Classes\\*\\shell\\PocketDock", "Send to iPhone with PocketDock"],
    ["HKCU\\Software\\Classes\\Directory\\shell\\PocketDock", "Send to iPhone with PocketDock"]
  ];
  for (const [key, label] of targets) {
    await execFileAsync("reg.exe", ["ADD", key, "/ve", "/d", label, "/f"], {
      windowsHide: true
    });
    await execFileAsync(
      "reg.exe",
      ["ADD", `${key}\\command`, "/ve", "/d", command, "/f"],
      { windowsHide: true }
    );
  }
  return true;
}

async function configureWindowsFirewall(): Promise<string> {
  if (process.platform !== "win32") {
    return "Windows Firewall configuration is available in the Windows build.";
  }
  const executable = process.execPath;
  const command = [
    "$addArguments = @(",
    "'advfirewall','firewall','add','rule',",
    "'name=PocketDock Private Transfer',",
    "'dir=in','action=allow','profile=private','protocol=TCP',",
    `'program="${executable.replaceAll("'", "''")}"'`,
    ")",
    "$firewallProcess = Start-Process -FilePath 'netsh.exe' -ArgumentList $addArguments -Verb RunAs -Wait -PassThru",
    "if ($firewallProcess.ExitCode -ne 0) { throw \"Windows Firewall returned exit code $($firewallProcess.ExitCode).\" }"
  ].join("\n");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { windowsHide: true, timeout: 120_000 }
  );
  return "Windows Firewall now allows PocketDock on private networks.";
}

async function writeCrashReport(
  userDataDirectory: string,
  source: string,
  error: unknown
): Promise<void> {
  try {
    const directory = path.join(userDataDirectory, "crash-reports");
    await mkdir(directory, { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      source,
      appVersion: app.getVersion(),
      platform: process.platform,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    };
    const fileName = `crash-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
    await writeFile(path.join(directory, fileName), JSON.stringify(report, null, 2), "utf8");
  } catch {
    // Crash reporting must never create a second crash.
  }
}

async function pruneCrashReports(userDataDirectory: string): Promise<void> {
  const directory = path.join(userDataDirectory, "crash-reports");
  const cutoff =
    Date.now() - store.getSettings().diagnosticsRetentionDays * 24 * 60 * 60 * 1000;
  for (const name of await readdir(directory).catch(() => [])) {
    const match = name.match(/^crash-(\d+)-[a-f0-9]+\.json$/);
    if (match && Number(match[1]) < cutoff) {
      await rm(path.join(directory, name), { force: true });
    }
  }
}

async function handleShareArguments(argv: string[]): Promise<void> {
  const shareIndex = argv.indexOf("--share");
  const candidate = shareIndex >= 0 ? argv[shareIndex + 1] : undefined;
  if (!candidate) return;
  try {
    const info = await import("node:fs/promises").then((module) => module.stat(candidate));
    if (info.isFile()) await transferService.registerSharedFiles([candidate]);
  } catch {
    // Explorer can pass a stale path; the UI remains usable.
  }
}

function startNetworkWatcher(): void {
  let previous = transferService.getConnectionInfo().addresses.join("|");
  networkWatcher = setInterval(() => {
    const current = transferService.getConnectionInfo().addresses.join("|");
    if (current !== previous) {
      previous = current;
      void broadcast({ type: "connection-updated" });
    }
  }, 3_000);
}

function configureAutomaticUpdates(): void {
  const settings = store.getSettings();
  if (!app.isPackaged || !settings.autoUpdate || !settings.updateFeedUrl) return;
  if (configuredUpdateFeed !== settings.updateFeedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: settings.updateFeedUrl });
    configuredUpdateFeed = settings.updateFeedUrl;
  }
  autoUpdater.autoDownload = true;
  if (!updaterEventsRegistered) {
    updaterEventsRegistered = true;
    autoUpdater.on("update-downloaded", async (information) => {
      const options: MessageBoxOptions = {
        type: "info",
        title: "PocketDock update ready",
        message: `PocketDock ${information.version} is ready to install.`,
        detail: "Restart PocketDock now to finish the update. Active transfers should finish first.",
        buttons: ["Restart and install", "Later"],
        defaultId: 0,
        cancelId: 1
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0 && transferService.getActiveTransfers().length === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  }
  void autoUpdater.checkForUpdates().catch(() => undefined);
}

async function createWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const window = new BrowserWindow({
    width: 1_260,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11131a" : "#f4f6fb",
    show: false,
    title: "PocketDock",
    icon: iconPath(),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? "#151822" : "#ffffff",
      symbolColor: nativeTheme.shouldUseDarkColors ? "#f7f8fb" : "#232635",
      height: 48
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;

  Menu.setApplicationMenu(null);
  window.once("ready-to-show", () => {
    if (!process.argv.includes("--background-service") && !window.isDestroyed()) window.show();
  });
  window.on("close", (event) => {
    if (!isQuitting && store.getSettings().minimizeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const trustedEntryUrl = rendererEntryUrl();
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, trustedEntryUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url, trustedEntryUrl)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  await window.loadURL(trustedEntryUrl);

  const capturePath = process.env.POCKETDOCK_CAPTURE_PATH;
  if (capturePath) {
    setTimeout(async () => {
      if (window.isDestroyed()) return;
      const image = await window.webContents.capturePage();
      await writeFile(capturePath, image.toPNG());
      isQuitting = true;
      app.quit();
    }, 1_500);
  }
  return window;
}

async function showOrCreateMainWindow(): Promise<void> {
  const window = await createWindow();
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.setToolTip("PocketDock");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open PocketDock",
        click: () => void showOrCreateMainWindow()
      },
      {
        label: "Open received files",
        click: () => void shell.openPath(store.getSettings().destinationDirectory)
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", () => void showOrCreateMainWindow());
}

function registerIpc(): void {
  ipcMain.handle("pocketdock:get-snapshot", () => getSnapshot());
  ipcMain.handle("pocketdock:get-qr", async () => {
    const url = transferService.getConnectionInfo().url;
    if (!url) throw new Error("No local network connection is available.");
    return QRCode.toDataURL(url, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#171923", light: "#ffffff" }
    });
  });
  ipcMain.handle("pocketdock:get-remote-qr", async () => {
    const settings = store.getSettings();
    const url = remoteBridge.getStatus(settings.remoteRelayUrl).pairingUrl;
    if (!url) return null;
    return QRCode.toDataURL(url, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#171923", light: "#ffffff" }
    });
  });
  ipcMain.handle("pocketdock:copy-link", () => {
    const url = transferService.getConnectionInfo().url;
    if (!url) throw new Error("No local connection link is available yet.");
    clipboard.writeText(url);
  });
  ipcMain.handle("pocketdock:refresh-pairing", async () => {
    transferService.rotatePairingCode();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:choose-destination", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose where iPhone files are saved",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const settings = await store.updateSettings({ destinationDirectory: result.filePaths[0] });
    transferService.updateSettings(settings);
    await restartMusicLibrary(settings);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:update-settings", async (_event, patch: Partial<AppSettings>) => {
    const previous = store.getSettings();
    const settings = await store.updateSettings(patch);
    applySystemSettings(settings);
    transferService.updateSettings(settings);
    if (previous.port !== settings.port) await transferService.restart();
    if (
      previous.remoteAccessEnabled !== settings.remoteAccessEnabled ||
      previous.remoteRelayUrl !== settings.remoteRelayUrl ||
      previous.port !== settings.port
    ) {
      remoteBridge.configure(settings.remoteAccessEnabled, settings.remoteRelayUrl);
    }
    if (previous.automaticClipboardSync !== settings.automaticClipboardSync) {
      configureClipboardWatcher();
    }
    configureAutomaticUpdates();
    if (
      patch.customMusicDirectories !== undefined ||
      patch.destinationDirectory !== undefined
    ) {
      await restartMusicLibrary(settings);
    }
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:share-files", async (_event, expiresMinutes = 0) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose files to make available on your iPhone",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) return null;
    await transferService.registerSharedFiles(result.filePaths, expiresMinutes, "manual");
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:share-dropped-files",
    async (_event, paths: string[], expiresMinutes = 0) => {
    if (!paths.length) throw new Error("No readable files were dropped.");
    await transferService.registerSharedFiles(paths, expiresMinutes, "manual");
    return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:remove-shared-file", async (_event, id: string) => {
    if (!transferService.getSharedFiles().some((file) => file.id === id)) {
      throw new Error("That shared file is no longer available.");
    }
    await transferService.removeSharedFile(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:clear-history", async () => {
    await store.clearHistory();
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:update-transfer-metadata",
    async (_event, id: string, patch: TransferMetadataPatch) => {
      await store.updateTransferMetadata(id, patch);
      return getSnapshot();
    }
  );
  ipcMain.handle(
    "pocketdock:update-transfers-metadata",
    async (_event, ids: string[], patch: TransferMetadataPatch) => {
      await store.updateTransfersMetadata(ids, patch);
      return getSnapshot();
    }
  );
  ipcMain.handle(
    "pocketdock:add-tag-to-transfers",
    async (_event, ids: string[], tag: string) => {
      await store.addTagToTransfers(ids, tag);
      return getSnapshot();
    }
  );
  ipcMain.handle(
    "pocketdock:share-transfers",
    async (_event, ids: string[], expiresMinutes = 0) => {
      const selectedIds = new Set(ids.slice(0, 5_000));
      const paths: string[] = [];
      for (const transfer of store.getHistory()) {
        if (!selectedIds.has(transfer.id) || !transfer.savedPath) continue;
        try {
          await access(transfer.savedPath);
          paths.push(transfer.savedPath);
        } catch {
          // Moved or deleted history entries are skipped.
        }
      }
      if (!paths.length) throw new Error("None of the selected files are still available.");
      await transferService.registerSharedFiles(
        [...new Set(paths)],
        expiresMinutes,
        "manual"
      );
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:vault-transfers", async (_event, ids: string[]) => {
    const selectedIds = new Set(ids.slice(0, 5_000));
    const paths: string[] = [];
    for (const transfer of store.getHistory()) {
      if (!selectedIds.has(transfer.id) || !transfer.savedPath) continue;
      try {
        await access(transfer.savedPath);
        paths.push(transfer.savedPath);
      } catch {
        // Moved or deleted history entries are skipped.
      }
    }
    if (!paths.length) throw new Error("None of the selected files are still available.");
    await vaultService.addFiles([...new Set(paths)]);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:reveal-transfer", async (_event, id: string) => {
    const transfer = store.getHistory().find((entry) => entry.id === id);
    if (!transfer?.savedPath) {
      throw new Error("This transfer does not have a saved Windows file to reveal.");
    }
    if (transfer.savedPath) {
      try {
        await access(transfer.savedPath);
        shell.showItemInFolder(transfer.savedPath);
      } catch {
        await dialog.showMessageBox(mainWindow!, {
          type: "info",
          title: "File moved",
          message: "PocketDock can’t find this file at its original location.",
          detail: "It may have been renamed, moved, or deleted after the transfer."
        });
      }
    }
  });
  ipcMain.handle("pocketdock:open-destination", async () => {
    const failure = await shell.openPath(store.getSettings().destinationDirectory);
    if (failure) throw new Error(`Windows could not open the received-files folder: ${failure}`);
  });
  ipcMain.handle("pocketdock:pause-transfer", async (_event, id: string) => {
    if (!transferService.getActiveTransfers().some((item) => item.id === id)) {
      throw new Error("That transfer is no longer active.");
    }
    await transferService.pauseTransfer(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:resume-transfer", async (_event, id: string) => {
    if (!transferService.getActiveTransfers().some((item) => item.id === id)) {
      throw new Error("That transfer is no longer active.");
    }
    await transferService.resumeTransfer(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:cancel-transfer", async (_event, id: string) => {
    if (!transferService.getActiveTransfers().some((item) => item.id === id)) {
      throw new Error("That transfer is no longer active.");
    }
    await transferService.cancelTransfer(id);
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:add-automation-rule",
    async (_event, rule: Omit<AutomationRule, "id">) => {
      await store.addAutomationRule(rule);
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:remove-automation-rule", async (_event, id: string) => {
    await store.removeAutomationRule(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:revoke-trusted-device", async (_event, id: string) => {
    await transferService.revokeTrustedDevice(id);
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:update-trusted-device-permissions",
    async (_event, id: string, permissions: DevicePermissions) => {
      await transferService.updateTrustedDevicePermissions(id, permissions);
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:copy-clipboard-entry", (_event, id: string) => {
    const entry = store.getClipboardEntries().find((item) => item.id === id);
    if (!entry) throw new Error("That clipboard item is no longer available.");
    clipboard.writeText(entry.content);
  });
  ipcMain.handle("pocketdock:send-clipboard-text", async (_event, content?: string) => {
    const entry = await transferService.addClipboardEntry(
      content ?? clipboard.readText(),
      "This PC"
    );
    if (!entry) throw new Error("The Windows clipboard is empty.");
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:clear-clipboard", async () => {
    await store.clearClipboard();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:refresh-usb-devices", async () => {
    await usbDeviceMonitor.refreshOrThrow();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:refresh-music-library", async () => {
    await musicLibraryService.refreshOrThrow();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:add-music-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add a folder to the PocketDock music library",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = path.resolve(result.filePaths[0]);
    const settings = store.getSettings();
    const existing = settings.customMusicDirectories.some(
      (directory) => path.resolve(directory).toLocaleLowerCase("en-US") === chosen.toLocaleLowerCase("en-US")
    );
    if (existing) throw new Error("That folder is already included in the music library.");
    const nextSettings = await store.updateSettings({
      customMusicDirectories: [...settings.customMusicDirectories, chosen]
    });
    await restartMusicLibrary(nextSettings);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:remove-music-directory", async (_event, directory: string) => {
    const target = path.resolve(String(directory));
    const settings = store.getSettings();
    const nextDirectories = settings.customMusicDirectories.filter(
      (entry) => path.resolve(entry).toLocaleLowerCase("en-US") !== target.toLocaleLowerCase("en-US")
    );
    if (nextDirectories.length === settings.customMusicDirectories.length) {
      throw new Error("That music folder is no longer configured.");
    }
    const nextSettings = await store.updateSettings({ customMusicDirectories: nextDirectories });
    await restartMusicLibrary(nextSettings);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:reveal-music-file", async (_event, id: string) => {
    const filePath = typeof id === "string" ? musicLibraryService.getFilePath(id) : null;
    if (!filePath) throw new Error("This music file is no longer in the local library.");
    try {
      await access(filePath);
      shell.showItemInFolder(filePath);
    } catch {
      await musicLibraryService.refresh();
      throw new Error("PocketDock can’t find this music file. Refresh the library and try again.");
    }
  });
  ipcMain.handle("pocketdock:get-music-playback-url", (_event, id: string) =>
    musicPlaybackService.getMusicPlaybackUrl(typeof id === "string" ? id : "")
  );
  ipcMain.handle("pocketdock:get-transfer-playback-url", (_event, id: string) =>
    musicPlaybackService.getTransferPlaybackUrl(typeof id === "string" ? id : "")
  );
  ipcMain.handle("pocketdock:import-usb-photos", async (_event, deviceId: string) => {
    if (!store.getSettings().allowUsbImport) {
      throw new Error("USB Camera Roll import is disabled in Settings.");
    }
    const destination = path.join(
      store.getSettings().destinationDirectory,
      "USB Import",
      new Date().toISOString().slice(0, 10)
    );
    const result = await usbService.importPhotos(deviceId, destination);
    const now = new Date().toISOString();
    const completelyFailed = result.failed > 0 && result.imported === 0;
    const record: TransferRecord = {
      id: crypto.randomUUID(),
      fileName:
        `USB Camera Roll import (${result.imported} new, ${result.skipped} existing` +
        `${result.failed ? `, ${result.failed} failed` : ""})`,
      size: result.bytes,
      mimeType: "application/x-pocketdock-import",
      direction: "iphone-to-pc",
      status: completelyFailed ? "failed" : "completed",
      createdAt: now,
      completedAt: now,
      sourceDevice: "iPhone Camera Roll over USB",
      savedPath: destination,
      verified: result.failed === 0,
      error: result.failed
        ? result.failures.slice(0, 3).join(" | ") || `${result.failed} item(s) could not be copied.`
        : undefined
    };
    await store.upsertTransfer(record);
    return {
      snapshot: await getSnapshot(),
      result
    };
  });
  ipcMain.handle("pocketdock:open-apple-devices", () => usbService.openAppleDevices());
  ipcMain.handle("pocketdock:install-explorer-integration", () =>
    registerExplorerIntegration()
  );
  ipcMain.handle("pocketdock:configure-firewall", () => configureWindowsFirewall());
  ipcMain.handle("pocketdock:check-for-updates", async () => {
    const settings = store.getSettings();
    if (!app.isPackaged) return "Update checks are available in packaged builds.";
    if (!settings.updateFeedUrl) return "Add an update feed URL in Advanced settings first.";
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({ provider: "generic", url: settings.updateFeedUrl });
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo.version === app.getVersion()
      ? "PocketDock is up to date."
      : `PocketDock ${result?.updateInfo.version ?? "update"} is available.`;
  });
  ipcMain.handle("pocketdock:choose-remote-browse-root", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose the PocketDock Drive root",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await store.updateSettings({ remoteBrowseRoot: result.filePaths[0] });
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:browse-drive", (_event, relativePath = "") =>
    productivityService.browse(relativePath)
  );
  ipcMain.handle("pocketdock:reveal-drive-entry", async (_event, relativePath: string) => {
    const target = await productivityService.localDriveEntryPath(relativePath);
    const info = await stat(target);
    if (info.isDirectory()) {
      const failure = await shell.openPath(target);
      if (failure) throw new Error(`Windows could not open that Drive folder: ${failure}`);
    } else {
      shell.showItemInFolder(target);
    }
  });
  ipcMain.handle("pocketdock:create-drive-folder", async (_event, relativePath: string) => {
    await productivityService.createFolder(relativePath);
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:rename-drive-entry",
    async (_event, relativePath: string, newName: string) => {
      await productivityService.renameEntry(relativePath, newName);
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:archive-drive-entry", async (_event, relativePath: string) => {
    await productivityService.archiveEntry(relativePath);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:create-file-request", async (_event, details) => {
    await transferService.createFileRequest(details);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:revoke-file-request", async (_event, id: string) => {
    await transferService.revokeFileRequest(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:copy-file-request-link", (_event, id: string) => {
    const link = transferService.getFileRequests().find((item) => item.id === id)?.url;
    if (!link) throw new Error("This file request is unavailable.");
    clipboard.writeText(link);
  });
  ipcMain.handle("pocketdock:get-file-request-qr", async (_event, id: string) => {
    const link = transferService.getFileRequests().find((item) => item.id === id)?.url;
    if (!link) throw new Error("This file request is unavailable.");
    return QRCode.toDataURL(link, {
      width: 720,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0c355d", light: "#ffffff" }
    });
  });
  ipcMain.handle("pocketdock:save-file-request-qr", async (_event, id: string) => {
    const request = transferService.getFileRequests().find((item) => item.id === id);
    if (!request?.url) throw new Error("This file request is unavailable.");
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save branded file-request QR",
      defaultPath: `${request.name.replace(/[<>:"/\\|?*]/g, "_")}-QR.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) return "QR export cancelled.";
    await QRCode.toFile(result.filePath, request.url, {
      width: 1024,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#0c355d", light: "#ffffff" }
    });
    return `QR saved to ${result.filePath}`;
  });
  ipcMain.handle("pocketdock:approve-file-request-upload", async (_event, id: string) => {
    await transferService.approveFileRequestUpload(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:reject-file-request-upload", async (_event, id: string) => {
    await transferService.rejectFileRequestUpload(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:refresh-duplicates", async () => {
    duplicateGroups = await productivityService.duplicateGroups();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:trash-duplicate-transfers", async (_event, ids: string[]) => {
    const requestedIds = [...new Set(ids.slice(0, 5_000))];
    if (!requestedIds.length) throw new Error("Choose at least one exact duplicate first.");
    const exactGroupByExtraId = new Map(
      duplicateGroups
        .filter((group) => group.kind === "exact" && group.items.length > 1)
        .flatMap((group) =>
          group.items.slice(1).map((item) => [item.transferId, group] as const)
        )
    );
    if (requestedIds.some((id) => !exactGroupByExtraId.has(id))) {
      throw new Error("Only SHA-256-verified duplicate extras can be moved automatically.");
    }
    const historyById = new Map(store.getHistory().map((item) => [item.id, item]));
    type VerifiedFile = {
      resolvedPath: string;
      size: number;
      modifiedAt: number;
      changedAt: number;
      device: number;
      inode: number;
      sha256: string;
    };
    const verificationCache = new Map<string, Promise<VerifiedFile>>();
    const verifyFile = async (filePath: string): Promise<VerifiedFile> => {
      const resolvedPath = path.resolve(filePath);
      const cacheKey = process.platform === "win32"
        ? resolvedPath.toLocaleLowerCase("en-US")
        : resolvedPath;
      const existing = verificationCache.get(cacheKey);
      if (existing) return existing;
      const verification = (async (): Promise<VerifiedFile> => {
        const before = await stat(resolvedPath);
        if (!before.isFile()) throw new Error("The duplicate path is no longer a file.");
        const sha256 = await sha256File(resolvedPath);
        const after = await stat(resolvedPath);
        if (
          !after.isFile() ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          before.dev !== after.dev ||
          before.ino !== after.ino
        ) {
          throw new Error("The file changed while its SHA-256 digest was being verified.");
        }
        return {
          resolvedPath,
          size: after.size,
          modifiedAt: after.mtimeMs,
          changedAt: after.ctimeMs,
          device: after.dev,
          inode: after.ino,
          sha256
        };
      })();
      verificationCache.set(cacheKey, verification);
      return verification;
    };
    const assertFileUnchanged = async (file: VerifiedFile): Promise<void> => {
      const current = await stat(file.resolvedPath);
      if (
        !current.isFile() ||
        current.size !== file.size ||
        current.mtimeMs !== file.modifiedAt ||
        current.ctimeMs !== file.changedAt ||
        current.dev !== file.device ||
        current.ino !== file.inode
      ) {
        throw new Error("The duplicate or keeper changed after its SHA-256 digest was verified.");
      }
    };
    const trashedIds: string[] = [];
    const failed: string[] = [];
    for (const id of requestedIds) {
      const record = historyById.get(id);
      const group = exactGroupByExtraId.get(id);
      const keeperItem = group?.items[0];
      const keeper = keeperItem ? historyById.get(keeperItem.transferId) : undefined;
      const label = record?.fileName ?? group?.items.find((item) => item.transferId === id)?.fileName ?? id;
      try {
        if (!record?.savedPath || !keeper?.savedPath) {
          throw new Error("The duplicate or its keeper is no longer present in transfer history.");
        }
        if (!record.sha256 || !keeper.sha256) {
          throw new Error("The duplicate or its keeper no longer has a verified historical SHA-256 digest.");
        }
        const candidatePath = path.resolve(record.savedPath);
        const keeperPath = path.resolve(keeper.savedPath);
        const candidateKey = process.platform === "win32"
          ? candidatePath.toLocaleLowerCase("en-US")
          : candidatePath;
        const keeperKey = process.platform === "win32"
          ? keeperPath.toLocaleLowerCase("en-US")
          : keeperPath;
        if (candidateKey === keeperKey) {
          throw new Error("The duplicate and keeper resolve to the same file.");
        }
        const [candidateFile, keeperFile] = await Promise.all([
          verifyFile(candidatePath),
          verifyFile(keeperPath)
        ]);
        const historicalCandidateHash = record.sha256.toLocaleLowerCase("en-US");
        const historicalKeeperHash = keeper.sha256.toLocaleLowerCase("en-US");
        if (
          candidateFile.size !== record.size ||
          keeperFile.size !== keeper.size ||
          candidateFile.size !== keeperFile.size
        ) {
          throw new Error("The duplicate or keeper size changed since it was indexed.");
        }
        if (
          historicalCandidateHash !== historicalKeeperHash ||
          candidateFile.sha256 !== historicalCandidateHash ||
          keeperFile.sha256 !== historicalKeeperHash ||
          candidateFile.sha256 !== keeperFile.sha256
        ) {
          throw new Error("The duplicate or keeper content changed since it was indexed.");
        }
        await Promise.all([
          assertFileUnchanged(candidateFile),
          assertFileUnchanged(keeperFile)
        ]);
        await shell.trashItem(candidateFile.resolvedPath);
        trashedIds.push(record.id);
      } catch (error) {
        failed.push(
          `${label}: ${error instanceof Error ? error.message : "Recycle Bin operation failed."}`
        );
      }
    }
    if (trashedIds.length) await store.removeTransfers(trashedIds);
    duplicateGroups = await productivityService.duplicateGroups();
    return {
      snapshot: await getSnapshot(),
      trashed: trashedIds.length,
      failed
    };
  });
  ipcMain.handle("pocketdock:refresh-recovery", async () => {
    recoveryIssues = await productivityService.recoveryIssues();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:resolve-recovery", async (_event, id: string) => {
    await productivityService.resolveRecoveryIssue(id);
    recoveryIssues = await productivityService.recoveryIssues();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:create-backup-snapshot", async () => {
    await backupService.create("manual");
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:restore-backup-snapshot", async (_event, id: string) => {
    const restoredDirectory = await backupService.restore(id);
    const failure = await shell.openPath(restoredDirectory);
    if (failure) {
      throw new Error(`The restore completed, but Windows could not open it: ${failure}`);
    }
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:set-background-service", async (_event, enabled: boolean) => {
    await setBackgroundService(enabled);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:rotate-remote-identity", async () => {
    store.rotateRemoteIdentity();
    const settings = store.getSettings();
    remoteBridge.configure(settings.remoteAccessEnabled, settings.remoteRelayUrl);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:add-sync-profile", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose a Windows folder to synchronize",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await syncService.createProfile(result.filePaths[0]);
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:update-sync-profile",
    async (_event, id: string, patch: Partial<SyncProfile>) => {
      await syncService.updateProfile(id, patch);
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:remove-sync-profile", async (_event, id: string) => {
    await syncService.removeProfile(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:run-sync-profile", async (_event, id: string) => {
    await syncService.run(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:add-watch-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose a folder PocketDock should watch",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await watchFolderService.create(result.filePaths[0]);
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:update-watch-folder",
    async (_event, id: string, patch: Partial<WatchFolder>) => {
      await watchFolderService.update(id, patch);
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:remove-watch-folder", async (_event, id: string) => {
    await watchFolderService.remove(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:scan-watch-folders", async () => {
    await watchFolderService.scanNow();
    return getSnapshot();
  });
  ipcMain.handle(
    "pocketdock:create-private-share-link",
    async (
      _event,
      name: string,
      sharedFileIds: string[],
      expiresHours: number,
      maxDownloads: number
    ) => {
      await transferService.createPrivateShareLink(
        name,
        sharedFileIds,
        expiresHours,
        maxDownloads
      );
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:revoke-private-share-link", async (_event, id: string) => {
    await transferService.revokePrivateShareLink(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:copy-private-share-link", (_event, id: string) => {
    const link = transferService.getPrivateShareLinks().find((entry) => entry.id === id);
    if (!link?.url) throw new Error("This private link is no longer available.");
    clipboard.writeText(link.url);
  });
  ipcMain.handle("pocketdock:get-private-share-qr", async (_event, id: string) => {
    const link = transferService.getPrivateShareLinks().find((entry) => entry.id === id);
    if (!link?.url) throw new Error("This private link is no longer available.");
    return QRCode.toDataURL(link.url, {
      width: 620,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#082E4F", light: "#FFFFFF" }
    });
  });
  ipcMain.handle("pocketdock:save-private-share-qr", async (_event, id: string) => {
    const link = transferService.getPrivateShareLinks().find((entry) => entry.id === id);
    if (!link?.url) throw new Error("This private link is no longer available.");
    const safeName = link.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save branded private-link QR code",
      defaultPath: `${safeName || "PocketDock-Private-Link"}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) return "QR export cancelled.";
    await QRCode.toFile(result.filePath, link.url, {
      width: 1_024,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#082E4F", light: "#FFFFFF" }
    });
    return `QR code saved to ${result.filePath}`;
  });
  ipcMain.handle("pocketdock:initialize-vault", async (_event, passphrase: string) => {
    await vaultService.initialize(passphrase);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:unlock-vault", async (_event, passphrase: string) => {
    vaultService.unlock(passphrase);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:lock-vault", async () => {
    vaultService.lock();
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:add-files-to-vault", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose files to encrypt in PocketDock Vault",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) return null;
    await vaultService.addFiles(result.filePaths);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:export-vault-item", async (_event, id: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose where to export the decrypted file",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return false;
    const exported = await vaultService.exportItem(id, result.filePaths[0]);
    shell.showItemInFolder(exported);
    return true;
  });
  ipcMain.handle("pocketdock:remove-vault-item", async (_event, id: string) => {
    await vaultService.removeItem(id);
    return getSnapshot();
  });
  ipcMain.handle("pocketdock:get-media-preview", (_event, transferId: string) => {
    const transfer = store.getHistory().find((entry) => entry.id === transferId);
    return transfer ? mediaService.preview(transfer) : null;
  });
  ipcMain.handle(
    "pocketdock:create-producer-package",
    async (
      _event,
      details: {
        title: string;
        artist: string;
        bpm?: number;
        musicalKey?: string;
        notes: string;
        clientName?: string;
        licenseName?: string;
      }
    ) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: "Choose beats, stems, artwork, MIDI, and project files",
        properties: ["openFile", "multiSelections"]
      });
      if (result.canceled) return null;
      const item = await producerService.create(result.filePaths, details);
      const shared = transferService.getSharedFiles().find((file) => file.path === item.path);
      if (shared) {
        const link = await transferService.createPrivateShareLink(
          `${item.title} · v${item.version ?? 1}`,
          [shared.id],
          7 * 24,
          100
        );
        await store.upsertProducerPackage({
          ...item,
          portalLinkId: link.id,
          approvalStatus: "sent"
        });
      }
      return getSnapshot();
    }
  );
  ipcMain.handle("pocketdock:run-diagnostics", () => diagnosticService.run());
  ipcMain.handle("pocketdock:export-diagnostics", async () => {
    const report = await diagnosticService.run();
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Export redacted PocketDock diagnostics",
      defaultPath: `PocketDock-Diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return "Export cancelled.";
    await writeFile(result.filePath, JSON.stringify(report, null, 2), "utf8");
    return `Diagnostics saved to ${result.filePath}`;
  });
  ipcMain.handle("pocketdock:set-onboarding-complete", () =>
    store.setOnboardingComplete()
  );
  ipcMain.handle("pocketdock:get-onboarding-complete", () =>
    store.getOnboardingComplete()
  );
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on("second-instance", (_event, argv) => {
  const initialization = initializationPromise;
  if (!initialization) return;
  void initialization.then(async () => {
    await handleShareArguments(argv);
    await showOrCreateMainWindow();
  });
});

initializationPromise = app.whenReady().then(async () => {
  const userDataDirectory = app.getPath("userData");
  store = new StateStore(userDataDirectory);
  await store.load();
  if (process.env.POCKETDOCK_CAPTURE_PATH) await store.setOnboardingComplete();
  applySystemSettings(store.getSettings());

  transferService = new TransferService(store, mobilePath(), userDataDirectory);
  usbService = new UsbService(windowsScriptsPath());
  productivityService = new ProductivityService(
    store,
    path.join(userDataDirectory, "staging"),
    () => transferService.getConnectionInfo()
  );
  transferService.setProductivityService(productivityService);
  backupService = new BackupService(
    store,
    userDataDirectory,
    () => productivityService.backupAllowed()
  );
  syncService = new SyncService(store);
  vaultService = new VaultService(store, path.join(userDataDirectory, "vault"));
  mediaService = new MediaService();
  transferService.setEventHandler((event) => void broadcast(event));
  await transferService.start();
  usbDeviceMonitor = new UsbDeviceMonitor(
    async () => {
      const devices = await usbService.listDevices();
      const scanError = devices.find((device) => device.diagnosticCode === "scan-error");
      if (scanError) throw new Error(scanError.description);
      return devices;
    },
    (devices) => void broadcast({ type: "usb-updated", payload: { devices } })
  );
  void usbDeviceMonitor.start();
  musicLibraryService = createMusicLibraryService(store.getSettings());
  await musicLibraryService.start();
  musicPlaybackService = new MusicPlaybackService(
    (id) => musicLibraryService.getFilePath(id),
    (id) => {
      const record = store.getHistory().find((entry) => entry.id === id);
      return record ? mediaService.playbackSource(record) : null;
    }
  );
  protocol.handle(MUSIC_PLAYBACK_SCHEME, (request) => musicPlaybackService.handle(request));
  producerService = new ProducerService(
    store,
    (paths, expiresMinutes) =>
      transferService.registerSharedFiles(paths, expiresMinutes, "producer")
  );
  transferService.setAutomationHandler(async (rule, filePath, record) => {
    const value = rule.actionValue || rule.destinationSubfolder || rule.name;
    if (rule.action === "tag") {
      await store.updateTransferMetadata(record.id, {
        tags: [...(record.tags ?? []), value]
      });
      return;
    }
    if (rule.action === "share") {
      await transferService.registerSharedFiles([filePath], 24 * 60, "manual");
      return;
    }
    if (rule.action === "vault") {
      if (!vaultService.isUnlocked()) {
        throw new Error("Unlock Vault to complete this action.");
      }
      await vaultService.addFiles([filePath]);
      return;
    }
    if (rule.action === "producer") {
      await producerService.create(
        [filePath],
        {
          title: `${path.parse(filePath).name} Delivery`,
          artist: "DocDamage",
          notes: `Built automatically by “${rule.name}”.`
        },
        7 * 24 * 60
      );
    }
  });
  watchFolderService = new WatchFolderService(
    store,
    async (paths, folder) => {
      if (folder.mode === "producer") {
        await producerService.create(
          paths,
          {
            title: `${folder.name} ${new Date().toISOString().slice(0, 10)}`,
            artist: "",
            notes: `Created automatically from the ${folder.name} watch folder.`
          },
          folder.expiresMinutes
        );
        return;
      }
      await transferService.registerSharedFiles(
        paths,
        folder.expiresMinutes,
        "watch"
      );
    },
    () => productivityService.backupAllowed()
  );
  remoteBridge = new RemoteBridge(
    () => {
      const port = transferService.getConnectionInfo().port;
      return port ? `http://127.0.0.1:${port}/` : null;
    },
    () => store.getRemoteIdentity(),
    () => store.getTransferSecret(),
    () => transferService.getConnectionInfo().pin,
    () => void broadcast({ type: "connection-updated" })
  );
  diagnosticService = new DiagnosticService(
    store,
    app.getVersion(),
    () => remoteBridge.getStatus(store.getSettings().remoteRelayUrl),
    () => usbDeviceMonitor.refresh()
  );
  const initialSettings = store.getSettings();
  remoteBridge.configure(
    initialSettings.remoteAccessEnabled,
    initialSettings.remoteRelayUrl
  );
  watchFolderService.start();
  backupService.start();
  configureClipboardWatcher();
  recoveryIssues = await productivityService.recoveryIssues();
  await pruneCrashReports(userDataDirectory);
  process.on("uncaughtExceptionMonitor", (error) => {
    void writeCrashReport(userDataDirectory, "main-process", error);
  });
  process.on("unhandledRejection", (reason) => {
    void writeCrashReport(userDataDirectory, "unhandled-promise", reason);
  });
  app.on("render-process-gone", (_event, _contents, details) => {
    void writeCrashReport(
      userDataDirectory,
      "renderer-process",
      new Error(`${details.reason}; exit code ${details.exitCode}`)
    );
  });

  registerIpc();
  await createWindow();
  createTray();
  startNetworkWatcher();
  powerMonitor.on("resume", () => {
    void usbDeviceMonitor.refresh();
    void musicLibraryService.refresh();
    void transferService.restart().then(() => {
      const settings = store.getSettings();
      remoteBridge.configure(settings.remoteAccessEnabled, settings.remoteRelayUrl);
      void broadcast({ type: "connection-updated" });
    });
  });
  setTimeout(configureAutomaticUpdates, 4_000);
  if (process.platform === "win32") {
    app.setJumpList([
      {
        type: "tasks",
        items: [
          {
            type: "task",
            title: "Open PocketDock",
            program: process.execPath,
            args: "",
            iconPath: process.execPath,
            iconIndex: 0
          }
        ]
      }
    ]);
  }
  await handleShareArguments(process.argv);
});

app.on("before-quit", () => {
  isQuitting = true;
  if (networkWatcher) clearInterval(networkWatcher);
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  usbDeviceMonitor?.stop();
  musicLibraryService?.stop();
  watchFolderService?.stop();
  backupService?.stop();
  remoteBridge?.stop();
  vaultService?.lock();
  store?.close();
});

app.on("window-all-closed", () => {
  if (
    process.platform !== "darwin" &&
    (isQuitting || !store?.getSettings().minimizeToTray)
  ) {
    app.quit();
  }
});

app.on("activate", () => {
  const initialization = initializationPromise;
  if (initialization) void initialization.then(() => showOrCreateMainWindow());
});
