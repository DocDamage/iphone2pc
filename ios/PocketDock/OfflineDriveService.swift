import Foundation

actor OfflineDriveService {
    private let manager = FileManager.default
    private let root: URL
    private let indexURL: URL

    init() {
        root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketDock/Offline Drive", isDirectory: true)
        indexURL = root.appendingPathComponent("index.json")
    }

    func items() -> [OfflineDriveItem] {
        guard
            let data = try? Data(contentsOf: indexURL),
            let items = try? JSONDecoder().decode([OfflineDriveItem].self, from: data)
        else { return [] }
        return items.filter { manager.fileExists(atPath: $0.localPath) }
    }

    func cache(entry: MobileDriveEntry, downloadedURL: URL) throws -> OfflineDriveItem {
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let folder = root.appendingPathComponent(entry.id, isDirectory: true)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(entry.name)
        try? manager.removeItem(at: destination)
        try manager.moveItem(at: downloadedURL, to: destination)
        var current = items().filter { $0.id != entry.id }
        let item = OfflineDriveItem(
            id: entry.id,
            name: entry.name,
            relativePath: entry.relativePath,
            localPath: destination.path,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            mimeType: entry.mimeType,
            cachedAt: Date()
        )
        current.insert(item, at: 0)
        try save(current)
        return item
    }

    func remove(_ item: OfflineDriveItem) throws {
        try? manager.removeItem(at: URL(fileURLWithPath: item.localPath).deletingLastPathComponent())
        try save(items().filter { $0.id != item.id })
    }

    func search(_ query: String) -> [OfflineDriveItem] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return items() }
        return items().filter {
            $0.name.localizedCaseInsensitiveContains(term) ||
                $0.relativePath.localizedCaseInsensitiveContains(term)
        }
    }

    private func save(_ items: [OfflineDriveItem]) throws {
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(items).write(
            to: indexURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }
}
