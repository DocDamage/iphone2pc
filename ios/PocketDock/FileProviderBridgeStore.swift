import Foundation
import Security

private struct FileProviderBridgeMetadata: Codable {
    let baseURL: URL
    let deviceId: UUID
    let pcName: String
}

enum FileProviderBridgeStore {
    private static let suite = "group.com.docdamage.pocketdock"
    private static let metadataKey = "PocketDock.FileProvider.Connection"
    private static let keychainService = "com.docdamage.pocketdock.fileprovider"
    private static let keychainAccount = "active-connection"

    static func save(_ connection: SavedConnection) {
        guard connection.relayURL == nil else { return }
        let metadata = FileProviderBridgeMetadata(
            baseURL: connection.baseURL,
            deviceId: connection.deviceId,
            pcName: connection.pcName
        )
        guard
            let metadataData = try? JSONEncoder().encode(metadata),
            let secrets = try? JSONEncoder().encode([
                connection.transferKey.base64EncodedString(),
                connection.token ?? "",
                connection.refreshToken ?? ""
            ])
        else { return }
        UserDefaults(suiteName: suite)?.set(metadataData, forKey: metadataKey)
        setSharedKeychain(secrets)
    }

    static func clear() {
        UserDefaults(suiteName: suite)?.removeObject(forKey: metadataKey)
        SecItemDelete(keychainQuery() as CFDictionary)
    }

    private static func setSharedKeychain(_ data: Data) {
        let query = keychainQuery()
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private static func keychainQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        if let group = Bundle.main.object(
            forInfoDictionaryKey: "PocketDockKeychainAccessGroup"
        ) as? String, !group.isEmpty {
            query[kSecAttrAccessGroup as String] = group
        }
        return query
    }
}
