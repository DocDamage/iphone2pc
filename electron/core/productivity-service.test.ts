import os from "node:os";
import path from "node:path";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { ProductivityService, isInsideBackupWindow } from "./productivity-service.js";
import { StateStore } from "./store.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function createDirectoryLink(
  target: string,
  linkPath: string,
  context: TestContext
): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      context.skip();
      return false;
    }
    throw error;
  }
}

describe("ProductivityService", () => {
  it("handles overnight and daytime backup windows", () => {
    expect(isInsideBackupWindow("22:00", "07:00", new Date(2026, 0, 1, 23, 0))).toBe(true);
    expect(isInsideBackupWindow("22:00", "07:00", new Date(2026, 0, 1, 12, 0))).toBe(false);
    expect(isInsideBackupWindow("09:00", "17:00", new Date(2026, 0, 1, 12, 0))).toBe(true);
  });

  it("browses approved roots and groups exact duplicates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-productivity-"));
    const drive = path.join(root, "drive");
    const staging = path.join(root, "staging");
    await mkdir(path.join(drive, "Beats", "Alternate Takes"), { recursive: true });
    await mkdir(staging, { recursive: true });
    const first = path.join(drive, "master.wav");
    const second = path.join(drive, "master-copy.wav");
    await writeFile(first, "same content");
    await writeFile(second, "same content");
    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    await store.updateSettings({ remoteBrowseRoot: drive });
    const hash = "a".repeat(64);
    for (const [index, savedPath] of [first, second].entries()) {
      await store.upsertTransfer({
        id: `transfer-${index}`,
        fileName: path.basename(savedPath),
        size: 12,
        mimeType: "audio/wav",
        direction: "iphone-to-pc",
        status: "completed",
        createdAt: new Date().toISOString(),
        sourceDevice: "iPhone",
        savedPath,
        sha256: hash
      });
    }
    const service = new ProductivityService(
      store,
      staging,
      () => ({
        running: true,
        url: null,
        pin: "123456",
        port: 42_890,
        addresses: ["192.168.1.10"],
        connectedDevices: 1,
        encryptionAvailable: true,
        trustedDevices: 1
      })
    );
    expect((await service.browse()).map((entry) => entry.name)).toEqual([
      "Beats",
      "master-copy.wav",
      "master.wav"
    ]);
    await writeFile(path.join(drive, "Beats", "Alternate Takes", "Misspelled Mastr.wav"), "take");
    const search = await service.searchDrive("mastr");
    expect(search).toHaveLength(1);
    expect(search[0].relativePath).toBe("Beats/Alternate Takes/Misspelled Mastr.wav");
    const duplicates = await service.duplicateGroups();
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reclaimableBytes).toBe(12);
    expect(await service.transportStatus()).toMatchObject({
      selected: "lan",
      available: ["lan"]
    });
    expect((await service.transportStatus()).reason).toContain(
      "USB remains a separate Camera Roll import capability"
    );
  });

  it("rejects Drive reads and writes through directory links", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-productivity-links-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const drive = path.join(root, "drive");
    const outside = path.join(root, "outside");
    const staging = path.join(root, "staging");
    await mkdir(drive);
    await mkdir(outside);
    await mkdir(staging);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    if (!await createDirectoryLink(outside, path.join(drive, "escape"), context)) return;

    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(async () => store.close());
    await store.updateSettings({ remoteBrowseRoot: drive });
    const service = new ProductivityService(store, staging, () => ({
      running: true,
      url: null,
      pin: "123456",
      port: 42_890,
      addresses: [],
      connectedDevices: 0,
      encryptionAvailable: true,
      trustedDevices: 0
    }));

    await expect(service.browse("escape")).rejects.toThrow(/unsafe|symbolic|junction/i);
    await expect(service.driveFilePath("escape/secret.txt")).rejects.toThrow(
      /unsafe|symbolic|junction/i
    );
    await expect(service.createFolder("escape/new-folder")).rejects.toThrow(
      /unsafe|symbolic|junction/i
    );
    await expect(access(path.join(outside, "new-folder"))).rejects.toThrow();
    expect(await access(path.join(outside, "secret.txt"))).toBeUndefined();
  });
});
