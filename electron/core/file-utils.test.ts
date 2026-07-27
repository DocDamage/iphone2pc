import path from "node:path";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPathInside,
  resolveDestinationPath,
  sanitizeFileName,
  sanitizeRelativeDirectory,
  uniqueFilePath
} from "./file-utils.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("file path safety", () => {
  it("removes traversal and Windows-reserved characters", () => {
    expect(sanitizeFileName("../../CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName('beat<final>:"?.wav')).toBe("beat_final____.wav");
    expect(sanitizeRelativeDirectory("../../Sessions/../Beats")).toBe(
      path.join("Sessions", "Beats")
    );
  });

  it("recognizes paths inside the selected destination", () => {
    expect(isPathInside("/downloads/PocketDock", "/downloads/PocketDock/Photos/a.heic")).toBe(true);
    expect(isPathInside("/downloads/PocketDock", "/downloads/private/a.heic")).toBe(false);
  });

  it("keeps both files without overwriting the original", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-paths-"));
    temporaryDirectories.push(root);
    const original = path.join(root, "Beat.wav");
    await writeFile(original, "original");

    expect(await uniqueFilePath(original)).toBe(path.join(root, "Beat (2).wav"));
    const canonicalRoot = await realpath(root);
    const resolved = await resolveDestinationPath(root, "Beat.wav", "", "rename");
    expect(resolved).toEqual({
      finalPath: path.join(canonicalRoot, "Beat (2).wav"),
      skipped: false
    });
  });
});
