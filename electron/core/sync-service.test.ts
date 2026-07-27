import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { resolveDestinationPath } from "./file-utils.js";
import { StateStore } from "./store.js";
import { SyncService } from "./sync-service.js";

const cleanup: Array<() => Promise<void> | void> = [];

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

describe("SyncService", () => {
  it("builds filtered manifests, blocks traversal, and recoverably archives deletions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-sync-"));
    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => store.close());

    const syncRoot = path.join(root, "session");
    const service = new SyncService(store);
    const profile = await service.createProfile(syncRoot, "Album");
    await service.updateProfile(profile.id, { includeExtensions: ["wav"] });
    await writeFile(path.join(syncRoot, "lead.wav"), "audio");
    await writeFile(path.join(syncRoot, "notes.txt"), "ignore");

    const manifest = await service.run(profile.id);
    expect(manifest.map((entry) => entry.relativePath)).toEqual(["lead.wav"]);
    await expect(service.localFilePath(profile.id, "../escape.wav")).rejects.toThrow(/unsafe/i);

    await service.archiveDeleted(profile.id, ["lead.wav"]);
    await expect(access(path.join(syncRoot, "lead.wav"))).rejects.toThrow();
    const archived = path.join(
      syncRoot,
      ".pocketdock-archive"
    );
    const archivedFiles = await import("node:fs/promises").then(({ readdir }) =>
      readdir(archived, { recursive: true })
    );
    const archivedLead = archivedFiles.find((name) => String(name).endsWith("lead.wav"));
    expect(archivedLead).toBeTruthy();
    expect(await readFile(path.join(archived, String(archivedLead)), "utf8")).toBe("audio");

    await service.updateProfile(profile.id, { direction: "iphone-to-pc" });
    await expect(service.localFilePath(profile.id, "notes.txt")).rejects.toThrow(/does not send/i);
    expect(await service.manifest(profile.id)).toEqual([]);

    await service.updateProfile(profile.id, { enabled: false });
    await expect(service.manifest(profile.id)).rejects.toThrow(/disabled/i);
    await expect(service.incomingDestination(profile.id, "incoming.txt")).rejects.toThrow(/disabled/i);

    await service.updateProfile(profile.id, { enabled: true });
    expect(await service.incomingDestination(profile.id, "incoming.txt")).toContain("incoming.txt");
  });

  it("rejects sync reads and incoming writes through directory links", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-sync-links-"));
    const store = new StateStore(path.join(root, "data"));
    await store.load();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => store.close());

    const syncRoot = path.join(root, "session");
    const outside = path.join(root, "outside");
    await mkdir(syncRoot);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    if (!await createDirectoryLink(outside, path.join(syncRoot, "escape"), context)) return;

    const service = new SyncService(store);
    const profile = await service.createProfile(syncRoot, "Linked Album");
    await expect(service.localFilePath(profile.id, "escape/secret.txt")).rejects.toThrow(
      /unsafe|symbolic|junction/i
    );
    await expect(service.incomingDestination(profile.id, "escape/new.txt")).rejects.toThrow(
      /unsafe|symbolic|junction/i
    );
    expect(await service.manifest(profile.id)).toEqual([]);

    const incomingRoot = await service.incomingDestination(profile.id, "");
    await expect(
      resolveDestinationPath(incomingRoot, "new.txt", "escape", "rename")
    ).rejects.toThrow(/unsafe|symbolic|junction/i);
    await expect(access(path.join(outside, "new.txt"))).rejects.toThrow();
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
  });
});
