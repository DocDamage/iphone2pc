import { describe, expect, it, vi } from "vitest";
import { parseUsbDiscoveryOutput, UsbService } from "./usb-service.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("USB device discovery", () => {
  it("normalizes one ready Shell device", () => {
    expect(
      parseUsbDiscoveryOutput(
        '{"InstanceId":"shell:Doc iPhone","FriendlyName":"Doc iPhone","Status":"Ready","Description":"Camera Roll access is ready","DiagnosticCode":"dcim-ready","DriverDetected":true,"ShellDetected":true,"StorageDetected":true,"DcimDetected":true,"RecommendedAction":"Keep it unlocked."}'
      )
    ).toEqual([
      {
        id: "shell:Doc iPhone",
        name: "Doc iPhone",
        status: "connected",
        description: "Camera Roll access is ready",
        diagnosticCode: "dcim-ready",
        driverDetected: true,
        shellDetected: true,
        storageDetected: true,
        dcimDetected: true,
        recommendedAction: "Keep it unlocked."
      }
    ]);
  });

  it("does not confuse a PnP cable with usable DCIM access", () => {
    const devices = parseUsbDiscoveryOutput(
      '\uFEFF[{"InstanceId":"pnp:1","FriendlyName":"Apple iPhone","Status":"Unavailable","DiagnosticCode":"driver-only","DriverDetected":true,"ShellDetected":false,"StorageDetected":false,"DcimDetected":false,"RecommendedAction":"Unlock, Trust, and scan again."}]'
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      status: "unavailable",
      name: "Apple iPhone",
      diagnosticCode: "driver-only",
      driverDetected: true,
      shellDetected: false,
      storageDetected: false,
      dcimDetected: false
    });
  });

  it("keeps a storage-visible iPhone present when DCIM is missing", () => {
    const devices = parseUsbDiscoveryOutput(
      '{"InstanceId":"shell:Apple iPhone","FriendlyName":"Apple iPhone","Status":"Unavailable","Description":"Internal Storage is visible, but no DCIM folder is exposed.","DiagnosticCode":"dcim-missing","DriverDetected":true,"ShellDetected":true,"StorageDetected":true,"DcimDetected":false,"RecommendedAction":"Open Camera, take or download a photo, then scan again."}'
    );

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      name: "Apple iPhone",
      status: "unavailable",
      diagnosticCode: "dcim-missing",
      driverDetected: true,
      shellDetected: true,
      storageDetected: true,
      dcimDetected: false
    });
  });

  it("keeps compatibility with the original discovery schema", () => {
    expect(
      parseUsbDiscoveryOutput(
        '{"InstanceId":"shell:iPhone","FriendlyName":"iPhone","Status":"OK"}'
      )[0]
    ).toMatchObject({
      status: "connected",
      diagnosticCode: "dcim-ready",
      dcimDetected: true
    });
  });

  it("handles an empty PowerShell result", () => {
    expect(parseUsbDiscoveryOutput(" \r\n")).toEqual([]);
  });

  it("rejects a concurrent DCIM import for the same iPhone and releases the guard", async () => {
    const heldImport = deferred<{ stdout: string; stderr: string }>();
    const commandRunner = vi.fn()
      .mockImplementationOnce(() => heldImport.promise)
      .mockResolvedValue({
        stdout: '{"imported":1,"skipped":0,"failed":0,"bytes":12}',
        stderr: ""
      });
    const service = new UsbService("C:\\PocketDock\\scripts", {
      commandRunner,
      platform: "win32"
    });

    const firstImport = service.importPhotos("shell:Doc iPhone", "C:\\DCIM");
    await expect(
      service.importPhotos("shell:Doc iPhone", "C:\\Other DCIM")
    ).rejects.toThrow("already running for this iPhone");
    expect(commandRunner).toHaveBeenCalledTimes(1);

    heldImport.resolve({
      stdout: '{"imported":2,"skipped":0,"failed":0,"bytes":24}',
      stderr: ""
    });
    await expect(firstImport).resolves.toMatchObject({ imported: 2, bytes: 24 });
    await expect(
      service.importPhotos("shell:Doc iPhone", "C:\\DCIM")
    ).resolves.toMatchObject({ imported: 1, bytes: 12 });
    expect(commandRunner).toHaveBeenCalledTimes(2);
  });
});
