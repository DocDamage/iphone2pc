import CryptoKit
import Foundation

struct RelayHTTPResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data
}

private struct RelayRequestEnvelope: Encodable, Sendable {
    let type = "request"
    let id: String
    let method: String
    let path: String
    let headers: [String: String]
    let body: String?
}

private struct RelayResponseEnvelope: Decodable, Sendable {
    let type: String
    let id: String?
    let status: Int?
    let headers: [String: String]?
    let body: String?
}

private struct RelayTunnelEnvelope: Codable, Sendable {
    let type: String
    let version: Int
    let nonce: String
    let payload: String
}

private struct RelayControlEnvelope: Decodable, Sendable {
    let type: String
}

private struct RelayKeyExchangeEnvelope: Codable, Sendable {
    let type: String
    let version: Int
    let publicKey: String
}

actor RelayTransport {
    // This must match the relay server's default MAX_MESSAGE_BYTES. Check the
    // final UTF-8 tunnel payload because request bodies are Base64-encoded,
    // encrypted, and Base64-encoded again before becoming a WebSocket message.
    private static let maximumMessageBytes = 8_500_000

    private let url: URL
    private let rootKeyData: Data
    private var task: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<RelayHTTPResponse, Error>] = [:]
    private var receiveTask: Task<Void, Never>?
    private var ephemeralPrivateKey: Curve25519.KeyAgreement.PrivateKey?
    private var sessionKey: SymmetricKey?
    private var keyWaiters: [CheckedContinuation<SymmetricKey, Error>] = []

    init(url: URL, keyData: Data) {
        self.url = url
        rootKeyData = keyData
    }

    deinit {
        task?.cancel(with: .goingAway, reason: nil)
        receiveTask?.cancel()
    }

    func request(
        method: String,
        path: String,
        headers: [String: String],
        body: Data?
    ) async throws -> RelayHTTPResponse {
        try connectIfNeeded()
        let key = try await forwardSecretKey()
        guard let task else { throw PocketDockError.server("The relay is unavailable.") }
        let id = UUID().uuidString.lowercased()
        let envelope = RelayRequestEnvelope(
            id: id,
            method: method,
            path: path,
            headers: headers,
            body: body?.base64EncodedString()
        )
        let encoded = try JSONEncoder().encode(envelope)
        let tunnel = try seal(encoded, direction: "Request", using: key)
        let tunneled = try JSONEncoder().encode(tunnel)
        guard tunneled.count <= Self.maximumMessageBytes else {
            throw PocketDockError.server(
                "This request is too large for PocketDock Relay after encryption (maximum 8.5 MB). Connect directly to the PC on the same Wi-Fi and try again."
            )
        }
        guard let text = String(data: tunneled, encoding: .utf8) else {
            throw PocketDockError.server("Could not encode the remote request.")
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do {
                    try await task.send(.string(text))
                    try await Task.sleep(for: .seconds(120))
                    await self.timeout(id: id)
                } catch {
                    await self.fail(id: id, error: error)
                }
            }
        }
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        receiveTask?.cancel()
        receiveTask = nil
        sessionKey = nil
        ephemeralPrivateKey = nil
        let continuations = pending.values
        pending.removeAll()
        for continuation in continuations {
            continuation.resume(throwing: PocketDockError.server("The relay disconnected."))
        }
        let waiters = keyWaiters
        keyWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: PocketDockError.server("The secure relay session ended."))
        }
    }

    private func connectIfNeeded() throws {
        if task != nil { return }
        let created = URLSession.shared.webSocketTask(with: url)
        task = created
        created.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled, let task {
            do {
                let message = try await task.receive()
                guard case .string(let text) = message,
                      let data = text.data(using: .utf8)
                else { continue }
                if let control = try? JSONDecoder().decode(RelayControlEnvelope.self, from: data),
                   control.type == "paired" {
                    try await publishKeyExchange()
                    continue
                }
                if let exchange = try? JSONDecoder().decode(RelayKeyExchangeEnvelope.self, from: data),
                   exchange.type == "key-exchange",
                   exchange.version == 2 {
                    try acceptKeyExchange(exchange)
                    continue
                }
                guard let tunnel = try? JSONDecoder().decode(RelayTunnelEnvelope.self, from: data),
                      let key = sessionKey,
                      let plaintext = try? open(tunnel, direction: "Response", using: key),
                      let envelope = try? JSONDecoder().decode(RelayResponseEnvelope.self, from: plaintext),
                      envelope.type == "response",
                      let id = envelope.id,
                      let status = envelope.status
                else { continue }
                let response = RelayHTTPResponse(
                    status: status,
                    headers: envelope.headers ?? [:],
                    body: Data(base64Encoded: envelope.body ?? "") ?? Data()
                )
                if let continuation = pending.removeValue(forKey: id) {
                    continuation.resume(returning: response)
                }
            } catch {
                self.task = nil
                let continuations = pending.values
                pending.removeAll()
                for continuation in continuations {
                    continuation.resume(throwing: error)
                }
                let waiters = keyWaiters
                keyWaiters.removeAll()
                for waiter in waiters {
                    waiter.resume(throwing: error)
                }
                return
            }
        }
    }

    private func timeout(id: String) {
        if let continuation = pending.removeValue(forKey: id) {
            continuation.resume(throwing: PocketDockError.server("The remote PC did not respond."))
        }
    }

    private func fail(id: String, error: Error) {
        if let continuation = pending.removeValue(forKey: id) {
            continuation.resume(throwing: error)
        }
    }

    private func forwardSecretKey() async throws -> SymmetricKey {
        if let sessionKey { return sessionKey }
        return try await withCheckedThrowingContinuation { continuation in
            keyWaiters.append(continuation)
        }
    }

    private func publishKeyExchange() async throws {
        guard let task else { throw PocketDockError.server("The relay is unavailable.") }
        let privateKey = Curve25519.KeyAgreement.PrivateKey()
        ephemeralPrivateKey = privateKey
        sessionKey = nil
        let exchange = RelayKeyExchangeEnvelope(
            type: "key-exchange",
            version: 2,
            publicKey: privateKey.publicKey.rawRepresentation.base64EncodedString()
        )
        let encoded = try JSONEncoder().encode(exchange)
        guard let text = String(data: encoded, encoding: .utf8) else {
            throw PocketDockError.server("Could not encode the secure-session key.")
        }
        try await task.send(.string(text))
    }

    private func acceptKeyExchange(_ exchange: RelayKeyExchangeEnvelope) throws {
        guard
            let privateKey = ephemeralPrivateKey,
            let data = Data(base64Encoded: exchange.publicKey),
            data.count == 32
        else { throw PocketDockError.server("The relay session key is invalid.") }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: data)
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let derived = secret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: rootKeyData,
            sharedInfo: Data("PocketDock Remote Forward-Secret Session v2".utf8),
            outputByteCount: 32
        )
        sessionKey = derived
        let waiters = keyWaiters
        keyWaiters.removeAll()
        for waiter in waiters { waiter.resume(returning: derived) }
    }

    private func seal(
        _ plaintext: Data,
        direction: String,
        using key: SymmetricKey
    ) throws -> RelayTunnelEnvelope {
        let aad = Data("PocketDock Remote \(direction) v2".utf8)
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
        let ciphertext = sealed.ciphertext + sealed.tag
        return RelayTunnelEnvelope(
            type: "tunnel",
            version: 2,
            nonce: Data(sealed.nonce).base64EncodedString(),
            payload: ciphertext.base64EncodedString()
        )
    }

    private func open(
        _ envelope: RelayTunnelEnvelope,
        direction: String,
        using key: SymmetricKey
    ) throws -> Data {
        guard envelope.type == "tunnel",
              envelope.version == 2,
              let nonceData = Data(base64Encoded: envelope.nonce),
              let combined = Data(base64Encoded: envelope.payload),
              combined.count > 16
        else {
            throw PocketDockError.server("The remote response was not securely tunneled.")
        }
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let ciphertext = combined.dropLast(16)
        let tag = combined.suffix(16)
        let sealed = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tag
        )
        let aad = Data("PocketDock Remote \(direction) v2".utf8)
        return try AES.GCM.open(sealed, using: key, authenticating: aad)
    }
}
