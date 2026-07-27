import CryptoKit
import Foundation

enum CryptoBox {
    static func seal(
        _ plaintext: Data,
        keyData: Data,
        identifier: String,
        offset: Int64
    ) throws -> (payload: Data, iv: String) {
        let key = SymmetricKey(data: keyData)
        let nonce = AES.GCM.Nonce()
        let aad = Data("\(identifier):\(offset):\(plaintext.count)".utf8)
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: aad)
        return (box.ciphertext + box.tag, Data(nonce).base64URLEncodedString)
    }

    static func open(
        _ payload: Data,
        keyData: Data,
        identifier: String,
        offset: Int64,
        plainLength: Int,
        iv: String
    ) throws -> Data {
        guard
            let nonceData = Data(base64URLEncoded: iv),
            payload.count >= 16
        else { throw PocketDockError.integrityFailure }
        let ciphertext = payload.dropLast(16)
        let tag = payload.suffix(16)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonceData),
            ciphertext: ciphertext,
            tag: tag
        )
        let aad = Data("\(identifier):\(offset):\(plainLength)".utf8)
        return try AES.GCM.open(box, using: SymmetricKey(data: keyData), authenticating: aad)
    }
}
