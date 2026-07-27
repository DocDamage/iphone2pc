import CryptoKit
import Foundation

actor TransferJournal {
    private let manager = FileManager.default
    private let directory: URL
    private let journalURL: URL

    init() {
        let root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = root.appendingPathComponent("PocketDock/Transfer Queue", isDirectory: true)
        journalURL = directory.appendingPathComponent("transfers.json")
    }

    func load() -> [MobileTransfer] {
        guard
            let data = try? Data(contentsOf: journalURL),
            let transfers = try? JSONDecoder().decode([MobileTransfer].self, from: data)
        else { return [] }
        return transfers.sorted { $0.createdAt > $1.createdAt }
    }

    func save(_ transfers: [MobileTransfer]) throws {
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(transfers)
        try data.write(to: journalURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func stage(_ source: URL, id: UUID) throws -> URL {
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let stagedDirectory = directory.appendingPathComponent(id.uuidString, isDirectory: true)
        let destination = stagedDirectory
            .appendingPathComponent(source.lastPathComponent)
        if manager.fileExists(atPath: stagedDirectory.path) {
            try manager.removeItem(at: stagedDirectory)
        }
        try manager.createDirectory(
            at: stagedDirectory,
            withIntermediateDirectories: true
        )
        try manager.copyItem(at: source, to: destination)
        return destination
    }

    /// Stages a recovery source and verifies the queue copy byte-for-byte by
    /// digest before it can be uploaded. A failed copy is removed immediately.
    func stageVerified(_ source: URL, id: UUID, expectedSHA256: String) throws -> URL {
        let destination = try stage(source, id: id)
        guard try fileMatchesSHA256(atPath: destination.path, expected: expectedSHA256) else {
            try? manager.removeItem(at: destination.deletingLastPathComponent())
            throw CocoaError(.fileReadCorruptFile)
        }
        return destination
    }

    func fileMatchesSHA256(atPath path: String, expected: String) throws -> Bool {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let queueRoot = directory.standardizedFileURL.path + "/"
        guard url.path.hasPrefix(queueRoot),
              expected.count == 64,
              manager.fileExists(atPath: url.path)
        else { return false }
        return try sha256(of: url) == expected.lowercased()
    }

    func removeStagedFile(for transfer: MobileTransfer) throws {
        guard let localPath = transfer.localPath else { return }
        let fileURL = URL(fileURLWithPath: localPath)
        let stagedDirectory = fileURL.deletingLastPathComponent().standardizedFileURL
        guard stagedDirectory.deletingLastPathComponent().standardizedFileURL ==
                directory.standardizedFileURL
        else { throw CocoaError(.fileReadNoPermission) }
        guard manager.fileExists(atPath: stagedDirectory.path) else { return }
        try manager.removeItem(at: stagedDirectory)
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
}
