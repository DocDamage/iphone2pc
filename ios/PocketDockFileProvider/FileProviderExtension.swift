import CryptoKit
import FileProvider
import Foundation
import Security
import UniformTypeIdentifiers

private struct BridgeConnectionMetadata: Codable {
    let baseURL: URL
    let deviceId: UUID
    let pcName: String
}

private struct BridgeConnection {
    let baseURL: URL
    let transferKey: Data
    var token: String?
    let refreshToken: String?
    let deviceId: UUID
    let pcName: String

    static func load() throws -> BridgeConnection {
        guard
            let defaults = UserDefaults(suiteName: "group.com.docdamage.pocketdock"),
            let metadataData = defaults.data(forKey: "PocketDock.FileProvider.Connection"),
            let metadata = try? JSONDecoder().decode(
                BridgeConnectionMetadata.self,
                from: metadataData
            ),
            let secretData = sharedSecretData(),
            let values = try? JSONDecoder().decode([String].self, from: secretData),
            values.count == 3,
            let transferKey = Data(base64Encoded: values[0])
        else { throw CocoaError(.fileNoSuchFile) }
        return BridgeConnection(
            baseURL: metadata.baseURL,
            transferKey: transferKey,
            token: values[1].isEmpty ? nil : values[1],
            refreshToken: values[2].isEmpty ? nil : values[2],
            deviceId: metadata.deviceId,
            pcName: metadata.pcName
        )
    }

    private static func sharedSecretData() -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.docdamage.pocketdock.fileprovider",
            kSecAttrAccount as String: "active-connection",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        if let group = Bundle.main.object(
            forInfoDictionaryKey: "PocketDockKeychainAccessGroup"
        ) as? String, !group.isEmpty {
            query[kSecAttrAccessGroup as String] = group
        }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    static func saveSecrets(_ connection: BridgeConnection) {
        guard let data = try? JSONEncoder().encode([
            connection.transferKey.base64EncodedString(),
            connection.token ?? "",
            connection.refreshToken ?? ""
        ]) else { return }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.docdamage.pocketdock.fileprovider",
            kSecAttrAccount as String: "active-connection"
        ]
        if let group = Bundle.main.object(
            forInfoDictionaryKey: "PocketDockKeychainAccessGroup"
        ) as? String, !group.isEmpty {
            query[kSecAttrAccessGroup as String] = group
        }
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }
}

private struct DriveEntry: Codable {
    let id: String
    let name: String
    let relativePath: String
    let kind: String
    let size: Int64
    let modifiedAt: String
    let mimeType: String
}

private struct UploadStart: Decodable {
    let id: UUID
    let offset: Int64
}

private struct UploadProgress: Decodable {
    let offset: Int64
}

private struct RefreshResponse: Decodable {
    let token: String
}

private final class DriveItem: NSObject, NSFileProviderItem {
    let entry: DriveEntry?
    let itemIdentifier: NSFileProviderItemIdentifier

    init(entry: DriveEntry?, identifier: NSFileProviderItemIdentifier) {
        self.entry = entry
        itemIdentifier = identifier
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        guard let path = entry?.relativePath else { return .rootContainer }
        let parent = (path as NSString).deletingLastPathComponent
        return parent.isEmpty ? .rootContainer : FileProviderExtension.identifier(for: parent)
    }
    var filename: String { entry?.name ?? "PocketDock Drive" }
    var typeIdentifier: String {
        entry?.kind == "folder"
            ? UTType.folder.identifier
            : UTType(mimeType: entry?.mimeType ?? "")?.identifier ?? UTType.data.identifier
    }
    var documentSize: NSNumber? { entry?.kind == "file" ? NSNumber(value: entry?.size ?? 0) : nil }
    var capabilities: NSFileProviderItemCapabilities {
        entry?.kind == "folder"
            ? [.allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsDeleting]
            : [.allowsReading, .allowsWriting, .allowsRenaming, .allowsDeleting]
    }
    var itemVersion: NSFileProviderItemVersion {
        let version = Data((entry?.modifiedAt ?? "root").utf8)
        return NSFileProviderItemVersion(contentVersion: version, metadataVersion: version)
    }
}

private final class DriveEnumerator: NSObject, NSFileProviderEnumerator {
    private let path: String
    private let client: DriveClient?

    init(path: String, client: DriveClient?) {
        self.path = path
        self.client = client
    }

    func invalidate() {}

    func enumerateItems(
        for observer: NSFileProviderEnumerationObserver,
        startingAt page: NSFileProviderPage
    ) {
        Task {
            do {
                guard let client else { throw CocoaError(.fileReadNoPermission) }
                let entries = try await client.list(path: path)
                observer.didEnumerate(entries.map {
                    DriveItem(entry: $0, identifier: FileProviderExtension.identifier(for: $0.relativePath))
                })
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(error)
            }
        }
    }
}

private actor DriveClient {
    private var connection: BridgeConnection
    private let decoder = JSONDecoder()

    init() throws {
        connection = try BridgeConnection.load()
    }

    func list(path: String) async throws -> [DriveEntry] {
        let data = try await request("drive?path=\(path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")
        return try decoder.decode([DriveEntry].self, from: data)
    }

    func fetch(path: String, size: Int64) async throws -> URL {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        let chunkSize: Int64 = 4 * 1024 * 1024
        var offset: Int64 = 0
        while offset < size {
            let route = "drive/file?path=\(path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&offset=\(offset)&length=\(chunkSize)"
            var request = try authorizedRequest(route)
            request.httpMethod = "GET"
            let (payload, response) = try await perform(request)
            guard
                let http = response as? HTTPURLResponse,
                http.statusCode == 200,
                let iv = http.value(forHTTPHeaderField: "X-PocketDock-IV"),
                let plainLength = Int(http.value(forHTTPHeaderField: "X-PocketDock-Plain-Length") ?? "")
            else { throw CocoaError(.fileReadUnknown) }
            let plaintext = try open(
                payload,
                identifier: "drive:\(path)",
                offset: offset,
                plainLength: plainLength,
                iv: iv
            )
            try handle.write(contentsOf: plaintext)
            offset += Int64(plaintext.count)
        }
        return output
    }

    func createFolder(path: String) async throws {
        _ = try await jsonRequest("drive/folder", body: ["path": path])
    }

    func rename(path: String, name: String) async throws {
        _ = try await jsonRequest("drive/rename", body: ["path": path, "name": name])
    }

    func archive(path: String) async throws {
        _ = try await jsonRequest("drive/archive", body: ["path": path])
    }

    func upload(contents: URL, relativePath: String) async throws {
        let values = try contents.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .contentModificationDateKey])
        let size = Int64(values.fileSize ?? 0)
        let metadata: [String: Any] = [
            "name": (relativePath as NSString).lastPathComponent,
            "size": size,
            "type": values.contentType?.preferredMIMEType ?? "application/octet-stream",
            "lastModified": Int64((values.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000),
            "relativePath": relativePath,
            "encrypted": true,
            "protocolVersion": 2
        ]
        var startRequest = try authorizedRequest("uploads")
        startRequest.httpMethod = "POST"
        startRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        startRequest.httpBody = try JSONSerialization.data(withJSONObject: metadata)
        let (startData, startResponse) = try await perform(startRequest)
        guard
            let startHTTP = startResponse as? HTTPURLResponse,
            startHTTP.statusCode == 201 || startHTTP.statusCode == 200
        else { throw CocoaError(.fileWriteNoPermission) }
        let upload = try decoder.decode(UploadStart.self, from: startData)
        let handle = try FileHandle(forReadingFrom: contents)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(upload.offset))
        var offset = upload.offset
        var hasher = SHA256()
        if upload.offset > 0 {
            try handle.seek(toOffset: 0)
            var remaining = upload.offset
            while remaining > 0 {
                let data = try handle.read(upToCount: Int(min(1024 * 1024, remaining))) ?? Data()
                if data.isEmpty { break }
                hasher.update(data: data)
                remaining -= Int64(data.count)
            }
            try handle.seek(toOffset: UInt64(upload.offset))
        }
        while offset < size {
            let plaintext = try handle.read(upToCount: Int(min(4 * 1024 * 1024, size - offset))) ?? Data()
            if plaintext.isEmpty { break }
            hasher.update(data: plaintext)
            let nonce = AES.GCM.Nonce()
            let aad = Data("\(upload.id.uuidString.lowercased()):\(offset):\(plaintext.count)".utf8)
            let sealed = try AES.GCM.seal(
                plaintext,
                using: SymmetricKey(data: connection.transferKey),
                nonce: nonce,
                authenticating: aad
            )
            var chunkRequest = try authorizedRequest("uploads/\(upload.id.uuidString.lowercased())?offset=\(offset)")
            chunkRequest.httpMethod = "PUT"
            chunkRequest.setValue(
                Data(nonce).base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: ""),
                forHTTPHeaderField: "X-PocketDock-IV"
            )
            chunkRequest.setValue(String(plaintext.count), forHTTPHeaderField: "X-PocketDock-Plain-Length")
            chunkRequest.httpBody = sealed.ciphertext + sealed.tag
            let (progressData, progressResponse) = try await perform(chunkRequest)
            guard let progressHTTP = progressResponse as? HTTPURLResponse, progressHTTP.statusCode == 200 else {
                throw CocoaError(.fileWriteUnknown)
            }
            offset = try decoder.decode(UploadProgress.self, from: progressData).offset
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        var complete = try authorizedRequest("uploads/\(upload.id.uuidString.lowercased())/complete")
        complete.httpMethod = "POST"
        complete.setValue("application/json", forHTTPHeaderField: "Content-Type")
        complete.httpBody = try JSONEncoder().encode(["sha256": digest])
        let (_, response) = try await perform(complete)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw CocoaError(.fileWriteUnknown)
        }
    }

    private func request(_ route: String) async throws -> Data {
        let request = try authorizedRequest(route)
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw CocoaError(.fileReadNoPermission)
        }
        return data
    }

    private func jsonRequest(_ route: String, body: [String: String]) async throws -> Data {
        var request = try authorizedRequest(route)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            throw CocoaError(.fileWriteNoPermission)
        }
        return data
    }

    private func authorizedRequest(_ route: String) throws -> URLRequest {
        guard let url = URL(string: "api/\(route)", relativeTo: connection.baseURL) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        var request = URLRequest(url: url)
        if let token = connection.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func perform(_ original: URLRequest) async throws -> (Data, URLResponse) {
        var request = original
        if let token = connection.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let first = try await URLSession.shared.data(for: request)
        guard (first.1 as? HTTPURLResponse)?.statusCode == 401 else { return first }
        try await reconnect()
        var retry = original
        retry.setValue("Bearer \(connection.token ?? "")", forHTTPHeaderField: "Authorization")
        return try await URLSession.shared.data(for: retry)
    }

    private func reconnect() async throws {
        guard
            let refreshToken = connection.refreshToken,
            let url = URL(string: "api/reconnect", relativeTo: connection.baseURL)
        else { throw CocoaError(.fileReadNoPermission) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "deviceId": connection.deviceId.uuidString.lowercased(),
            "refreshToken": refreshToken
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw CocoaError(.fileReadNoPermission)
        }
        connection.token = try decoder.decode(RefreshResponse.self, from: data).token
        BridgeConnection.saveSecrets(connection)
    }

    private func open(
        _ payload: Data,
        identifier: String,
        offset: Int64,
        plainLength: Int,
        iv: String
    ) throws -> Data {
        var base64 = iv.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let nonceData = Data(base64Encoded: base64), payload.count >= 16 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonceData),
            ciphertext: payload.dropLast(16),
            tag: payload.suffix(16)
        )
        return try AES.GCM.open(
            box,
            using: SymmetricKey(data: connection.transferKey),
            authenticating: Data("\(identifier):\(offset):\(plainLength)".utf8)
        )
    }
}

final class FileProviderExtension: NSFileProviderReplicatedExtension {
    private let client: DriveClient?

    required init(domain: NSFileProviderDomain) {
        client = try? DriveClient()
        super.init(domain: domain)
    }

    override func invalidate() {}

    static func identifier(for path: String) -> NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier(Data(path.utf8).base64EncodedString())
    }

    static func path(for identifier: NSFileProviderItemIdentifier) -> String {
        if identifier == .rootContainer || identifier == .workingSet { return "" }
        return Data(base64Encoded: identifier.rawValue)
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    override func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let client else { throw CocoaError(.fileReadNoPermission) }
                if identifier == .rootContainer {
                    completionHandler(DriveItem(entry: nil, identifier: .rootContainer), nil)
                } else {
                    let path = Self.path(for: identifier)
                    let parent = (path as NSString).deletingLastPathComponent
                    let entry = try await client.list(path: parent).first { $0.relativePath == path }
                    completionHandler(entry.map { DriveItem(entry: $0, identifier: identifier) }, nil)
                }
                progress.completedUnitCount = 1
            } catch { completionHandler(nil, error) }
        }
        return progress
    }

    override func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let client else { throw CocoaError(.fileReadNoPermission) }
                let path = Self.path(for: itemIdentifier)
                let parent = (path as NSString).deletingLastPathComponent
                guard let entry = try await client.list(path: parent).first(where: { $0.relativePath == path }) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                let url = try await client.fetch(path: path, size: entry.size)
                completionHandler(url, DriveItem(entry: entry, identifier: itemIdentifier), nil)
                progress.completedUnitCount = 1
            } catch { completionHandler(nil, nil, error) }
        }
        return progress
    }

    override func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
        guard client != nil else { throw CocoaError(.fileReadNoPermission) }
        DriveEnumerator(path: Self.path(for: containerItemIdentifier), client: client)
    }

    override func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let client else { throw CocoaError(.fileWriteNoPermission) }
                let parent = Self.path(for: itemTemplate.parentItemIdentifier)
                let path = [parent, itemTemplate.filename].filter { !$0.isEmpty }.joined(separator: "/")
                if itemTemplate.contentType == .folder {
                    try await client.createFolder(path: path)
                } else if let url {
                    try await client.upload(contents: url, relativePath: path)
                } else {
                    throw CocoaError(.fileWriteUnknown)
                }
                let parentEntries = try await client.list(path: parent)
                guard let entry = parentEntries.first(where: { $0.relativePath == path }) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                completionHandler(
                    DriveItem(entry: entry, identifier: Self.identifier(for: path)),
                    [],
                    false,
                    nil
                )
                progress.completedUnitCount = 1
            } catch { completionHandler(nil, fields, false, error) }
        }
        return progress
    }

    override func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion version: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options: NSFileProviderModifyItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let client else { throw CocoaError(.fileWriteNoPermission) }
                var path = Self.path(for: item.itemIdentifier)
                if changedFields.contains(.filename) {
                    try await client.rename(path: path, name: item.filename)
                    path = [((path as NSString).deletingLastPathComponent), item.filename]
                        .filter { !$0.isEmpty }
                        .joined(separator: "/")
                }
                if let newContents {
                    try await client.archive(path: path)
                    try await client.upload(contents: newContents, relativePath: path)
                }
                let parent = (path as NSString).deletingLastPathComponent
                let entry = try await client.list(path: parent).first { $0.relativePath == path }
                completionHandler(
                    entry.map { DriveItem(entry: $0, identifier: Self.identifier(for: path)) },
                    [],
                    false,
                    nil
                )
                progress.completedUnitCount = 1
            } catch { completionHandler(nil, changedFields, false, error) }
        }
        return progress
    }

    override func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions,
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let client else { throw CocoaError(.fileWriteNoPermission) }
                try await client.archive(path: Self.path(for: identifier))
                completionHandler(nil)
                progress.completedUnitCount = 1
            } catch { completionHandler(error) }
        }
        return progress
    }
}
