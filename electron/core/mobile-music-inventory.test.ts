import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("native iPhone music inventory", () => {
  it("requests Music access only through an explicit native action and exhausts every batch", async () => {
    const service = await readFile(
      path.join(root, "ios/PocketDock/MusicInventoryService.swift"),
      "utf8"
    );
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const view = await readFile(
      path.join(root, "ios/PocketDock/PocketDockMoreView.swift"),
      "utf8"
    );

    expect(service).toContain("MusicAuthorization.request()");
    expect(service).toContain("MusicLibraryRequest<Song>()");
    expect(service).toContain("request.includeOnlyDownloadedContent = false");
    expect(service).toContain("current.hasNextBatch");
    expect(service).toContain("current.nextBatch(limit: 100)");
    expect(service).toContain("generationSequence: nextGenerationSequence()");
    expect(service).toContain(".withFractionalSeconds");
    expect(model).toContain("func requestMusicLibraryAccess() async");
    expect(view).toContain("await model.requestMusicLibraryAccess()");
    expect(view).toContain('Label("Allow Music Access"');
  });

  it("keeps PocketDock Documents independent while surfacing automatic recovered originals", async () => {
    const documents = await readFile(
      path.join(root, "ios/PocketDock/USBDocumentService.swift"),
      "utf8"
    );
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const view = await readFile(
      path.join(root, "ios/PocketDock/PocketDockMoreView.swift"),
      "utf8"
    );

    expect(documents).toContain("manager.enumerator(");
    expect(documents).toContain("isAudio:");
    expect(model).toContain("let documents = try await usbDocumentService.items()");
    expect(model).toContain("guard musicInventoryEnabled else { return }");
    expect(model).not.toContain(
      "guard musicInventoryEnabled, musicInventoryAuthorization == .authorized"
    );
    expect(view).toContain("Recovered Music files are sent automatically when recovery is enabled");
    expect(view).toContain("Send All Manually Added Audio to PC");
    expect(view).toContain("confirmSendAll = true");
    expect(model).toContain("func sendAllMusicFilesToPC() async");
    expect(model).toContain('!$0.relativePath.hasPrefix("Recovered Music/")');
    expect(model).toContain("waitForCompletion: true");
  });

  it("recovers the complete DocRoshi Beats playlist first, then the remaining local library", async () => {
    const recovery = await readFile(
      path.join(root, "ios/PocketDock/MusicRecoveryService.swift"),
      "utf8"
    );
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const view = await readFile(
      path.join(root, "ios/PocketDock/PocketDockMoreView.swift"),
      "utf8"
    );

    expect(recovery).toContain('static let targetPlaylistName = "DocRoshi Beats"');
    expect(recovery).toContain("for playlist in targetPlaylists");
    expect(recovery).toContain("for (offset, item) in playlist.items.enumerated()");
    expect(recovery).toContain("for clueTitle in Self.clueTitles");
    expect(recovery).toContain("for item in allSongs {");
    expect(recovery.indexOf("for playlist in targetPlaylists")).toBeLessThan(
      recovery.indexOf("for clueTitle in Self.clueTitles")
    );
    expect(recovery.indexOf("for clueTitle in Self.clueTitles")).toBeLessThan(
      recovery.lastIndexOf("for item in allSongs {")
    );
    expect(recovery).toContain("candidate.item.hasProtectedAsset");
    expect(recovery).toContain("candidate.item.isCloudItem");
    expect(recovery).toContain("guard let assetURL = candidate.item.assetURL else");
    expect(recovery.indexOf("candidate.item.isCloudItem")).toBeGreaterThan(
      recovery.indexOf("guard let assetURL = candidate.item.assetURL else")
    );
    expect(recovery).toContain("asset.load(.isExportable)");
    expect(recovery).toContain("MusicRecoveryTargetItemStatus");
    expect(recovery).toContain("playlist-manifest.json");
    expect(recovery).toContain("quarantineCorruptFile");
    expect(model).toContain("await recoverMusicIfReady()");
    expect(model).toContain("await deliverRecoveredMusicIfConnected()");
    expect(model).toContain("func sceneBecameActive() async");
    expect(model).toContain("musicRecoveryTask?.cancel()");
    expect(model).toContain("musicRecoveryService.markSent");
    expect(view).toContain("Retry / Recover Now");
    expect(view).toContain("Pause Recovery");
    expect(view).toContain("DocRoshi Beats found");
    expect(view).toContain("Ordered DocRoshi entries");
  });

  it("binds recovered queue reuse to verified content and retires duplicate rows", async () => {
    const recovery = await readFile(
      path.join(root, "ios/PocketDock/MusicRecoveryService.swift"),
      "utf8"
    );
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const models = await readFile(path.join(root, "ios/PocketDock/Models.swift"), "utf8");
    const journal = await readFile(
      path.join(root, "ios/PocketDock/TransferJournal.swift"),
      "utf8"
    );

    expect(recovery).toContain("let sha256: String");
    expect(recovery).toContain("sha256: record.sha256");
    expect(recovery).toContain("firstManifestPosition");
    expect(recovery).toContain("func deliveryIsRecorded");
    expect(models).toContain("var recoverySHA256: String? = nil");
    expect(journal).toContain("func stageVerified");
    expect(journal).toContain("func fileMatchesSHA256");
    expect(journal).toContain("try sha256(of: url) == expected.lowercased()");
    expect(model).toContain("transfers[selectedIndex].recoverySHA256 == file.sha256");
    expect(model).toContain("prepareRecoveredTransferForUpload");
    expect(model).toContain("retireDuplicateRecoveredTransfers");
    expect(model).toContain("An unbound legacy completion cannot prove which bytes");
    expect(model.indexOf("recoveryHashMatches")).toBeLessThan(
      model.indexOf("verifiedForThisConnection")
    );
  });

  it("reconnects once on foreground or Bonjour appearance without coupling vault auth", async () => {
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const reconnectStart = model.indexOf("private func reconnectAndDeliverRecoveredMusicIfNeeded");
    const reconnectEnd = model.indexOf(
      "private func performAutomaticReconnectOrRefresh",
      reconnectStart
    );
    const reconnect = model.slice(reconnectStart, reconnectEnd);
    const vaultStart = model.indexOf("func unlockVault() async");
    const vaultEnd = model.indexOf("func lockVault()", vaultStart);
    const vault = model.slice(vaultStart, vaultEnd);

    expect(model).toContain("automaticReconnectTask: Task<Void, Never>?");
    expect(model).toContain("newlyAppearedDockIDs");
    expect(model).toContain("bypassReconnectCooldown: true");
    expect(model).toContain("await self?.performAutomaticReconnectOrRefresh(saved)");
    expect(reconnect).toContain("await running.value");
    expect(reconnect.indexOf("performAutomaticReconnectOrRefresh")).toBeLessThan(
      reconnect.indexOf("await deliverRecoveredMusicIfConnected()")
    );
    expect(vault).toContain("authenticateDeviceOwner");
    expect(vault).not.toContain("await unlock()");
    expect(vault).not.toContain("isUnlocked =");
    expect(model).toContain("if hasStartedAfterUnlock {");
  });

  it("keeps Send All single-flight, cancellable, sequential, and path faithful", async () => {
    const model = await readFile(path.join(root, "ios/PocketDock/AppModel.swift"), "utf8");
    const view = await readFile(
      path.join(root, "ios/PocketDock/PocketDockMoreView.swift"),
      "utf8"
    );

    expect(model).toContain("@Published private(set) var isSendingAllMusicFiles = false");
    expect(model).toContain("guard !isSendingAllMusicFiles else");
    expect(model).toContain("for (index, item) in audioFiles.enumerated()");
    expect(model).toContain("guard await sendMusicDocument(item) else");
    expect(model).toContain("UploadSource(url: $0.url, relativePath: $0.relativePath)");
    expect(model).toContain("guard let task = startTransfer(id) else { return false }");
    expect(model).toContain("await task.value");
    expect(model).toContain("guard completed else { return false }");
    expect(model).toContain("transferTasks[id]?.cancel()");
    expect(model).toContain("Task.isCancelled");
    expect(model).toContain("(error as? URLError)?.code == .cancelled");
    expect(model).toContain("try await transferJournal.removeStagedFile(for: completedTransfer)");
    expect(model).toContain("transfers[completedIndex].localPath = nil");
    expect(model.indexOf("transfers[index].completed = true")).toBeLessThan(
      model.indexOf("try await transferJournal.removeStagedFile(for: completedTransfer)")
    );
    expect(view).toContain("model.isSendingAllMusicFiles");
    expect(view).toContain("Pausing or failing the active transfer stops the batch");
    expect(view).toContain("Folder paths are preserved.");
  });

  it("sends only a complete encrypted manifest through the authenticated API", async () => {
    const models = await readFile(path.join(root, "ios/PocketDock/Models.swift"), "utf8");
    const client = await readFile(
      path.join(root, "ios/PocketDock/PocketDockClient.swift"),
      "utf8"
    );
    const info = await readFile(path.join(root, "ios/PocketDock/Info.plist"), "utf8");
    const entitlements = await readFile(
      path.join(root, "ios/PocketDock/PocketDock.entitlements"),
      "utf8"
    );

    expect(models).toContain("let complete: Bool");
    expect(models).toContain("let duration: Double?");
    expect(models).toContain("let track: Int?");
    expect(models).toContain("let disc: Int?");
    expect(client).toContain('path: "/api/music/inventory"');
    expect(client).toContain('method: "PUT"');
    expect(client).toContain(
      'identifier: "music-inventory:\\(connection.deviceId.uuidString.lowercased())"'
    );
    expect(client).toContain('"X-PocketDock-IV"');
    expect(info).toContain("NSAppleMusicUsageDescription");
    expect(entitlements).not.toContain("com.apple.developer.musickit");
  });

  it("checks the final encrypted relay envelope before creating an oversized frame", async () => {
    const client = await readFile(
      path.join(root, "ios/PocketDock/PocketDockClient.swift"),
      "utf8"
    );
    const transport = await readFile(
      path.join(root, "ios/PocketDock/RelayTransport.swift"),
      "utf8"
    );
    const relayServer = await readFile(path.join(root, "relay/src/server.ts"), "utf8");

    expect(client).toContain("guard plaintext.count <= 8_000_000");
    expect(transport).toContain("private static let maximumMessageBytes = 8_500_000");
    expect(relayServer).toContain(
      "process.env.MAX_MESSAGE_BYTES ?? 8_500_000"
    );
    expect(transport).toContain("guard tunneled.count <= Self.maximumMessageBytes");
    expect(transport).toContain("too large for PocketDock Relay after encryption");
    expect(transport.indexOf("guard tunneled.count <= Self.maximumMessageBytes")).toBeLessThan(
      transport.indexOf("task.send(.string(text))")
    );
  });
});
