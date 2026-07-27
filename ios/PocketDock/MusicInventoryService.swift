import Foundation
import MusicKit

/// Builds the complete, user-approved iPhone music inventory. This service is
/// metadata-only; MusicRecoveryService separately places eligible local,
/// unprotected items into PocketDock's Documents container.
actor MusicInventoryService {
    private let manager = FileManager.default
    private let sharingPrefix = "PocketDock.music-inventory.enabled."
    private let lastSyncPrefix = "PocketDock.music-inventory.last-sync."
    private let generationSequenceKey = "PocketDock.music-inventory.generation-sequence"

    func authorization() -> MusicInventoryAuthorization {
        Self.mapAuthorization(MusicAuthorization.currentStatus)
    }

    /// Call only from a direct user action. Inventory refresh and app startup
    /// intentionally never invoke the system authorization prompt.
    func requestAuthorization() async -> MusicInventoryAuthorization {
        Self.mapAuthorization(await MusicAuthorization.request())
    }

    func sharingEnabled(for connectionId: UUID) -> Bool {
        UserDefaults.standard.bool(forKey: sharingPrefix + connectionId.uuidString)
    }

    func setSharingEnabled(_ enabled: Bool, for connectionId: UUID) {
        UserDefaults.standard.set(
            enabled,
            forKey: sharingPrefix + connectionId.uuidString
        )
    }

    func removeConnection(_ connectionId: UUID) {
        UserDefaults.standard.removeObject(
            forKey: sharingPrefix + connectionId.uuidString
        )
        UserDefaults.standard.removeObject(
            forKey: lastSyncPrefix + connectionId.uuidString
        )
    }

    func lastSyncedAt(for connectionId: UUID) -> Date? {
        UserDefaults.standard.object(
            forKey: lastSyncPrefix + connectionId.uuidString
        ) as? Date
    }

    func markSynced(at date: Date, for connectionId: UUID) {
        UserDefaults.standard.set(
            date,
            forKey: lastSyncPrefix + connectionId.uuidString
        )
    }

    func cachedInventory() -> PhoneMusicInventory? {
        guard
            let data = try? Data(contentsOf: cacheURL),
            let inventory = try? JSONDecoder().decode(PhoneMusicInventory.self, from: data),
            inventory.complete
        else { return nil }
        return inventory
    }

    func makeInventory(documents: [USBDocumentItem]) async throws -> PhoneMusicInventory {
        let currentAuthorization = authorization()
        let library: (
            tracks: [PhoneMusicTrack],
            collections: [PhoneMusicCollection]
        )
        if currentAuthorization == .authorized {
            library = try await musicLibraryInventory()
        } else {
            library = (tracks: [], collections: [])
        }
        let files = documents.map { item in
            PhoneDocumentFile(
                externalId: item.externalId,
                name: item.name,
                relativePath: item.relativePath,
                size: item.size,
                modifiedAt: Self.iso8601(item.modifiedAt),
                contentType: item.contentType,
                isAudio: item.isAudio
            )
        }
        .sorted {
            $0.relativePath.localizedCaseInsensitiveCompare($1.relativePath) == .orderedAscending
        }
        let inventory = PhoneMusicInventory(
            generationId: UUID().uuidString.lowercased(),
            generationSequence: nextGenerationSequence(),
            generatedAt: Self.iso8601(Date()),
            authorization: currentAuthorization,
            complete: true,
            music: library.tracks,
            collections: library.collections,
            files: files
        )
        try cache(inventory)
        return inventory
    }

    private func musicLibraryInventory() async throws -> (
        tracks: [PhoneMusicTrack],
        collections: [PhoneMusicCollection]
    ) {
        let tracks = try await musicTracks()
        let collections = try await musicCollections()
        return (tracks, collections)
    }

    private func musicTracks() async throws -> [PhoneMusicTrack] {
        var request = MusicLibraryRequest<Song>()
        request.includeOnlyDownloadedContent = false
        request.limit = 100
        let response = try await request.response()
        var batch: MusicItemCollection<Song>? = response.items
        var byId: [String: PhoneMusicTrack] = [:]

        while let current = batch {
            try Task.checkCancellation()
            for song in current {
                let externalId = song.id.rawValue
                byId[externalId] = PhoneMusicTrack(
                    externalId: externalId,
                    title: song.title,
                    artist: song.artistName,
                    album: song.albumTitle ?? "",
                    duration: song.duration,
                    track: song.trackNumber,
                    disc: song.discNumber,
                    year: song.releaseDate.map {
                        Calendar(identifier: .gregorian).component(.year, from: $0)
                    },
                    genre: song.genreNames.first,
                    isDownloaded: nil
                )
            }
            if current.hasNextBatch {
                batch = try await current.nextBatch(limit: 100)
            } else {
                batch = nil
            }
        }

        return byId.values.sorted {
            let titleOrder = $0.title.localizedCaseInsensitiveCompare($1.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return $0.artist.localizedCaseInsensitiveCompare($1.artist) == .orderedAscending
        }
    }

    /// Enumerates every library playlist and every relationship batch. A
    /// playlist name can carry important user organization that is absent from
    /// song metadata (for example, "DocRoshi Beats"), so it is part of the wire
    /// inventory rather than only a display detail on the phone.
    private func musicCollections() async throws -> [PhoneMusicCollection] {
        var request = MusicLibraryRequest<Playlist>()
        request.includeOnlyDownloadedContent = false
        request.limit = 100
        let response = try await request.response()
        var batch: MusicItemCollection<Playlist>? = response.items
        var byId: [String: PhoneMusicCollection] = [:]

        while let current = batch {
            try Task.checkCancellation()
            for playlist in current {
                let detailed = try await playlist.with(
                    [.tracks],
                    preferredSource: .library
                )
                var trackBatch = detailed.tracks
                var trackIds: [String] = []
                while let tracks = trackBatch {
                    try Task.checkCancellation()
                    trackIds.append(contentsOf: tracks.map { $0.id.rawValue })
                    trackBatch = tracks.hasNextBatch
                        ? try await tracks.nextBatch(limit: 100)
                        : nil
                }
                let externalId = playlist.id.rawValue
                byId[externalId] = PhoneMusicCollection(
                    externalId: externalId,
                    name: playlist.name,
                    kind: "playlist",
                    itemCount: trackIds.count,
                    trackExternalIds: trackIds
                )
            }
            batch = current.hasNextBatch
                ? try await current.nextBatch(limit: 100)
                : nil
        }

        return byId.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private func cache(_ inventory: PhoneMusicInventory) throws {
        try manager.createDirectory(
            at: cacheDirectory,
            withIntermediateDirectories: true,
            attributes: [
                .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
            ]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(inventory).write(to: cacheURL, options: .atomic)
        try? manager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: cacheURL.path
        )
    }

    private var cacheDirectory: URL {
        manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Music Inventory", isDirectory: true)
    }

    private var cacheURL: URL {
        cacheDirectory.appendingPathComponent("complete-inventory.json")
    }

    /// A persisted logical clock keeps inventory ordering correct across rapid
    /// refreshes and wall-clock changes. The actor serializes increments.
    private func nextGenerationSequence() -> Int64 {
        let defaults = UserDefaults.standard
        let stored = (defaults.object(forKey: generationSequenceKey) as? NSNumber)?.int64Value ?? 0
        let cached = cachedInventory()?.generationSequence ?? 0
        let wallClockMilliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
        let next = max(max(stored, cached) + 1, wallClockMilliseconds)
        defaults.set(NSNumber(value: next), forKey: generationSequenceKey)
        return next
    }

    private static func mapAuthorization(
        _ status: MusicAuthorization.Status
    ) -> MusicInventoryAuthorization {
        switch status {
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .restricted
        }
    }

    private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
