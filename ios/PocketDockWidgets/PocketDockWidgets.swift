import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct PocketDockWidgets: WidgetBundle {
    var body: some Widget {
        PocketDockTransferLiveActivity()
        if #available(iOSApplicationExtension 18.0, *) {
            PocketDockBackupControl()
        }
    }
}

struct PocketDockTransferLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PocketDockTransferAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.attributes.fileName)
                        .font(.headline)
                        .lineLimit(1)
                    ProgressView(value: context.state.progress)
                    Text("\(context.state.status) · \(context.attributes.computerName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .activityBackgroundTint(Color(.secondarySystemBackground))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "arrow.up.circle.fill")
                        .foregroundStyle(.tint)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.fileName)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ProgressView(value: context.state.progress)
                }
            } compactLeading: {
                Image(systemName: "arrow.up")
            } compactTrailing: {
                Text("\(Int(context.state.progress * 100))%")
                    .monospacedDigit()
            } minimal: {
                Image(systemName: "arrow.up.circle.fill")
            }
        }
    }
}

@available(iOSApplicationExtension 18.0, *)
struct PocketDockBackupControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.docdamage.pocketdock.backup") {
            ControlWidgetButton(action: BackupNowIntent()) {
                Label("PocketDock Backup", systemImage: "photo.badge.arrow.down")
            }
        }
        .displayName("PocketDock Backup")
        .description("Start the configured iPhone backup.")
    }
}
