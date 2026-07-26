import CryptoKit
import Foundation

@MainActor
final class PortableLibrary: ObservableObject {
    struct Item: Identifiable, Hashable {
        let url: URL
        let size: Int64
        let modified: Date?
        var id: URL { url }
        var name: String { url.lastPathComponent }
    }

    @Published private(set) var items: [Item] = []
    @Published var message = "Ready for your files"

    let root: URL
    let externalRoot: URL?

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("Portable Files", isDirectory: true)
        externalRoot = FileProviderSetup.exchangeRoot
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let externalRoot { try? FileManager.default.createDirectory(at: externalRoot, withIntermediateDirectories: true) }
        refresh()
    }

    func refresh() {
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]
        )) ?? []
        items = urls.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { return nil }
            return Item(url: url, size: Int64(values.fileSize ?? 0), modified: values.contentModificationDate)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func importFiles(_ urls: [URL]) {
        var imported = 0
        for source in urls {
            let scoped = source.startAccessingSecurityScopedResource()
            defer { if scoped { source.stopAccessingSecurityScopedResource() } }
            do {
                var destination = root.appendingPathComponent(source.lastPathComponent)
                var suffix = 1
                while FileManager.default.fileExists(atPath: destination.path) {
                    let stem = source.deletingPathExtension().lastPathComponent
                    destination = root.appendingPathComponent("\(stem)_\(suffix)").appendingPathExtension(source.pathExtension)
                    suffix += 1
                }
                try FileManager.default.copyItem(at: source, to: destination)
                imported += 1
            } catch {
                message = "Could not import \(source.lastPathComponent): \(error.localizedDescription)"
            }
        }
        refresh()
        if imported > 0 { message = "Imported \(imported) file\(imported == 1 ? "" : "s")" }
    }

    func delete(_ item: Item) {
        do {
            try FileManager.default.removeItem(at: item.url)
            message = "Removed \(item.name)"
            refresh()
        } catch {
            message = "Could not remove \(item.name): \(error.localizedDescription)"
        }
    }

    func publishToFiles(_ item: Item) {
        guard let externalRoot else {
            message = "The File Provider app group is unavailable"; return
        }
        do {
            let destination = uniqueDestination(named: item.name, in: externalRoot)
            try FileManager.default.copyItem(at: item.url, to: destination)
            FileProviderSetup.signal()
            message = "Published \(item.name) to the Files app"
        } catch { message = "Could not publish \(item.name): \(error.localizedDescription)" }
    }

    func storeDownloaded(_ data: Data, named name: String) {
        do {
            let destination = uniqueDestination(named: name, in: root)
            try data.write(to: destination, options: [.atomic])
            message = "Saved and verified \(destination.lastPathComponent)"
            refresh()
        } catch { message = "Could not save \(name): \(error.localizedDescription)" }
    }

    private func uniqueDestination(named name: String, in directory: URL) -> URL {
        var destination = directory.appendingPathComponent(name)
        var suffix = 1
        while FileManager.default.fileExists(atPath: destination.path) {
            let original = URL(fileURLWithPath: name)
            destination = directory.appendingPathComponent("\(original.deletingPathExtension().lastPathComponent)_\(suffix)")
                .appendingPathExtension(original.pathExtension)
            suffix += 1
        }
        return destination
    }

    func writeIntegrityManifest() async {
        let currentItems = items
        let root = root
        message = "Calculating SHA-256 checksums…"
        do {
            let manifest = try await Task.detached(priority: .userInitiated) {
                var records: [[String: Any]] = []
                for item in currentItems {
                    let data = try Data(contentsOf: item.url, options: [.mappedIfSafe])
                    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                    records.append(["name": item.name, "bytes": item.size, "sha256": hash])
                }
                return try JSONSerialization.data(
                    withJSONObject: ["createdAt": ISO8601DateFormatter().string(from: Date()), "files": records],
                    options: [.prettyPrinted, .sortedKeys]
                )
            }.value
            try manifest.write(to: root.appendingPathComponent("iDrivePulse-manifest.json"), options: .atomic)
            message = "Integrity manifest saved"
            refresh()
        } catch {
            message = "Could not create manifest: \(error.localizedDescription)"
        }
    }
}
