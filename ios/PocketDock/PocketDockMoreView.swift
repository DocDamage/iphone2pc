import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct PocketDockMoreView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        MobileSyncManagementView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Folder Sync",
                            subtitle: "Two-way, PC-to-iPhone, and iPhone-to-PC profiles",
                            symbol: "arrow.triangle.2.circlepath.circle.fill",
                            color: .cyan
                        )
                    }
                    NavigationLink {
                        TransferCenterView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Transfer Center",
                            subtitle: "Pause, resume, retry, and review verified transfers",
                            symbol: "arrow.up.arrow.down.circle.fill",
                            color: .blue
                        )
                    }
                    NavigationLink {
                        ProducerStudioView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Producer Studio",
                            subtitle: "Review deliveries, artwork matches, and audio",
                            symbol: "waveform.circle.fill",
                            color: .purple
                        )
                    }
                    NavigationLink {
                        MusicInventoryView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Music Library",
                            subtitle: "Sync metadata and send original files you staged",
                            symbol: "music.note.list",
                            color: .pink
                        )
                    }
                    NavigationLink {
                        PhoneMigrationView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Phone Migration",
                            subtitle: "Inventory and preserve Photos, albums, Live Photos, and contacts",
                            symbol: "iphone.gen3.radiowaves.left.and.right",
                            color: .indigo
                        )
                    }
                    NavigationLink {
                        USBDocumentsView()
                    } label: {
                        MoreDestinationLabel(
                            title: "USB Documents",
                            subtitle: "Move selected files and folders through Apple Devices",
                            symbol: "cable.connector",
                            color: .blue
                        )
                    }
                }

                Section {
                    NavigationLink {
                        ConnectionDoctorView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Connection Doctor",
                            subtitle: "Test permissions, security, storage, and transport",
                            symbol: "stethoscope.circle.fill",
                            color: .green
                        )
                    }
                    NavigationLink {
                        OfflineDriveView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Offline Drive",
                            subtitle: "Files protected and available without your PC",
                            symbol: "externaldrive.fill.badge.checkmark",
                            color: .orange
                        )
                    }
                    NavigationLink {
                        MobileVaultView()
                    } label: {
                        MoreDestinationLabel(
                            title: "Mobile Vault",
                            subtitle: "Face ID-gated, on-device encrypted files",
                            symbol: "lock.shield.fill",
                            color: .teal
                        )
                    }
                } header: {
                    Text("Security & Availability")
                }

                Section {
                    Label("Shortcuts: Send to PC, Back Up Now, and Connection Doctor", systemImage: "shortcuts")
                    Label("Live Activity and Dynamic Island transfer progress", systemImage: "dynamic.island")
                    Label("Control Center backup control on iOS 18 or later", systemImage: "switch.2")
                } header: {
                    Text("Apple Integrations")
                } footer: {
                    Text("PocketDock remains account-free. No Google Drive, Dropbox, or OneDrive OAuth is built in.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("More")
        }
    }
}

private struct MusicInventoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var showAudioImporter = false
    @State private var confirmSendAll = false
    @State private var searchText = ""

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Recover your local beats", systemImage: "music.note.list")
                        .font(.headline)
                    Text(
                        "PocketDock automatically checks the Music app for locally stored, unprotected tracks you own. Eligible audio is recovered into PocketDock Files and sent to your connected PC one file at a time."
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }

            Section {
                Toggle(
                    isOn: Binding(
                        get: { model.musicRecoveryEnabled },
                        set: { enabled in
                            Task { await model.setMusicRecoveryEnabled(enabled) }
                        }
                    )
                ) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Recover and send my local music")
                        Text("On by default · resumes incrementally after launch")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Button {
                    if model.isRecoveringMusic {
                        model.pauseMusicRecovery()
                    } else {
                        Task { await model.recoverMusicNow() }
                    }
                } label: {
                    Label(
                        model.isRecoveringMusic ? "Pause Recovery" : "Retry / Recover Now",
                        systemImage: model.isRecoveringMusic
                            ? "pause.circle.fill"
                            : "externaldrive.badge.plus"
                    )
                }
                .disabled(!model.musicRecoveryEnabled)

                if model.musicRecoveryStatus.total > 0 {
                    ProgressView(
                        value: Double(model.musicRecoveryStatus.processed),
                        total: Double(model.musicRecoveryStatus.total)
                    )
                    .accessibilityLabel("Music recovery progress")
                    .accessibilityValue(
                        "\(model.musicRecoveryStatus.processed) of \(model.musicRecoveryStatus.total)"
                    )
                } else if model.isRecoveringMusic {
                    ProgressView()
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(model.musicRecoveryStatus.phase)
                        .font(.subheadline.weight(.semibold))
                    Text(model.musicRecoveryStatus.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let warning = model.musicRecoveryStatus.completenessWarning {
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Label(
                        model.musicRecoveryStatus.targetPlaylistFound
                            ? "DocRoshi Beats found"
                            : model.isRecoveringMusic
                            ? "Looking for DocRoshi Beats"
                            : "DocRoshi Beats not found",
                        systemImage: model.musicRecoveryStatus.targetPlaylistFound
                            ? "checkmark.circle.fill"
                            : "magnifyingglass.circle"
                    )
                    .foregroundStyle(
                        model.musicRecoveryStatus.targetPlaylistFound
                            ? Color.green
                            : Color.secondary
                    )
                    recoveryCountSummary(model.musicRecoveryStatus.target)
                }
                .padding(.vertical, 3)

                DisclosureGroup("Verification titles") {
                    ForEach(model.musicRecoveryStatus.clues) { clue in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(clue.title)
                                .font(.subheadline.weight(.semibold))
                            Text(
                                "Found \(clue.counts.found) · eligible \(clue.counts.eligible) · recovered \(clue.counts.recovered) · sent \(clue.counts.sent)"
                            )
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            Text(clue.reason)
                                .font(.caption2)
                                .foregroundStyle(
                                    clue.counts.failed > 0 ? Color.red : Color.secondary
                                )
                        }
                        .padding(.vertical, 3)
                    }
                }

                DisclosureGroup(
                    "Ordered DocRoshi entries (\(model.musicRecoveryStatus.targetItems.count))"
                ) {
                    if model.musicRecoveryStatus.targetItems.isEmpty {
                        Text("No ordered playlist entries were returned by MediaPlayer.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(model.musicRecoveryStatus.targetItems) { item in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("#\(item.position) · \(item.title)")
                                    .font(.subheadline.weight(.semibold))
                                if !item.artist.isEmpty {
                                    Text(item.artist)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Text("\(item.status) · \(item.reason)")
                                    .font(.caption2)
                                    .foregroundStyle(
                                        item.status == "Failed" ? Color.red : Color.secondary
                                    )
                                if let path = item.recoveredRelativePath {
                                    Text(path)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                            }
                            .padding(.vertical, 3)
                        }
                    }
                }

                DisclosureGroup("Whole-library totals") {
                    recoveryCountSummary(model.musicRecoveryStatus.overall)
                    let counts = model.musicRecoveryStatus.overall
                    if counts.protected + counts.cloudWithoutAssetURL + counts.missingAssetURL +
                        counts.notExportable + counts.exportFailed > 0
                    {
                        Text(
                            "Protected \(counts.protected) · cloud-marked with no asset URL \(counts.cloudWithoutAssetURL) · no asset URL \(counts.missingAssetURL) · not exportable \(counts.notExportable) · export failures \(counts.exportFailed)"
                        )
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Automatic local-music recovery")
            } footer: {
                Text(
                    "PocketDock never accesses DRM-protected audio. Cloud-library membership alone is not a block when iOS supplies a usable local asset URL. Use recovery only for music you own. iOS cannot launch PocketDock merely because a cable was plugged in; opening or foregrounding the app stages files offline, and a paired PC receives them when connected. Recovered files remain visible in Apple Devices under Files → PocketDock → Recovered Music."
                )
            }

            Section("Inventory sync") {
                Toggle(
                    isOn: Binding(
                        get: { model.musicInventoryEnabled },
                        set: { enabled in
                            Task {
                                if enabled {
                                    await model.enableMusicInventory()
                                } else {
                                    await model.disableMusicInventory()
                                }
                            }
                        }
                    )
                ) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Share inventory with this PC")
                        Text("Sends the full searchable library index to this PC")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(model.musicInventorySyncing)

                LabeledContent("Music permission") {
                    Label(
                        model.musicInventoryAuthorization.title,
                        systemImage: model.musicInventoryAuthorization == .authorized
                            ? "checkmark.circle.fill"
                            : "info.circle"
                    )
                    .foregroundStyle(
                        model.musicInventoryAuthorization == .authorized
                            ? Color.green
                            : Color.secondary
                    )
                }

                if model.musicInventoryAuthorization == .notDetermined {
                    Button {
                        Task { await model.requestMusicLibraryAccess() }
                    } label: {
                        Label("Allow Music Access", systemImage: "music.note")
                    }
                    .disabled(model.musicInventorySyncing)
                } else if model.musicInventoryAuthorization == .denied {
                    Button {
                        guard let settings = URL(string: UIApplication.openSettingsURLString) else {
                            return
                        }
                        openURL(settings)
                    } label: {
                        Label("Open Settings for Music Access", systemImage: "gear")
                    }
                }

                Button {
                    Task { await model.refreshMusicInventory() }
                } label: {
                    Label(
                        model.musicInventorySyncing ? "Syncing…" : "Refresh & Sync Inventory",
                        systemImage: "arrow.clockwise"
                    )
                }
                .disabled(!model.musicInventoryEnabled || model.musicInventorySyncing)

                if let lastSync = model.musicInventoryLastSyncedAt {
                    LabeledContent("Last synced") {
                        Text(lastSync, style: .relative)
                    }
                }

                Text(model.musicInventoryMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if isSearching {
                Section("Search Results") {
                    LabeledContent("Music tracks") {
                        Text(matchingTracks.count.formatted())
                    }
                    LabeledContent("Playlists") {
                        Text(matchingCollections.count.formatted())
                    }
                    LabeledContent("Staged audio") {
                        Text(matchingAudioDocuments.count.formatted())
                    }
                    if matchingTracks.isEmpty &&
                        matchingCollections.isEmpty &&
                        matchingAudioDocuments.isEmpty
                    {
                        ContentUnavailableView.search(text: normalizedSearchText)
                    }
                }
            }

            Section {
                LabeledContent(isSearching ? "Matching metadata" : "Metadata items") {
                    Text(matchingTracks.count.formatted())
                }
                if matchingTracks.isEmpty {
                    Text(
                        isSearching
                            ? "No Music-app tracks match this search."
                            : model.musicInventoryAuthorization == .authorized
                            ? "No Music-app items were returned."
                            : "Grant Music access only if you also want titles and album metadata from Apple's Music app."
                    )
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(matchingTracks) { track in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(track.title)
                                .lineLimit(1)
                            Text([track.artist, track.album].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            } header: {
                Text("Music app library")
            } footer: {
                Text(
                    "PocketDock recovers unprotected, exportable items whenever iOS supplies a usable asset URL. Cloud-library membership alone does not block recovery; unavailable or protected items remain searchable metadata and include a clear skip reason."
                )
            }

            Section {
                LabeledContent(isSearching ? "Matching playlists" : "Playlists") {
                    Text(matchingCollections.count.formatted())
                }
                if matchingCollections.isEmpty {
                    Text(
                        isSearching
                            ? "No playlist names match this search."
                            : model.musicInventoryAuthorization == .authorized
                            ? "No Music-app playlists were returned."
                            : "Grant Music access to inventory playlist names and membership."
                    )
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(matchingCollections) { collection in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(collection.name)
                                .lineLimit(2)
                            Text("\(collection.itemCount.formatted()) tracks · \(collection.kind.capitalized)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Music collections")
            } footer: {
                Text("Playlist names and track membership are synced so collections such as DocRoshi Beats can be found on the phone and paired PC.")
            }

            Section {
                LabeledContent("All staged files") {
                    Text(model.usbDocuments.count.formatted())
                }
                LabeledContent("Audio originals") {
                    Text(
                        "\(model.musicAudioDocuments.count.formatted()) · \(formatBytes(model.musicAudioDocumentBytes))"
                    )
                }
                LabeledContent("Manually added audio") {
                    Text(
                        "\(model.manuallyAddedMusicAudioDocuments.count.formatted()) · \(formatBytes(model.manuallyAddedMusicAudioDocumentBytes))"
                    )
                }

                Button {
                    showAudioImporter = true
                } label: {
                    Label("Add Audio Originals or a Folder", systemImage: "folder.badge.plus")
                }

                Button {
                    confirmSendAll = true
                } label: {
                    Label(
                        model.isSendingAllMusicFiles
                            ? "Sending Audio Files…"
                            : "Send All Manually Added Audio to PC",
                        systemImage: model.isSendingAllMusicFiles
                            ? "arrow.up.circle"
                            : "arrow.up.circle.fill"
                    )
                }
                .disabled(
                    model.manuallyAddedMusicAudioDocuments.isEmpty ||
                        model.connectionState != .connected ||
                        model.isRecoveringMusic ||
                        model.isSendingAllMusicFiles
                )

                if !model.documentImportMessage.isEmpty {
                    Text(model.documentImportMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !model.musicBulkSendMessage.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        if model.isSendingAllMusicFiles {
                            ProgressView()
                        }
                        Text(model.musicBulkSendMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if matchingAudioDocuments.isEmpty {
                    Text(
                        isSearching
                            ? "No staged audio files match this search."
                            : "No transferable audio originals are staged yet."
                    )
                    .foregroundStyle(.secondary)
                }

                ForEach(matchingAudioDocuments) { item in
                    Button {
                        Task { await model.sendUSBDocument(item) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "waveform")
                                .foregroundStyle(.pink)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(formatBytes(item.size))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if let result = model.musicFileSendResults[item.id] {
                                    Text(result)
                                        .font(.caption2)
                                        .foregroundStyle(
                                            result.hasPrefix("Failed") ? Color.red : Color.secondary
                                        )
                                }
                            }
                            Spacer()
                            Image(systemName: "arrow.up")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(
                        model.isSendingAllMusicFiles ||
                            model.isRecoveringMusic ||
                            model.musicFileSendResults[item.id] == "Sending…"
                    )
                }
            } header: {
                Text("PocketDock Files · transferable originals")
            } footer: {
                Text(
                    "Recovered Music files are sent automatically when recovery is enabled. Manually added audio can still be sent here one at a time or with Send All. Other PocketDock Documents remain available in USB Documents."
                )
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Music Library")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Tracks, playlists, artists, albums, or files"
        )
        .refreshable { await model.refreshMusicLibrary(reportErrors: true) }
        .task { await model.refreshMusicLibrary() }
        .fileImporter(
            isPresented: $showAudioImporter,
            allowedContentTypes: [.audio, .folder],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                guard !urls.isEmpty else {
                    model.reportEmptyImporterSelection(context: "Music Library")
                    return
                }
                Task { await model.stageUSBDocuments(urls) }
            case .failure(let error):
                model.reportImporterFailure(error, context: "Music Library")
            }
        }
        .confirmationDialog(
            "Send all \(model.manuallyAddedMusicAudioDocuments.count.formatted()) manually added audio files?",
            isPresented: $confirmSendAll,
            titleVisibility: .visible
        ) {
            Button("Send \(formatBytes(model.manuallyAddedMusicAudioDocumentBytes)) to PC") {
                Task { await model.sendAllMusicFilesToPC() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "PocketDock stages and sends one audio original at a time using encrypted, resumable transfer. Pausing or failing the active transfer stops the batch before another file is staged. Folder paths are preserved."
            )
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    @ViewBuilder
    private func recoveryCountSummary(_ counts: MusicRecoveryCounts) -> some View {
        Text(
            "Found \(counts.found) · eligible \(counts.eligible) · recovered \(counts.recovered) · queued \(counts.queued) · sent \(counts.sent) · skipped \(counts.skipped) · failed \(counts.failed)"
        )
        .font(.caption)
        .foregroundStyle(counts.failed > 0 ? Color.red : Color.secondary)
    }

    private var normalizedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isSearching: Bool { !normalizedSearchText.isEmpty }

    private var matchingCollections: [PhoneMusicCollection] {
        guard isSearching else { return model.musicInventoryCollections }
        return model.musicInventoryCollections.filter {
            $0.name.localizedCaseInsensitiveContains(normalizedSearchText) ||
                $0.kind.localizedCaseInsensitiveContains(normalizedSearchText)
        }
    }

    private var matchingTracks: [PhoneMusicTrack] {
        guard isSearching else { return model.musicInventoryTracks }
        let collectionTrackIds = Set(matchingCollections.flatMap(\.trackExternalIds))
        return model.musicInventoryTracks.filter { track in
            collectionTrackIds.contains(track.externalId) ||
                track.title.localizedCaseInsensitiveContains(normalizedSearchText) ||
                track.artist.localizedCaseInsensitiveContains(normalizedSearchText) ||
                track.album.localizedCaseInsensitiveContains(normalizedSearchText) ||
                (track.genre?.localizedCaseInsensitiveContains(normalizedSearchText) == true)
        }
    }

    private var matchingAudioDocuments: [USBDocumentItem] {
        guard isSearching else { return model.musicAudioDocuments }
        return model.musicAudioDocuments.filter {
            $0.name.localizedCaseInsensitiveContains(normalizedSearchText) ||
                $0.relativePath.localizedCaseInsensitiveContains(normalizedSearchText)
        }
    }
}

private struct USBDocumentsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showFileImporter = false

    var body: some View {
        List {
            Section {
                Label(
                    "Choose any file or folder below. PocketDock copies it to its USB-shared Documents folder, which Apple Devices exposes on Windows.",
                    systemImage: "info.circle"
                )
                Button {
                    showFileImporter = true
                } label: {
                    Label("Add Files or Folders for USB", systemImage: "folder.badge.plus")
                }
                if !model.documentImportMessage.isEmpty {
                    Text(model.documentImportMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("On Windows, open Apple Devices, choose this iPhone, then Files → PocketDock. iOS only permits USB access to PocketDock's shared Documents folder; it does not permit any app to browse other apps' private data or the whole iPhone filesystem.")
            }

            Section("Staged Documents") {
                if model.usbDocuments.isEmpty {
                    ContentUnavailableView(
                        "No USB Documents",
                        systemImage: "doc.badge.plus",
                        description: Text("Add files to PocketDock from Apple Devices or On My iPhone.")
                    )
                }
                ForEach(model.usbDocuments) { item in
                    HStack(spacing: 12) {
                        PocketDockFileIcon(filename: item.name)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).lineLimit(1)
                            Text(item.relativePath)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                            Text(ByteCountFormatter.string(
                                fromByteCount: item.size,
                                countStyle: .file
                            ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            if let result = model.musicFileSendResults[item.id] {
                                Text(result)
                                    .font(.caption2)
                                    .foregroundStyle(
                                        result.hasPrefix("Failed") ? Color.red : Color.secondary
                                    )
                            }
                        }
                        Spacer()
                        Button {
                            model.previewUSBDocument(item)
                        } label: {
                            Image(systemName: "eye")
                        }
                        .buttonStyle(.plain)
                        Button {
                            Task { await model.sendUSBDocument(item) }
                        } label: {
                            Image(systemName: "arrow.up.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .disabled(
                            model.connectionState != .connected ||
                                model.musicFileSendResults[item.id] == "Sending…"
                        )
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await model.removeUSBDocument(item) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("USB Documents")
        .refreshable { await model.refreshUSBDocuments() }
        .task { await model.refreshUSBDocuments() }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item, .folder],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                guard !urls.isEmpty else {
                    model.reportEmptyImporterSelection(context: "USB Documents")
                    return
                }
                Task { await model.stageUSBDocuments(urls) }
            case .failure(let error):
                model.reportImporterFailure(error, context: "USB Documents")
            }
        }
        .quickLookPreview($model.quickLookURL)
    }
}

private struct MobileSyncManagementView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedProfile: MobileSyncProfile?

    var body: some View {
        List {
            if model.syncProfiles.isEmpty {
                ContentUnavailableView(
                    "No Sync Profiles",
                    systemImage: "folder.badge.gearshape",
                    description: Text("Create a sync profile on your PC first.")
                )
            }
            ForEach(model.syncProfiles) { profile in
                Section(profile.name) {
                    LabeledContent("Direction", value: direction(profile.direction))
                    LabeledContent(
                        "iPhone Folder",
                        value: model.syncFolderNames[profile.id] ?? "Not Selected"
                    )
                    Button {
                        selectedProfile = profile
                    } label: {
                        Label("Choose Files Folder", systemImage: "folder")
                    }
                    Button {
                        Task { await model.runSync(profile) }
                    } label: {
                        Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(model.syncFolderNames[profile.id] == nil)
                }
            }
            if !model.syncMessage.isEmpty {
                Section("Status") { Text(model.syncMessage) }
            }
        }
        .navigationTitle("Folder Sync")
        .refreshable { await model.refresh() }
        .fileImporter(
            isPresented: Binding(
                get: { selectedProfile != nil },
                set: { if !$0 { selectedProfile = nil } }
            ),
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false
        ) { result in
            guard let profile = selectedProfile else { return }
            switch result {
            case .success(let urls):
                guard let folder = urls.first else {
                    model.reportEmptyImporterSelection(context: "Folder Sync")
                    selectedProfile = nil
                    return
                }
                Task { await model.chooseSyncFolder(folder, profile: profile) }
            case .failure(let error):
                model.reportImporterFailure(error, context: "Folder Sync")
            }
            selectedProfile = nil
        }
    }

    private func direction(_ value: String) -> String {
        switch value {
        case "pc-to-iphone": "PC to iPhone"
        case "iphone-to-pc": "iPhone to PC"
        default: "Two-Way"
        }
    }
}

private struct MoreDestinationLabel: View {
    let title: String
    let subtitle: String
    let symbol: String
    let color: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(color)
                .frame(width: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
    }
}

struct TransferCenterView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if model.transfers.isEmpty {
                ContentUnavailableView(
                    "Transfer Center Is Clear",
                    systemImage: "checkmark.circle",
                    description: Text("Durable, resumable transfers appear here.")
                )
            } else {
                ForEach(model.transfers) { transfer in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            PocketDockFileIcon(filename: transfer.name)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(transfer.name).lineLimit(1)
                                Text(status(transfer))
                                    .font(.caption)
                                    .foregroundStyle(transfer.error == nil ? .secondary : .red)
                            }
                            Spacer()
                            transferAction(transfer)
                        }
                        ProgressView(value: transfer.progress)
                    }
                    .padding(.vertical, 4)
                    .swipeActions {
                        if transfer.error != nil || transfer.paused {
                            Button {
                                model.retryTransfer(transfer.id)
                            } label: {
                                Label("Resume", systemImage: "play.fill")
                            }
                            .tint(.green)
                        } else if !transfer.completed {
                            Button {
                                model.pauseTransfer(transfer.id)
                            } label: {
                                Label("Pause", systemImage: "pause.fill")
                            }
                            .tint(.orange)
                        }
                    }
                }
            }
        }
        .navigationTitle("Transfer Center")
        .toolbar {
            if model.transfers.contains(where: \.completed) {
                Button("Clear Finished") { model.clearFinishedTransfers() }
            }
        }
    }

    @ViewBuilder
    private func transferAction(_ transfer: MobileTransfer) -> some View {
        if transfer.completed {
            Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
        } else if transfer.error != nil || transfer.paused {
            Button {
                model.resumeTransfer(transfer.id)
            } label: {
                Image(systemName: "play.circle.fill").font(.title2)
            }
            .buttonStyle(.plain)
        } else {
            Button {
                model.pauseTransfer(transfer.id)
            } label: {
                Image(systemName: "pause.circle").font(.title2)
            }
            .buttonStyle(.plain)
        }
    }

    private func status(_ transfer: MobileTransfer) -> String {
        if transfer.completed { return "Verified with SHA-256" }
        if let error = transfer.error { return error }
        if transfer.paused { return "Paused · tap Resume to continue from the PC offset" }
        return "\(Int(transfer.progress * 100))% · \(ByteCountFormatter.string(fromByteCount: Int64(transfer.bytesPerSecond), countStyle: .file))/s"
    }
}

struct ProducerStudioView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if model.producerPackages.isEmpty {
                ContentUnavailableView(
                    "No Producer Deliveries",
                    systemImage: "waveform",
                    description: Text("Create a Producer package on your PC, then refresh.")
                )
            }
            ForEach(model.producerPackages) { package in
                NavigationLink {
                    ProducerPackageView(package: package)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(package.title).font(.headline)
                            Spacer()
                            Text("v\(package.version ?? 1)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        Text(package.artist.isEmpty ? "Unknown artist" : package.artist)
                            .foregroundStyle(.secondary)
                        HStack {
                            Label("\(package.fileCount)", systemImage: "doc")
                            if let artwork = package.artwork {
                                Label(
                                    "\(Int(artwork.confidence * 100))% art match",
                                    systemImage: artwork.confidence >= 0.78
                                        ? "checkmark.seal" : "exclamationmark.triangle"
                                )
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .navigationTitle("Producer Studio")
        .refreshable { await model.refreshProducerPackages() }
        .task { await model.refreshProducerPackages() }
    }
}

private struct ProducerPackageView: View {
    @EnvironmentObject private var model: AppModel
    let package: MobileProducerPackage
    @State private var note = ""

    var body: some View {
        List {
            Section("Delivery") {
                LabeledContent("Artist", value: package.artist)
                if let bpm = package.bpm {
                    LabeledContent("Tempo", value: "\(bpm.formatted()) BPM")
                }
                if let key = package.musicalKey {
                    LabeledContent("Key", value: key)
                }
                LabeledContent("Size", value: ByteCountFormatter.string(
                    fromByteCount: package.size,
                    countStyle: .file
                ))
                if !package.notes.isEmpty { Text(package.notes) }
            }

            if let artwork = package.artwork {
                Section("Artwork Match") {
                    LabeledContent("Status", value: artwork.status.replacingOccurrences(of: "-", with: " ").capitalized)
                    LabeledContent("Confidence", value: "\(Int(artwork.confidence * 100))%")
                    LabeledContent("Requested", value: "\(artwork.requestedTitle) · \(artwork.requestedArtist)")
                    if let matchedTitle = artwork.matchedTitle {
                        LabeledContent("Matched", value: "\(matchedTitle) · \(artwork.matchedArtist ?? "")")
                    }
                    if !artwork.queryVariants.isEmpty {
                        DisclosureGroup("Alternate and misspelled searches") {
                            ForEach(artwork.queryVariants, id: \.self) { Text($0) }
                        }
                    }
                    if let reason = artwork.matchReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                }
            }

            Section("Tracks") {
                ForEach(package.tracks ?? []) { track in
                    Button {
                        Task { await model.previewProducerTrack(track, package: package) }
                    } label: {
                        HStack {
                            PocketDockFileIcon(filename: track.name)
                            VStack(alignment: .leading) {
                                Text(track.name).foregroundStyle(.primary)
                                Text("\(track.role.capitalized) · \(ByteCountFormatter.string(fromByteCount: track.size, countStyle: .file))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: track.previewAvailable == true ? "play.circle" : "lock.circle")
                        }
                    }
                    .disabled(track.previewAvailable != true || track.role == "artwork")
                }
            }

            Section("Review") {
                TextField("Optional note", text: $note, axis: .vertical)
                Button {
                    Task { await model.reviewProducerPackage(package, approved: true, note: note) }
                } label: {
                    Label("Approve Delivery", systemImage: "checkmark.seal.fill")
                }
                .tint(.green)
                Button {
                    Task { await model.reviewProducerPackage(package, approved: false, note: note) }
                } label: {
                    Label("Request Changes", systemImage: "arrow.uturn.backward.circle")
                }
                .tint(.orange)
            }
        }
        .navigationTitle(package.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PhoneMigrationView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            Section {
                Label(
                    "PocketDock inventories before it copies, preserves originals and album folders, downloads iCloud originals when available, and uploads a machine-readable report.",
                    systemImage: "checklist.checked"
                )
            }

            if let report = model.migrationReport {
                Section("Inventory") {
                    LabeledContent("Photos", value: "\(report.photoCount)")
                    LabeledContent("Videos", value: "\(report.videoCount)")
                    LabeledContent("Live Photos", value: "\(report.livePhotoCount)")
                    LabeledContent("Albums", value: "\(report.albumCount)")
                    LabeledContent("Copied resources", value: "\(report.transferredResources)")
                    LabeledContent("Verified bytes", value: ByteCountFormatter.string(
                        fromByteCount: report.transferredBytes,
                        countStyle: .file
                    ))
                    if report.unavailableResources > 0 {
                        LabeledContent("Unavailable", value: "\(report.unavailableResources)")
                            .foregroundStyle(.orange)
                    }
                }
            }

            Section {
                Button {
                    Task { await model.prepareMigration() }
                } label: {
                    Label("Build Migration Inventory", systemImage: "list.bullet.clipboard")
                }
                Button {
                    Task { await model.runFullMigration() }
                } label: {
                    Label("Start Full Migration", systemImage: "iphone.and.arrow.forward")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.migrationReport == nil || model.migrationReport?.status == "Migrating")

                if !model.migrationMessage.isEmpty {
                    Text(model.migrationMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Apple does not let third-party apps extract Messages, Health, Keychain passwords, or protected app containers. PocketDock reports those boundaries instead of claiming to copy them.")
            }
        }
        .navigationTitle("Phone Migration")
    }
}

struct ConnectionDoctorView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if let report = model.diagnosticReport {
                Section {
                    ForEach(report.checks) { check in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: symbol(check.status))
                                .foregroundStyle(color(check.status))
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(check.title)
                                Text(check.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text(report.pcName)
                }
            } else {
                ContentUnavailableView(
                    "Run Connection Doctor",
                    systemImage: "stethoscope",
                    description: Text("PocketDock will inspect both ends without exposing keys or file names.")
                )
            }

            Section {
                Button {
                    Task { await model.runConnectionDoctor() }
                } label: {
                    Label("Run All Checks", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                if let url = model.diagnosticExportURL {
                    ShareLink(item: url) {
                        Label("Share Diagnostic Report", systemImage: "square.and.arrow.up")
                    }
                }
            } footer: {
                Text("For cable import, Windows Photos/Apple Devices handles iPhone DCIM over USB. PocketDock’s secure arbitrary-file transport uses LAN or the optional relay.")
            }
        }
        .navigationTitle("Connection Doctor")
        .task { if model.diagnosticReport == nil { await model.runConnectionDoctor() } }
    }

    private func symbol(_ status: String) -> String {
        switch status {
        case "pass": "checkmark.circle.fill"
        case "fail": "xmark.octagon.fill"
        case "warning": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "pass": .green
        case "fail": .red
        case "warning": .orange
        default: .blue
        }
    }
}

struct OfflineDriveView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""

    var body: some View {
        List {
            if filtered.isEmpty {
                ContentUnavailableView(
                    "No Offline Files",
                    systemImage: "externaldrive.badge.xmark",
                    description: Text("In Drive, touch and hold a file, then choose Keep Offline.")
                )
            }
            ForEach(filtered) { item in
                Button {
                    model.quickLookURL = URL(fileURLWithPath: item.localPath)
                } label: {
                    HStack {
                        PocketDockFileIcon(filename: item.name)
                        VStack(alignment: .leading) {
                            Text(item.name).foregroundStyle(.primary)
                            Text("Available offline · \(ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await model.removeOfflineDriveItem(item) }
                    } label: {
                        Label("Remove Download", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Offline Drive")
        .searchable(text: $query, prompt: "Search offline files")
        .toolbar {
            Button {
                Task { await model.refreshOfflineDrive() }
            } label: {
                Label("Refresh Offline Files", systemImage: "arrow.clockwise")
            }
        }
    }

    private var filtered: [OfflineDriveItem] {
        guard !query.isEmpty else { return model.offlineDriveItems }
        return model.offlineDriveItems.filter {
            $0.name.localizedCaseInsensitiveContains(query) ||
                $0.relativePath.localizedCaseInsensitiveContains(query)
        }
    }
}

struct MobileVaultView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showImporter = false

    var body: some View {
        List {
            if !model.vaultUnlocked {
                Section {
                    ContentUnavailableView(
                        "Mobile Vault Is Locked",
                        systemImage: "lock.shield",
                        description: Text("Unlock with Face ID, Touch ID, or your device passcode.")
                    )
                    Button {
                        Task { await model.unlockVault() }
                    } label: {
                        Label("Unlock Mobile Vault", systemImage: "faceid")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .listRowBackground(Color.clear)
                }
            } else {
                if model.vaultItems.isEmpty {
                    ContentUnavailableView(
                        "Vault Is Empty",
                        systemImage: "lock.doc",
                        description: Text("Imported files are encrypted on this iPhone and never uploaded automatically.")
                    )
                }
                ForEach(model.vaultItems) { item in
                    Button {
                        Task { await model.exportVaultItem(item) }
                    } label: {
                        HStack {
                            PocketDockFileIcon(filename: item.name)
                            VStack(alignment: .leading) {
                                Text(item.name).foregroundStyle(.primary)
                                Text(ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "lock.fill").foregroundStyle(.teal)
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await model.removeVaultItem(item) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }

                if let url = model.vaultExportURL {
                    Section {
                        ShareLink(item: url) {
                            Label("Share Decrypted Copy", systemImage: "square.and.arrow.up")
                        }
                    } footer: {
                        Text("The temporary decrypted copy is protected by iOS file protection.")
                    }
                }
            }
        }
        .navigationTitle("Mobile Vault")
        .toolbar {
            if model.vaultUnlocked {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showImporter = true } label: { Label("Import", systemImage: "plus") }
                    Button { model.lockVault() } label: { Label("Lock", systemImage: "lock") }
                }
            }
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else {
                    model.reportEmptyImporterSelection(context: "Mobile Vault")
                    return
                }
                Task { await model.importVaultFile(url) }
            case .failure(let error):
                model.reportImporterFailure(error, context: "Mobile Vault")
            }
        }
    }
}
