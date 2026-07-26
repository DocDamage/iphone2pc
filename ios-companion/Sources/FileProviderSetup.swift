import FileProvider
import Foundation

enum FileProviderSetup {
    static let group = "group.com.idrivepulse.companion"
    static let domain = NSFileProviderDomain(
        identifier: NSFileProviderDomainIdentifier("idrivepulse.portable"),
        displayName: "iDrivePulse"
    )

    static func register() async {
        await withCheckedContinuation { continuation in
            NSFileProviderManager.add(domain) { _ in continuation.resume() }
        }
    }

    static func signal() {
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .rootContainer) { _ in }
    }

    static var exchangeRoot: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("File Provider", isDirectory: true)
    }
}
