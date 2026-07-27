import AppIntents
import Foundation

private enum PocketDockIntentQueue {
    static func enqueue(_ action: String) {
        UserDefaults(suiteName: "group.com.docdamage.pocketdock")?
            .set(action, forKey: "pendingAppIntent")
    }
}

struct SendToPCIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Files to PC"
    static var description = IntentDescription("Open PocketDock’s protected send queue.")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        PocketDockIntentQueue.enqueue("send")
        return .result()
    }
}

struct BackupNowIntent: AppIntent {
    static var title: LocalizedStringResource = "Back Up iPhone Now"
    static var description = IntentDescription("Run the configured PocketDock photo backup.")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        PocketDockIntentQueue.enqueue("backup")
        return .result(dialog: "Opening PocketDock to start the backup.")
    }
}

struct ConnectionDoctorIntent: AppIntent {
    static var title: LocalizedStringResource = "Run Connection Doctor"
    static var description = IntentDescription("Check the iPhone, network, encryption, and paired PC.")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        PocketDockIntentQueue.enqueue("doctor")
        return .result()
    }
}

struct OpenPocketDockDriveIntent: AppIntent {
    static var title: LocalizedStringResource = "Open PocketDock Drive"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        PocketDockIntentQueue.enqueue("drive")
        return .result()
    }
}

struct PocketDockShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendToPCIntent(),
            phrases: ["Send files with \(.applicationName)"],
            shortTitle: "Send to PC",
            systemImageName: "arrow.up.circle"
        )
        AppShortcut(
            intent: BackupNowIntent(),
            phrases: ["Back up my iPhone with \(.applicationName)"],
            shortTitle: "Back Up Now",
            systemImageName: "photo.badge.arrow.down"
        )
        AppShortcut(
            intent: ConnectionDoctorIntent(),
            phrases: ["Check \(.applicationName) connection"],
            shortTitle: "Connection Doctor",
            systemImageName: "stethoscope"
        )
    }
}
