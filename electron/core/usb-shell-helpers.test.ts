import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface LayoutFixtureResult {
  classic: {
    ready: boolean;
    kind: string;
    rootName: string;
    mediaFolderCount: number;
  };
  flat: { ready: boolean; kind: string; buckets: string[] };
  legacyFlat: { ready: boolean; kind: string; buckets: string[] };
  arbitrary: { ready: boolean; kind: string };
  noisyDcf: { ready: boolean; kind: string };
  emptyDcf: { ready: boolean; kind: string };
  locked: { ready: boolean; kind: string };
  localizedStorageName: string;
  bucketNames: Record<string, boolean>;
}

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

describeOnWindows("Windows iPhone Shell media layouts", () => {
  it("recognizes classic and flattened Apple layouts without accepting arbitrary folders", () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/iphone-shell-layouts.ps1", import.meta.url)
    );
    const helperPath = fileURLToPath(
      new URL("../../scripts/windows/IPhoneShellHelpers.ps1", import.meta.url)
    );
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fixturePath,
        "-HelperPath",
        helperPath
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }
    );
    const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as LayoutFixtureResult;

    expect(result.classic).toEqual({
      ready: true,
      kind: "classic-dcim",
      rootName: "DCIM",
      mediaFolderCount: 1
    });
    expect(result.flat).toEqual({
      ready: true,
      kind: "flat-dcf",
      buckets: ["202506_a", "202504_d"]
    });
    expect(result.legacyFlat).toEqual({
      ready: true,
      kind: "flat-dcf",
      buckets: ["100APPLE", "101CLOUD"]
    });
    expect(result.arbitrary).toEqual({ ready: false, kind: "unknown" });
    expect(result.noisyDcf).toEqual({ ready: false, kind: "unknown-dcf" });
    expect(result.emptyDcf).toEqual({ ready: true, kind: "flat-dcf-empty" });
    expect(result.locked).toEqual({ ready: false, kind: "storage-locked" });
    expect(result.localizedStorageName).toBe("Stockage interne");
    expect(result.bucketNames).toEqual({
      recent: true,
      recentVariant: true,
      legacy: true,
      cloud: true,
      documents: false,
      incompleteDate: false,
      invalidMonth: false,
      randomFolder: false
    });
  }, 20_000);
});
