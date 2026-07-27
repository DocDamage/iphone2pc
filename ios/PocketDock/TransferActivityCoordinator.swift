import ActivityKit
import Foundation

@MainActor
final class TransferActivityCoordinator {
    static let shared = TransferActivityCoordinator()
    private var activities: [UUID: Activity<PocketDockTransferAttributes>] = [:]

    private init() {}

    func start(id: UUID, fileName: String, computerName: String) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = PocketDockTransferAttributes(
            transferId: id,
            fileName: fileName,
            computerName: computerName
        )
        let state = PocketDockTransferAttributes.ContentState(
            progress: 0,
            status: "Preparing",
            bytesPerSecond: 0
        )
        if let activity = try? Activity.request(
            attributes: attributes,
            content: ActivityContent(state: state, staleDate: nil),
            pushType: nil
        ) {
            activities[id] = activity
        }
    }

    func update(id: UUID, progress: Double, speed: Double, status: String = "Sending") async {
        guard let activity = activities[id] else { return }
        let state = PocketDockTransferAttributes.ContentState(
            progress: progress,
            status: status,
            bytesPerSecond: speed
        )
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

    func finish(id: UUID, success: Bool) async {
        guard let activity = activities.removeValue(forKey: id) else { return }
        var state = activity.content.state
        state.progress = success ? 1 : state.progress
        state.status = success ? "Verified" : "Needs attention"
        await activity.end(
            ActivityContent(state: state, staleDate: Date().addingTimeInterval(60)),
            dismissalPolicy: .default
        )
    }
}
