import os from "node:os";
import path from "node:path";
import { access, statfs, writeFile, rm } from "node:fs/promises";
import { getLanAddresses } from "./network.js";
import { StateStore } from "./store.js";
import type {
  AppSettings,
  DiagnosticCheck,
  DiagnosticReport,
  RemoteStatus
} from "./types.js";

export class DiagnosticService {
  constructor(
    private readonly store: StateStore,
    private readonly appVersion: string,
    private readonly remoteStatus: () => RemoteStatus,
    private readonly usbDevices: () => Promise<import("./types.js").UsbDevice[]> =
      async () => []
  ) {}

  async run(): Promise<DiagnosticReport> {
    const settings = this.store.getSettings();
    const checks: DiagnosticCheck[] = [];
    const addresses = getLanAddresses();
    checks.push({
      id: "network",
      label: "Private network adapter",
      status: addresses.length ? "pass" : "fail",
      detail: addresses.length
        ? `Available at ${addresses.join(", ")}`
        : "No usable IPv4 LAN address is available."
    });

    if (process.platform === "win32") {
      const usb = await this.usbDevices();
      const driver = usb.filter((device) => device.driverDetected);
      const ready = usb.filter((device) => device.status === "connected");
      checks.push({
        id: "usb-driver",
        label: "Apple USB driver",
        status: driver.length ? "pass" : "warning",
        detail: driver.length
          ? `${driver.map((device) => device.name).join(", ")} is physically visible to Windows.`
          : "No Apple USB driver is visible. Check the cable and Apple Devices installation."
      });
      checks.push({
        id: "usb-dcim",
        label: "Camera Roll USB access",
        status: ready.length ? "pass" : "warning",
        detail: ready.length
          ? `${ready.map((device) => device.name).join(", ")} exposes a readable Camera Roll media layout.`
          : usb[0]
            ? `${usb[0].description} ${usb[0].recommendedAction}`
            :
            "No iPhone is visible over USB. Unlock it, tap Trust, and install Apple Devices for Windows."
      });
    }

    try {
      await access(settings.destinationDirectory);
      const probe = path.join(
        settings.destinationDirectory,
        `.pocketdock-write-test-${process.pid}`
      );
      await writeFile(probe, "PocketDock diagnostic", { flag: "wx" });
      await rm(probe, { force: true });
      checks.push({
        id: "destination",
        label: "Destination access",
        status: "pass",
        detail: "PocketDock can read and write the selected destination."
      });
    } catch (error) {
      checks.push({
        id: "destination",
        label: "Destination access",
        status: "fail",
        detail: error instanceof Error ? error.message : "The destination is unavailable."
      });
    }

    try {
      const storage = await statfs(settings.destinationDirectory);
      const free = storage.bavail * storage.bsize;
      checks.push({
        id: "storage",
        label: "Free storage",
        status: free > 5 * 1024 ** 3 ? "pass" : free > 1024 ** 3 ? "warning" : "fail",
        detail: `${Math.round(free / 1024 ** 3)} GB is currently free.`
      });
    } catch {
      checks.push({
        id: "storage",
        label: "Free storage",
        status: "warning",
        detail: "Free space could not be measured for this destination."
      });
    }

    const integrity = this.store.databaseIntegrityCheck();
    checks.push({
      id: "database",
      label: "PocketDock database",
      status: integrity === "ok" ? "pass" : "fail",
      detail: `SQLite quick check: ${integrity}; schema v${this.store.databaseSchemaVersion()}.`
    });

    const remote = this.remoteStatus();
    checks.push({
      id: "relay",
      label: "Private relay",
      status: !remote.configured ? "warning" : remote.connected ? "pass" : "fail",
      detail: !remote.configured
        ? "Remote access is not configured; local transfers are unaffected."
        : remote.connected
          ? "The PC is connected to the configured opaque relay."
          : remote.lastError ?? "The configured relay is not connected."
    });

    checks.push({
      id: "security",
      label: "Transfer protection",
      status:
        settings.encryptTransfers && settings.verifyIntegrity ? "pass" : "warning",
      detail:
        settings.encryptTransfers && settings.verifyIntegrity
          ? "AES-256-GCM encryption and SHA-256 verification are enabled."
          : "Encryption or end-to-end verification has been disabled."
    });

    checks.push({
      id: "remote-tunnel",
      label: "Remote tunnel hardening",
      status:
        !remote.configured || remote.forwardSecrecyActive ? "pass" : "warning",
      detail:
        `Complete request envelopes use ephemeral X25519 session keys, direction-bound ` +
        `AES-256-GCM, and replay rejection. ` +
        `${remote.rejectedReplayCount ?? 0} replay attempt(s) rejected this session.`
    });

    const activeDevices = this.store
      .getTrustedDevices()
      .filter((device) => !device.revoked);
    checks.push({
      id: "device-trust",
      label: "Trusted-device access",
      status: activeDevices.length ? "pass" : "warning",
      detail: activeDevices.length
        ? `${activeDevices.length} active trusted device(s) have individual permissions.`
        : "No active trusted iPhone is saved; new devices must pair with the current PIN."
    });

    return {
      generatedAt: new Date().toISOString(),
      appVersion: this.appVersion,
      platform: `${process.platform} ${os.release()} (${process.arch})`,
      checks,
      redactedSettings: redactSettings(settings)
    };
  }
}

function redactSettings(settings: AppSettings): Partial<AppSettings> {
  return {
    port: settings.port,
    conflictPolicy: settings.conflictPolicy,
    maxConcurrentUploads: settings.maxConcurrentUploads,
    theme: settings.theme,
    verifyIntegrity: settings.verifyIntegrity,
    encryptTransfers: settings.encryptTransfers,
    trustedDeviceAutoConnect: settings.trustedDeviceAutoConnect,
    duplicatePolicy: settings.duplicatePolicy,
    organizeMode: settings.organizeMode,
    bandwidthLimitMbps: settings.bandwidthLimitMbps,
    clipboardSharing: settings.clipboardSharing,
    allowUsbImport: settings.allowUsbImport,
    autoUpdate: settings.autoUpdate,
    remoteAccessEnabled: settings.remoteAccessEnabled,
    language: settings.language,
    vaultAutoLockMinutes: settings.vaultAutoLockMinutes,
    pauseBackupOnBattery: settings.pauseBackupOnBattery,
    pauseBackupOnMeteredNetwork: settings.pauseBackupOnMeteredNetwork
  };
}
