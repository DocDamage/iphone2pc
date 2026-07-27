import CryptoKit
import Foundation
import Security
import UniformTypeIdentifiers

actor MobileVaultService {
    private let manager = FileManager.default
    private let root: URL
    private let indexURL: URL
    private let keyName = "mobile-vault.master-key.v1"

    init() {
        root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketDock/Mobile Vault", isDirectory: true)
        indexURL = root.appendingPathComponent("index.json")
    }

    func items() -> [MobileVaultItem] {
        guard
            let data = try? Data(contentsOf: indexURL),
            let entries = try? JSONDecoder().decode([MobileVaultItem].self, from: data)
        else { return [] }
        return entries.filter { manager.fileExists(atPath: $0.encryptedPath) }
    }

    func importFile(_ source: URL) throws -> MobileVaultItem {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let plaintext = try Data(contentsOf: source)
        let sealed = try AES.GCM.seal(plaintext, using: key())
        guard let combined = sealed.combined else { throw PocketDockError.integrityFailure }
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let id = UUID()
        let destination = root.appendingPathComponent("\(id.uuidString).pocketvault")
        try combined.write(to: destination, options: [.atomic, .completeFileProtection])
        let type = UTType(filenameExtension: source.pathExtension)
        let item = MobileVaultItem(
            id: id,
            name: source.lastPathComponent,
            encryptedPath: destination.path,
            size: Int64(plaintext.count),
            mimeType: type?.preferredMIMEType ?? "application/octet-stream",
            createdAt: Date()
        )
        var current = items()
        current.insert(item, at: 0)
        try save(current)
        return item
    }

    func export(_ item: MobileVaultItem) throws -> URL {
        let combined = try Data(contentsOf: URL(fileURLWithPath: item.encryptedPath))
        let box = try AES.GCM.SealedBox(combined: combined)
        let plaintext = try AES.GCM.open(box, using: key())
        let destination = manager.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(item.name)")
        try plaintext.write(to: destination, options: [.atomic, .completeFileProtection])
        return destination
    }

    func remove(_ item: MobileVaultItem) throws {
        try manager.removeItem(at: URL(fileURLWithPath: item.encryptedPath))
        try save(items().filter { $0.id != item.id })
    }

    private func key() throws -> SymmetricKey {
        if let data = KeychainStore.get(keyName), data.count == 32 {
            return SymmetricKey(data: data)
        }
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
        }
        guard status == errSecSuccess else { throw PocketDockError.secureStorage(status) }
        try KeychainStore.set(bytes, for: keyName)
        return SymmetricKey(data: bytes)
    }

    private func save(_ items: [MobileVaultItem]) throws {
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(items).write(
            to: indexURL,
            options: [.atomic, .completeFileProtection]
        )
    }
}
