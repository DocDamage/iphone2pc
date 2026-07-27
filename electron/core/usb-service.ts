import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UsbDevice, UsbImportResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface UsbCommandOptions {
  windowsHide: boolean;
  timeout: number;
  maxBuffer: number;
}

export type UsbCommandRunner = (
  executable: string,
  args: string[],
  options: UsbCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface UsbServiceOptions {
  commandRunner?: UsbCommandRunner;
  platform?: NodeJS.Platform;
}

const runUsbCommand: UsbCommandRunner = async (executable, args, options) => {
  const { stdout, stderr } = await execFileAsync(executable, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

interface PowerShellDevice {
  InstanceId?: string;
  FriendlyName?: string;
  Status?: string;
  Description?: string;
  DiagnosticCode?: UsbDevice["diagnosticCode"];
  DriverDetected?: boolean;
  ShellDetected?: boolean;
  StorageDetected?: boolean;
  DcimDetected?: boolean;
  RecommendedAction?: string;
}

export function parseUsbDiscoveryOutput(output: string): UsbDevice[] {
  const trimmed = output.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as PowerShellDevice | PowerShellDevice[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((device) => {
    const connected = ["OK", "READY"].includes(String(device.Status).toUpperCase());
    const diagnosticCode = device.DiagnosticCode ??
      (connected ? "dcim-ready" : "trust-required");
    return {
      id: device.InstanceId ?? device.FriendlyName ?? "apple-device",
      name: device.FriendlyName ?? "Apple device",
      status: connected ? "connected" : "unavailable",
      description:
        device.Description ??
        (connected
          ? "Camera Roll access is ready"
          : "Unlock the iPhone, keep its screen on, and tap Trust"),
      diagnosticCode,
      driverDetected: device.DriverDetected ?? true,
      shellDetected: device.ShellDetected ?? connected,
      storageDetected: device.StorageDetected ?? connected,
      dcimDetected: device.DcimDetected ?? connected,
      recommendedAction:
        device.RecommendedAction ??
        (connected
          ? "Keep the iPhone unlocked until the import finishes."
          : "Unlock the iPhone, tap Trust, and scan again.")
    };
  });
}

function commandError(error: unknown, fallback: string): Error {
  if (!(error instanceof Error)) return new Error(fallback);
  const details = error as Error & { stderr?: string; stdout?: string };
  const message = [details.stderr, details.stdout, details.message]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  return new Error(message || fallback);
}

export class UsbService {
  private readonly commandRunner: UsbCommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly activePhotoImports = new Set<string>();

  constructor(
    private readonly scriptsDirectory: string,
    options: UsbServiceOptions = {}
  ) {
    this.commandRunner = options.commandRunner ?? runUsbCommand;
    this.platform = options.platform ?? process.platform;
  }

  async listDevices(): Promise<UsbDevice[]> {
    if (this.platform !== "win32") return [];
    const scriptPath = path.join(this.scriptsDirectory, "Find-IPhoneDevices.ps1");
    try {
      const { stdout } = await this.commandRunner(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath
        ],
        { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
      );
      return parseUsbDiscoveryOutput(stdout);
    } catch (error) {
      const message = commandError(error, "Windows could not scan its portable devices.").message;
      return [{
        id: "usb-scan-error",
        name: "USB scan needs attention",
        status: "unavailable",
        description: message.slice(0, 300),
        diagnosticCode: "scan-error",
        driverDetected: false,
        shellDetected: false,
        storageDetected: false,
        dcimDetected: false,
        recommendedAction: "Restart PocketDock and run the USB scan again."
      }];
    }
  }

  async importPhotos(deviceId: string, destination: string): Promise<UsbImportResult> {
    if (this.platform !== "win32") {
      throw new Error("USB photo import is available in the Windows build.");
    }
    const importKey = deviceId.trim().normalize("NFC").toLocaleLowerCase("en-US");
    if (this.activePhotoImports.has(importKey)) {
      throw new Error(
        "A DCIM import is already running for this iPhone. Wait for it to finish before starting another import."
      );
    }
    this.activePhotoImports.add(importKey);
    const scriptPath = path.join(this.scriptsDirectory, "Import-IPhonePhotos.ps1");
    try {
      const { stdout } = await this.commandRunner(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Destination",
          destination,
          "-DeviceId",
          deviceId
        ],
        { windowsHide: true, timeout: 2 * 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "{}") as {
        imported?: number;
        skipped?: number;
        failed?: number;
        bytes?: number;
        failures?: string[];
      };
      return {
        imported: Number(parsed.imported ?? 0),
        skipped: Number(parsed.skipped ?? 0),
        failed: Number(parsed.failed ?? 0),
        bytes: Number(parsed.bytes ?? 0),
        destination,
        failures: Array.isArray(parsed.failures)
          ? parsed.failures.map((failure) => String(failure).slice(0, 300))
          : []
      };
    } catch (error) {
      throw commandError(
        error,
        "USB import failed. Unlock the iPhone, tap Trust, and keep its screen on."
      );
    } finally {
      this.activePhotoImports.delete(importKey);
    }
  }

  async openAppleDevices(): Promise<string> {
    if (this.platform !== "win32") {
      throw new Error("Apple Devices is available from the Windows build.");
    }
    const scriptPath = path.join(this.scriptsDirectory, "Open-AppleDevices.ps1");
    const { stdout } = await this.commandRunner(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }
    );
    const result = stdout.replace(/^\uFEFF/, "").trim();
    return result || "Apple Devices opened.";
  }
}
