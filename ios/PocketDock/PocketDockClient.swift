import CryptoKit
import Foundation
import UIKit
import UniformTypeIdentifiers

private struct ClientHTTPResult {
    let data: Data
    let status: Int
    let headers: [String: String]
}

actor PocketDockClient {
    private var connection: SavedConnection
    private let session: URLSession
    private let relay: RelayTransport?
    private let chunkSize = 4 * 1024 * 1024

    init(connection: SavedConnection) {
        self.connection = connection
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        session = URLSession(configuration: configuration)
        relay = connection.relayURL.map {
            RelayTransport(url: $0, keyData: connection.transferKey)
        }
    }

    func pair(pin: String) async throws -> SavedConnection {
        let digits = pin.filter(\.isNumber)
        guard digits.count == 6 else {
            throw PocketDockError.server("Enter the six-digit code shown on your PC.")
        }
        let status: PairingServerStatus = try await jsonRequest(
            path: "/api/status",
            authenticated: false
        )
        guard status.requiresPairing else {
            throw PocketDockError.server("This is not a compatible PocketDock connection.")
        }
        let body: [String: Any] = [
            "pin": digits,
            "deviceName": UIDevice.current.name,
            "deviceId": connection.deviceId.uuidString,
            "platform": "ios"
        ]
        let response: PairResponse = try await jsonRequest(
            path: "/api/pair",
            method: "POST",
            body: body,
            authenticated: false
        )
        connection.token = response.token
        connection.refreshToken = response.refreshToken
        connection.pcName = response.pcName
        connection.save()
        return connection
    }

    func reconnect() async throws {
        guard let refreshToken = connection.refreshToken else { throw PocketDockError.notPaired }
        let body: [String: Any] = [
            "deviceId": connection.deviceId.uuidString,
            "refreshToken": refreshToken
        ]
        let response: PairResponse = try await jsonRequest(
            path: "/api/reconnect",
            method: "POST",
            body: body,
            authenticated: false
        )
        connection.token = response.token
        connection.pcName = response.pcName
        connection.save()
    }

    func upload(
        fileURL: URL,
        syncProfileId: UUID? = nil,
        relativePath: String? = nil,
        progress: @escaping @Sendable (Double, Double) -> Void
    ) async throws {
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
        let values = try fileURL.resourceValues(
            forKeys: [.fileSizeKey, .contentModificationDateKey, .contentTypeKey]
        )
        let size = Int64(values.fileSize ?? 0)
        var startBody: [String: Any] = [
            "name": fileURL.lastPathComponent,
            "size": size,
            "type": values.contentType?.preferredMIMEType ?? "application/octet-stream",
            "lastModified": Int64(
                (values.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000
            ),
            "relativePath": relativePath ?? fileURL.lastPathComponent,
            "encrypted": true,
            "protocolVersion": 2
        ]
        if let syncProfileId {
            startBody["syncProfileId"] = syncProfileId.uuidString.lowercased()
        }
        let start: UploadStartResponse = try await jsonRequest(
            path: "/api/uploads",
            method: "POST",
            body: startBody
        )
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        var offset: Int64 = 0
        let began = Date()

        while offset < start.offset {
            let prefix = try handle.read(
                upToCount: min(chunkSize, Int(start.offset - offset))
            ) ?? Data()
            guard !prefix.isEmpty else { throw PocketDockError.integrityFailure }
            hasher.update(data: prefix)
            offset += Int64(prefix.count)
        }

        while offset < size {
            try Task.checkCancellation()
            let plaintext = try handle.read(
                upToCount: min(chunkSize, Int(size - offset))
            ) ?? Data()
            guard !plaintext.isEmpty else { throw PocketDockError.integrityFailure }
            let encrypted = try CryptoBox.seal(
                plaintext,
                keyData: connection.transferKey,
                identifier: start.id.uuidString.lowercased(),
                offset: offset
            )
            let headers = [
                "Content-Type": "application/octet-stream",
                "X-PocketDock-IV": encrypted.iv,
                "X-PocketDock-Plain-Length": String(plaintext.count)
            ]
            let result = try await perform(
                path: "/api/uploads/\(start.id.uuidString.lowercased())?offset=\(offset)",
                method: "PUT",
                headers: headers,
                body: encrypted.payload,
                useBackgroundTransfer: connection.relayURL == nil
            )
            let response = try JSONDecoder().decode(UploadChunkResponse.self, from: result.data)
            guard response.offset == offset + Int64(plaintext.count) else {
                throw PocketDockError.server("The PC returned an unexpected resume offset.")
            }
            hasher.update(data: plaintext)
            offset = response.offset
            let elapsed = max(0.001, Date().timeIntervalSince(began))
            progress(Double(offset) / Double(max(1, size)), Double(offset) / elapsed)
        }

        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        let _: [String: JSONValue] = try await jsonRequest(
            path: "/api/uploads/\(start.id.uuidString.lowercased())/complete",
            method: "POST",
            body: ["sha256": digest]
        )
    }

    func sharedFiles() async throws -> [RemoteSharedFile] {
        try await jsonRequest(path: "/api/shares")
    }

    func backupSchedule() async throws -> PCStatus.BackupSchedule {
        let status: PCStatus = try await jsonRequest(path: "/api/me")
        return status.backupSchedule
    }

    func sendMusicInventory(
        _ inventory: PhoneMusicInventory
    ) async throws -> PhoneMusicInventoryReceipt {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let plaintext = try encoder.encode(inventory)
        guard plaintext.count <= 8_000_000 else {
            throw PocketDockError.server(
                "This music inventory is too large to sync as one complete generation."
            )
        }
        let encrypted = try CryptoBox.seal(
            plaintext,
            keyData: connection.transferKey,
            identifier: "music-inventory:\(connection.deviceId.uuidString.lowercased())",
            offset: 0
        )
        let result = try await perform(
            path: "/api/music/inventory",
            method: "PUT",
            headers: [
                "Content-Type": "application/octet-stream",
                "X-PocketDock-IV": encrypted.iv,
                "X-PocketDock-Plain-Length": String(plaintext.count)
            ],
            body: encrypted.payload
        )
        return try JSONDecoder().decode(PhoneMusicInventoryReceipt.self, from: result.data)
    }

    func driveEntries(path: String) async throws -> [MobileDriveEntry] {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await jsonRequest(path: "/api/drive?path=\(encoded)")
    }

    func searchDrive(_ query: String) async throws -> [MobileDriveEntry] {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await jsonRequest(path: "/api/drive/search?q=\(encoded)&limit=150")
    }

    func downloadDriveFile(_ entry: MobileDriveEntry) async throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(entry.name)")
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        let encoded = entry.relativePath.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? entry.relativePath
        var offset: Int64 = 0
        while offset < entry.size {
            let length = min(Int64(chunkSize), entry.size - offset)
            let result = try await perform(
                path: "/api/drive/file?path=\(encoded)&offset=\(offset)&length=\(length)",
                method: "GET",
                useBackgroundTransfer: connection.relayURL == nil,
                backgroundDownload: true
            )
            let plainLength = Int(result.headers["x-pocketdock-plain-length"] ?? "0") ?? 0
            let plaintext = try CryptoBox.open(
                result.data,
                keyData: connection.transferKey,
                identifier: "drive:\(entry.relativePath)",
                offset: offset,
                plainLength: plainLength,
                iv: result.headers["x-pocketdock-iv"] ?? ""
            )
            try output.write(contentsOf: plaintext)
            offset += Int64(plaintext.count)
        }
        return destination
    }

    func download(file: RemoteSharedFile) async throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(file.name)")
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var hasher = SHA256()
        var offset: Int64 = 0
        while offset < file.size {
            let length = min(Int64(chunkSize), file.size - offset)
            let result = try await perform(
                path: "\(file.chunkUrl)?offset=\(offset)&length=\(length)",
                method: "GET",
                useBackgroundTransfer: connection.relayURL == nil,
                backgroundDownload: true
            )
            let plainLength = Int(result.headers["x-pocketdock-plain-length"] ?? "0") ?? 0
            let iv = result.headers["x-pocketdock-iv"] ?? ""
            let plaintext = try CryptoBox.open(
                result.data,
                keyData: connection.transferKey,
                identifier: file.id.uuidString.lowercased(),
                offset: offset,
                plainLength: plainLength,
                iv: iv
            )
            try output.write(contentsOf: plaintext)
            hasher.update(data: plaintext)
            offset += Int64(plaintext.count)
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        if let expected = file.sha256, expected != digest {
            try? FileManager.default.removeItem(at: destination)
            throw PocketDockError.integrityFailure
        }
        let _: [String: JSONValue] = try await jsonRequest(
            path: "/api/shares/\(file.id.uuidString.lowercased())/complete",
            method: "POST",
            body: [:]
        )
        return destination
    }

    func syncProfiles() async throws -> [MobileSyncProfile] {
        try await jsonRequest(path: "/api/sync/profiles")
    }

    func syncManifest(profileId: UUID) async throws -> [MobileSyncManifestEntry] {
        try await jsonRequest(
            path: "/api/sync/\(profileId.uuidString.lowercased())/manifest"
        )
    }

    func downloadSyncFile(
        profileId: UUID,
        entry: MobileSyncManifestEntry,
        destination: URL
    ) async throws {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var hasher = SHA256()
        var offset: Int64 = 0
        let encodedPath = entry.relativePath.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? entry.relativePath
        while offset < entry.size {
            let length = min(Int64(chunkSize), entry.size - offset)
            let result = try await perform(
                path:
                    "/api/sync/\(profileId.uuidString.lowercased())/file" +
                    "?path=\(encodedPath)&offset=\(offset)&length=\(length)",
                method: "GET",
                useBackgroundTransfer: connection.relayURL == nil,
                backgroundDownload: true
            )
            let plainLength = Int(result.headers["x-pocketdock-plain-length"] ?? "0") ?? 0
            let identifier =
                "sync:\(profileId.uuidString.lowercased()):\(entry.relativePath)"
            let plaintext = try CryptoBox.open(
                result.data,
                keyData: connection.transferKey,
                identifier: identifier,
                offset: offset,
                plainLength: plainLength,
                iv: result.headers["x-pocketdock-iv"] ?? ""
            )
            try output.write(contentsOf: plaintext)
            hasher.update(data: plaintext)
            offset += Int64(plaintext.count)
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        if digest != entry.sha256 {
            try? FileManager.default.removeItem(at: destination)
            throw PocketDockError.integrityFailure
        }
    }

    func archiveSyncFiles(profileId: UUID, relativePaths: [String]) async throws {
        let _: [String: JSONValue] = try await jsonRequest(
            path: "/api/sync/\(profileId.uuidString.lowercased())/archive",
            method: "POST",
            body: ["paths": relativePaths]
        )
    }

    func clipboardEntries() async throws -> [RemoteClipboardEntry] {
        let result = try await perform(path: "/api/clipboard", method: "GET")
        let plainLength = Int(result.headers["x-pocketdock-plain-length"] ?? "0") ?? 0
        let plaintext = try CryptoBox.open(
            result.data,
            keyData: connection.transferKey,
            identifier: "clipboard:\(connection.deviceId.uuidString.lowercased())",
            offset: 0,
            plainLength: plainLength,
            iv: result.headers["x-pocketdock-iv"] ?? ""
        )
        return try JSONDecoder().decode([RemoteClipboardEntry].self, from: plaintext)
    }

    func sendClipboard(
        _ content: String,
        kind explicitKind: String? = nil,
        pinned: Bool = false,
        expiresMinutes: Int = 0,
        fileName: String? = nil
    ) async throws {
        let kind = explicitKind ??
            (content.lowercased().hasPrefix("http") ? "url" : "text")
        var payload: [String: Any] = [
            "kind": kind,
            "content": content,
            "pinned": pinned,
            "expiresMinutes": expiresMinutes
        ]
        if let fileName { payload["fileName"] = fileName }
        let plaintext = try JSONSerialization.data(
            withJSONObject: payload
        )
        let encrypted = try CryptoBox.seal(
            plaintext,
            keyData: connection.transferKey,
            identifier: "clipboard:\(connection.deviceId.uuidString.lowercased())",
            offset: 0
        )
        _ = try await perform(
            path: "/api/clipboard",
            method: "POST",
            headers: [
                "Content-Type": "application/octet-stream",
                "X-PocketDock-IV": encrypted.iv,
                "X-PocketDock-Plain-Length": String(plaintext.count)
            ],
            body: encrypted.payload
        )
    }

    func updateClipboard(_ id: UUID, pinned: Bool) async throws {
        let _: [String: JSONValue] = try await jsonRequest(
            path: "/api/clipboard/\(id.uuidString.lowercased())",
            method: "PATCH",
            body: ["pinned": pinned]
        )
    }

    func deleteClipboard(_ id: UUID) async throws {
        _ = try await perform(
            path: "/api/clipboard/\(id.uuidString.lowercased())",
            method: "DELETE"
        )
    }

    func diagnosticReport() async throws -> MobileDiagnosticReport {
        try await jsonRequest(path: "/api/diagnostics/mobile")
    }

    func producerPackages() async throws -> [MobileProducerPackage] {
        try await jsonRequest(path: "/api/studio/packages")
    }

    func reviewProducerPackage(
        id: UUID,
        status: String,
        note: String
    ) async throws {
        let _: [String: JSONValue] = try await jsonRequest(
            path: "/api/studio/packages/\(id.uuidString.lowercased())/review",
            method: "POST",
            body: ["status": status, "note": note]
        )
    }

    func downloadProducerTrack(
        packageId: UUID,
        track: MobileProducerTrack
    ) async throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(track.name)")
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var offset: Int64 = 0
        while offset < track.size {
            let length = min(Int64(chunkSize), track.size - offset)
            let result = try await perform(
                path:
                    "/api/studio/packages/\(packageId.uuidString.lowercased())" +
                    "/tracks/\(track.sha256)?offset=\(offset)&length=\(length)",
                method: "GET",
                useBackgroundTransfer: connection.relayURL == nil,
                backgroundDownload: true
            )
            let plainLength = Int(result.headers["x-pocketdock-plain-length"] ?? "0") ?? 0
            let plaintext = try CryptoBox.open(
                result.data,
                keyData: connection.transferKey,
                identifier: "studio:\(packageId.uuidString.lowercased()):\(track.sha256)",
                offset: offset,
                plainLength: plainLength,
                iv: result.headers["x-pocketdock-iv"] ?? ""
            )
            try output.write(contentsOf: plaintext)
            offset += Int64(plaintext.count)
        }
        return destination
    }

    private func jsonRequest<T: Decodable>(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        authenticated: Bool = true
    ) async throws -> T {
        let payload = try body.map {
            try JSONSerialization.data(withJSONObject: $0)
        }
        let result = try await perform(
            path: path,
            method: method,
            authenticated: authenticated,
            headers: body == nil ? [:] : ["Content-Type": "application/json"],
            body: payload
        )
        return try JSONDecoder().decode(T.self, from: result.data)
    }

    private func perform(
        path: String,
        method: String,
        authenticated: Bool = true,
        headers: [String: String] = [:],
        body: Data? = nil,
        useBackgroundTransfer: Bool = false,
        backgroundDownload: Bool = false
    ) async throws -> ClientHTTPResult {
        var requestHeaders = headers
        if authenticated {
            guard let token = connection.token else { throw PocketDockError.notPaired }
            requestHeaders["Authorization"] = "Bearer \(token)"
        }
        if let relay {
            let response = try await relay.request(
                method: method,
                path: path,
                headers: requestHeaders,
                body: body
            )
            try validate(status: response.status, data: response.body)
            return ClientHTTPResult(
                data: response.body,
                status: response.status,
                headers: normalizeHeaders(response.headers)
            )
        }

        guard let url = URL(string: path, relativeTo: connection.baseURL) else {
            throw PocketDockError.invalidPairingLink
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        for (name, value) in requestHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if useBackgroundTransfer && (body != nil || backgroundDownload) {
            let result: BackgroundHTTPResponse
            if backgroundDownload {
                result = try await BackgroundTransferSession.shared.download(request: request)
            } else {
                let temporary = FileManager.default.temporaryDirectory
                    .appendingPathComponent("PocketDock-\(UUID().uuidString).chunk")
                try body?.write(to: temporary, options: .atomic)
                defer { try? FileManager.default.removeItem(at: temporary) }
                result = try await BackgroundTransferSession.shared.upload(
                    request: request,
                    fromFile: temporary
                )
            }
            let data: Data
            if let fileURL = result.fileURL {
                data = try Data(contentsOf: fileURL)
                try? FileManager.default.removeItem(at: fileURL)
            } else {
                data = result.data
            }
            try validate(status: result.response.statusCode, data: data)
            return ClientHTTPResult(
                data: data,
                status: result.response.statusCode,
                headers: normalizeHeaders(result.response.allHeaderFields)
            )
        }
        request.httpBody = body
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                 .notConnectedToInternet, .dataNotAllowed:
                throw PocketDockError.server(
                    "Couldn’t reach PocketDock on this network. Keep both devices on the same Wi-Fi, then use “Repair Windows access” on the PC."
                )
            default:
                throw error
            }
        }
        guard let http = response as? HTTPURLResponse else {
            throw PocketDockError.server("PocketDock returned an invalid response.")
        }
        try validate(status: http.statusCode, data: data)
        return ClientHTTPResult(
            data: data,
            status: http.statusCode,
            headers: normalizeHeaders(http.allHeaderFields)
        )
    }

    private func normalizeHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: headers.map {
            (String(describing: $0.key).lowercased(), String(describing: $0.value))
        })
    }

    private func normalizeHeaders(_ headers: [String: String]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
    }

    private func validate(status: Int, data: Data) throws {
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?[
                "error"
            ] as? String
            throw PocketDockError.server(message ?? "PocketDock rejected the request.")
        }
    }
}

enum JSONValue: Codable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]),
        array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try box.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .object(let value): try box.encode(value)
        case .array(let value): try box.encode(value)
        case .null: try box.encodeNil()
        }
    }
}
