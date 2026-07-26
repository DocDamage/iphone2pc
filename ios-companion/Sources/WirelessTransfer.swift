import CryptoKit
import Foundation
import Security

@MainActor
final class WirelessTransfer: ObservableObject {
    struct RemoteFile: Decodable, Identifiable {
        let name: String
        let bytes: Int64
        let sha256: String
        var id: String { name }
    }

    @Published var endpoint = ""
    @Published var pairingCode = ""
    @Published var certificateFingerprint = ""
    @Published private(set) var files: [RemoteFile] = []
    @Published private(set) var paired = SecureTokenStore.load() != nil
    @Published var message = "Wireless exchange is off"

    private var token: String? { SecureTokenStore.load() }

    func pair() async {
        do {
            let url = try serviceURL("/v1/pair")
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["code": pairingCode])
            let (data, response) = try await session().data(for: request)
            try validate(response, data: data)
            let value = try JSONDecoder().decode([String: String].self, from: data)
            guard let token = value["token"] else { throw TransferError.invalidResponse }
            try SecureTokenStore.save(token)
            paired = true
            message = "Securely paired to this PC"
            await refresh()
        } catch { message = "Pairing failed: \(error.localizedDescription)" }
    }

    func forget() {
        SecureTokenStore.clear()
        files = []
        paired = false
        message = "Pairing removed"
    }

    func refresh() async {
        guard paired else { return }
        do {
            var request = URLRequest(url: try serviceURL("/v1/files"))
            authorize(&request)
            let (data, response) = try await session().data(for: request)
            try validate(response, data: data)
            struct Listing: Decodable { let files: [RemoteFile] }
            files = try JSONDecoder().decode(Listing.self, from: data).files
            message = "Secure exchange ready · \(files.count) PC files"
        } catch { message = "Could not refresh PC files: \(error.localizedDescription)" }
    }

    func upload(_ source: URL) async {
        do {
            var request = URLRequest(url: try serviceURL("/v1/files"))
            request.httpMethod = "POST"
            request.setValue(source.lastPathComponent, forHTTPHeaderField: "X-iDrivePulse-Filename")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            authorize(&request)
            let (_, response) = try await session().upload(for: request, fromFile: source)
            try validate(response, data: Data())
            message = "Sent \(source.lastPathComponent) to PC"
            await refresh()
        } catch { message = "Upload failed: \(error.localizedDescription)" }
    }

    func download(_ file: RemoteFile) async -> Data? {
        do {
            let encoded = file.name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file.name
            var request = URLRequest(url: try serviceURL("/v1/files/\(encoded)"))
            authorize(&request)
            let (data, response) = try await session().data(for: request)
            try validate(response, data: data)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard hash == file.sha256 else { throw TransferError.integrityFailure }
            message = "Verified and downloaded \(file.name)"
            return data
        } catch {
            message = "Download failed: \(error.localizedDescription)"
            return nil
        }
    }

    private func serviceURL(_ path: String) throws -> URL {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard trimmed.hasPrefix("https://"), let url = URL(string: trimmed + path) else {
            throw TransferError.httpsRequired
        }
        return url
    }

    private func session() -> URLSession {
        let delegate = PinnedCertificateDelegate(fingerprint: certificateFingerprint)
        return URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    }

    private func authorize(_ request: inout URLRequest) {
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let detail = (try? JSONDecoder().decode([String: String].self, from: data)["detail"]) ?? "PC rejected the request"
            throw TransferError.server(detail)
        }
    }
}

private final class PinnedCertificateDelegate: NSObject, URLSessionDelegate {
    private let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint.lowercased().filter(\.isHexDigit)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = SecTrustGetCertificateAtIndex(trust, 0) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let data = SecCertificateCopyData(certificate) as Data
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard !fingerprint.isEmpty, actual == fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

private enum SecureTokenStore {
    private static let account = "paired-pc-token"

    static func save(_ token: String) throws {
        clear()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.idrivepulse.companion",
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw TransferError.keychain }
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.idrivepulse.companion",
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.idrivepulse.companion",
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}

private enum TransferError: LocalizedError {
    case httpsRequired, invalidResponse, integrityFailure, keychain, server(String)
    var errorDescription: String? {
        switch self {
        case .httpsRequired: return "Enter the HTTPS address shown by the PC"
        case .invalidResponse: return "The PC returned an invalid pairing response"
        case .integrityFailure: return "SHA-256 verification failed"
        case .keychain: return "The pairing token could not be protected in Keychain"
        case .server(let message): return message
        }
    }
}
