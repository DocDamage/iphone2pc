import CryptoKit
import Foundation
import UniformTypeIdentifiers

struct USBDocumentItem: Identifiable, Sendable {
    let url: URL
    let size: Int64
    let modifiedAt: Date
    let contentType: String?
    let isAudio: Bool

    var id: String { url.path }
    var name: String { url.lastPathComponent }
    var relativePath: String { url.path.replacingOccurrences(of: documentsDirectory.path + "/", with: "") }
    var externalId: String {
        SHA256.hash(data: Data(relativePath.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private var documentsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
}

actor USBDocumentService {
    private let manager = FileManager.default

    func prepare() throws {
        try manager.createDirectory(
            at: documentsDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }

    func items() throws -> [USBDocumentItem] {
        try prepare()
        guard let enumerator = manager.enumerator(
            at: documentsDirectory,
            includingPropertiesForKeys: [
                .isRegularFileKey,
                .isSymbolicLinkKey,
                .fileSizeKey,
                .contentModificationDateKey,
                .contentTypeKey
            ]
        ) else {
            return []
        }
        var result: [USBDocumentItem] = []
        for case let url as URL in enumerator {
            let values = try url.resourceValues(
                forKeys: [
                    .isRegularFileKey,
                    .isSymbolicLinkKey,
                    .fileSizeKey,
                    .contentModificationDateKey,
                    .contentTypeKey
                ]
            )
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            let contentType = values.contentType
            result.append(USBDocumentItem(
                url: url,
                size: Int64(values.fileSize ?? 0),
                modifiedAt: values.contentModificationDate ?? .distantPast,
                contentType: contentType?.identifier,
                isAudio: contentType?.conforms(to: .audio) == true || Self.audioExtensions.contains(
                    url.pathExtension.lowercased()
                )
            ))
        }
        return result.sorted { $0.modifiedAt > $1.modifiedAt }
    }

    /// Copies user-selected files and folders into the app's Apple File Sharing container.
    /// iOS exposes this container to Windows through Apple Devices, but never exposes other
    /// apps' private storage or the full device filesystem.
    func stage(_ sourceURLs: [URL]) throws -> Int {
        try prepare()
        var copied = 0
        for sourceURL in sourceURLs {
            let accessed = sourceURL.startAccessingSecurityScopedResource()
            defer {
                if accessed { sourceURL.stopAccessingSecurityScopedResource() }
            }
            let destination = uniqueDestination(for: sourceURL.lastPathComponent)
            try manager.copyItem(at: sourceURL, to: destination)
            copied += 1
        }
        return copied
    }

    func remove(_ item: USBDocumentItem) throws {
        let root = documentsDirectory.standardizedFileURL.path
        let candidate = item.url.standardizedFileURL.path
        guard candidate.hasPrefix(root + "/")
        else {
            throw CocoaError(.fileReadNoPermission)
        }
        try manager.removeItem(at: item.url)
    }

    private func uniqueDestination(for name: String) -> URL {
        let safeName = name.isEmpty ? "Untitled" : name
        let initial = documentsDirectory.appendingPathComponent(safeName)
        guard manager.fileExists(atPath: initial.path) else { return initial }

        let stem = initial.deletingPathExtension().lastPathComponent
        let ext = initial.pathExtension
        var suffix = 2
        while true {
            let candidateName = ext.isEmpty
                ? "\(stem) \(suffix)"
                : "\(stem) \(suffix).\(ext)"
            let candidate = documentsDirectory.appendingPathComponent(candidateName)
            if !manager.fileExists(atPath: candidate.path) { return candidate }
            suffix += 1
        }
    }

    private var documentsDirectory: URL {
        manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private static let audioExtensions = Set([
        "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma"
    ])
}
