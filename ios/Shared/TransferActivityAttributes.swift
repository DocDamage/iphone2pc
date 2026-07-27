import ActivityKit
import Foundation

struct PocketDockTransferAttributes: ActivityAttributes, Sendable {
    struct ContentState: Codable, Hashable, Sendable {
        var progress: Double
        var status: String
        var bytesPerSecond: Double
    }

    let transferId: UUID
    let fileName: String
    let computerName: String
}
