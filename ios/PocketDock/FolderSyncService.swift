import CryptoKit
import Foundation

actor FolderSyncService {
    private let bookmarkPrefix = "PocketDock.sync-bookmark."
    private let snapshotPrefix = "PocketDock.sync-snapshot."

    func saveFolder(_ folder: URL, for profileId: UUID) throws {
        let bookmark = try folder.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        UserDefaults.standard.set(
            bookmark,
            forKey: bookmarkPrefix + profileId.uuidString
        )
    }

    func folder(for profileId: UUID) -> URL? {
        guard
            let bookmark = UserDefaults.standard.data(
                forKey: bookmarkPrefix + profileId.uuidString
            )
        else { return nil }
        var stale = false
        let url = try? URL(
            resolvingBookmarkData: bookmark,
            options: [.withoutUI, .withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        if stale, let url {
            try? saveFolder(url, for: profileId)
        }
        return url
    }

    func synchronize(
        profile: MobileSyncProfile,
        client: PocketDockClient,
        progress: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let root = folder(for: profile.id) else {
            throw PocketDockError.server("Choose an iPhone Files folder for this profile.")
        }
        let scoped = root.startAccessingSecurityScopedResource()
        defer { if scoped { root.stopAccessingSecurityScopedResource() } }
        let remoteEntries = try await client.syncManifest(profileId: profile.id)
        let remote = Dictionary(uniqueKeysWithValues: remoteEntries.map { ($0.relativePath, $0) })
        var local = try localManifest(root: root, extensions: profile.includeExtensions)
        let previous = loadSnapshot(profile.id)
        var next: [String: String] = [:]
        let allPaths = Set(remote.keys).union(local.keys).union(previous.keys)
        var remoteArchive: [String] = []

        for relativePath in allPaths.sorted() {
            try Task.checkCancellation()
            let remoteEntry = remote[relativePath]
            let localHash = local[relativePath]
            let previousHash = previous[relativePath]
            let remoteChanged = remoteEntry?.sha256 != previousHash
            let localChanged = localHash != previousHash
            let destination = root.appendingPathComponent(relativePath)

            if let remoteEntry, let localHash, remoteEntry.sha256 != localHash {
                if remoteChanged && localChanged && previousHash != nil {
                    let conflict = conflictURL(for: destination)
                    try FileManager.default.createDirectory(
                        at: conflict.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try FileManager.default.moveItem(at: destination, to: conflict)
                    let conflictRelative = relativePathFor(root: root, file: conflict)
                    progress("Preserving iPhone conflict: \(conflict.lastPathComponent)")
                    try await client.upload(
                        fileURL: conflict,
                        syncProfileId: profile.id,
                        relativePath: conflictRelative
                    ) { _, _ in }
                }
                if profile.direction != "iphone-to-pc" {
                    progress("Receiving \(relativePath)")
                    try await client.downloadSyncFile(
                        profileId: profile.id,
                        entry: remoteEntry,
                        destination: destination
                    )
                    local[relativePath] = remoteEntry.sha256
                    next[relativePath] = remoteEntry.sha256
                } else {
                    progress("Sending \(relativePath)")
                    try await client.upload(
                        fileURL: destination,
                        syncProfileId: profile.id,
                        relativePath: relativePath
                    ) { _, _ in }
                    next[relativePath] = localHash
                }
            } else if let remoteEntry, localHash == nil {
                if previousHash != nil &&
                    !remoteChanged &&
                    profile.direction != "pc-to-iphone" &&
                    profile.deletionPolicy == "archive" {
                    remoteArchive.append(relativePath)
                } else if profile.direction != "iphone-to-pc" {
                    progress("Receiving \(relativePath)")
                    try await client.downloadSyncFile(
                        profileId: profile.id,
                        entry: remoteEntry,
                        destination: destination
                    )
                    next[relativePath] = remoteEntry.sha256
                }
            } else if let localHash, remoteEntry == nil {
                if previousHash != nil &&
                    !localChanged &&
                    profile.deletionPolicy == "archive" {
                    try archiveLocal(root: root, relativePath: relativePath)
                } else if previousHash != nil &&
                    !localChanged &&
                    profile.direction == "pc-to-iphone" {
                    next[relativePath] = localHash
                } else if profile.direction != "pc-to-iphone" {
                    progress("Sending \(relativePath)")
                    try await client.upload(
                        fileURL: destination,
                        syncProfileId: profile.id,
                        relativePath: relativePath
                    ) { _, _ in }
                    next[relativePath] = localHash
                } else {
                    next[relativePath] = localHash
                }
            } else if let hash = remoteEntry?.sha256 ?? localHash {
                next[relativePath] = hash
            }
        }
        if !remoteArchive.isEmpty {
            progress("Archiving \(remoteArchive.count) deleted PC files")
            try await client.archiveSyncFiles(
                profileId: profile.id,
                relativePaths: remoteArchive
            )
        }
        saveSnapshot(next, profile.id)
        progress("Folder sync complete")
    }

    private func localManifest(
        root: URL,
        extensions: [String]
    ) throws -> [String: String] {
        let allowed = Set(extensions.map { $0.lowercased().replacingOccurrences(of: ".", with: "") })
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ) else { return [:] }
        var result: [String: String] = [:]
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            let ext = file.pathExtension.lowercased()
            if !allowed.isEmpty && !allowed.contains(ext) { continue }
            result[relativePathFor(root: root, file: file)] = try sha256(file)
            if result.count >= 50_000 { break }
        }
        return result
    }

    private func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func relativePathFor(root: URL, file: URL) -> String {
        String(file.path.dropFirst(root.path.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func conflictURL(for file: URL) -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH-mm"
        let suffix = " (iPhone conflict \(formatter.string(from: Date())))"
        return file.deletingLastPathComponent()
            .appendingPathComponent(file.deletingPathExtension().lastPathComponent + suffix)
            .appendingPathExtension(file.pathExtension)
    }

    private func archiveLocal(root: URL, relativePath: String) throws {
        let source = root.appendingPathComponent(relativePath)
        let destination = root
            .appendingPathComponent(".PocketDock Archive")
            .appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.moveItem(at: source, to: destination)
    }

    private func loadSnapshot(_ id: UUID) -> [String: String] {
        guard
            let data = UserDefaults.standard.data(forKey: snapshotPrefix + id.uuidString),
            let snapshot = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return snapshot
    }

    private func saveSnapshot(_ snapshot: [String: String], _ id: UUID) {
        UserDefaults.standard.set(
            try? JSONEncoder().encode(snapshot),
            forKey: snapshotPrefix + id.uuidString
        )
    }
}
