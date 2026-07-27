import Foundation
import UIKit

struct SavedConnection: Codable, Equatable, Sendable {
    var id: UUID
    var baseURL: URL
    var relayURL: URL?
    var transferKey: Data
    var pcName: String
    var token: String?
    var refreshToken: String?
    var deviceId: UUID

    private init(
        id: UUID,
        baseURL: URL,
        relayURL: URL?,
        transferKey: Data,
        pcName: String,
        token: String?,
        refreshToken: String?,
        deviceId: UUID
    ) {
        self.id = id
        self.baseURL = baseURL
        self.relayURL = relayURL
        self.transferKey = transferKey
        self.pcName = pcName
        self.token = token
        self.refreshToken = refreshToken
        self.deviceId = deviceId
    }

    init(pairingURL: URL) throws {
        guard
            let components = URLComponents(url: pairingURL, resolvingAgainstBaseURL: false),
            let keyText = components.fragment?
                .split(separator: "&")
                .compactMap({ part -> String? in
                    let pieces = part.split(separator: "=", maxSplits: 1)
                    return pieces.first == "key" && pieces.count == 2 ? String(pieces[1]) : nil
                }).first,
            let key = Data(base64URLEncoded: keyText),
            key.count == 32
        else { throw PocketDockError.invalidPairingLink }
        id = UUID()
        if components.scheme == "pocketdock" {
            guard
                let relayText = components.queryItems?.first(where: { $0.name == "relay" })?.value,
                let relayData = Data(base64URLEncoded: relayText),
                let relayString = String(data: relayData, encoding: .utf8),
                let relay = URL(string: relayString),
                relay.scheme == "wss" || (relay.scheme == "ws" && ["localhost", "127.0.0.1"].contains(relay.host))
            else { throw PocketDockError.invalidPairingLink }
            relayURL = relay
            baseURL = URL(string: "http://127.0.0.1/")!
            pcName = "Remote PocketDock"
        } else {
            var clean = components
            clean.fragment = nil
            clean.query = nil
            guard let url = clean.url, url.scheme == "http" || url.scheme == "https" else {
                throw PocketDockError.invalidPairingLink
            }
            baseURL = url
            relayURL = nil
            pcName = url.host ?? "PocketDock PC"
        }
        transferKey = key
        token = nil
        refreshToken = nil
        deviceId = UIDevice.current.identifierForVendor ?? UUID()
    }

    func save() {
        let metadata = ConnectionMetadata(
            id: id,
            baseURL: baseURL,
            relayURL: relayURL,
            pcName: pcName,
            deviceId: deviceId
        )
        var all = Self.loadMetadata().filter { $0.id != id }
        all.insert(metadata, at: 0)
        if let data = try? JSONEncoder().encode(all) {
            UserDefaults.standard.set(data, forKey: "PocketDock.connections")
        }
        let secrets = ConnectionSecrets(
            transferKey: transferKey,
            token: token,
            refreshToken: refreshToken
        )
        if let data = try? JSONEncoder().encode(secrets) {
            try? KeychainStore.set(data, for: "connection.\(id.uuidString)")
        }
        FileProviderBridgeStore.save(self)
    }

    static func load() -> SavedConnection? {
        loadAll().first
    }

    static func loadAll() -> [SavedConnection] {
        migrateLegacyConnection()
        return loadMetadata().compactMap { metadata in
            guard
                let data = KeychainStore.get("connection.\(metadata.id.uuidString)"),
                let secrets = try? JSONDecoder().decode(ConnectionSecrets.self, from: data)
            else { return nil }
            return SavedConnection(
                id: metadata.id,
                baseURL: metadata.baseURL,
                relayURL: metadata.relayURL,
                transferKey: secrets.transferKey,
                pcName: metadata.pcName,
                token: secrets.token,
                refreshToken: secrets.refreshToken,
                deviceId: metadata.deviceId
            )
        }
    }

    static func clear(id: UUID) {
        let all = loadMetadata().filter { $0.id != id }
        UserDefaults.standard.set(try? JSONEncoder().encode(all), forKey: "PocketDock.connections")
        KeychainStore.remove("connection.\(id.uuidString)")
        FileProviderBridgeStore.clear()
    }

    private static func loadMetadata() -> [ConnectionMetadata] {
        guard let data = UserDefaults.standard.data(forKey: "PocketDock.connections") else {
            return []
        }
        return (try? JSONDecoder().decode([ConnectionMetadata].self, from: data)) ?? []
    }

    private static func migrateLegacyConnection() {
        guard
            loadMetadata().isEmpty,
            let data = UserDefaults.standard.data(forKey: "PocketDock.connection"),
            let legacy = try? JSONDecoder().decode(LegacyConnection.self, from: data)
        else { return }
        let migrated = SavedConnection(
            id: UUID(),
            baseURL: legacy.baseURL,
            relayURL: nil,
            transferKey: legacy.transferKey,
            pcName: legacy.pcName,
            token: legacy.token,
            refreshToken: legacy.refreshToken,
            deviceId: legacy.deviceId
        )
        migrated.save()
        UserDefaults.standard.removeObject(forKey: "PocketDock.connection")
    }
}

private struct ConnectionMetadata: Codable, Sendable {
    let id: UUID
    let baseURL: URL
    let relayURL: URL?
    let pcName: String
    let deviceId: UUID
}

private struct ConnectionSecrets: Codable, Sendable {
    let transferKey: Data
    let token: String?
    let refreshToken: String?
}

private struct LegacyConnection: Codable, Sendable {
    let baseURL: URL
    let transferKey: Data
    let pcName: String
    let token: String?
    let refreshToken: String?
    let deviceId: UUID
}

struct PairResponse: Codable, Sendable {
    let token: String
    let refreshToken: String?
    let deviceId: UUID?
    let pcName: String
}

struct PairingServerStatus: Codable, Sendable {
    let name: String
    let requiresPairing: Bool
    let encryptionRequired: Bool
}

struct UploadStartResponse: Codable, Sendable {
    let id: UUID
    let offset: Int64
    let resumed: Bool
    let paused: Bool?
}

struct UploadChunkResponse: Codable, Sendable {
    let id: UUID
    let offset: Int64
    let readyForVerification: Bool
}

struct PCStatus: Codable, Sendable {
    struct BackupSchedule: Codable, Sendable {
        let enabled: Bool
        let start: String
        let end: String
        let allowedNow: Bool
    }

    let pcName: String
    let destinationLabel: String
    let encryptionRequired: Bool
    let integrityRequired: Bool
    let backupSchedule: BackupSchedule
}

struct RemoteSharedFile: Codable, Identifiable, Sendable {
    let id: UUID
    let name: String
    let size: Int64
    let mimeType: String
    let sha256: String?
    let encrypted: Bool
    let chunkUrl: String
}

struct RemoteClipboardEntry: Codable, Identifiable, Sendable {
    let id: UUID
    let kind: String
    let content: String
    let sourceDevice: String
    let createdAt: String
    let pinned: Bool?
    let expiresAt: String?
    let fileName: String?
}

struct MobileTransfer: Codable, Identifiable, Sendable {
    let id: UUID
    let name: String
    var localPath: String?
    var relativePath: String?
    var size: Int64 = 0
    /// Recovery identity and destination are persisted with the queue entry so
    /// relaunch/retry can reuse the same record instead of staging duplicates.
    var recoveryPersistentID: String?
    /// SHA-256 of the verified recovery record that this queue entry represents.
    /// Older journals decode this as nil and are safely restaged before reuse.
    var recoverySHA256: String? = nil
    var connectionID: UUID?
    var progress: Double = 0
    var bytesPerSecond: Double = 0
    var completed = false
    var error: String?
    var paused = false
    /// `true` only when the user explicitly pressed Pause. Older journals do
    /// not contain this optional field, so they remain decodable during an
    /// upgrade and are classified when the journal is loaded.
    var manuallyPaused: Bool?
    var createdAt = Date()
    var updatedAt = Date()

    var isActive: Bool { !completed && error == nil && !paused }
}

struct DiscoveredDock: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let host: String
    let port: Int
}

struct MobileSyncProfile: Codable, Identifiable, Sendable {
    let id: UUID
    let name: String
    let iphoneDirectory: String
    let direction: String
    let deletionPolicy: String
    let enabled: Bool
    let includeExtensions: [String]
    let lastRunAt: String?
    let createdAt: String
}

struct MobileSyncManifestEntry: Codable, Identifiable, Sendable {
    var id: String { relativePath }
    let relativePath: String
    let size: Int64
    let modifiedAt: Double
    let sha256: String
}

struct MobileDriveEntry: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let relativePath: String
    let kind: String
    let size: Int64
    let modifiedAt: String
    let mimeType: String
}

struct OfflineDriveItem: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let relativePath: String
    let localPath: String
    let size: Int64
    let modifiedAt: String
    let mimeType: String
    let cachedAt: Date
}

struct MobileProducerTrack: Codable, Identifiable, Sendable {
    var id: String { sha256 }
    let name: String
    let role: String
    let size: Int64
    let sha256: String
    let previewAvailable: Bool?
}

struct MobileProducerArtwork: Codable, Sendable {
    let status: String
    let source: String
    let confidence: Double
    let requestedTitle: String
    let requestedArtist: String
    let matchedTitle: String?
    let matchedArtist: String?
    let releaseGroupId: String?
    let queryVariants: [String]
    let matchReason: String?
}

struct MobileProducerPackage: Codable, Identifiable, Sendable {
    let id: UUID
    let title: String
    let artist: String
    let bpm: Double?
    let musicalKey: String?
    let notes: String
    let fileCount: Int
    let size: Int64
    let createdAt: String
    let version: Int?
    let clientName: String?
    let licenseName: String?
    let approvalStatus: String?
    let clientNote: String?
    let downloadCount: Int?
    let artwork: MobileProducerArtwork?
    let tracks: [MobileProducerTrack]?
}

enum MusicInventoryAuthorization: String, Codable, Sendable {
    case authorized
    case denied
    case restricted
    case notDetermined = "not-determined"

    var title: String {
        switch self {
        case .authorized: "Allowed"
        case .denied: "Denied"
        case .restricted: "Restricted"
        case .notDetermined: "Not requested"
        }
    }
}

/// Metadata returned by MusicKit. Recovery state and file paths deliberately
/// live in MusicRecoveryService instead of being exposed in the wire inventory.
struct PhoneMusicTrack: Codable, Identifiable, Sendable {
    var id: String { externalId }
    let externalId: String
    let title: String
    let artist: String
    let album: String
    let duration: Double?
    let track: Int?
    let disc: Int?
    let year: Int?
    let genre: String?
    let isDownloaded: Bool?
}

/// A named MusicKit collection and its complete ordered membership. Keeping
/// the relationship IDs alongside the tracks makes user-created playlists
/// such as a beat folder discoverable without exposing or copying audio.
struct PhoneMusicCollection: Codable, Identifiable, Sendable {
    var id: String { externalId }
    let externalId: String
    let name: String
    let kind: String
    let itemCount: Int
    let trackExternalIds: [String]
}

/// A real file inside PocketDock's own Documents container, whether imported by
/// the user or recovered from an eligible local Music item. These entries can be
/// sent through the encrypted queue and browsed through Apple File Sharing.
struct PhoneDocumentFile: Codable, Identifiable, Sendable {
    var id: String { externalId }
    let externalId: String
    let name: String
    let relativePath: String
    let size: Int64
    let modifiedAt: String
    let contentType: String?
    let isAudio: Bool
}

struct PhoneMusicInventory: Codable, Sendable {
    let generationId: String
    let generationSequence: Int64
    let generatedAt: String
    let authorization: MusicInventoryAuthorization
    let complete: Bool
    let music: [PhoneMusicTrack]
    let collections: [PhoneMusicCollection]
    let files: [PhoneDocumentFile]

    init(
        generationId: String,
        generationSequence: Int64,
        generatedAt: String,
        authorization: MusicInventoryAuthorization,
        complete: Bool,
        music: [PhoneMusicTrack],
        collections: [PhoneMusicCollection],
        files: [PhoneDocumentFile]
    ) {
        self.generationId = generationId
        self.generationSequence = generationSequence
        self.generatedAt = generatedAt
        self.authorization = authorization
        self.complete = complete
        self.music = music
        self.collections = collections
        self.files = files
    }

    private enum CodingKeys: String, CodingKey {
        case generationId
        case generationSequence
        case generatedAt
        case authorization
        case complete
        case music
        case collections
        case files
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        generationId = try values.decode(String.self, forKey: .generationId)
        generationSequence = try values.decode(Int64.self, forKey: .generationSequence)
        generatedAt = try values.decode(String.self, forKey: .generatedAt)
        authorization = try values.decode(MusicInventoryAuthorization.self, forKey: .authorization)
        complete = try values.decode(Bool.self, forKey: .complete)
        music = try values.decode([PhoneMusicTrack].self, forKey: .music)
        collections = try values.decodeIfPresent(
            [PhoneMusicCollection].self,
            forKey: .collections
        ) ?? []
        files = try values.decode([PhoneDocumentFile].self, forKey: .files)
    }
}

struct PhoneMusicInventoryReceipt: Codable, Sendable {
    let saved: Bool
    let reason: String?
    let generationId: String
    let musicCount: Int
    let fileCount: Int
    let receivedAt: String
}

struct DiagnosticCheck: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let status: String
    let detail: String
}

struct MobileDiagnosticReport: Codable, Sendable {
    let generatedAt: String
    let pcName: String
    var checks: [DiagnosticCheck]
}

struct PhotoMigrationReport: Codable, Identifiable, Sendable {
    let id: UUID
    let createdAt: Date
    var photoCount: Int
    var videoCount: Int
    var livePhotoCount: Int
    var albumCount: Int
    var transferredResources: Int
    var transferredBytes: Int64
    var unavailableResources: Int
    var contactsTransferred: Int
    var status: String
    var notes: [String]
}

struct MobileVaultItem: Codable, Identifiable, Sendable {
    let id: UUID
    let name: String
    let encryptedPath: String
    let size: Int64
    let mimeType: String
    let createdAt: Date
}

struct BackupPreferences: Codable, Equatable, Sendable {
    var enabled = false
    var favoritesOnly = false
    var includeVideos = true
    var includeLivePhotoVideo = true
    var pauseOnBattery = true
    var pauseOnConstrainedNetwork = true
}

struct BackupProgress: Sendable {
    var total = 0
    var completed = 0
    var currentName = ""
    var running = false
    var message = "Not started"
}

enum PocketDockConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case unavailable

    var title: String {
        switch self {
        case .disconnected: String(localized: "Not connected")
        case .connecting: String(localized: "Connecting…")
        case .connected: String(localized: "Encrypted connection")
        case .unavailable: String(localized: "Connection unavailable")
        }
    }

    var symbol: String {
        switch self {
        case .disconnected: "wifi.slash"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .connected: "checkmark.shield.fill"
        case .unavailable: "exclamationmark.triangle.fill"
        }
    }
}

enum PocketDockError: LocalizedError, Sendable {
    case invalidPairingLink
    case notPaired
    case server(String)
    case integrityFailure
    case secureStorage(Int32)

    var errorDescription: String? {
        switch self {
        case .invalidPairingLink: "That is not a valid PocketDock QR link."
        case .notPaired: "Pair with PocketDock before transferring files."
        case .server(let message): message
        case .integrityFailure: "The SHA-256 integrity check failed."
        case .secureStorage(let status): "Secure Keychain storage failed (\(status))."
        }
    }
}

extension Data {
    init?(base64URLEncoded value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    var base64URLEncodedString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
