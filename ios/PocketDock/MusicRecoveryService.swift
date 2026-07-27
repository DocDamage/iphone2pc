@preconcurrency import AVFoundation
import CryptoKit
import Foundation
@preconcurrency import MediaPlayer

struct MusicRecoveryCounts: Sendable {
    var found = 0
    var eligible = 0
    var recovered = 0
    var newlyRecovered = 0
    var queued = 0
    var sent = 0
    var skipped = 0
    var failed = 0
    var alreadyRecovered = 0
    var protected = 0
    var cloudWithoutAssetURL = 0
    var missingAssetURL = 0
    var notExportable = 0
    var exportFailed = 0
}

struct MusicRecoveryTargetItemStatus: Identifiable, Codable, Sendable {
    let id: String
    let playlistPersistentID: String
    let playlistName: String
    let position: Int
    let persistentID: String
    let title: String
    let artist: String
    var status: String
    var reason: String
    var recoveredRelativePath: String?
}

struct MusicRecoveryClueStatus: Identifiable, Sendable {
    let id: String
    let title: String
    var counts = MusicRecoveryCounts()
    var reason = "Not found in the Music library yet."
}

struct MusicRecoveryStatus: Sendable {
    var enabled = true
    var running = false
    var phase = "Waiting"
    var message = "Allow Music access once. PocketDock will recover eligible local audio whenever the app opens or returns to the foreground."
    var processed = 0
    var total = 0
    var targetPlaylistFound = false
    var targetPlaylistName = MusicRecoveryService.targetPlaylistName
    var target = MusicRecoveryCounts()
    var overall = MusicRecoveryCounts()
    var targetItems: [MusicRecoveryTargetItemStatus] = []
    var musicKitExpectedTargetEntries: Int?
    var completenessWarning: String?
    var clues = MusicRecoveryService.clueTitles.map {
        MusicRecoveryClueStatus(id: $0.lowercased(), title: $0)
    }

    static func idle(enabled: Bool) -> MusicRecoveryStatus {
        var value = MusicRecoveryStatus()
        value.enabled = enabled
        if !enabled {
            value.phase = "Off"
            value.message = "Automatic recovery is off."
        }
        return value
    }
}

struct RecoveredMusicFile: Identifiable, Sendable {
    var id: String { persistentID }
    let persistentID: String
    let sha256: String
    let title: String
    let url: URL
    let relativePath: String
    let isTargetPlaylist: Bool
    let clueTitles: [String]
    let targetEntryIDs: [String]
}

struct MusicRecoveryRun: Sendable {
    let status: MusicRecoveryStatus
    let recoveredFiles: [RecoveredMusicFile]
}

/// Personal-library recovery for locally stored, unprotected Music items.
///
/// MediaPlayer is deliberately used as the first gate: protected items and items
/// without a usable asset URL are never handed to AVFoundation. Cloud-library
/// membership alone is not an exclusion. Eligible assets are
/// remuxed (or, when passthrough is unavailable, exported as Apple M4A) into the
/// app's USB-visible Documents/Recovered Music directory. A durable SHA-256
/// record makes recovery incremental and prevents a verified file from being
/// overwritten on later launches.
actor MusicRecoveryService {
    static let targetPlaylistName = "DocRoshi Beats"
    static let clueTitles = [
        "the abandoning",
        "Alien Graveyard",
        "ding dong mfer"
    ]

    private let manager = FileManager.default
    private let enabledKey = "PocketDock.music-recovery.enabled"

    private struct Candidate {
        let item: MPMediaItem
        let persistentID: String
        let title: String
        let artist: String
        let clueTitles: [String]
        var targetEntryIDs: [String]

        var isTargetPlaylist: Bool { !targetEntryIDs.isEmpty }
    }

    private struct RecoveryRecord: Codable {
        let persistentID: String
        let relativePath: String
        let byteCount: Int64
        let modifiedAt: TimeInterval
        let sha256: String
        var sentConnectionIDs: [String]
        var title: String?
        var artist: String?
        var isTargetPlaylist: Bool?
        var clueTitles: [String]?
        var targetEntryIDs: [String]?
    }

    private struct RecoveryStore: Codable {
        var records: [String: RecoveryRecord] = [:]
    }

    private struct TargetPlaylistManifest: Codable {
        let formatVersion: Int
        let generatedAt: Date
        let playlistName: String
        let entries: [MusicRecoveryTargetItemStatus]
    }

    private struct ExportConfiguration {
        let session: AVAssetExportSession
        let fileType: AVFileType
        let fileExtension: String
    }

    private final class ExportSessionBox: @unchecked Sendable {
        let session: AVAssetExportSession

        init(_ session: AVAssetExportSession) {
            self.session = session
        }
    }

    func isEnabled() -> Bool {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: enabledKey) != nil else { return true }
        return defaults.bool(forKey: enabledKey)
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: enabledKey)
    }

    func authorizationIsReady() -> Bool {
        MPMediaLibrary.authorizationStatus() == .authorized
    }

    /// This may show Apple's system prompt, so AppModel calls it only from the
    /// explicit Music-access button.
    func requestAuthorization() async -> Bool {
        let status = await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        return status == .authorized
    }

    func recover(
        reportingFor connectionID: UUID?,
        progress: @escaping @Sendable (MusicRecoveryStatus) -> Void
    ) async throws -> MusicRecoveryRun {
        guard isEnabled() else {
            return MusicRecoveryRun(status: .idle(enabled: false), recoveredFiles: [])
        }
        guard authorizationIsReady() else {
            var status = MusicRecoveryStatus.idle(enabled: true)
            status.phase = "Music access needed"
            status.message = "Allow Music access to recover locally stored, unprotected tracks."
            return MusicRecoveryRun(status: status, recoveredFiles: [])
        }

        var status = MusicRecoveryStatus.idle(enabled: true)
        status.running = true
        status.phase = "Scanning Music"
        status.message = "Looking for the complete DocRoshi Beats playlist first…"
        progress(status)

        let candidates = enumerateCandidates(status: &status)
        status.total = candidates.count
        status.overall.found = candidates.count
        status.message = status.targetPlaylistFound
            ? "Found \(status.target.found) ordered DocRoshi Beats entries across \(candidates.filter(\.isTargetPlaylist).count) unique audio items. Checking every entry…"
            : "DocRoshi Beats was not found by name. Checking the named tracks and the rest of the library…"
        var store = try loadStore()
        _ = try loadTargetManifestEntries()
        try saveTargetManifest(status.targetItems)
        progress(status)

        var recoveredFiles: [RecoveredMusicFile] = []
        let normalizedConnectionID = connectionID?.uuidString.lowercased()

        for (index, candidate) in candidates.enumerated() {
            try Task.checkCancellation()
            guard isEnabled() else { throw CancellationError() }
            status.phase = "Recovering Music"
            status.message = "Checking \(candidate.title)"

            var verifiedRecord = store.records[candidate.persistentID].flatMap { record in
                verifiedURL(for: record).map { (record, $0) }
            }
            if verifiedRecord == nil,
               let adopted = try adoptExistingRecovery(for: candidate)
            {
                store.records[candidate.persistentID] = adopted.record
                try saveStore(store)
                verifiedRecord = (adopted.record, adopted.url)
            }
            if var (record, recoveredURL) = verifiedRecord {
                record.title = candidate.title
                record.artist = candidate.artist
                record.isTargetPlaylist = candidate.isTargetPlaylist
                record.clueTitles = candidate.clueTitles
                record.targetEntryIDs = candidate.targetEntryIDs
                store.records[candidate.persistentID] = record
                try saveStore(store)
                increment(\.eligible, in: &status, for: candidate)
                increment(\.recovered, in: &status, for: candidate)
                increment(\.alreadyRecovered, in: &status, for: candidate)
                let delivered = normalizedConnectionID.map(record.sentConnectionIDs.contains) == true
                if delivered {
                    increment(\.sent, in: &status, for: candidate)
                    setClueReason("Previously recovered, sent, and verified by this PC.", in: &status, for: candidate)
                    setTargetItemState(
                        "Sent",
                        reason: "Recovered audio was previously verified by this PC.",
                        relativePath: record.relativePath,
                        in: &status,
                        for: candidate
                    )
                } else {
                    setClueReason("Recovered file is verified on this iPhone.", in: &status, for: candidate)
                    let locationReason = candidate.isTargetPlaylist &&
                        !record.relativePath.hasPrefix("Recovered Music/DocRoshi Beats/")
                        ? "Verified audio is stored at \(record.relativePath); this ordered playlist entry references it without duplicating bytes."
                        : "Recovered audio is verified on this iPhone and ready to send when a PC connects."
                    setTargetItemState(
                        "Recovered",
                        reason: locationReason,
                        relativePath: record.relativePath,
                        in: &status,
                        for: candidate
                    )
                }
                recoveredFiles.append(recoveredFile(
                    candidate: candidate,
                    url: recoveredURL,
                    relativePath: record.relativePath,
                    sha256: record.sha256
                ))
                try finishCandidate(index, status: &status, progress: progress)
                continue
            }

            if candidate.item.hasProtectedAsset {
                increment(\.protected, in: &status, for: candidate)
                increment(\.skipped, in: &status, for: candidate)
                setClueReason("Protected by DRM; PocketDock did not access it.", in: &status, for: candidate)
                setTargetItemState(
                    "Skipped",
                    reason: "Protected by DRM; PocketDock did not access or export this item.",
                    in: &status,
                    for: candidate
                )
                try finishCandidate(index, status: &status, progress: progress)
                continue
            }
            guard let assetURL = candidate.item.assetURL else {
                increment(\.missingAssetURL, in: &status, for: candidate)
                if candidate.item.isCloudItem {
                    increment(\.cloudWithoutAssetURL, in: &status, for: candidate)
                }
                increment(\.skipped, in: &status, for: candidate)
                let reason = candidate.item.isCloudItem
                    ? "Music did not provide an asset URL. The item is cloud-marked and may need to be downloaded in Music."
                    : "Music did not provide an asset URL for this item."
                setClueReason(reason, in: &status, for: candidate)
                setTargetItemState("Skipped", reason: reason, in: &status, for: candidate)
                try finishCandidate(index, status: &status, progress: progress)
                continue
            }

            let asset = AVURLAsset(url: assetURL)
            do {
                if try await asset.load(.hasProtectedContent) {
                    increment(\.protected, in: &status, for: candidate)
                    increment(\.skipped, in: &status, for: candidate)
                    setClueReason("AVFoundation reported protected content; PocketDock did not export it.", in: &status, for: candidate)
                    setTargetItemState(
                        "Skipped",
                        reason: "AVFoundation reported protected content; PocketDock did not export it.",
                        in: &status,
                        for: candidate
                    )
                    try finishCandidate(index, status: &status, progress: progress)
                    continue
                }
                guard try await asset.load(.isExportable),
                      let configuration = exportConfiguration(for: asset, sourceURL: assetURL)
                else {
                    increment(\.notExportable, in: &status, for: candidate)
                    increment(\.skipped, in: &status, for: candidate)
                    setClueReason("The local item is not exportable by iOS.", in: &status, for: candidate)
                    setTargetItemState(
                        "Skipped",
                        reason: "An asset URL exists, but AVFoundation reports that the item is not exportable.",
                        in: &status,
                        for: candidate
                    )
                    try finishCandidate(index, status: &status, progress: progress)
                    continue
                }

                increment(\.eligible, in: &status, for: candidate)
                setTargetItemState(
                    "Eligible",
                    reason: "Local, unprotected, and exportable; recovery is in progress.",
                    in: &status,
                    for: candidate
                )
                status.message = "Recovering \(candidate.title)"
                progress(status)
                let destination = try await export(
                    candidate: candidate,
                    configuration: configuration
                )
                let record = try makeRecord(
                    candidate: candidate,
                    destination: destination
                )
                store.records[candidate.persistentID] = record
                try saveStore(store)
                increment(\.recovered, in: &status, for: candidate)
                increment(\.newlyRecovered, in: &status, for: candidate)
                setClueReason("Recovered and verified; ready for encrypted transfer.", in: &status, for: candidate)
                setTargetItemState(
                    "Recovered",
                    reason: "Recovered and SHA-256 verified on this iPhone; it will send when a paired PC is connected.",
                    relativePath: record.relativePath,
                    in: &status,
                    for: candidate
                )
                recoveredFiles.append(recoveredFile(
                    candidate: candidate,
                    url: destination,
                    relativePath: record.relativePath,
                    sha256: record.sha256
                ))
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                increment(\.failed, in: &status, for: candidate)
                increment(\.exportFailed, in: &status, for: candidate)
                setClueReason("Export failed: \(error.localizedDescription)", in: &status, for: candidate)
                setTargetItemState(
                    "Failed",
                    reason: "Export failed: \(error.localizedDescription)",
                    in: &status,
                    for: candidate
                )
            }
            try finishCandidate(index, status: &status, progress: progress)
        }

        status.running = false
        if !status.targetPlaylistFound {
            status.phase = "Completed · DocRoshi Beats not found"
            status.message = "The scan completed, but MediaPlayer did not return a playlist named DocRoshi Beats. Named-title and whole-library recovery still ran."
        } else if status.overall.failed > 0 || status.overall.skipped > 0 {
            status.phase = "Complete with limitations"
            status.message = "Recovery completed. Review the per-item reasons for skipped or failed entries."
        } else if status.overall.newlyRecovered > 0 {
            status.phase = "Recovered on iPhone"
            status.message = "Eligible audio is verified in PocketDock Files and will send when a paired PC is connected."
        } else {
            status.phase = "Up to date"
            status.message = "All eligible local audio is already verified in PocketDock Files."
        }
        try saveTargetManifest(status.targetItems)
        progress(status)
        return MusicRecoveryRun(status: status, recoveredFiles: recoveredFiles)
    }

    func markSent(persistentID: String, to connectionID: UUID) throws {
        var store = try loadStore()
        guard var record = store.records[persistentID], verifiedURL(for: record) != nil else {
            throw PocketDockError.server("The recovered file could not be verified before recording delivery.")
        }
        let normalizedID = connectionID.uuidString.lowercased()
        if !record.sentConnectionIDs.contains(normalizedID) {
            record.sentConnectionIDs.append(normalizedID)
            record.sentConnectionIDs.sort()
            store.records[persistentID] = record
            try saveStore(store)
        }
        var entries = try loadTargetManifestEntries()
        var changed = false
        for index in entries.indices where entries[index].persistentID == persistentID {
            entries[index].status = "Sent"
            entries[index].reason = "Recovered audio was sent and verified by this PC."
            entries[index].recoveredRelativePath = record.relativePath
            changed = true
        }
        if changed { try saveTargetManifest(entries) }
    }

    func filesNeedingDelivery(to connectionID: UUID) throws -> [RecoveredMusicFile] {
        let normalizedID = connectionID.uuidString.lowercased()
        let store = try loadStore()
        let orderedManifest = try loadTargetManifestEntries()
        var firstManifestPosition: [String: Int] = [:]
        for (offset, entry) in orderedManifest.enumerated() {
            if firstManifestPosition[entry.persistentID] == nil {
                firstManifestPosition[entry.persistentID] = offset
            }
        }
        return store.records.values.compactMap { record in
            guard !record.sentConnectionIDs.contains(normalizedID),
                  let url = verifiedURL(for: record)
            else { return nil }
            return RecoveredMusicFile(
                persistentID: record.persistentID,
                sha256: record.sha256,
                title: record.title ?? url.deletingPathExtension().lastPathComponent,
                url: url,
                relativePath: record.relativePath,
                isTargetPlaylist: record.isTargetPlaylist ?? false,
                clueTitles: record.clueTitles ?? [],
                targetEntryIDs: record.targetEntryIDs ?? []
            )
        }
        .sorted {
            let leftPosition = firstManifestPosition[$0.persistentID]
            let rightPosition = firstManifestPosition[$1.persistentID]
            if leftPosition != nil || rightPosition != nil {
                if leftPosition == nil { return false }
                if rightPosition == nil { return true }
                if let leftPosition, let rightPosition, leftPosition != rightPosition {
                    return leftPosition < rightPosition
                }
            }
            if $0.isTargetPlaylist != $1.isTargetPlaylist { return $0.isTargetPlaylist }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }

    func verifiedRecoveredFile(
        persistentID: String?,
        relativePath: String?
    ) throws -> RecoveredMusicFile? {
        let store = try loadStore()
        let record: RecoveryRecord?
        if let persistentID {
            record = store.records[persistentID]
        } else if let relativePath {
            record = store.records.values.first(where: { $0.relativePath == relativePath })
        } else {
            record = nil
        }
        guard let record, let url = verifiedURL(for: record) else { return nil }
        return recoveredFile(record: record, url: url)
    }

    func deliveryIsRecorded(
        persistentID: String,
        sha256: String,
        to connectionID: UUID
    ) throws -> Bool {
        let store = try loadStore()
        guard let record = store.records[persistentID],
              record.sha256 == sha256,
              verifiedURL(for: record) != nil
        else { return false }
        return record.sentConnectionIDs.contains(connectionID.uuidString.lowercased())
    }

    func persistentID(forRecoveredRelativePath relativePath: String) throws -> String? {
        let store = try loadStore()
        return store.records.values.first(where: { $0.relativePath == relativePath })?.persistentID
    }

    private func enumerateCandidates(status: inout MusicRecoveryStatus) -> [Candidate] {
        let targetName = Self.normalized(Self.targetPlaylistName)
        let targetPlaylists = (MPMediaQuery.playlists().collections ?? [])
            .compactMap { $0 as? MPMediaPlaylist }
            .filter { Self.normalized($0.name ?? "") == targetName }
        status.targetPlaylistFound = !targetPlaylists.isEmpty

        let allSongs = MPMediaQuery.songs().items ?? []
        var ordered: [Candidate] = []
        var indexByPersistentID: [MPMediaEntityPersistentID: Int] = [:]

        func append(_ item: MPMediaItem, targetEntryID: String? = nil) {
            if let existingIndex = indexByPersistentID[item.persistentID] {
                if let targetEntryID,
                   !ordered[existingIndex].targetEntryIDs.contains(targetEntryID)
                {
                    ordered[existingIndex].targetEntryIDs.append(targetEntryID)
                }
                return
            }
            let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let safeTitle = (title?.isEmpty == false) ? title! : "Untitled Track"
            let normalizedTitle = Self.normalized(safeTitle)
            let matchedClues = Self.clueTitles.filter {
                Self.normalized($0) == normalizedTitle
            }
            let candidate = Candidate(
                item: item,
                persistentID: String(item.persistentID),
                title: safeTitle,
                artist: item.artist?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                clueTitles: matchedClues,
                targetEntryIDs: targetEntryID.map { [$0] } ?? []
            )
            indexByPersistentID[item.persistentID] = ordered.count
            ordered.append(candidate)
            for clueTitle in matchedClues {
                if let clueIndex = status.clues.firstIndex(where: { $0.title == clueTitle }) {
                    status.clues[clueIndex].counts.found += 1
                    status.clues[clueIndex].reason = targetEntryID != nil
                        ? "Found in DocRoshi Beats."
                        : "Found elsewhere in the Music library."
                }
            }
        }

        // The entire named playlist is always the first batch. The clue titles
        // are diagnostics, not a limit on what is recovered.
        for playlist in targetPlaylists {
            let playlistID = String(playlist.persistentID)
            for (offset, item) in playlist.items.enumerated() {
                let position = offset + 1
                let entryID = "\(playlistID):\(position)"
                let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines)
                let safeTitle = (title?.isEmpty == false) ? title! : "Untitled Track"
                status.targetItems.append(MusicRecoveryTargetItemStatus(
                    id: entryID,
                    playlistPersistentID: playlistID,
                    playlistName: playlist.name ?? Self.targetPlaylistName,
                    position: position,
                    persistentID: String(item.persistentID),
                    title: safeTitle,
                    artist: item.artist?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                    status: "Found",
                    reason: "Waiting for local availability and protection checks.",
                    recoveredRelativePath: nil
                ))
                append(item, targetEntryID: entryID)
            }
        }
        status.target.found = status.targetItems.count
        for clueTitle in Self.clueTitles {
            let normalizedClue = Self.normalized(clueTitle)
            for item in allSongs where Self.normalized(item.title ?? "") == normalizedClue {
                append(item)
            }
        }
        for item in allSongs {
            append(item)
        }
        return ordered
    }

    private func finishCandidate(
        _ zeroBasedIndex: Int,
        status: inout MusicRecoveryStatus,
        progress: @escaping @Sendable (MusicRecoveryStatus) -> Void
    ) throws {
        status.processed = zeroBasedIndex + 1
        try saveTargetManifest(status.targetItems)
        progress(status)
    }

    private func increment(
        _ keyPath: WritableKeyPath<MusicRecoveryCounts, Int>,
        in status: inout MusicRecoveryStatus,
        for candidate: Candidate
    ) {
        status.overall[keyPath: keyPath] += 1
        if candidate.isTargetPlaylist {
            status.target[keyPath: keyPath] += candidate.targetEntryIDs.count
        }
        for clueTitle in candidate.clueTitles {
            if let index = status.clues.firstIndex(where: { $0.title == clueTitle }) {
                status.clues[index].counts[keyPath: keyPath] += 1
            }
        }
    }

    private func setTargetItemState(
        _ itemStatus: String,
        reason: String,
        relativePath: String? = nil,
        in status: inout MusicRecoveryStatus,
        for candidate: Candidate
    ) {
        let entryIDs = Set(candidate.targetEntryIDs)
        for index in status.targetItems.indices where entryIDs.contains(status.targetItems[index].id) {
            status.targetItems[index].status = itemStatus
            status.targetItems[index].reason = reason
            if let relativePath {
                status.targetItems[index].recoveredRelativePath = relativePath
            }
        }
    }

    private func setClueReason(
        _ reason: String,
        in status: inout MusicRecoveryStatus,
        for candidate: Candidate
    ) {
        for clueTitle in candidate.clueTitles {
            if let index = status.clues.firstIndex(where: { $0.title == clueTitle }) {
                status.clues[index].reason = reason
            }
        }
    }

    private func recoveredFile(
        candidate: Candidate,
        url: URL,
        relativePath: String,
        sha256: String
    ) -> RecoveredMusicFile {
        RecoveredMusicFile(
            persistentID: candidate.persistentID,
            sha256: sha256,
            title: candidate.title,
            url: url,
            relativePath: relativePath,
            isTargetPlaylist: candidate.isTargetPlaylist,
            clueTitles: candidate.clueTitles,
            targetEntryIDs: candidate.targetEntryIDs
        )
    }

    private func recoveredFile(record: RecoveryRecord, url: URL) -> RecoveredMusicFile {
        RecoveredMusicFile(
            persistentID: record.persistentID,
            sha256: record.sha256,
            title: record.title ?? url.deletingPathExtension().lastPathComponent,
            url: url,
            relativePath: record.relativePath,
            isTargetPlaylist: record.isTargetPlaylist ?? false,
            clueTitles: record.clueTitles ?? [],
            targetEntryIDs: record.targetEntryIDs ?? []
        )
    }

    private func exportConfiguration(
        for asset: AVAsset,
        sourceURL: URL
    ) -> ExportConfiguration? {
        if let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough),
           let fileType = preferredFileType(
               sourceExtension: sourceURL.pathExtension,
               supported: session.supportedFileTypes
           )
        {
            return ExportConfiguration(
                session: session,
                fileType: fileType,
                fileExtension: fileExtension(for: fileType)
            )
        }
        if let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A),
           session.supportedFileTypes.contains(.m4a)
        {
            return ExportConfiguration(session: session, fileType: .m4a, fileExtension: "m4a")
        }
        return nil
    }

    private func preferredFileType(
        sourceExtension: String,
        supported: [AVFileType]
    ) -> AVFileType? {
        let requested: AVFileType? = switch sourceExtension.lowercased() {
        case "m4a": .m4a
        case "mp3": .mp3
        case "wav", "wave": .wav
        case "aif", "aiff": .aiff
        case "caf": .caf
        default: nil
        }
        if let requested, supported.contains(requested) { return requested }
        return [.m4a, .mp3, .wav, .aiff, .caf]
            .first(where: supported.contains)
    }

    private func fileExtension(for type: AVFileType) -> String {
        switch type {
        case .m4a: "m4a"
        case .mp3: "mp3"
        case .wav: "wav"
        case .aiff: "aiff"
        case .caf: "caf"
        default: "m4a"
        }
    }

    private func export(
        candidate: Candidate,
        configuration: ExportConfiguration
    ) async throws -> URL {
        let directoryName = candidate.isTargetPlaylist ? Self.targetPlaylistName : "All Music"
        let directory = recoveredRoot.appendingPathComponent(
            Self.sanitized(directoryName, fallback: "All Music"),
            isDirectory: true
        )
        try manager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let destination = uniqueDestination(
            candidate: candidate,
            directory: directory,
            fileExtension: configuration.fileExtension
        )
        let temporary = manager.temporaryDirectory.appendingPathComponent(
            "PocketDock-Recovery-\(UUID().uuidString).\(configuration.fileExtension)"
        )
        defer { try? manager.removeItem(at: temporary) }

        let session = configuration.session
        session.outputURL = temporary
        session.outputFileType = configuration.fileType
        session.shouldOptimizeForNetworkUse = false
        let box = ExportSessionBox(session)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, Error>) in
                box.session.exportAsynchronously {
                    switch box.session.status {
                    case .completed:
                        continuation.resume()
                    case .cancelled:
                        continuation.resume(throwing: CancellationError())
                    case .failed:
                        continuation.resume(throwing: box.session.error ?? CocoaError(.fileWriteUnknown))
                    case .unknown, .waiting, .exporting:
                        continuation.resume(throwing: box.session.error ?? CocoaError(.fileWriteUnknown))
                    @unknown default:
                        continuation.resume(throwing: box.session.error ?? CocoaError(.fileWriteUnknown))
                    }
                }
            }
        } onCancel: {
            box.session.cancelExport()
        }

        let byteCount = try fileByteCount(temporary)
        guard byteCount > 0 else { throw CocoaError(.fileWriteUnknown) }
        guard !manager.fileExists(atPath: destination.path) else {
            throw PocketDockError.server("A file appeared at the recovery destination; PocketDock left it untouched.")
        }
        try manager.moveItem(at: temporary, to: destination)
        try? manager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: destination.path
        )
        return destination
    }

    private func uniqueDestination(
        candidate: Candidate,
        directory: URL,
        fileExtension: String
    ) -> URL {
        let title = Self.sanitized(candidate.title, fallback: "Untitled Track")
        let artist = Self.sanitized(candidate.artist, fallback: "")
        let label = artist.isEmpty ? title : "\(artist) - \(title)"
        let stem = "\(label) [\(candidate.persistentID)]"
        var candidateURL = directory.appendingPathComponent("\(stem).\(fileExtension)")
        var suffix = 2
        while manager.fileExists(atPath: candidateURL.path) {
            candidateURL = directory.appendingPathComponent(
                "\(stem) (\(suffix)).\(fileExtension)"
            )
            suffix += 1
        }
        return candidateURL
    }

    private func makeRecord(
        candidate: Candidate,
        destination: URL
    ) throws -> RecoveryRecord {
        let values = try destination.resourceValues(
            forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        )
        guard values.isRegularFile == true, let fileSize = values.fileSize, fileSize > 0 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return RecoveryRecord(
            persistentID: candidate.persistentID,
            relativePath: relativePath(for: destination),
            byteCount: Int64(fileSize),
            modifiedAt: (values.contentModificationDate ?? Date()).timeIntervalSince1970,
            sha256: try sha256(of: destination),
            sentConnectionIDs: [],
            title: candidate.title,
            artist: candidate.artist,
            isTargetPlaylist: candidate.isTargetPlaylist,
            clueTitles: candidate.clueTitles,
            targetEntryIDs: candidate.targetEntryIDs
        )
    }

    private func adoptExistingRecovery(
        for candidate: Candidate
    ) throws -> (record: RecoveryRecord, url: URL)? {
        guard manager.fileExists(atPath: recoveredRoot.path),
              let enumerator = manager.enumerator(
                  at: recoveredRoot,
                  includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                  options: [.skipsHiddenFiles]
              )
        else { return nil }
        let identityMarker = "[\(candidate.persistentID)]"
        let audioExtensions = Set(["m4a", "mp3", "wav", "wave", "aif", "aiff", "caf"])
        var matches: [URL] = []
        for case let url as URL in enumerator {
            guard url.lastPathComponent.contains(identityMarker),
                  audioExtensions.contains(url.pathExtension.lowercased()),
                  let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true,
                  (values.fileSize ?? 0) > 0
            else { continue }
            matches.append(url)
        }
        let preferred = matches.sorted { left, right in
            let leftTarget = left.path.contains("/DocRoshi Beats/")
            let rightTarget = right.path.contains("/DocRoshi Beats/")
            if candidate.isTargetPlaylist, leftTarget != rightTarget { return leftTarget }
            return left.path.localizedCaseInsensitiveCompare(right.path) == .orderedAscending
        }.first
        guard let preferred else { return nil }
        return (try makeRecord(candidate: candidate, destination: preferred), preferred)
    }

    private func verifiedURL(for record: RecoveryRecord) -> URL? {
        guard record.sha256.count == 64, record.byteCount > 0 else { return nil }
        let candidate = documentsDirectory.appendingPathComponent(record.relativePath)
            .standardizedFileURL
        let root = documentsDirectory.standardizedFileURL.path
        guard candidate.path.hasPrefix(root + "/") else { return nil }
        guard let values = try? candidate.resourceValues(
            forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        ), values.isRegularFile == true,
           Int64(values.fileSize ?? -1) == record.byteCount
        else { return nil }
        let modifiedAt = values.contentModificationDate?.timeIntervalSince1970 ?? 0
        guard abs(modifiedAt - record.modifiedAt) < 1 else { return nil }
        guard let digest = try? sha256(of: candidate), digest == record.sha256 else {
            return nil
        }
        return candidate
    }

    private func relativePath(for url: URL) -> String {
        let root = documentsDirectory.standardizedFileURL.path + "/"
        return url.standardizedFileURL.path.replacingOccurrences(of: root, with: "")
    }

    private func fileByteCount(_ url: URL) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values.fileSize ?? 0)
    }

    private func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func loadStore() throws -> RecoveryStore {
        guard manager.fileExists(atPath: storeURL.path) else { return RecoveryStore() }
        do {
            let data = try Data(contentsOf: storeURL)
            return try JSONDecoder().decode(RecoveryStore.self, from: data)
        } catch {
            let quarantine = try quarantineCorruptFile(storeURL)
            throw PocketDockError.server(
                "Music recovery history was unreadable and was quarantined as \(quarantine.lastPathComponent). No recovered audio was overwritten. Tap Recover Now to safely rebuild the index from existing files."
            )
        }
    }

    private func saveStore(_ store: RecoveryStore) throws {
        try manager.createDirectory(
            at: storeDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(store).write(to: storeURL, options: .atomic)
        try? manager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: storeURL.path
        )
    }

    private func loadTargetManifestEntries() throws -> [MusicRecoveryTargetItemStatus] {
        guard manager.fileExists(atPath: targetManifestURL.path) else { return [] }
        do {
            let data = try Data(contentsOf: targetManifestURL)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(TargetPlaylistManifest.self, from: data).entries
        } catch {
            let quarantine = try quarantineCorruptFile(targetManifestURL)
            throw PocketDockError.server(
                "The DocRoshi Beats recovery manifest was unreadable and was quarantined as \(quarantine.lastPathComponent). No audio was overwritten. Tap Recover Now to rebuild it from the Music library."
            )
        }
    }

    private func saveTargetManifest(_ entries: [MusicRecoveryTargetItemStatus]) throws {
        let directory = targetManifestURL.deletingLastPathComponent()
        try manager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let manifest = TargetPlaylistManifest(
            formatVersion: 1,
            generatedAt: Date(),
            playlistName: Self.targetPlaylistName,
            entries: entries.sorted {
                if $0.playlistPersistentID != $1.playlistPersistentID {
                    return $0.playlistPersistentID < $1.playlistPersistentID
                }
                return $0.position < $1.position
            }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(manifest).write(
            to: targetManifestURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    private func quarantineCorruptFile(_ url: URL) throws -> URL {
        let quarantine = url.deletingPathExtension().appendingPathExtension(
            "corrupt-\(UUID().uuidString.lowercased()).json"
        )
        try manager.moveItem(at: url, to: quarantine)
        return quarantine
    }

    private var documentsDirectory: URL {
        manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private var recoveredRoot: URL {
        documentsDirectory.appendingPathComponent("Recovered Music", isDirectory: true)
    }

    private var targetManifestURL: URL {
        recoveredRoot
            .appendingPathComponent(Self.targetPlaylistName, isDirectory: true)
            .appendingPathComponent("playlist-manifest.json")
    }

    private var storeDirectory: URL {
        manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Music Recovery", isDirectory: true)
    }

    private var storeURL: URL {
        storeDirectory.appendingPathComponent("completed-items.json")
    }

    private static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .unicodeScalars
            .filter(CharacterSet.alphanumerics.contains)
            .map(String.init)
            .joined()
    }

    private static func sanitized(_ value: String, fallback: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>")
            .union(.controlCharacters)
        let replaced = value.components(separatedBy: invalid).joined(separator: "-")
        let collapsed = replaced.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: " ."))
        let limited = String(trimmed.prefix(96))
        return limited.isEmpty ? fallback : limited
    }
}
