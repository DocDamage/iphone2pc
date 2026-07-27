import BackgroundTasks
import AVFoundation
import Foundation
import FileProvider
import LocalAuthentication
import Photos
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var connection: SavedConnection?
    @Published var connections: [SavedConnection] = []
    @Published var discovered: [DiscoveredDock] = []
    @Published var transfers: [MobileTransfer] = []
    @Published var sharedFiles: [RemoteSharedFile] = []
    @Published var clipboard: [RemoteClipboardEntry] = []
    @Published var producerPackages: [MobileProducerPackage] = []
    @Published var syncProfiles: [MobileSyncProfile] = []
    @Published var driveEntries: [MobileDriveEntry] = []
    @Published var driveSearchResults: [MobileDriveEntry] = []
    @Published var driveSearchText = ""
    @Published var offlineDriveItems: [OfflineDriveItem] = []
    @Published var drivePath = ""
    @Published var driveDownloadedURL: URL?
    @Published var quickLookURL: URL?
    @Published var diagnosticReport: MobileDiagnosticReport?
    @Published var diagnosticExportURL: URL?
    @Published var migrationReport: PhotoMigrationReport?
    @Published var migrationMessage = ""
    @Published var vaultItems: [MobileVaultItem] = []
    @Published var usbDocuments: [USBDocumentItem] = []
    @Published var musicInventoryTracks: [PhoneMusicTrack] = []
    @Published var musicInventoryCollections: [PhoneMusicCollection] = []
    @Published var musicInventoryAuthorization: MusicInventoryAuthorization = .notDetermined
    @Published var musicInventoryEnabled = false
    @Published var musicInventorySyncing = false
    @Published var musicInventoryLastSyncedAt: Date?
    @Published var musicInventoryMessage = "Share a private inventory when you are ready."
    @Published var musicRecoveryEnabled = true
    @Published var musicRecoveryStatus = MusicRecoveryStatus.idle(enabled: true)
    @Published private(set) var isRecoveringMusic = false
    @Published private(set) var isMusicRecoveryPaused = false
    @Published private(set) var isSendingAllMusicFiles = false
    @Published private(set) var musicBulkSendMessage = ""
    @Published private(set) var musicFileSendResults: [String: String] = [:]
    @Published private(set) var documentImportMessage = ""
    @Published var vaultExportURL: URL?
    @Published var vaultUnlocked = false
    @Published var syncFolderNames: [UUID: String] = [:]
    @Published var backupPreferences = BackupPreferences()
    @Published var backupProgress = BackupProgress()
    @Published var contactBackupMessage = ""
    @Published var syncMessage = ""
    @Published var isUnlocked = false
    @Published var connectionState: PocketDockConnectionState = .disconnected
    @Published var isRefreshing = false
    @Published var lastRefreshAt: Date?
    @Published var successFeedback = 0
    @Published var errorFeedback = 0
    @Published var errorMessage: String?
    @Published private(set) var optionalFeatureMessages: [String] = []
    @Published var navigationRequest: String?

    private let discovery = DiscoveryService()
    private let photoBackup = PhotoBackupService()
    private let contactBackup = ContactBackupService()
    private let folderSync = FolderSyncService()
    private let transferJournal = TransferJournal()
    private let offlineDrive = OfflineDriveService()
    private let mobileVault = MobileVaultService()
    private let migration = PhotoMigrationService()
    private let usbDocumentService = USBDocumentService()
    private let musicInventoryService = MusicInventoryService()
    private let musicRecoveryService = MusicRecoveryService()
    private var client: PocketDockClient?
    private var transferTasks: [UUID: Task<Void, Never>] = [:]
    private var pendingTransferResumes = Set<UUID>()
    private var acceptingMusicRecoveryProgress = false
    private var musicRecoveryTask: Task<Void, Never>?
    private var musicRecoveryRunID: UUID?
    private var activeMusicRecoveryTransferID: UUID?
    private var isReconcilingTransferQueue = false
    private var hasStartedAfterUnlock = false
    private var automaticReconnectTask: Task<Void, Never>?
    private var automaticReconnectRunID: UUID?
    private var lastAutomaticReconnectKey: String?
    private var lastAutomaticReconnectAt: Date?
    private var lastDiscoveredDockIDs = Set<String>()

    private struct UploadSource {
        let url: URL
        let relativePath: String
        let recoveryPersistentID: String?
        let recoverySHA256: String?
        let connectionID: UUID?

        init(
            url: URL,
            relativePath: String,
            recoveryPersistentID: String? = nil,
            recoverySHA256: String? = nil,
            connectionID: UUID? = nil
        ) {
            self.url = url
            self.relativePath = relativePath
            self.recoveryPersistentID = recoveryPersistentID
            self.recoverySHA256 = recoverySHA256
            self.connectionID = connectionID
        }
    }

    init() {
        BackgroundTransferSession.shared.activate()
        registerBackgroundBackup()
    }

    func start() async {
        if hasStartedAfterUnlock {
            if !isUnlocked {
                await unlock()
            }
            return
        }
        await unlock()
        guard isUnlocked else {
            // Do not discover, reconnect, read journals, or recover user data
            // until device-owner authentication succeeds.
            return
        }
        discovery.onChange = { [weak self] docks in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.discovered = docks
                await self.handleDiscoveredDocksForAutomaticDelivery(docks)
            }
        }
        discovery.start()
        backupPreferences = await photoBackup.preferences()
        transfers = await transferJournal.load().map { transfer in
            var value = transfer
            if value.isActive {
                value.paused = true
                value.error = nil
                value.manuallyPaused = false
            } else if value.paused, value.manuallyPaused == nil {
                // A paused entry written by an older app build was paused by
                // the user; do not unexpectedly restart it after upgrading.
                value.manuallyPaused = true
            }
            return value
        }
        offlineDriveItems = await offlineDrive.items()
        vaultItems = await mobileVault.items()
        await refreshUSBDocuments()
        await refreshMusicInventoryState()
        musicRecoveryEnabled = await musicRecoveryService.isEnabled()
        musicRecoveryStatus = .idle(enabled: musicRecoveryEnabled)
        connections = SavedConnection.loadAll()
        if let saved = connections.first {
            await select(saved, reconnect: true)
        } else {
            await recoverMusicIfReady()
        }
        await importShareExtensionQueue()
        await consumePendingAppIntent()
        hasStartedAfterUnlock = true
        if connectionState == .connected {
            lastDiscoveredDockIDs = Set(discovered.map(\.id))
        } else {
            // Bonjour may have resolved while the initial saved endpoint was
            // still failing. Consume that appearance once startup is ready.
            await handleDiscoveredDocksForAutomaticDelivery(discovered)
        }
    }

    func unlock() async {
        isUnlocked = await authenticateDeviceOwner(
            reason: String(localized: "Open your PocketDock connections")
        )
    }

    private func authenticateDeviceOwner(reason: String) async -> Bool {
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            // Fail closed. A missing passcode/biometric policy must never turn
            // into an authentication bypass for paired PCs or transfer history.
            return false
        }
        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            )
        } catch {
            return false
        }
    }

    func refreshUSBDocuments() async {
        do {
            usbDocuments = try await usbDocumentService.items()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stageUSBDocuments(_ urls: [URL]) async {
        guard !urls.isEmpty else {
            reportEmptyImporterSelection(context: "PocketDock Files")
            return
        }
        do {
            let copied = try await usbDocumentService.stage(urls)
            await refreshUSBDocuments()
            documentImportMessage = String(
                localized: "Added \(copied) selection(s) to PocketDock Files."
            )
            successFeedback += 1
            await syncMusicInventoryIfNeeded()
        } catch {
            documentImportMessage = String(
                localized: "Couldn’t add the selected files: \(error.localizedDescription)"
            )
            errorMessage = error.localizedDescription
            errorFeedback += 1
        }
    }

    func reportImporterFailure(_ error: Error, context: String) {
        let message = String(
            localized: "\(context) could not open the selection: \(error.localizedDescription)"
        )
        documentImportMessage = message
        errorMessage = message
        errorFeedback += 1
    }

    func reportEmptyImporterSelection(context: String) {
        let message = String(localized: "No files were selected for \(context).")
        documentImportMessage = message
        errorMessage = message
        errorFeedback += 1
    }

    func sendUSBDocument(_ item: USBDocumentItem) async {
        guard !isRecoveringMusic else {
            let message = String(localized: "Automatic music recovery is using the transfer queue.")
            musicFileSendResults[item.id] = message
            return
        }
        do {
            if let file = try await musicRecoveryService.verifiedRecoveredFile(
                persistentID: nil,
                relativePath: item.relativePath
            ), let activeConnection = connection, connectionState == .connected {
                musicFileSendResults[item.id] = String(localized: "Sending…")
                if await sendRecoveredFile(file, to: activeConnection) {
                    try await musicRecoveryService.markSent(
                        persistentID: file.persistentID,
                        to: activeConnection.id
                    )
                    musicFileSendResults[item.id] = String(localized: "Sent and verified")
                } else {
                    musicFileSendResults[item.id] = String(localized: "Transfer needs attention")
                }
                return
            }
        } catch {
            musicFileSendResults[item.id] = String(localized: "Failed: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            errorFeedback += 1
            return
        }
        _ = await sendMusicDocument(item)
    }

    func previewUSBDocument(_ item: USBDocumentItem) {
        quickLookURL = item.url
    }

    func removeUSBDocument(_ item: USBDocumentItem) async {
        do {
            try await usbDocumentService.remove(item)
            await refreshUSBDocuments()
            await syncMusicInventoryIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
            errorFeedback += 1
        }
    }

    var musicAudioDocuments: [USBDocumentItem] {
        usbDocuments.filter(\.isAudio)
    }

    var manuallyAddedMusicAudioDocuments: [USBDocumentItem] {
        musicAudioDocuments.filter {
            !$0.relativePath.hasPrefix("Recovered Music/")
        }
    }

    var musicAudioDocumentBytes: Int64 {
        musicAudioDocuments.reduce(0) { $0 + $1.size }
    }

    var manuallyAddedMusicAudioDocumentBytes: Int64 {
        manuallyAddedMusicAudioDocuments.reduce(0) { $0 + $1.size }
    }

    func enableMusicInventory() async {
        guard let connection else {
            errorMessage = String(localized: "Connect to a PC before sharing your music inventory.")
            return
        }
        await musicInventoryService.setSharingEnabled(true, for: connection.id)
        musicInventoryEnabled = true
        await recoverMusicIfReady(reportErrors: true)
        musicInventoryMessage = String(localized: "Syncing PocketDock Files…")
        await syncMusicInventoryIfNeeded(reportErrors: true)
        updateRecoveryCompletenessWarning()
    }

    /// This is the only path that can present Apple's Music authorization UI.
    /// It must remain attached to an explicit user action in MusicInventoryView.
    func requestMusicLibraryAccess() async {
        musicInventoryMessage = String(localized: "Waiting for Music access…")
        musicInventoryAuthorization = await musicInventoryService.requestAuthorization()
        // MediaPlayer recovery and MusicKit inventory use the same visible
        // privacy purpose but remain independent capabilities. Request both
        // from this explicit action so a missing MusicKit service cannot block
        // recovery of an otherwise eligible local file.
        let recoveryAccessReady = await musicRecoveryService.requestAuthorization()
        guard musicInventoryAuthorization == .authorized || recoveryAccessReady else {
            musicInventoryMessage = switch musicInventoryAuthorization {
            case .denied: String(localized: "Music access was denied. You can allow it in Settings.")
            case .restricted: String(localized: "Music access is restricted on this iPhone.")
            case .notDetermined: String(localized: "Music access has not been granted.")
            case .authorized: String(localized: "Music access is ready.")
            }
            return
        }
        if musicInventoryAuthorization == .authorized {
            musicInventoryMessage = recoveryAccessReady
                ? String(localized: "Music access is ready for inventory and local-track recovery.")
                : String(localized: "Music metadata is available, but local-track recovery access was not granted.")
        } else {
            musicInventoryMessage = String(
                localized: "Local-track recovery is ready; MusicKit metadata inventory is unavailable."
            )
        }
        // Stage owned local audio first; metadata pagination/sync can follow.
        await recoverMusicIfReady(reportErrors: true)
        if musicInventoryAuthorization == .authorized {
            if musicInventoryEnabled {
                await syncMusicInventoryIfNeeded(reportErrors: true)
            } else {
                await refreshMusicLibrary(reportErrors: true)
            }
            updateRecoveryCompletenessWarning()
        } else {
            await refreshUSBDocuments()
        }
    }

    func disableMusicInventory() async {
        guard let connection else { return }
        await musicInventoryService.setSharingEnabled(false, for: connection.id)
        musicInventoryEnabled = false
        musicInventoryMessage = String(localized: "Automatic inventory sync is off.")
    }

    func refreshMusicInventory() async {
        await recoverMusicIfReady(reportErrors: true)
        await refreshMusicLibrary(reportErrors: true)
        updateRecoveryCompletenessWarning()
    }

    func setMusicRecoveryEnabled(_ enabled: Bool) async {
        await musicRecoveryService.setEnabled(enabled)
        musicRecoveryEnabled = enabled
        if enabled {
            isMusicRecoveryPaused = false
            musicRecoveryStatus = .idle(enabled: true)
            await recoverMusicNow()
        } else {
            musicRecoveryTask?.cancel()
            if let activeMusicRecoveryTransferID {
                pauseTransfer(activeMusicRecoveryTransferID)
            }
            isMusicRecoveryPaused = false
            musicRecoveryStatus = .idle(enabled: false)
        }
    }

    func recoverMusicNow() async {
        await recoverMusicIfReady(reportErrors: true)
    }

    func pauseMusicRecovery() {
        guard isRecoveringMusic else { return }
        isMusicRecoveryPaused = true
        musicRecoveryTask?.cancel()
        if let activeMusicRecoveryTransferID {
            pauseTransfer(activeMusicRecoveryTransferID)
        }
    }

    /// Refreshes both sources shown by the Music screen. PocketDock Documents
    /// can change over USB while the app is backgrounded, so they must never be
    /// tied to whether MusicKit sharing is enabled.
    func refreshMusicLibrary(reportErrors: Bool = false) async {
        await refreshUSBDocuments()
        await refreshMusicInventoryState()
        if musicInventoryEnabled {
            await syncMusicInventoryIfNeeded(reportErrors: reportErrors)
            return
        }
        guard musicInventoryAuthorization == .authorized, !musicInventorySyncing else { return }

        musicInventorySyncing = true
        musicInventoryMessage = String(localized: "Loading your complete Music library…")
        defer { musicInventorySyncing = false }
        do {
            let inventory = try await musicInventoryService.makeInventory(documents: usbDocuments)
            musicInventoryTracks = inventory.music
            musicInventoryCollections = inventory.collections
            musicInventoryMessage = String(
                localized: "Loaded \(inventory.music.count) Music items and \(inventory.collections.count) playlists on this iPhone."
            )
        } catch {
            musicInventoryMessage = error.localizedDescription
            if reportErrors {
                errorMessage = error.localizedDescription
                errorFeedback += 1
            }
        }
    }

    /// Refreshes automatically only after the user has opted in. Music-app
    /// metadata is included when already authorized; PocketDock Files never
    /// depend on MusicKit authorization. This never triggers a permission prompt.
    func syncMusicInventoryIfNeeded(reportErrors: Bool = false) async {
        guard !musicInventorySyncing, let connection, let client else { return }
        musicInventoryEnabled = await musicInventoryService.sharingEnabled(for: connection.id)
        musicInventoryAuthorization = await musicInventoryService.authorization()
        guard musicInventoryEnabled else { return }

        musicInventorySyncing = true
        musicInventoryMessage = String(localized: "Building a complete music inventory…")
        defer { musicInventorySyncing = false }
        do {
            let documents = try await usbDocumentService.items()
            usbDocuments = documents
            let inventory = try await musicInventoryService.makeInventory(
                documents: documents
            )
            musicInventoryTracks = inventory.music
            musicInventoryCollections = inventory.collections
            let receipt = try await client.sendMusicInventory(inventory)
            guard !receipt.saved || receipt.generationId == inventory.generationId else {
                throw PocketDockError.server("The PC did not commit this inventory generation.")
            }
            if !receipt.saved, !["duplicate", "stale"].contains(receipt.reason ?? "") {
                throw PocketDockError.server("The PC did not accept this inventory generation.")
            }
            let receivedAt = ISO8601DateFormatter().date(from: receipt.receivedAt) ?? Date()
            musicInventoryLastSyncedAt = receivedAt
            await musicInventoryService.markSynced(at: receivedAt, for: connection.id)
            musicInventoryMessage = receipt.saved
                ? String(
                    localized: "Synced \(receipt.musicCount) Music items, \(inventory.collections.count) playlists, and \(receipt.fileCount) PocketDock files."
                )
                : String(localized: "The PC already has this inventory or a newer one.")
            successFeedback += 1
        } catch {
            musicInventoryMessage = error.localizedDescription
            if reportErrors {
                errorMessage = error.localizedDescription
                errorFeedback += 1
            }
        }
    }

    func sendAllMusicFilesToPC() async {
        guard !isRecoveringMusic else {
            musicBulkSendMessage = String(localized: "Automatic music recovery is using the transfer queue.")
            return
        }
        guard !isSendingAllMusicFiles else {
            musicBulkSendMessage = String(localized: "Send All is already in progress.")
            return
        }
        let audioFiles = manuallyAddedMusicAudioDocuments
        guard !audioFiles.isEmpty else {
            let message = String(localized: "Add audio originals to PocketDock Files first.")
            musicBulkSendMessage = message
            errorMessage = message
            errorFeedback += 1
            return
        }
        isSendingAllMusicFiles = true
        musicBulkSendMessage = String(
            localized: "Sending \(audioFiles.count) audio files one at a time…"
        )
        defer { isSendingAllMusicFiles = false }

        // Keep bulk sends bounded. Each original is staged, encrypted, resumed,
        // and verified before the next file begins instead of launching an
        // unbounded task for every beat in a large folder.
        for (index, item) in audioFiles.enumerated() {
            musicBulkSendMessage = String(
                localized: "Sending \(index + 1) of \(audioFiles.count): \(item.name)"
            )
            guard await sendMusicDocument(item) else {
                musicBulkSendMessage = String(
                    localized: "Send All stopped at \(item.name). Remaining files were not staged."
                )
                return
            }
        }
        musicBulkSendMessage = String(localized: "Sent all \(audioFiles.count) audio files to the PC.")
    }

    @discardableResult
    private func sendMusicDocument(_ item: USBDocumentItem) async -> Bool {
        musicFileSendResults[item.id] = String(localized: "Sending…")
        let succeeded = await upload(documents: [item], waitForCompletion: true)
        if succeeded {
            musicFileSendResults[item.id] = String(localized: "Sent and verified")
            return true
        }

        let transfer = transfers.first { $0.relativePath == item.relativePath }
        let result: String
        if transfer?.paused == true {
            result = String(localized: "Paused — tap Resume in Transfers")
        } else if let transferError = transfer?.error {
            result = String(localized: "Failed: \(transferError)")
            errorMessage = String(localized: "\(item.name) failed to send: \(transferError)")
        } else {
            result = String(localized: "Failed to send")
            if errorMessage == nil {
                errorMessage = String(localized: "\(item.name) could not be sent.")
            }
        }
        musicFileSendResults[item.id] = result
        return false
    }

    /// Starts or joins the single recovery task. It never requests permission;
    /// authorized local recovery can therefore run on launch or foreground even
    /// while every PC is offline.
    private func recoverMusicIfReady(reportErrors: Bool = false) async {
        guard isUnlocked, !isReconcilingTransferQueue else { return }
        if let task = musicRecoveryTask {
            await task.value
            return
        }
        let runID = UUID()
        musicRecoveryRunID = runID
        let task = Task<Void, Never> { [weak self] in
            await self?.runMusicRecoveryPipeline(reportErrors: reportErrors)
        }
        musicRecoveryTask = task
        await task.value
        if musicRecoveryRunID == runID {
            musicRecoveryTask = nil
            musicRecoveryRunID = nil
        }
    }

    private func runMusicRecoveryPipeline(reportErrors: Bool) async {
        musicRecoveryEnabled = await musicRecoveryService.isEnabled()
        guard musicRecoveryEnabled else {
            musicRecoveryStatus = .idle(enabled: false)
            return
        }
        guard await musicRecoveryService.authorizationIsReady() else {
            var status = MusicRecoveryStatus.idle(enabled: true)
            status.phase = "Music access needed"
            status.message = "Tap Allow Music Access once. Launch and foreground recovery never show a permission prompt."
            musicRecoveryStatus = status
            return
        }

        isRecoveringMusic = true
        isMusicRecoveryPaused = false
        acceptingMusicRecoveryProgress = true
        defer {
            acceptingMusicRecoveryProgress = false
            isRecoveringMusic = false
        }
        do {
            let reportingConnection = connectionState == .connected ? connection?.id : nil
            let run = try await musicRecoveryService.recover(
                reportingFor: reportingConnection
            ) { [weak self] update in
                Task { @MainActor in
                    guard self?.acceptingMusicRecoveryProgress == true else { return }
                    self?.musicRecoveryStatus = update
                }
            }
            try Task.checkCancellation()
            acceptingMusicRecoveryProgress = false
            musicRecoveryStatus = run.status

            // Recovery is already durable at this point. Refresh the USB-visible
            // Documents inventory whether or not a PC is connected.
            await refreshUSBDocuments()
            updateRecoveryCompletenessWarning()

            if connectionState == .connected, let activeConnection = connection, client != nil {
                let sentEverything = await sendPendingRecoveredFiles(
                    to: activeConnection,
                    reportErrors: reportErrors
                )
                if sentEverything, musicInventoryEnabled {
                    await syncMusicInventoryIfNeeded(reportErrors: reportErrors)
                    updateRecoveryCompletenessWarning()
                }
            } else {
                var status = musicRecoveryStatus
                status.running = false
                status.message += " Recovered files stay in PocketDock Files and will send when a paired PC connects."
                musicRecoveryStatus = status
            }
        } catch is CancellationError {
            var status = musicRecoveryStatus
            status.running = false
            if await musicRecoveryService.isEnabled() {
                status.phase = "Paused"
                status.message = "Music recovery paused. Retry / Recover Now continues from verified files without overwriting them."
                isMusicRecoveryPaused = true
            } else {
                status = .idle(enabled: false)
            }
            musicRecoveryStatus = status
        } catch {
            var status = musicRecoveryStatus
            status.running = false
            status.phase = "Recovery needs attention"
            status.message = error.localizedDescription
            musicRecoveryStatus = status
            if reportErrors {
                errorMessage = error.localizedDescription
                errorFeedback += 1
            }
        }
    }

    private func sendPendingRecoveredFiles(
        to activeConnection: SavedConnection,
        reportErrors: Bool
    ) async -> Bool {
        let pending: [RecoveredMusicFile]
        do {
            pending = try await musicRecoveryService.filesNeedingDelivery(
                to: activeConnection.id
            )
        } catch {
            var status = musicRecoveryStatus
            status.running = false
            status.phase = "Recovery delivery needs attention"
            status.message = error.localizedDescription
            musicRecoveryStatus = status
            if reportErrors {
                errorMessage = error.localizedDescription
                errorFeedback += 1
            }
            return false
        }

        guard !pending.isEmpty else {
            finishRecoveryStatus()
            return true
        }

        var status = musicRecoveryStatus
        status.running = true
        status.phase = "Sending recovered music"
        status.message = "Reusing the verified transfer queue one file at a time…"
        musicRecoveryStatus = status

        for (index, file) in pending.enumerated() {
            let recoveryStillEnabled = await musicRecoveryService.isEnabled()
            guard !Task.isCancelled, recoveryStillEnabled else {
                status = recoveryStillEnabled
                    ? musicRecoveryStatus
                    : .idle(enabled: false)
                if recoveryStillEnabled {
                    status.running = false
                    status.phase = "Paused"
                    status.message = "Music recovery paused. Verified files remain on this iPhone and the current transfer can resume."
                }
                musicRecoveryStatus = status
                return false
            }
            guard connectionState == .connected, connection?.id == activeConnection.id else {
                status = musicRecoveryStatus
                status.running = false
                status.phase = "Recovered on iPhone · waiting for PC"
                status.message = "The connection changed. Verified files remain staged and will send on the next connection."
                musicRecoveryStatus = status
                return false
            }

            incrementRecovery(\.queued, for: file)
            status = musicRecoveryStatus
            status.message = "Sending \(index + 1) of \(pending.count): \(file.title)"
            musicRecoveryStatus = status

            guard await sendRecoveredFile(file, to: activeConnection) else {
                let recoveryStillEnabled = await musicRecoveryService.isEnabled()
                if Task.isCancelled || isMusicRecoveryPaused || !recoveryStillEnabled {
                    status = recoveryStillEnabled
                        ? musicRecoveryStatus
                        : .idle(enabled: false)
                    if recoveryStillEnabled {
                        status.running = false
                        status.phase = "Paused"
                        status.message = "Music recovery paused. Verified files remain on this iPhone and the current transfer can resume."
                    }
                    musicRecoveryStatus = status
                    return false
                }
                incrementRecovery(\.failed, for: file)
                setRecoveryItemState(
                    "Transfer needs attention",
                    reason: "The recovered file is safe on this iPhone. Retry resumes the same queue record.",
                    for: file
                )
                status = musicRecoveryStatus
                status.running = false
                status.phase = "Transfer needs attention"
                status.message = "Stopped at \(file.title). Retry / Recover Now reuses this transfer instead of creating a duplicate."
                musicRecoveryStatus = status
                return false
            }

            do {
                try await musicRecoveryService.markSent(
                    persistentID: file.persistentID,
                    to: activeConnection.id
                )
                incrementRecovery(\.sent, for: file)
                setRecoveryClueReason("Recovered, sent, and verified by the PC.", for: file)
                setRecoveryItemState(
                    "Sent",
                    reason: "Recovered audio was sent and verified by this PC.",
                    for: file
                )
            } catch {
                incrementRecovery(\.failed, for: file)
                status = musicRecoveryStatus
                status.running = false
                status.phase = "Delivery record needs retry"
                status.message = "The PC verified \(file.title), but PocketDock could not persist its receipt: \(error.localizedDescription)"
                musicRecoveryStatus = status
                if reportErrors {
                    errorMessage = error.localizedDescription
                    errorFeedback += 1
                }
                return false
            }
        }

        finishRecoveryStatus()
        successFeedback += 1
        return true
    }

    private func deliverRecoveredMusicIfConnected(reportErrors: Bool = false) async {
        guard !isRecoveringMusic,
              !isReconcilingTransferQueue,
              connectionState == .connected,
              let activeConnection = connection,
              client != nil
        else { return }
        isRecoveringMusic = true
        defer { isRecoveringMusic = false }
        _ = await sendPendingRecoveredFiles(
            to: activeConnection,
            reportErrors: reportErrors
        )
    }

    private func sendRecoveredFile(
        _ file: RecoveredMusicFile,
        to activeConnection: SavedConnection
    ) async -> Bool {
        let matching = transfers.indices.filter { index in
            let transfer = transfers[index]
            let sameRecovery = transfer.recoveryPersistentID == file.persistentID
            let samePath = transfer.relativePath == file.relativePath
            let sameConnection = transfer.connectionID == nil ||
                transfer.connectionID == activeConnection.id
            return sameConnection && (sameRecovery || samePath)
        }
        let selectedIndex = matching.sorted { left, right in
            let leftTransfer = transfers[left]
            let rightTransfer = transfers[right]
            let leftHashMatches = leftTransfer.recoverySHA256 == file.sha256
            let rightHashMatches = rightTransfer.recoverySHA256 == file.sha256
            if leftHashMatches != rightHashMatches { return leftHashMatches }
            let leftConnectionMatches = leftTransfer.connectionID == activeConnection.id
            let rightConnectionMatches = rightTransfer.connectionID == activeConnection.id
            if leftConnectionMatches != rightConnectionMatches { return leftConnectionMatches }
            if leftTransfer.completed != rightTransfer.completed {
                return leftTransfer.completed
            }
            if leftTransfer.isActive != rightTransfer.isActive {
                return leftTransfer.isActive
            }
            return leftTransfer.updatedAt > rightTransfer.updatedAt
        }.first

        if let selectedIndex {
            let id = transfers[selectedIndex].id
            let duplicateIDs = matching
                .map { transfers[$0].id }
                .filter { $0 != id }
            await retireDuplicateRecoveredTransfers(duplicateIDs, keeping: id)
            guard let selectedIndex = transfers.firstIndex(where: { $0.id == id }) else {
                return false
            }
            if (try? await musicRecoveryService.deliveryIsRecorded(
                persistentID: file.persistentID,
                sha256: file.sha256,
                to: activeConnection.id
            )) == true {
                let stagedTransfer = transfers[selectedIndex]
                try? await transferJournal.removeStagedFile(for: stagedTransfer)
                guard let receiptIndex = transfers.firstIndex(where: { $0.id == id }) else {
                    return false
                }
                transfers[receiptIndex].localPath = nil
                transfers[receiptIndex].relativePath = file.relativePath
                transfers[receiptIndex].recoveryPersistentID = file.persistentID
                transfers[receiptIndex].recoverySHA256 = file.sha256
                transfers[receiptIndex].connectionID = activeConnection.id
                transfers[receiptIndex].progress = 1
                transfers[receiptIndex].completed = true
                transfers[receiptIndex].paused = false
                transfers[receiptIndex].manuallyPaused = false
                transfers[receiptIndex].error = nil
                try? await transferJournal.save(transfers)
                return true
            }
            let recoveryHashMatches = transfers[selectedIndex].recoverySHA256 == file.sha256
            let verifiedForThisConnection = transfers[selectedIndex].completed &&
                transfers[selectedIndex].connectionID == activeConnection.id &&
                recoveryHashMatches
            transfers[selectedIndex].recoveryPersistentID = file.persistentID
            transfers[selectedIndex].relativePath = file.relativePath
            if verifiedForThisConnection {
                try? await transferJournal.save(transfers)
                return true
            }
            do {
                let localPath = transfers[selectedIndex].localPath
                var stagedCopyMatches = false
                if recoveryHashMatches, let localPath {
                    stagedCopyMatches = (try? await transferJournal.fileMatchesSHA256(
                        atPath: localPath,
                        expected: file.sha256
                    )) == true
                }
                if !stagedCopyMatches {
                    if let activeTask = transferTasks[id] {
                        pendingTransferResumes.remove(id)
                        activeTask.cancel()
                        await activeTask.value
                    }
                    let staged = try await transferJournal.stageVerified(
                        file.url,
                        id: id,
                        expectedSHA256: file.sha256
                    )
                    guard let refreshedIndex = transfers.firstIndex(where: { $0.id == id }) else {
                        return false
                    }
                    transfers[refreshedIndex].localPath = staged.path
                    transfers[refreshedIndex].size = Int64(
                        (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    )
                }
                guard let refreshedIndex = transfers.firstIndex(where: { $0.id == id }) else {
                    return false
                }
                if transfers[refreshedIndex].localPath == nil {
                    let staged = try await transferJournal.stageVerified(
                        file.url,
                        id: id,
                        expectedSHA256: file.sha256
                    )
                    transfers[refreshedIndex].localPath = staged.path
                    transfers[refreshedIndex].size = Int64(
                        (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    )
                }
                transfers[refreshedIndex].recoveryPersistentID = file.persistentID
                transfers[refreshedIndex].recoverySHA256 = file.sha256
                transfers[refreshedIndex].connectionID = activeConnection.id
                transfers[refreshedIndex].relativePath = file.relativePath
                transfers[refreshedIndex].paused = false
                transfers[refreshedIndex].manuallyPaused = false
                transfers[refreshedIndex].error = nil
                transfers[refreshedIndex].completed = false
                try await transferJournal.save(transfers)
            } catch {
                errorMessage = error.localizedDescription
                errorFeedback += 1
                return false
            }
            let task: Task<Void, Never>?
            if let activeTask = transferTasks[id] {
                task = activeTask
            } else {
                task = startTransfer(id)
            }
            guard let task else { return false }
            activeMusicRecoveryTransferID = id
            await task.value
            if activeMusicRecoveryTransferID == id { activeMusicRecoveryTransferID = nil }
            return transfers.first(where: { $0.id == id })?.completed == true
        }

        let id = UUID()
        do {
            let staged = try await transferJournal.stageVerified(
                file.url,
                id: id,
                expectedSHA256: file.sha256
            )
            let size = Int64(
                (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            )
            transfers.insert(
                MobileTransfer(
                    id: id,
                    name: file.url.lastPathComponent,
                    localPath: staged.path,
                    relativePath: file.relativePath,
                    size: size,
                    recoveryPersistentID: file.persistentID,
                    recoverySHA256: file.sha256,
                    connectionID: activeConnection.id
                ),
                at: 0
            )
            try await transferJournal.save(transfers)
            guard let task = startTransfer(id) else { return false }
            activeMusicRecoveryTransferID = id
            await task.value
            if activeMusicRecoveryTransferID == id { activeMusicRecoveryTransferID = nil }
            return transfers.first(where: { $0.id == id })?.completed == true
        } catch {
            errorMessage = error.localizedDescription
            errorFeedback += 1
            return false
        }
    }

    /// Duplicate recovery rows are temporary queue state, never the owned
    /// recovered original. Removing them prevents a later manual Resume from
    /// uploading the same recovered bytes after the canonical row succeeds.
    private func retireDuplicateRecoveredTransfers(
        _ duplicateIDs: [UUID],
        keeping canonicalID: UUID
    ) async {
        guard !duplicateIDs.isEmpty else { return }
        for duplicateID in duplicateIDs {
            pendingTransferResumes.remove(duplicateID)
            if let task = transferTasks[duplicateID] {
                task.cancel()
                await task.value
            }
            guard let index = transfers.firstIndex(where: { $0.id == duplicateID }) else {
                continue
            }
            let duplicate = transfers[index]
            try? await transferJournal.removeStagedFile(for: duplicate)
            transfers.remove(at: index)
            if activeMusicRecoveryTransferID == duplicateID {
                activeMusicRecoveryTransferID = canonicalID
            }
        }
        try? await transferJournal.save(transfers)
    }

    private func finishRecoveryStatus() {
        var status = musicRecoveryStatus
        status.running = false
        if !status.targetPlaylistFound {
            status.phase = "Completed · DocRoshi Beats not found"
        } else if status.overall.failed > 0 || status.overall.skipped > 0 {
            status.phase = "Complete with limitations"
        } else if status.overall.newlyRecovered == 0 {
            status.phase = "Up to date"
        } else {
            status.phase = "Complete"
        }
        status.message = recoverySummary(status)
        musicRecoveryStatus = status
    }

    private func setRecoveryItemState(
        _ itemStatus: String,
        reason: String,
        for file: RecoveredMusicFile
    ) {
        var status = musicRecoveryStatus
        let entryIDs = Set(file.targetEntryIDs)
        for index in status.targetItems.indices where entryIDs.contains(status.targetItems[index].id) {
            status.targetItems[index].status = itemStatus
            status.targetItems[index].reason = reason
            status.targetItems[index].recoveredRelativePath = file.relativePath
        }
        musicRecoveryStatus = status
    }

    private func updateRecoveryCompletenessWarning() {
        var status = musicRecoveryStatus
        let expected = musicInventoryCollections
            .filter {
                $0.name.localizedCaseInsensitiveCompare(MusicRecoveryService.targetPlaylistName) == .orderedSame
            }
            .reduce(0) { $0 + $1.itemCount }
        status.musicKitExpectedTargetEntries = expected > 0 ? expected : nil
        if expected > 0, expected != status.target.found {
            status.completenessWarning = String(
                localized: "MusicKit lists \(expected) DocRoshi Beats entries, while MediaPlayer exposed \(status.target.found). Keep the iPhone unlocked, download unavailable items in Music, then retry."
            )
        } else {
            status.completenessWarning = nil
        }
        musicRecoveryStatus = status
    }

    private func incrementRecovery(
        _ keyPath: WritableKeyPath<MusicRecoveryCounts, Int>,
        for file: RecoveredMusicFile
    ) {
        var status = musicRecoveryStatus
        status.overall[keyPath: keyPath] += 1
        if file.isTargetPlaylist {
            status.target[keyPath: keyPath] += max(file.targetEntryIDs.count, 1)
        }
        for clueTitle in file.clueTitles {
            if let index = status.clues.firstIndex(where: { $0.title == clueTitle }) {
                status.clues[index].counts[keyPath: keyPath] += 1
            }
        }
        musicRecoveryStatus = status
    }

    private func setRecoveryClueReason(_ reason: String, for file: RecoveredMusicFile) {
        var status = musicRecoveryStatus
        for clueTitle in file.clueTitles {
            if let index = status.clues.firstIndex(where: { $0.title == clueTitle }) {
                status.clues[index].reason = reason
            }
        }
        musicRecoveryStatus = status
    }

    private func recoverySummary(_ status: MusicRecoveryStatus) -> String {
        let target = status.target
        if status.targetPlaylistFound {
            return String(
                localized: "DocRoshi Beats ordered entries: found \(target.found), eligible \(target.eligible), recovered \(target.recovered), queued \(target.queued), sent \(target.sent), skipped \(target.skipped), failed \(target.failed)."
            )
        }
        return String(
            localized: "Completed without finding a playlist named DocRoshi Beats. Scanned \(status.overall.found) unique Music items; recovered \(status.overall.recovered), sent \(status.overall.sent), skipped \(status.overall.skipped), and failed \(status.overall.failed)."
        )
    }

    private func refreshMusicInventoryState() async {
        musicInventoryAuthorization = await musicInventoryService.authorization()
        if
            musicInventoryAuthorization == .authorized,
            let cached = await musicInventoryService.cachedInventory()
        {
            musicInventoryTracks = cached.music
            musicInventoryCollections = cached.collections
        } else {
            musicInventoryTracks = []
            musicInventoryCollections = []
        }
        guard let connection else {
            musicInventoryEnabled = false
            musicInventoryLastSyncedAt = nil
            return
        }
        musicInventoryEnabled = await musicInventoryService.sharingEnabled(for: connection.id)
        musicInventoryLastSyncedAt = await musicInventoryService.lastSyncedAt(for: connection.id)
    }

    func consumePendingAppIntent() async {
        let defaults = UserDefaults(suiteName: "group.com.docdamage.pocketdock")
        guard let action = defaults?.string(forKey: "pendingAppIntent") else { return }
        defaults?.removeObject(forKey: "pendingAppIntent")
        switch action {
        case "backup":
            navigationRequest = "send"
            await runPhotoBackup()
        case "doctor":
            navigationRequest = "more"
            await runConnectionDoctor()
        default:
            navigationRequest = action
        }
    }

    func sceneBecameActive() async {
        guard isUnlocked, hasStartedAfterUnlock else { return }
        await consumePendingAppIntent()
        await refreshUSBDocuments()
        // Reconnect/refresh is single-flight and Music recovery checks existing
        // authorization only; foreground re-entry never presents a permission prompt.
        await reconnectAndDeliverRecoveredMusicIfNeeded()
    }

    private func handleDiscoveredDocksForAutomaticDelivery(
        _ docks: [DiscoveredDock]
    ) async {
        guard isUnlocked, hasStartedAfterUnlock else { return }
        let currentDockIDs = Set(docks.map(\.id))
        let newlyAppearedDockIDs = currentDockIDs.subtracting(lastDiscoveredDockIDs)
        lastDiscoveredDockIDs = currentDockIDs
        guard let dock = docks.first(where: { dock in
            newlyAppearedDockIDs.contains(dock.id) &&
            connections.contains(where: {
                $0.pcName.localizedCaseInsensitiveCompare(dock.name) == .orderedSame
            })
        }) else { return }
        // A real Bonjour appearance bypasses a recent foreground failure once;
        // repeat browse publications are suppressed by the appearance set.
        await reconnectAndDeliverRecoveredMusicIfNeeded(
            matching: dock,
            bypassReconnectCooldown: true
        )
    }

    /// Foreground and Bonjour events share one throttled reconnect/refresh task.
    /// Recovery itself remains offline-capable and never asks for permission here.
    private func reconnectAndDeliverRecoveredMusicIfNeeded(
        matching dock: DiscoveredDock? = nil,
        bypassReconnectCooldown: Bool = false
    ) async {
        guard isUnlocked, hasStartedAfterUnlock else { return }
        var saved: SavedConnection?
        if let dock {
            saved = connections.first(where: {
                $0.pcName.localizedCaseInsensitiveCompare(dock.name) == .orderedSame
            })
            if var nearby = saved, nearby.relayURL == nil {
                var components = URLComponents()
                components.scheme = "http"
                components.host = dock.host
                components.port = dock.port
                components.path = "/"
                if let nearbyURL = components.url {
                    nearby.baseURL = nearbyURL
                    nearby.save()
                    saved = nearby
                    connections = SavedConnection.loadAll()
                }
            }
        } else {
            saved = connection ?? connections.first
        }

        if let saved {
            let attemptKey = "\(saved.id.uuidString.lowercased())|\(saved.baseURL.absoluteString)"
            if let running = automaticReconnectTask {
                let joinedRunID = automaticReconnectRunID
                await running.value
                if automaticReconnectRunID == joinedRunID {
                    automaticReconnectTask = nil
                    automaticReconnectRunID = nil
                }
            }
            let recentlyAttempted = !bypassReconnectCooldown &&
                lastAutomaticReconnectKey == attemptKey &&
                lastAutomaticReconnectAt.map { Date().timeIntervalSince($0) < 15 } == true
            if automaticReconnectTask == nil, !recentlyAttempted {
                lastAutomaticReconnectKey = attemptKey
                lastAutomaticReconnectAt = Date()
                let runID = UUID()
                automaticReconnectRunID = runID
                let task = Task<Void, Never> { [weak self] in
                    await self?.performAutomaticReconnectOrRefresh(saved)
                }
                automaticReconnectTask = task
                await task.value
                if automaticReconnectRunID == runID {
                    automaticReconnectTask = nil
                    automaticReconnectRunID = nil
                }
            }
        }

        await recoverMusicIfReady()
        await deliverRecoveredMusicIfConnected()
        await resumePendingTransfers()
    }

    private func performAutomaticReconnectOrRefresh(_ saved: SavedConnection) async {
        let endpointChanged = connection?.id == saved.id && connection?.baseURL != saved.baseURL
        if connectionState != .connected || connection?.id != saved.id || client == nil || endpointChanged {
            await select(saved, reconnect: true, runRecovery: false)
        } else {
            await refresh(triggerRecovery: false)
        }
    }

    func pair(url: URL, pin: String) async {
        errorMessage = nil
        connectionState = .connecting
        do {
            let parsed = try SavedConnection(pairingURL: url)
            let pairingClient = PocketDockClient(connection: parsed)
            let paired = try await pairingClient.pair(pin: pin)
            paired.save()
            connections = SavedConnection.loadAll()
            await select(paired, reconnect: false)
            if connectionState == .connected {
                successFeedback += 1
            }
        } catch {
            connectionState = .unavailable
            errorMessage = error.localizedDescription
            errorFeedback += 1
        }
    }

    func select(
        _ saved: SavedConnection,
        reconnect: Bool = true,
        runRecovery: Bool = true
    ) async {
        errorMessage = nil
        connectionState = .connecting
        connection = saved
        client = PocketDockClient(connection: saved)
        await refreshMusicInventoryState()
        sharedFiles = []
        clipboard = []
        syncProfiles = []
        optionalFeatureMessages = []
        do {
            if reconnect {
                try await client?.reconnect()
            }
            FileProviderBridgeStore.save(saved)
            configureFileProvider(for: saved)
            await refresh(triggerRecovery: false)
            if errorMessage == nil, runRecovery {
                connectionState = .connected
                // Recover/stage first. The recovery sender reconciles any old
                // recovered queue entry before creating one, so reconnect and
                // foreground work cannot race into duplicate transfers.
                await recoverMusicIfReady()
                await deliverRecoveredMusicIfConnected()
                await resumePendingTransfers()
                if !musicInventoryEnabled {
                    await refreshMusicLibrary()
                    updateRecoveryCompletenessWarning()
                }
            } else if errorMessage != nil, runRecovery {
                // The authenticated health check can fail without throwing out
                // of refresh(); local staging must still run while the PC is off.
                await recoverMusicIfReady()
            }
        } catch {
            connectionState = .unavailable
            errorMessage = saved.relayURL == nil
                ? String(localized: "Scan PocketDock again to refresh this connection.")
                : error.localizedDescription
            errorFeedback += 1
            // A PC outage must not block staging owned, eligible music into
            // the USB-visible Documents container.
            if runRecovery {
                await recoverMusicIfReady()
            }
        }
    }

    func connectNearby(_ dock: DiscoveredDock) async {
        guard var saved = connections.first(where: {
            $0.pcName.localizedCaseInsensitiveCompare(dock.name) == .orderedSame
        }) else {
            errorMessage = String(
                localized: "Scan this computer’s QR code once to establish its encrypted identity."
            )
            return
        }
        var components = URLComponents()
        components.scheme = "http"
        components.host = dock.host
        components.port = dock.port
        components.path = "/"
        guard let url = components.url else {
            errorMessage = String(localized: "The nearby computer address could not be resolved.")
            return
        }
        saved.baseURL = url
        saved.save()
        connections = SavedConnection.loadAll()
        await select(saved)
    }

    func refresh(triggerRecovery: Bool = false) async {
        guard let client else { return }
        errorMessage = nil
        isRefreshing = true
        defer { isRefreshing = false }

        // `/api/me` is the baseline authenticated health check. Feature
        // endpoints below are permission-gated independently on the PC and a
        // denied optional feature must not make a fresh pairing look offline.
        do {
            _ = try await client.backupSchedule()
            connectionState = .connected
            lastRefreshAt = Date()
        } catch {
            connectionState = .unavailable
            errorMessage = error.localizedDescription
            errorFeedback += 1
            if triggerRecovery {
                await recoverMusicIfReady(reportErrors: true)
            }
            return
        }


        var notices: [String] = []
        do {
            sharedFiles = try await client.sharedFiles()
        } catch {
            sharedFiles = []
            notices.append(optionalFeatureNotice("Receive from PC", error: error))
        }
        do {
            clipboard = try await client.clipboardEntries()
        } catch {
            clipboard = []
            notices.append(optionalFeatureNotice("Clipboard", error: error))
        }
        do {
            syncProfiles = try await client.syncProfiles()
        } catch {
            syncProfiles = []
            notices.append(optionalFeatureNotice("Automatic folder sync", error: error))
        }
        do {
            producerPackages = try await client.producerPackages()
        } catch {
            producerPackages = []
            notices.append(optionalFeatureNotice("Producer Studio", error: error))
        }
        do {
            driveEntries = try await client.driveEntries(path: drivePath)
        } catch {
            driveEntries = []
            notices.append(optionalFeatureNotice("PocketDock Drive", error: error))
        }
        optionalFeatureMessages = notices
        await refreshSyncFolderNames()
        if triggerRecovery, connectionState == .connected {
            await recoverMusicIfReady(reportErrors: true)
            await deliverRecoveredMusicIfConnected(reportErrors: true)
            await resumePendingTransfers()
        }
    }

    private func optionalFeatureNotice(_ feature: String, error: Error) -> String {
        let detail = error.localizedDescription
        let normalized = detail.lowercased()
        let permissionWords = ["allow", "permission", "disabled", "access", "forbidden"]
        if permissionWords.contains(where: { normalized.contains($0) }) {
            return String(localized: "\(feature) permission is off: \(detail)")
        }
        return String(localized: "\(feature) is temporarily unavailable: \(detail)")
    }

    @discardableResult
    func upload(urls: [URL], waitForCompletion: Bool = false) async -> Bool {
        await upload(
            sources: urls.map {
                UploadSource(url: $0, relativePath: $0.lastPathComponent)
            },
            waitForCompletion: waitForCompletion
        )
    }

    @discardableResult
    private func upload(
        documents: [USBDocumentItem],
        waitForCompletion: Bool = false
    ) async -> Bool {
        await upload(
            sources: documents.map {
                UploadSource(url: $0.url, relativePath: $0.relativePath)
            },
            waitForCompletion: waitForCompletion
        )
    }

    @discardableResult
    private func upload(
        sources: [UploadSource],
        waitForCompletion: Bool
    ) async -> Bool {
        guard !sources.isEmpty else {
            reportEmptyImporterSelection(context: "Send to PC")
            return false
        }
        guard client != nil else {
            errorMessage = String(localized: "Connect to a PC before sending files.")
            errorFeedback += 1
            return false
        }
        var succeeded = true
        for source in sources {
            let id = UUID()
            do {
                let staged = try await transferJournal.stage(source.url, id: id)
                let size = (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize)
                    .map(Int64.init) ?? 0
                transfers.insert(
                    MobileTransfer(
                        id: id,
                        name: source.url.lastPathComponent,
                        localPath: staged.path,
                        relativePath: source.relativePath,
                        size: size,
                        recoveryPersistentID: source.recoveryPersistentID,
                        recoverySHA256: source.recoverySHA256,
                        connectionID: source.connectionID ?? connection?.id
                    ),
                    at: 0
                )
                try await transferJournal.save(transfers)
                if waitForCompletion {
                    guard let task = startTransfer(id) else { return false }
                    await task.value
                    let completed = transfers.first(where: { $0.id == id })?.completed == true
                    succeeded = succeeded && completed
                    guard completed else { return false }
                } else {
                    startTransfer(id)
                }
            } catch {
                errorMessage = error.localizedDescription
                errorFeedback += 1
                succeeded = false
                if waitForCompletion { return false }
            }
        }
        return succeeded
    }

    func pauseTransfer(_ id: UUID) {
        pendingTransferResumes.remove(id)
        transferTasks[id]?.cancel()
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].paused = true
        transfers[index].manuallyPaused = true
        transfers[index].error = nil
        transfers[index].updatedAt = Date()
        Task {
            try? await transferJournal.save(transfers)
            await TransferActivityCoordinator.shared.update(
                id: id,
                progress: transfers[index].progress,
                speed: 0,
                status: "Paused"
            )
        }
    }

    func resumeTransfer(_ id: UUID) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].paused = false
        transfers[index].manuallyPaused = false
        transfers[index].error = nil
        if transferTasks[id] != nil {
            pendingTransferResumes.insert(id)
            return
        }
        startTransfer(id)
    }

    func retryTransfer(_ id: UUID) {
        resumeTransfer(id)
    }

    @discardableResult
    private func startTransfer(_ id: UUID) -> Task<Void, Never>? {
        guard transferTasks[id] == nil else { return nil }
        let task = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.performTransfer(id)
        }
        transferTasks[id] = task
        return task
    }

    private func performTransfer(_ id: UUID) async {
        defer {
            transferTasks[id] = nil
            if pendingTransferResumes.remove(id) != nil {
                startTransfer(id)
            }
        }
        do {
            try await prepareRecoveredTransferForUpload(id)
            try Task.checkCancellation()
        } catch {
            if error is CancellationError || Task.isCancelled {
                if let index = transfers.firstIndex(where: { $0.id == id }) {
                    transfers[index].paused = true
                    transfers[index].updatedAt = Date()
                }
                try? await transferJournal.save(transfers)
            } else {
                markTransfer(id, error: error.localizedDescription)
                errorMessage = error.localizedDescription
                errorFeedback += 1
            }
            return
        }
        guard
            let client,
            let initial = transfers.first(where: { $0.id == id }),
            let localPath = initial.localPath,
            FileManager.default.fileExists(atPath: localPath)
        else {
            markTransfer(id, error: String(localized: "The queued source file is no longer available."))
            return
        }
        guard initial.connectionID == nil || initial.connectionID == connection?.id else {
            markTransfer(
                id,
                error: String(localized: "This queue entry belongs to a different paired computer.")
            )
            return
        }
        await TransferActivityCoordinator.shared.start(
            id: id,
            fileName: initial.name,
            computerName: connection?.pcName ?? "PC"
        )
        do {
            try await client.upload(
                fileURL: URL(fileURLWithPath: localPath),
                relativePath: initial.relativePath
            ) { [weak self] progress, speed in
                Task { @MainActor in
                    guard
                        let self,
                        let index = self.transfers.firstIndex(where: { $0.id == id })
                    else { return }
                    self.transfers[index].progress = progress
                    self.transfers[index].bytesPerSecond = speed
                    self.transfers[index].updatedAt = Date()
                    try? await self.transferJournal.save(self.transfers)
                    await TransferActivityCoordinator.shared.update(
                        id: id,
                        progress: progress,
                        speed: speed
                    )
                }
            }
            if let index = transfers.firstIndex(where: { $0.id == id }) {
                transfers[index].progress = 1
                transfers[index].completed = true
                transfers[index].paused = false
                transfers[index].manuallyPaused = false
                transfers[index].updatedAt = Date()
                // The server has verified the completed file at this point. Free
                // the queue copy before Send All stages the next original so a
                // large library does not consume a second library's worth of space.
                // Keep the path when cleanup fails so Clear Finished can retry it.
                let completedTransfer = transfers[index]
                do {
                    try await transferJournal.removeStagedFile(for: completedTransfer)
                    if let completedIndex = transfers.firstIndex(where: { $0.id == id }) {
                        transfers[completedIndex].localPath = nil
                    }
                } catch {
                    errorMessage = String(
                        localized: "The file was sent, but its temporary queue copy could not be removed. Use Clear Finished to retry cleanup."
                    )
                }
            }
            try? await transferJournal.save(transfers)
            await markRecoveredTransferSentIfNeeded(id)
            await TransferActivityCoordinator.shared.finish(id: id, success: true)
            successFeedback += 1
        } catch {
            if
                error is CancellationError ||
                Task.isCancelled ||
                (error as? URLError)?.code == .cancelled
            {
                if let index = transfers.firstIndex(where: { $0.id == id }) {
                    transfers[index].paused = true
                    transfers[index].updatedAt = Date()
                }
                try? await transferJournal.save(transfers)
            } else {
                markTransfer(id, error: error.localizedDescription)
                errorMessage = error.localizedDescription
                await TransferActivityCoordinator.shared.finish(id: id, success: false)
                errorFeedback += 1
            }
        }
    }

    /// Every recovered upload is rebound to the service's currently verified
    /// digest. Old journal rows and changed/corrupt queue copies are restaged
    /// under the same transfer ID before any network request begins.
    private func prepareRecoveredTransferForUpload(_ id: UUID) async throws {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else {
            throw PocketDockError.server("The recovery queue entry no longer exists.")
        }
        let queued = transfers[index]
        let relativePath = queued.relativePath ?? ""
        guard queued.recoveryPersistentID != nil || relativePath.hasPrefix("Recovered Music/") else {
            return
        }
        guard let recovered = try await musicRecoveryService.verifiedRecoveredFile(
            persistentID: queued.recoveryPersistentID,
            relativePath: queued.relativePath
        ) else {
            throw PocketDockError.server(
                "The recovered original no longer matches its verified recovery record. Run Recover Now before retrying."
            )
        }

        var stagedCopyMatches = false
        if queued.recoverySHA256 == recovered.sha256, let localPath = queued.localPath {
            stagedCopyMatches = try await transferJournal.fileMatchesSHA256(
                atPath: localPath,
                expected: recovered.sha256
            )
        }
        let stagedURL: URL
        if stagedCopyMatches, let localPath = queued.localPath {
            stagedURL = URL(fileURLWithPath: localPath)
        } else {
            stagedURL = try await transferJournal.stageVerified(
                recovered.url,
                id: id,
                expectedSHA256: recovered.sha256
            )
        }
        let size = Int64(
            (try stagedURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        )
        guard size > 0,
              let refreshedIndex = transfers.firstIndex(where: { $0.id == id })
        else { throw CocoaError(.fileReadCorruptFile) }
        transfers[refreshedIndex].localPath = stagedURL.path
        transfers[refreshedIndex].relativePath = recovered.relativePath
        transfers[refreshedIndex].size = size
        transfers[refreshedIndex].recoveryPersistentID = recovered.persistentID
        transfers[refreshedIndex].recoverySHA256 = recovered.sha256
        transfers[refreshedIndex].connectionID = queued.connectionID ?? connection?.id
        try await transferJournal.save(transfers)
    }

    private func markRecoveredTransferSentIfNeeded(_ id: UUID) async {
        guard let index = transfers.firstIndex(where: { $0.id == id }),
              transfers[index].completed,
              let relativePath = transfers[index].relativePath,
              let deliveryConnectionID = transfers[index].connectionID ?? connection?.id
        else { return }
        do {
            guard let recovered = try await musicRecoveryService.verifiedRecoveredFile(
                persistentID: transfers[index].recoveryPersistentID,
                relativePath: relativePath
            ), transfers[index].recoverySHA256 == recovered.sha256
            else { return }
            try await musicRecoveryService.markSent(
                persistentID: recovered.persistentID,
                to: deliveryConnectionID
            )
            transfers[index].recoveryPersistentID = recovered.persistentID
            transfers[index].recoverySHA256 = recovered.sha256
            transfers[index].connectionID = deliveryConnectionID
            try? await transferJournal.save(transfers)
        } catch {
            errorMessage = String(
                localized: "The PC verified this recovered file, but PocketDock could not save its recovery receipt: \(error.localizedDescription)"
            )
            errorFeedback += 1
        }
    }

    private func markTransfer(_ id: UUID, error: String) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].error = error
        transfers[index].paused = false
        transfers[index].manuallyPaused = false
        transfers[index].updatedAt = Date()
        Task { try? await transferJournal.save(transfers) }
    }

    private func resumePendingTransfers() async {
        guard !isReconcilingTransferQueue,
              !isRecoveringMusic,
              connectionState == .connected,
              client != nil,
              let activeConnectionID = connection?.id
        else { return }
        isReconcilingTransferQueue = true
        defer { isReconcilingTransferQueue = false }
        var canonicalRecoveryTransfers: [String: UUID] = [:]
        let orderedIDs = transfers.sorted { left, right in
            if left.completed != right.completed { return left.completed }
            if left.isActive != right.isActive { return left.isActive }
            return left.updatedAt > right.updatedAt
        }.map(\.id)

        for id in orderedIDs {
            guard let index = transfers.firstIndex(where: { $0.id == id }) else { continue }
            if let queuedConnectionID = transfers[index].connectionID,
               queuedConnectionID != activeConnectionID
            {
                continue
            }
            let relativePath = transfers[index].relativePath ?? ""
            var recoveryID = transfers[index].recoveryPersistentID
            if recoveryID == nil, relativePath.hasPrefix("Recovered Music/") {
                do {
                    recoveryID = try await musicRecoveryService.persistentID(
                        forRecoveredRelativePath: relativePath
                    )
                    transfers[index].recoveryPersistentID = recoveryID
                    transfers[index].connectionID = activeConnectionID
                } catch {
                    errorMessage = error.localizedDescription
                    errorFeedback += 1
                    continue
                }
            }
            if let recoveryKey = recoveryID.map({ "id:\($0)" }) ??
                (relativePath.hasPrefix("Recovered Music/") ? "path:\(relativePath)" : nil)
            {
                if let canonicalID = canonicalRecoveryTransfers[recoveryKey],
                   let canonicalIndex = transfers.firstIndex(where: { $0.id == canonicalID }),
                   let candidateIndex = transfers.firstIndex(where: { $0.id == id })
                {
                    let recovered = try? await musicRecoveryService.verifiedRecoveredFile(
                        persistentID: recoveryID,
                        relativePath: relativePath
                    )
                    let expectedHash = recovered?.sha256
                    let canonicalMatches = expectedHash != nil &&
                        transfers[canonicalIndex].recoverySHA256 == expectedHash
                    let candidateMatches = expectedHash != nil &&
                        transfers[candidateIndex].recoverySHA256 == expectedHash
                    if candidateMatches && !canonicalMatches {
                        await retireDuplicateRecoveredTransfers([canonicalID], keeping: id)
                        canonicalRecoveryTransfers[recoveryKey] = id
                    } else {
                        await retireDuplicateRecoveredTransfers([id], keeping: canonicalID)
                        continue
                    }
                } else {
                    canonicalRecoveryTransfers[recoveryKey] = id
                }
            }
            guard let currentIndex = transfers.firstIndex(where: { $0.id == id }) else { continue }
            if transfers[currentIndex].completed {
                if recoveryID != nil || relativePath.hasPrefix("Recovered Music/") {
                    do {
                        guard let recovered = try await musicRecoveryService.verifiedRecoveredFile(
                            persistentID: recoveryID,
                            relativePath: relativePath
                        ) else {
                            throw PocketDockError.server(
                                "The completed recovery row has no verified recovered original."
                            )
                        }
                        let hashBoundCompletion = transfers[currentIndex].recoverySHA256 == recovered.sha256 &&
                            transfers[currentIndex].connectionID == activeConnectionID
                        let durableReceipt = try await musicRecoveryService.deliveryIsRecorded(
                            persistentID: recovered.persistentID,
                            sha256: recovered.sha256,
                            to: activeConnectionID
                        )
                        if hashBoundCompletion || durableReceipt {
                            transfers[currentIndex].recoveryPersistentID = recovered.persistentID
                            transfers[currentIndex].recoverySHA256 = recovered.sha256
                            transfers[currentIndex].connectionID = activeConnectionID
                            transfers[currentIndex].relativePath = recovered.relativePath
                            try? await transferJournal.save(transfers)
                            await markRecoveredTransferSentIfNeeded(id)
                            continue
                        }
                        // An unbound legacy completion cannot prove which bytes
                        // reached this PC. Reuse its ID, but stage and send the
                        // current verified recovery record again.
                        transfers[currentIndex].completed = false
                        transfers[currentIndex].progress = 0
                        transfers[currentIndex].localPath = nil
                    } catch {
                        errorMessage = error.localizedDescription
                        errorFeedback += 1
                        continue
                    }
                } else {
                    continue
                }
            }
            guard let resumableIndex = transfers.firstIndex(where: { $0.id == id }) else { continue }
            guard transfers[resumableIndex].manuallyPaused != true else { continue }
            if transfers[resumableIndex].error != nil, recoveryID == nil { continue }

            transfers[resumableIndex].paused = false
            transfers[resumableIndex].manuallyPaused = false
            transfers[resumableIndex].error = nil
            transfers[resumableIndex].connectionID = transfers[resumableIndex].connectionID ?? activeConnectionID
            try? await transferJournal.save(transfers)
            let task: Task<Void, Never>?
            if let activeTask = transferTasks[id] {
                task = activeTask
            } else {
                task = startTransfer(id)
            }
            guard let task else { continue }
            await task.value
            if recoveryID != nil || relativePath.hasPrefix("Recovered Music/") {
                await markRecoveredTransferSentIfNeeded(id)
            }
        }
    }

    func download(_ file: RemoteSharedFile) async -> URL? {
        do {
            return try await client?.download(file: file)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func sendClipboard(_ content: String) async {
        do {
            try await client?.sendClipboard(content)
            await refresh()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
            errorFeedback += 1
        }
    }

    func sendRichClipboard(
        _ content: String,
        kind: String? = nil,
        pinned: Bool,
        expiresMinutes: Int,
        fileName: String? = nil
    ) async {
        do {
            try await client?.sendClipboard(
                content,
                kind: kind,
                pinned: pinned,
                expiresMinutes: expiresMinutes,
                fileName: fileName
            )
            await refresh()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
            errorFeedback += 1
        }
    }

    func sendClipboardAttachment(_ url: URL) async {
        guard await upload(urls: [url], waitForCompletion: true) else { return }
        let kind = ["png", "jpg", "jpeg", "heic", "gif", "webp"]
            .contains(url.pathExtension.lowercased()) ? "image" : "file"
        await sendRichClipboard(
            url.lastPathComponent,
            kind: kind,
            pinned: false,
            expiresMinutes: 24 * 60,
            fileName: url.lastPathComponent
        )
    }

    func toggleClipboardPin(_ entry: RemoteClipboardEntry) async {
        do {
            try await client?.updateClipboard(entry.id, pinned: !(entry.pinned ?? false))
            clipboard = try await client?.clipboardEntries() ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteClipboard(_ entry: RemoteClipboardEntry) async {
        do {
            try await client?.deleteClipboard(entry.id)
            clipboard.removeAll { $0.id == entry.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshDrive() async {
        do {
            driveEntries = try await client?.driveEntries(path: drivePath) ?? []
        } catch {
            driveEntries = []
        }
    }

    func searchDrive() async {
        let query = driveSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            driveSearchResults = []
            return
        }
        do {
            let remote = try await client?.searchDrive(query) ?? []
            let offline = await offlineDrive.search(query).map {
                MobileDriveEntry(
                    id: $0.id,
                    name: $0.name,
                    relativePath: $0.relativePath,
                    kind: "file",
                    size: $0.size,
                    modifiedAt: $0.modifiedAt,
                    mimeType: $0.mimeType
                )
            }
            driveSearchResults = Array(
                Dictionary(grouping: remote + offline, by: \.id)
                    .compactMap { $0.value.first }
                    .prefix(150)
            )
        } catch {
            driveSearchResults = []
        }
    }

    func openDriveFolder(_ entry: MobileDriveEntry) async {
        guard entry.kind == "folder" else { return }
        drivePath = entry.relativePath
        await refreshDrive()
    }

    func upDriveFolder() async {
        drivePath = (drivePath as NSString).deletingLastPathComponent
        await refreshDrive()
    }

    func downloadDriveFile(_ entry: MobileDriveEntry) async {
        do {
            driveDownloadedURL = try await client?.downloadDriveFile(entry)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func previewDriveFile(_ entry: MobileDriveEntry) async {
        if let cached = offlineDriveItems.first(where: { $0.id == entry.id }) {
            quickLookURL = URL(fileURLWithPath: cached.localPath)
            return
        }
        await downloadDriveFile(entry)
        quickLookURL = driveDownloadedURL
    }

    func pinDriveFile(_ entry: MobileDriveEntry) async {
        do {
            guard let downloaded = try await client?.downloadDriveFile(entry) else { return }
            _ = try await offlineDrive.cache(entry: entry, downloadedURL: downloaded)
            offlineDriveItems = await offlineDrive.items()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeOfflineDriveItem(_ item: OfflineDriveItem) async {
        do {
            try await offlineDrive.remove(item)
            offlineDriveItems = await offlineDrive.items()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshOfflineDrive() async {
        guard let client else { return }
        do {
            for cached in offlineDriveItems {
                let match = try await client.searchDrive(cached.name).first {
                    $0.relativePath == cached.relativePath && $0.kind == "file"
                }
                guard let match, match.modifiedAt != cached.modifiedAt else { continue }
                let downloaded = try await client.downloadDriveFile(match)
                _ = try await offlineDrive.cache(entry: match, downloadedURL: downloaded)
            }
            offlineDriveItems = await offlineDrive.items()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func runConnectionDoctor() async {
        guard let client else { return }
        do {
            var report = try await client.diagnosticReport()
            let camera = AVCaptureDevice.authorizationStatus(for: .video)
            let photos = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            report.checks.append(contentsOf: [
                DiagnosticCheck(
                    id: "iphone-camera",
                    title: "QR camera access",
                    status: camera == .authorized ? "pass" : "warning",
                    detail: camera == .authorized
                        ? "Camera access is ready for pairing."
                        : "Allow Camera access in Settings to scan a new PC."
                ),
                DiagnosticCheck(
                    id: "iphone-photos",
                    title: "Photo library access",
                    status: photos == .authorized || photos == .limited ? "pass" : "info",
                    detail: "Controls Camera Roll backup and full migration access."
                ),
                DiagnosticCheck(
                    id: "background-refresh",
                    title: "Background App Refresh",
                    status: UIApplication.shared.backgroundRefreshStatus == .available
                        ? "pass" : "warning",
                    detail: UIApplication.shared.backgroundRefreshStatus == .available
                        ? "PocketDock may continue approved background work."
                        : "Enable Background App Refresh for more reliable unattended transfers."
                )
            ])
            diagnosticReport = report
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("PocketDock-Connection-Report.json")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report).write(to: url, options: .atomic)
            diagnosticExportURL = url
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshProducerPackages() async {
        do {
            producerPackages = try await client?.producerPackages() ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reviewProducerPackage(_ package: MobileProducerPackage, approved: Bool, note: String) async {
        do {
            try await client?.reviewProducerPackage(
                id: package.id,
                status: approved ? "approved" : "changes-requested",
                note: note
            )
            await refreshProducerPackages()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func previewProducerTrack(_ track: MobileProducerTrack, package: MobileProducerPackage) async {
        do {
            quickLookURL = try await client?.downloadProducerTrack(
                packageId: package.id,
                track: track
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func prepareMigration() async {
        do {
            migrationReport = try await migration.inventory()
            migrationMessage = "Inventory ready"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func runFullMigration() async {
        guard let client, let connection else { return }
        do {
            migrationReport = try await migration.migrate(
                connectionId: connection.id,
                client: client
            ) { [weak self] report, message in
                Task { @MainActor in
                    self?.migrationReport = report
                    self?.migrationMessage = message
                }
            }
            let contacts = try await contactBackup.exportVCard()
            defer { try? FileManager.default.removeItem(at: contacts.url) }
            try await client.upload(
                fileURL: contacts.url,
                relativePath: "Phone Migration/Contacts/Contacts.vcf",
                progress: { _, _ in }
            )
            migrationReport?.contactsTransferred = contacts.count
            if let report = migrationReport {
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("PocketDock-Phone-Migration-Report.json")
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(report).write(to: url, options: .atomic)
                try await client.upload(
                    fileURL: url,
                    relativePath: "Phone Migration/PocketDock-Phone-Migration-Report.json",
                    progress: { _, _ in }
                )
                try? FileManager.default.removeItem(at: url)
            }
            migrationMessage = "Migration complete and verified"
            successFeedback += 1
        } catch {
            migrationMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    func unlockVault() async {
        vaultUnlocked = await authenticateDeviceOwner(
            reason: String(localized: "Open your encrypted PocketDock vault")
        )
        if vaultUnlocked { vaultItems = await mobileVault.items() }
    }

    func lockVault() {
        if let vaultExportURL {
            try? FileManager.default.removeItem(at: vaultExportURL)
        }
        vaultUnlocked = false
        vaultExportURL = nil
    }

    func importVaultFile(_ url: URL) async {
        guard vaultUnlocked else { return }
        do {
            _ = try await mobileVault.importFile(url)
            vaultItems = await mobileVault.items()
            successFeedback += 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func exportVaultItem(_ item: MobileVaultItem) async {
        guard vaultUnlocked else { return }
        do {
            if let vaultExportURL {
                try? FileManager.default.removeItem(at: vaultExportURL)
            }
            vaultExportURL = try await mobileVault.export(item)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeVaultItem(_ item: MobileVaultItem) async {
        guard vaultUnlocked else { return }
        do {
            try await mobileVault.remove(item)
            vaultItems = await mobileVault.items()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveBackupPreferences() async {
        await photoBackup.savePreferences(backupPreferences)
        if backupPreferences.enabled {
            await photoBackup.schedule()
        } else {
            await photoBackup.cancelScheduled()
        }
    }

    func runPhotoBackup() async {
        guard let connection, let client else {
            errorMessage = String(localized: "Connect to a PC before starting backup.")
            return
        }
        do {
            try await photoBackup.backUpNewAssets(
                connectionId: connection.id,
                client: client
            ) { [weak self] update in
                Task { @MainActor in self?.backupProgress = update }
            }
        } catch is CancellationError {
            backupProgress.running = false
            backupProgress.message = String(localized: "Backup paused")
        } catch {
            backupProgress.running = false
            backupProgress.message = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    func runContactBackup() async {
        guard let client else {
            errorMessage = String(localized: "Connect to a PC before backing up contacts.")
            return
        }
        contactBackupMessage = String(localized: "Preparing encrypted contacts backup…")
        do {
            let export = try await contactBackup.exportVCard()
            defer { try? FileManager.default.removeItem(at: export.url) }
            try await client.upload(fileURL: export.url) { [weak self] progress, _ in
                Task { @MainActor in
                    self?.contactBackupMessage =
                        "\(Int(progress * 100))% · \(export.count) contacts"
                }
            }
            contactBackupMessage =
                String(localized: "\(export.count) contacts backed up and verified")
        } catch {
            contactBackupMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    func chooseSyncFolder(_ folder: URL, profile: MobileSyncProfile) async {
        do {
            try await folderSync.saveFolder(folder, for: profile.id)
            syncFolderNames[profile.id] = folder.lastPathComponent
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func runSync(_ profile: MobileSyncProfile) async {
        guard let client else { return }
        syncMessage = String(localized: "Preparing folder sync…")
        do {
            try await folderSync.synchronize(profile: profile, client: client) {
                [weak self] message in
                Task { @MainActor in self?.syncMessage = message }
            }
        } catch {
            syncMessage = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    func forgetCurrentComputer() async {
        guard let id = connection?.id else { return }
        await musicInventoryService.removeConnection(id)
        SavedConnection.clear(id: id)
        connections = SavedConnection.loadAll()
        connection = nil
        client = nil
        connectionState = .disconnected
        musicInventoryEnabled = false
        musicInventoryLastSyncedAt = nil
        clearRemoteContent()
        if let next = connections.first {
            await select(next)
        }
    }

    private func clearRemoteContent() {
        sharedFiles = []
        clipboard = []
        producerPackages = []
        syncProfiles = []
        driveEntries = []
        drivePath = ""
        driveDownloadedURL = nil
        syncFolderNames = [:]
        optionalFeatureMessages = []
    }

    func clearFinishedTransfers() {
        let finished = transfers.filter(\.completed)
        guard !finished.isEmpty else { return }
        Task {
            var cleared = Set<UUID>()
            var cleanupError: String?
            for transfer in finished {
                do {
                    try await transferJournal.removeStagedFile(for: transfer)
                    cleared.insert(transfer.id)
                } catch {
                    cleanupError = cleanupError ?? error.localizedDescription
                }
            }
            transfers.removeAll { cleared.contains($0.id) }
            try? await transferJournal.save(transfers)
            if let cleanupError {
                errorMessage = String(
                    localized: "Some finished queue files could not be cleared: \(cleanupError)"
                )
                errorFeedback += 1
            } else {
                successFeedback += 1
            }
        }
    }

    private func configureFileProvider(for connection: SavedConnection) {
        guard connection.relayURL == nil else { return }
        let domain = NSFileProviderDomain(
            identifier: NSFileProviderDomainIdentifier("com.docdamage.pocketdock.drive"),
            displayName: "PocketDock · \(connection.pcName)"
        )
        NSFileProviderManager.add(domain) { error in
            if let error {
                Task { @MainActor [weak self] in
                    self?.errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func refreshSyncFolderNames() async {
        var names: [UUID: String] = [:]
        for profile in syncProfiles {
            if let folder = await folderSync.folder(for: profile.id) {
                names[profile.id] = folder.lastPathComponent
            }
        }
        syncFolderNames = names
    }

    private func registerBackgroundBackup() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "com.docdamage.pocketdock.transfer",
            using: nil
        ) { [weak self] task in
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            let operation = Task { @MainActor [weak self] in
                guard let self else {
                    processingTask.setTaskCompleted(success: false)
                    return
                }
                await self.runPhotoBackup()
                processingTask.setTaskCompleted(
                    success: self.backupProgress.message !=
                        String(localized: "Backup paused")
                )
                await self.photoBackup.schedule()
            }
            processingTask.expirationHandler = {
                operation.cancel()
            }
        }
    }

    private func importShareExtensionQueue() async {
        guard client != nil else { return }
        let defaults = UserDefaults(suiteName: "group.com.docdamage.pocketdock")
        guard let paths = defaults?.stringArray(forKey: "pendingSharePaths"), !paths.isEmpty
        else { return }
        defaults?.removeObject(forKey: "pendingSharePaths")
        await upload(urls: paths.map(URL.init(fileURLWithPath:)))
    }
}
