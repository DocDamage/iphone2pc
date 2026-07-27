import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsbDevice } from "./types.js";
import { UsbDeviceMonitor } from "./usb-device-monitor.js";

function usbDevice(id: string, patch: Partial<UsbDevice> = {}): UsbDevice {
  return {
    id,
    name: `iPhone ${id}`,
    status: "unavailable",
    description: "Cable detected",
    diagnosticCode: "driver-only",
    driverDetected: true,
    shellDetected: false,
    storageDetected: false,
    dcimDetected: false,
    recommendedAction: "Unlock and trust this computer.",
    ...patch
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UsbDeviceMonitor", () => {
  it("scans immediately on start and exposes normalized defensive copies", async () => {
    const scanned = [usbDevice("z"), usbDevice("a")];
    const scan = vi.fn(async () => scanned);
    const onChange = vi.fn();
    const monitor = new UsbDeviceMonitor(scan, onChange, {
      startupRetryDelaysMs: [],
      pollIntervalMs: 0
    });

    const startedDevices = await monitor.start();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(startedDevices.map((device) => device.id)).toEqual(["a", "z"]);
    expect(onChange).toHaveBeenCalledTimes(1);

    scanned[0]!.name = "Changed scan result";
    startedDevices[0]!.name = "Changed start result";
    const notifiedDevices = onChange.mock.calls[0]![0] as UsbDevice[];
    notifiedDevices[0]!.name = "Changed notification";
    expect(monitor.getDevices().map((device) => device.name)).toEqual([
      "iPhone a",
      "iPhone z"
    ]);
    monitor.stop();
  });

  it("uses bounded startup retries to pick up delayed Windows enumeration", async () => {
    vi.useFakeTimers();
    const driverOnly = usbDevice("phone");
    const dcimReady = usbDevice("phone", {
      status: "connected",
      description: "Camera Roll access is ready",
      diagnosticCode: "dcim-ready",
      shellDetected: true,
      storageDetected: true,
      dcimDetected: true
    });
    const results = [[], [driverOnly], [dcimReady]];
    const scan = vi.fn(async () => results.shift() ?? [dcimReady]);
    const onChange = vi.fn();
    const monitor = new UsbDeviceMonitor(scan, onChange, {
      startupRetryDelaysMs: [100, 200],
      pollIntervalMs: 0
    });

    await monitor.start();
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.getDevices()[0]).toMatchObject({
      id: "phone",
      driverDetected: true,
      dcimDetected: false
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.getDevices()[0]).toMatchObject({
      id: "phone",
      dcimDetected: true
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("polls recursively after each completed scan without overlap", async () => {
    vi.useFakeTimers();
    const heldScan = deferred<UsbDevice[]>();
    const scan = vi
      .fn<() => Promise<UsbDevice[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => heldScan.promise)
      .mockResolvedValueOnce([]);
    const monitor = new UsbDeviceMonitor(scan, vi.fn(), {
      startupRetryDelaysMs: [],
      pollIntervalMs: 100
    });

    await monitor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(2);

    heldScan.resolve([usbDevice("phone")]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("coalesces concurrent refreshes into one discovery scan", async () => {
    const heldScan = deferred<UsbDevice[]>();
    const scan = vi
      .fn<() => Promise<UsbDevice[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => heldScan.promise);
    const monitor = new UsbDeviceMonitor(scan, vi.fn(), {
      startupRetryDelaysMs: [],
      pollIntervalMs: 0
    });
    await monitor.start();

    const first = monitor.refresh();
    const second = monitor.refresh();
    expect(scan).toHaveBeenCalledTimes(2);

    heldScan.resolve([usbDevice("phone")]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(scan).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("ignores ordering-only changes, preserves cache on errors, and emits removal", async () => {
    const first = [usbDevice("b"), usbDevice("a")];
    const reordered = [usbDevice("a"), usbDevice("b")];
    const scan = vi
      .fn<() => Promise<UsbDevice[]>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(reordered)
      .mockRejectedValueOnce(new Error("temporary WPD failure"))
      .mockResolvedValueOnce([]);
    const onChange = vi.fn();
    const monitor = new UsbDeviceMonitor(scan, onChange, {
      startupRetryDelaysMs: [],
      pollIntervalMs: 0
    });

    await monitor.start();
    await monitor.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(await monitor.refresh()).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    await monitor.refresh();
    expect(monitor.getDevices()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0]).toEqual([]);
    monitor.stop();
  });

  it("clears scheduled work and generation-guards a late scan after stop", async () => {
    vi.useFakeTimers();
    const heldScan = deferred<UsbDevice[]>();
    const scan = vi.fn(() => heldScan.promise);
    const onChange = vi.fn();
    const monitor = new UsbDeviceMonitor(scan, onChange, {
      startupRetryDelaysMs: [100],
      pollIntervalMs: 100
    });

    const start = monitor.start();
    monitor.stop();
    heldScan.resolve([usbDevice("late-phone")]);
    await start;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(monitor.getDevices()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("surfaces a manual scan failure while keeping the last detected phone", async () => {
    const scan = vi
      .fn<() => Promise<UsbDevice[]>>()
      .mockResolvedValueOnce([usbDevice("kept")])
      .mockRejectedValueOnce(new Error("Apple device scan failed"));
    const monitor = new UsbDeviceMonitor(scan, vi.fn(), {
      startupRetryDelaysMs: [],
      pollIntervalMs: 0
    });
    await monitor.start();

    await expect(monitor.refreshOrThrow()).rejects.toThrow("Apple device scan failed");
    expect(monitor.getDevices()).toEqual([usbDevice("kept")]);
    monitor.stop();
  });
});
