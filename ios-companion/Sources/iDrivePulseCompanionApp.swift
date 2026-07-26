import SwiftUI

@main
struct iDrivePulseCompanionApp: App {
    @StateObject private var library = PortableLibrary()
    @StateObject private var wireless = WirelessTransfer()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(library)
                .environmentObject(wireless)
        }
    }
}
