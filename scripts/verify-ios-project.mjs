import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve("ios");
const required = [
  "project.yml",
  "PocketDock/PocketDockApp.swift",
  "PocketDock/AppModel.swift",
  "PocketDock/PocketDockClient.swift",
  "PocketDock/BackgroundTransferSession.swift",
  "PocketDock/TransferJournal.swift",
  "PocketDock/TransferActivityCoordinator.swift",
  "PocketDock/DiscoveryService.swift",
  "PocketDock/PhotoMigrationService.swift",
  "PocketDock/OfflineDriveService.swift",
  "PocketDock/MobileVaultService.swift",
  "PocketDock/USBDocumentService.swift",
  "PocketDock/MusicInventoryService.swift",
  "PocketDock/MusicRecoveryService.swift",
  "PocketDock/PocketDockMoreView.swift",
  "PocketDock/RelayTransport.swift",
  "PocketDock/PhotoBackupService.swift",
  "PocketDock/ContactBackupService.swift",
  "PocketDock/FolderSyncService.swift",
  "PocketDock/FileProviderBridgeStore.swift",
  "PocketDock/Info.plist",
  "PocketDock/PocketDock.entitlements",
  "PocketDock/en.lproj/Localizable.strings",
  "PocketDock/es.lproj/Localizable.strings",
  "PocketDock/Assets.xcassets/Contents.json",
  "PocketDock/Assets.xcassets/AppIcon.appiconset/Contents.json",
  "PocketDock/Assets.xcassets/PocketDockBrandMark.imageset/Contents.json",
  "PocketDockShare/ShareViewController.swift",
  "PocketDockShare/Info.plist",
  "PocketDockShare/PocketDockShare.entitlements",
  "PocketDockFileProvider/FileProviderExtension.swift",
  "PocketDockFileProvider/Info.plist",
  "PocketDockFileProvider/PocketDockFileProvider.entitlements",
  "PocketDockWidgets/PocketDockWidgets.swift",
  "PocketDockWidgets/Info.plist",
  "PocketDockWidgets/PocketDockWidgets.entitlements",
  "Shared/CryptoBox.swift",
  "Shared/KeychainStore.swift",
  "Shared/TransferActivityAttributes.swift",
  "Shared/PocketDockIntents.swift"
];

for (const relative of required) {
  const content = await readFile(path.join(root, relative), "utf8");
  if (!content.trim()) throw new Error(`${relative} is empty.`);
  if (
    (relative.endsWith(".plist") || relative.endsWith(".entitlements")) &&
    (!content.includes("<plist version=\"1.0\">") || !content.includes("</plist>"))
  ) {
    throw new Error(`${relative} is not a complete Apple property list.`);
  }
}

const project = await readFile(path.join(root, "project.yml"), "utf8");
if (!project.includes('MARKETING_VERSION: 4.0.1')) {
  throw new Error("The native target version is not PocketDock 4.0.1.");
}
for (const framework of ["AVFoundation.framework", "MediaPlayer.framework"]) {
  if (!project.includes(`sdk: ${framework}`)) {
    throw new Error(`The native recovery target is missing ${framework}.`);
  }
}
for (const target of ["PocketDock:", "PocketDockShare:", "PocketDockFileProvider:", "PocketDockWidgets:"]) {
  if (!project.includes(target)) throw new Error(`The native project is missing ${target}`);
}
const info = await readFile(path.join(root, "PocketDock/Info.plist"), "utf8");
for (const capability of [
  "NSPhotoLibraryUsageDescription",
  "NSAppleMusicUsageDescription",
  "NSContactsUsageDescription",
  "BGTaskSchedulerPermittedIdentifiers",
  "CFBundleURLTypes",
  "NSSupportsLiveActivities",
  "UIApplicationSupportsMultipleScenes",
  "UIFileSharingEnabled",
  "LSSupportsOpeningDocumentsInPlace"
]) {
  if (!info.includes(capability)) throw new Error(`Info.plist is missing ${capability}.`);
}
if (!info.includes("recover locally stored, unprotected songs you own")) {
  throw new Error("The Music privacy purpose does not explain local-track recovery.");
}
const musicInventory = await readFile(
  path.join(root, "PocketDock/MusicInventoryService.swift"),
  "utf8"
);
for (const behavior of [
  "MusicAuthorization.request()",
  "MusicLibraryRequest<Song>()",
  "current.nextBatch(limit: 100)",
  "complete: true"
]) {
  if (!musicInventory.includes(behavior)) {
    throw new Error(`The iPhone music inventory is missing ${behavior}.`);
  }
}
const client = await readFile(path.join(root, "PocketDock/PocketDockClient.swift"), "utf8");
for (const behavior of [
  'path: "/api/music/inventory"',
  'method: "PUT"',
  'identifier: "music-inventory:',
  '"X-PocketDock-Plain-Length"'
]) {
  if (!client.includes(behavior)) {
    throw new Error(`The encrypted iPhone inventory client is missing ${behavior}.`);
  }
}
const relayTransport = await readFile(
  path.join(root, "PocketDock/RelayTransport.swift"),
  "utf8"
);
const relayServer = await readFile(path.resolve("relay/src/server.ts"), "utf8");
const iosRelayLimit = relayTransport.match(/maximumMessageBytes\s*=\s*([\d_]+)/)?.[1];
const serverRelayLimit = relayServer.match(/MAX_MESSAGE_BYTES\s*\?\?\s*([\d_]+)/)?.[1];
if (!iosRelayLimit || iosRelayLimit !== serverRelayLimit) {
  throw new Error("The iOS and server relay message limits do not match.");
}
const relaySizeGuard = "guard tunneled.count <= Self.maximumMessageBytes";
if (
  !relayTransport.includes(relaySizeGuard) ||
  relayTransport.indexOf(relaySizeGuard) > relayTransport.indexOf("task.send(.string(text))")
) {
  throw new Error("The iOS relay must reject an oversized final tunnel before sending it.");
}
const moreView = await readFile(path.join(root, "PocketDock/PocketDockMoreView.swift"), "utf8");
for (const behavior of [
  "Allow Music Access",
  "Automatic local-music recovery",
  "Retry / Recover Now",
  "DocRoshi Beats found",
  "Verification titles",
  "Whole-library totals",
  "Ordered DocRoshi entries",
  "PocketDock Files · transferable originals",
  "Send All Manually Added Audio to PC",
  "Pause Recovery"
]) {
  if (!moreView.includes(behavior)) {
    throw new Error(`The native Music Library UI is missing ${behavior}.`);
  }
}
const musicRecovery = await readFile(
  path.join(root, "PocketDock/MusicRecoveryService.swift"),
  "utf8"
);
for (const behavior of [
  "import MediaPlayer",
  'targetPlaylistName = "DocRoshi Beats"',
  '"the abandoning"',
  '"Alien Graveyard"',
  '"ding dong mfer"',
  "MPMediaQuery.playlists()",
  "MPMediaQuery.songs()",
  "for (offset, item) in playlist.items.enumerated()",
  "item.hasProtectedAsset",
  "item.isCloudItem",
  "item.assetURL",
  "asset.load(.hasProtectedContent)",
  "asset.load(.isExportable)",
  "AVAssetExportPresetPassthrough",
  "AVAssetExportPresetAppleM4A",
  'appendingPathComponent("Recovered Music"',
  'appendingPathComponent("completed-items.json")',
  "sha256: try sha256(of: destination)",
  "digest == record.sha256",
  "sentConnectionIDs",
  "func markSent",
  "MusicRecoveryTargetItemStatus",
  "playlist-manifest.json",
  "targetEntryIDs",
  "func filesNeedingDelivery",
  "firstManifestPosition",
  "func verifiedRecoveredFile",
  "func deliveryIsRecorded",
  "sha256: record.sha256",
  "quarantineCorruptFile"
]) {
  if (!musicRecovery.includes(behavior)) {
    throw new Error(`The local Music recovery pipeline is missing ${behavior}.`);
  }
}
const playlistLoop = musicRecovery.indexOf("for playlist in targetPlaylists");
const clueLoop = musicRecovery.indexOf("for clueTitle in Self.clueTitles");
const allSongsLoop = musicRecovery.indexOf("for item in allSongs {");
if (
  playlistLoop < 0 ||
  clueLoop < 0 ||
  allSongsLoop < 0 ||
  !(playlistLoop < clueLoop && clueLoop < allSongsLoop)
) {
  throw new Error(
    "Recovery must process the entire DocRoshi Beats playlist first, use the named tracks only as verification clues, then process all remaining songs."
  );
}
for (const orderedGate of [
  "candidate.item.hasProtectedAsset",
  "guard let assetURL = candidate.item.assetURL else",
  "asset.load(.hasProtectedContent)",
  "asset.load(.isExportable)"
]) {
  if (musicRecovery.indexOf(orderedGate) < 0) {
    throw new Error(`The recovery eligibility gate is missing ${orderedGate}.`);
  }
}
const eligibilityOrder = [
  "candidate.item.hasProtectedAsset",
  "guard let assetURL = candidate.item.assetURL else",
  "asset.load(.hasProtectedContent)",
  "asset.load(.isExportable)"
].map((marker) => musicRecovery.indexOf(marker));
if (!eligibilityOrder.every((position, index) => index === 0 || position > eligibilityOrder[index - 1])) {
  throw new Error("Recovery eligibility must reject DRM or a missing asset URL before AVAsset protection/export checks.");
}
const assetURLGate = musicRecovery.indexOf("guard let assetURL = candidate.item.assetURL else");
const assetConstruction = musicRecovery.indexOf("let asset = AVURLAsset(url: assetURL)");
const cloudReferences = [...musicRecovery.matchAll(/candidate\.item\.isCloudItem/g)].map(
  (match) => match.index
);
if (
  cloudReferences.length === 0 ||
  cloudReferences.some((position) => position < assetURLGate || position > assetConstruction)
) {
  throw new Error(
    "Cloud-library membership may explain a missing asset URL, but must never be a standalone recovery exclusion."
  );
}
const appModel = await readFile(path.join(root, "PocketDock/AppModel.swift"), "utf8");
const transferJournal = await readFile(
  path.join(root, "PocketDock/TransferJournal.swift"),
  "utf8"
);
for (const behavior of [
  "musicRecoveryEnabled",
  "recoverMusicIfReady",
  "await refreshMusicLibrary()",
  "waitForCompletion: true",
  "musicRecoveryService.markSent",
  "status.target[keyPath: keyPath]",
  "musicRecoveryTask: Task<Void, Never>?",
  "musicRecoveryTask?.cancel()",
  "func pauseMusicRecovery()",
  "func sceneBecameActive() async",
  "deliverRecoveredMusicIfConnected",
  "recoveryPersistentID",
  "recoverySHA256",
  "connectionID",
  "prepareRecoveredTransferForUpload",
  "transfers[selectedIndex].recoverySHA256 == file.sha256",
  "transferJournal.stageVerified",
  "transferJournal.fileMatchesSHA256",
  "retireDuplicateRecoveredTransfers",
  "automaticReconnectTask: Task<Void, Never>?",
  "handleDiscoveredDocksForAutomaticDelivery",
  "reconnectAndDeliverRecoveredMusicIfNeeded",
  "bypassReconnectCooldown: true",
  "newlyAppearedDockIDs",
  "runRecovery: false",
  "authenticateDeviceOwner",
  '!$0.relativePath.hasPrefix("Recovered Music/")',
  "hasStartedAfterUnlock",
  "await photoBackup.cancelScheduled()",
  "isUnlocked = false"
]) {
  if (!appModel.includes(behavior)) {
    throw new Error(`The automatic recovery lifecycle is missing ${behavior}.`);
  }
}
for (const behavior of [
  "import CryptoKit",
  "func stageVerified",
  "func fileMatchesSHA256",
  "try sha256(of: url) == expected.lowercased()"
]) {
  if (!transferJournal.includes(behavior)) {
    throw new Error(`The transfer journal hash boundary is missing ${behavior}.`);
  }
}
const selectStart = appModel.indexOf("func select(");
const selectEnd = appModel.indexOf("func connectNearby", selectStart);
const selectLifecycle = appModel.slice(selectStart, selectEnd);
if (
  selectStart < 0 ||
  selectLifecycle.indexOf("await refreshMusicLibrary()") < 0 ||
  selectLifecycle.indexOf("await recoverMusicIfReady()") < 0 ||
  selectLifecycle.indexOf("await recoverMusicIfReady()") >
    selectLifecycle.indexOf("await refreshMusicLibrary()") ||
  selectLifecycle.indexOf("await deliverRecoveredMusicIfConnected()") < 0 ||
  selectLifecycle.indexOf("await resumePendingTransfers()") < 0
) {
  throw new Error("A connected launch must recover and reconcile pending audio before full Music inventory work.");
}
const startStart = appModel.indexOf("func start() async");
const startEnd = appModel.indexOf("func unlock() async", startStart);
const startLifecycle = appModel.slice(startStart, startEnd);
if (
  startStart < 0 ||
  startLifecycle.indexOf("guard isUnlocked else") < 0 ||
  startLifecycle.indexOf("discovery.start()") < startLifecycle.indexOf("guard isUnlocked else") ||
  startLifecycle.indexOf("SavedConnection.loadAll()") < startLifecycle.indexOf("guard isUnlocked else")
) {
  throw new Error("App startup must not discover, load connections, reconnect, or recover before unlock succeeds.");
}
const vaultStart = appModel.indexOf("func unlockVault() async");
const vaultEnd = appModel.indexOf("func lockVault()", vaultStart);
const vaultLifecycle = appModel.slice(vaultStart, vaultEnd);
if (
  vaultStart < 0 ||
  !vaultLifecycle.includes("authenticateDeviceOwner") ||
  vaultLifecycle.includes("await unlock()") ||
  vaultLifecycle.includes("isUnlocked =")
) {
  throw new Error("Vault authentication must never mutate or reuse the global app unlock state.");
}
const reconnectStart = appModel.indexOf("private func reconnectAndDeliverRecoveredMusicIfNeeded");
const reconnectEnd = appModel.indexOf("private func performAutomaticReconnectOrRefresh", reconnectStart);
const reconnectLifecycle = appModel.slice(reconnectStart, reconnectEnd);
if (
  reconnectStart < 0 ||
  reconnectLifecycle.indexOf("await running.value") < 0 ||
  reconnectLifecycle.indexOf("performAutomaticReconnectOrRefresh") < 0 ||
  reconnectLifecycle.indexOf("await recoverMusicIfReady()") < 0 ||
  reconnectLifecycle.indexOf("await deliverRecoveredMusicIfConnected()") < 0 ||
  reconnectLifecycle.indexOf("await recoverMusicIfReady()") >
    reconnectLifecycle.indexOf("await deliverRecoveredMusicIfConnected()")
) {
  throw new Error("Automatic reconnect must be single-flight and finish before recovered delivery.");
}
const entitlements = await readFile(
  path.join(root, "PocketDock/PocketDock.entitlements"),
  "utf8"
);
if (entitlements.includes("com.apple.developer.musickit")) {
  throw new Error("MusicKit is an App ID service; do not invent a MusicKit entitlement.");
}
const appIcon = path.join(
  root,
  "PocketDock/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
);
const iconMetadata = await sharp(appIcon).metadata();
if (iconMetadata.width !== 1024 || iconMetadata.height !== 1024 || iconMetadata.hasAlpha) {
  throw new Error("The App Store icon must be an opaque 1024×1024 PNG.");
}

const entries = await readdir(root, { recursive: true });
const swiftCount = entries.filter((entry) => entry.endsWith(".swift")).length;
if (swiftCount < 8) throw new Error("The native iOS project is incomplete.");
process.stdout.write(
  `PocketDock iOS source verified: ${swiftCount} Swift files and all four targets present.\n`
);
