import SwiftUI

@main
struct PocketDockApp: App {
    @UIApplicationDelegateAdaptor(PocketDockAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task { await model.start() }
        }
    }
}
