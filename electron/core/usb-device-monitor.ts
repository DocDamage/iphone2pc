import type { UsbDevice } from "./types.js";

export const DEFAULT_USB_STARTUP_RETRY_DELAYS_MS = [1_500, 4_000, 10_000] as const;
export const DEFAULT_USB_POLL_INTERVAL_MS = 15_000;

export interface UsbDeviceMonitorOptions {
  startupRetryDelaysMs?: readonly number[];
  pollIntervalMs?: number;
}

export type UsbDeviceScan = () => Promise<UsbDevice[]>;
export type UsbDeviceChangeHandler = (devices: UsbDevice[]) => void;

type TimerHandle = ReturnType<typeof setTimeout>;

function cloneDevice(device: UsbDevice): UsbDevice {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    description: device.description,
    diagnosticCode: device.diagnosticCode,
    driverDetected: device.driverDetected,
    shellDetected: device.shellDetected,
    storageDetected: device.storageDetected,
    dcimDetected: device.dcimDetected,
    recommendedAction: device.recommendedAction
  };
}

function deviceSortKey(device: UsbDevice): string {
  return JSON.stringify([
    device.id,
    device.name,
    device.status,
    device.description,
    device.diagnosticCode,
    device.driverDetected,
    device.shellDetected,
    device.storageDetected,
    device.dcimDetected,
    device.recommendedAction
  ]);
}

function normalizeDevices(devices: readonly UsbDevice[]): UsbDevice[] {
  return devices
    .map(cloneDevice)
    .sort((left, right) => {
      const leftKey = deviceSortKey(left);
      const rightKey = deviceSortKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function normalizedDelays(delays: readonly number[]): number[] {
  return delays.filter((delay) => Number.isFinite(delay) && delay >= 0);
}

function unrefTimer(timer: TimerHandle): void {
  const candidate = timer as TimerHandle & { unref?: () => void };
  candidate.unref?.();
}

export class UsbDeviceMonitor {
  private readonly startupRetryDelaysMs: number[];
  private readonly pollIntervalMs: number;
  private readonly timers = new Set<TimerHandle>();
  private devices: UsbDevice[] = [];
  private signature = "[]";
  private inFlight: Promise<UsbDevice[]> | null = null;
  private running = false;
  private generation = 0;

  constructor(
    private readonly scan: UsbDeviceScan,
    private readonly onChange: UsbDeviceChangeHandler,
    options: UsbDeviceMonitorOptions = {}
  ) {
    this.startupRetryDelaysMs = normalizedDelays(
      options.startupRetryDelaysMs ?? DEFAULT_USB_STARTUP_RETRY_DELAYS_MS
    );
    const requestedPollInterval = options.pollIntervalMs ?? DEFAULT_USB_POLL_INTERVAL_MS;
    this.pollIntervalMs = Number.isFinite(requestedPollInterval) && requestedPollInterval > 0
      ? requestedPollInterval
      : 0;
  }

  async start(): Promise<UsbDevice[]> {
    this.stop();
    this.running = true;
    const generation = this.generation;
    const devices = await this.refresh();

    if (this.isCurrent(generation)) {
      for (const delay of this.startupRetryDelaysMs) {
        this.schedule(delay, generation, async () => {
          await this.refresh();
        });
      }
      this.schedulePoll(generation);
    }

    return devices;
  }

  async refresh(): Promise<UsbDevice[]> {
    if (!this.running) return this.getDevices();
    if (this.inFlight) return this.inFlight;

    const generation = this.generation;
    const operation = (async (): Promise<UsbDevice[]> => {
      try {
        const scannedDevices = await this.scan();
        if (this.isCurrent(generation)) {
          this.replaceDevices(normalizeDevices(scannedDevices));
        }
      } catch {
        // A transient discovery failure must not erase the last known device state.
      }
      return this.getDevices();
    })();

    this.inFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  /** Manual scan path: keep cached devices intact while allowing UI callers to report failures. */
  async refreshOrThrow(): Promise<UsbDevice[]> {
    if (!this.running) throw new Error("USB device monitoring is not running.");
    const generation = this.generation;
    const scannedDevices = normalizeDevices(await this.scan());
    if (this.isCurrent(generation)) this.replaceDevices(scannedDevices);
    return this.getDevices();
  }

  getDevices(): UsbDevice[] {
    return this.devices.map(cloneDevice);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.inFlight = null;
  }

  private replaceDevices(devices: UsbDevice[]): void {
    const nextSignature = JSON.stringify(devices);
    if (nextSignature === this.signature) return;

    this.devices = devices;
    this.signature = nextSignature;
    try {
      this.onChange(this.getDevices());
    } catch {
      // A listener cannot be allowed to stop monitoring.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private schedule(
    delayMs: number,
    generation: number,
    callback: () => Promise<void>
  ): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.isCurrent(generation)) return;
      void callback().catch(() => undefined);
    }, delayMs);
    this.timers.add(timer);
    unrefTimer(timer);
  }

  private schedulePoll(generation: number): void {
    if (!this.pollIntervalMs || !this.isCurrent(generation)) return;
    this.schedule(this.pollIntervalMs, generation, async () => {
      await this.refresh();
      if (this.isCurrent(generation)) this.schedulePoll(generation);
    });
  }
}
