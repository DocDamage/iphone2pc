import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("PocketDock 4 mobile professional features", () => {
  it("keeps every new remote surface authenticated and permission gated", async () => {
    const source = await readFile(
      path.join(root, "electron/core/transfer-service.ts"),
      "utf8"
    );
    const authentication = source.indexOf('app.use("/api",');
    for (const route of [
      'app.get("/api/diagnostics/mobile"',
      'app.get("/api/studio/packages"',
      'app.get("/api/drive/search"'
    ]) {
      expect(source.indexOf(route)).toBeGreaterThan(authentication);
    }
    expect(source).toContain('app.use("/api/studio"');
    expect(source).toContain('this.permission(response, "receiveFromPc")');
  });

  it("ships durable transfer, Apple integration, migration, offline, and vault sources", async () => {
    const expected = [
      "TransferJournal.swift",
      "TransferActivityCoordinator.swift",
      "PocketDockIntents.swift",
      "PocketDockWidgets.swift",
      "PhotoMigrationService.swift",
      "OfflineDriveService.swift",
      "MobileVaultService.swift",
      "PocketDockMoreView.swift"
    ];
    const files = [
      path.join(root, "ios/PocketDock/TransferJournal.swift"),
      path.join(root, "ios/PocketDock/TransferActivityCoordinator.swift"),
      path.join(root, "ios/Shared/PocketDockIntents.swift"),
      path.join(root, "ios/PocketDockWidgets/PocketDockWidgets.swift"),
      path.join(root, "ios/PocketDock/PhotoMigrationService.swift"),
      path.join(root, "ios/PocketDock/OfflineDriveService.swift"),
      path.join(root, "ios/PocketDock/MobileVaultService.swift"),
      path.join(root, "ios/PocketDock/PocketDockMoreView.swift")
    ];
    await Promise.all(files.map(async (file, index) => {
      const source = await readFile(file, "utf8");
      expect(source.length, expected[index]).toBeGreaterThan(200);
    }));
  });
});
