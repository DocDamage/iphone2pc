import Foundation
import Photos

actor PhotoMigrationService {
    private struct MigrationCheckpoint: Codable, Sendable {
        var completed: [String: Int64] = [:]
        var unavailable: Set<String> = []
    }

    func inventory() async throws -> PhotoMigrationReport {
        try await authorize()
        let assets = PHAsset.fetchAssets(with: nil)
        var photos = 0
        var videos = 0
        var livePhotos = 0
        assets.enumerateObjects { asset, _, _ in
            if asset.mediaType == .video { videos += 1 }
            else if asset.mediaType == .image { photos += 1 }
            if asset.mediaSubtypes.contains(.photoLive) { livePhotos += 1 }
        }
        return PhotoMigrationReport(
            id: UUID(),
            createdAt: Date(),
            photoCount: photos,
            videoCount: videos,
            livePhotoCount: livePhotos,
            albumCount: albumNamesByAsset().allAlbums.count,
            transferredResources: 0,
            transferredBytes: 0,
            unavailableResources: 0,
            contactsTransferred: 0,
            status: "Ready",
            notes: [
                "Original photo, video, and Live Photo resources are preserved.",
                "Shared albums, Messages, Health, passwords, and protected app data remain under Apple’s migration controls."
            ]
        )
    }

    func migrate(
        connectionId: UUID,
        client: PocketDockClient,
        progress: @escaping @Sendable (PhotoMigrationReport, String) -> Void
    ) async throws -> PhotoMigrationReport {
        var report = try await inventory()
        report.status = "Migrating"
        var checkpoint = loadCheckpoint(connectionId)
        report.transferredResources = checkpoint.completed.count
        report.transferredBytes = checkpoint.completed.values.reduce(0, +)
        report.unavailableResources = checkpoint.unavailable.count
        let albumIndex = albumNamesByAsset()
        let assets = PHAsset.fetchAssets(with: nil)
        let manager = PHAssetResourceManager.default()
        for index in 0..<assets.count {
            try Task.checkCancellation()
            let asset = assets.object(at: index)
            guard asset.mediaType == .image || asset.mediaType == .video else { continue }
            let album = albumIndex.names[asset.localIdentifier]?.first ?? "Camera Roll"
            let year = Calendar.current.component(.year, from: asset.creationDate ?? Date())
            for resource in PHAssetResource.assetResources(for: asset) {
                let checkpointId = "\(asset.localIdentifier)|\(resource.type.rawValue)|\(resource.originalFilename)"
                if checkpoint.completed[checkpointId] != nil { continue }
                let temporary = FileManager.default.temporaryDirectory
                    .appendingPathComponent("\(UUID().uuidString)-\(resource.originalFilename)")
                do {
                    try await write(resource: resource, to: temporary, manager: manager)
                    let bytes = (try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize)
                        .map(Int64.init) ?? 0
                    let relative =
                        "Phone Migration/Photos/\(year)/\(safeComponent(album))/\(resource.originalFilename)"
                    try await client.upload(
                        fileURL: temporary,
                        relativePath: relative,
                        progress: { _, _ in }
                    )
                    report.transferredResources += 1
                    report.transferredBytes += bytes
                    checkpoint.completed[checkpointId] = bytes
                    checkpoint.unavailable.remove(checkpointId)
                } catch {
                    checkpoint.unavailable.insert(checkpointId)
                }
                report.unavailableResources = checkpoint.unavailable.count
                saveCheckpoint(checkpoint, connectionId: connectionId)
                try? FileManager.default.removeItem(at: temporary)
            }
            progress(report, "Migrated \(index + 1) of \(assets.count) library items")
        }
        report.status = report.unavailableResources == 0 ? "Complete" : "Complete with warnings"
        return report
    }

    private func loadCheckpoint(_ connectionId: UUID) -> MigrationCheckpoint {
        guard
            let data = try? Data(contentsOf: checkpointURL(connectionId)),
            let checkpoint = try? JSONDecoder().decode(MigrationCheckpoint.self, from: data)
        else { return MigrationCheckpoint() }
        return checkpoint
    }

    private func saveCheckpoint(_ checkpoint: MigrationCheckpoint, connectionId: UUID) {
        let url = checkpointURL(connectionId)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? JSONEncoder().encode(checkpoint).write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    private func checkpointURL(_ connectionId: UUID) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketDock/Migration", isDirectory: true)
            .appendingPathComponent("\(connectionId.uuidString).json")
    }

    private func authorize() async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw PocketDockError.server("Allow Photos access to build a migration inventory.")
        }
    }

    private func write(
        resource: PHAssetResource,
        to url: URL,
        manager: PHAssetResourceManager
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = true
            manager.writeData(for: resource, toFile: url, options: options) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func albumNamesByAsset() -> (names: [String: [String]], allAlbums: Set<String>) {
        var names: [String: [String]] = [:]
        var allAlbums = Set<String>()
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .album,
            subtype: .any,
            options: nil
        )
        collections.enumerateObjects { collection, _, _ in
            let name = collection.localizedTitle ?? "Album"
            allAlbums.insert(name)
            PHAsset.fetchAssets(in: collection, options: nil).enumerateObjects { asset, _, _ in
                names[asset.localIdentifier, default: []].append(name)
            }
        }
        return (names, allAlbums)
    }

    private func safeComponent(_ value: String) -> String {
        value
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(120)
            .description
    }
}
