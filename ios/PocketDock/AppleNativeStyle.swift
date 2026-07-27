import SwiftUI
import UIKit

enum PocketDockTab: String, Hashable, CaseIterable, Identifiable {
    case send
    case receive
    case drive
    case sync
    case clipboard
    case more

    var id: String { rawValue }

    var title: String {
        switch self {
        case .send: "Send"
        case .receive: "Receive"
        case .drive: "Drive"
        case .sync: "Sync"
        case .clipboard: "Clipboard"
        case .more: "More"
        }
    }

    var symbol: String {
        switch self {
        case .send: "arrow.up.circle"
        case .receive: "arrow.down.circle"
        case .drive: "externaldrive"
        case .sync: "arrow.triangle.2.circlepath"
        case .clipboard: "clipboard"
        case .more: "ellipsis.circle"
        }
    }
}

struct PocketDockConnectionRow: View {
    let state: PocketDockConnectionState
    let computerName: String
    let lastRefreshAt: Date?
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(symbolColor.opacity(0.14))
                    .frame(width: 38, height: 38)
                if state == .connecting {
                    ProgressView()
                        .tint(symbolColor)
                } else {
                    Image(systemName: state.symbol)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(symbolColor)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(state.title)
                    .font(.subheadline.weight(.semibold))
                Text(detailText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if state == .unavailable {
                Button("Retry", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detailText: String {
        if let lastRefreshAt, state == .connected {
            return String(localized: "\(computerName) · Updated \(lastRefreshAt.formatted(date: .omitted, time: .shortened))")
        }
        return computerName
    }

    private var symbolColor: Color {
        switch state {
        case .connected: .green
        case .unavailable: .orange
        case .connecting: .accentColor
        case .disconnected: .secondary
        }
    }
}

struct PocketDockBrandHeader: View {
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Image("PocketDockBrandMark")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
                .accessibilityHidden(true)

            VStack(spacing: 7) {
                Text(title)
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

struct PocketDockFileIcon: View {
    let filename: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 36, height: 36)
            .background(color.opacity(0.13), in: RoundedRectangle(cornerRadius: 9))
            .accessibilityHidden(true)
    }

    private var fileExtension: String {
        (filename as NSString).pathExtension.lowercased()
    }

    private var symbol: String {
        switch fileExtension {
        case "jpg", "jpeg", "png", "gif", "heic", "webp": "photo.fill"
        case "mov", "mp4", "m4v": "film.fill"
        case "mp3", "wav", "m4a", "aac", "flac": "waveform"
        case "zip", "rar", "7z", "tar", "gz": "archivebox.fill"
        case "pdf": "doc.richtext.fill"
        default: "doc.fill"
        }
    }

    private var color: Color {
        switch fileExtension {
        case "jpg", "jpeg", "png", "gif", "heic", "webp": .blue
        case "mov", "mp4", "m4v": .pink
        case "mp3", "wav", "m4a", "aac", "flac": .orange
        case "zip", "rar", "7z", "tar", "gz": .purple
        case "pdf": .red
        default: .accentColor
        }
    }
}

struct PocketDockActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}
