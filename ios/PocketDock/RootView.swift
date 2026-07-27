import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: PocketDockTab = .send
    @State private var showScanner = false
    @State private var showPairing = false
    @State private var pairingURL: URL?
    @State private var pin = ""
    @State private var isPairing = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var clipboardText = ""
    @State private var clipboardPinned = false
    @State private var clipboardExpiryMinutes = 0
    @State private var showClipboardFile = false
    @State private var folderProfile: MobileSyncProfile?
    @State private var shareURL: URL?
    @State private var confirmForget = false
    @State private var copyFeedback = 0

    var body: some View {
        Group {
            if !model.isUnlocked {
                lockedView
            } else if model.connection == nil {
                pairingView
            } else {
                dashboard
            }
        }
        .tint(.accentColor)
        .sheet(isPresented: $showPairing) {
            pairingView
                .interactiveDismissDisabled(model.connection == nil || isPairing)
        }
        .sheet(
            isPresented: Binding(
                get: { shareURL != nil },
                set: { if !$0 { shareURL = nil } }
            )
        ) {
            if let shareURL {
                PocketDockActivityView(items: [shareURL])
                    .presentationDetents([.medium, .large])
            }
        }
        .onOpenURL { url in
            acceptPairingLink(url.absoluteString)
        }
        .quickLookPreview($model.quickLookURL)
        .onChange(of: model.navigationRequest) { _, request in
            guard let request, let tab = PocketDockTab(rawValue: request) else { return }
            selectedTab = tab
            model.navigationRequest = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await model.sceneBecameActive()
                }
            } else if phase == .background {
                model.lockVault()
            }
        }
        .sensoryFeedback(.success, trigger: model.successFeedback)
        .sensoryFeedback(.error, trigger: model.errorFeedback)
        .sensoryFeedback(.selection, trigger: selectedTab)
        .sensoryFeedback(.success, trigger: copyFeedback)
        .alert(
            model.connectionState == .unavailable
                ? "Connection unavailable"
                : "PocketDock",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            if model.connection != nil {
                Button("Try Again") {
                    Task { await model.refresh(triggerRecovery: true) }
                }
            }
            Button("OK", role: .cancel) {
                model.errorMessage = nil
            }
        } message: {
            Text(model.errorMessage ?? "")
        }
        .confirmationDialog(
            "Forget \(model.connection?.pcName ?? "this computer")?",
            isPresented: $confirmForget,
            titleVisibility: .visible
        ) {
            Button("Forget Computer", role: .destructive) {
                Task { await model.forgetCurrentComputer() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You’ll need to scan a new PocketDock QR code to reconnect.")
        }
    }

    private var lockedView: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()

            VStack(spacing: 24) {
                Image("PocketDockBrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 104, height: 104)
                    .accessibilityHidden(true)

                VStack(spacing: 7) {
                    Text("PocketDock is locked")
                        .font(.title2.bold())
                    Text("Unlock to protect your computers and transfer history.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                Button {
                    Task { await model.start() }
                } label: {
                    Label("Unlock PocketDock", systemImage: "faceid")
                        .frame(maxWidth: 280)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityHint("Authenticates with Face ID, Touch ID, or your passcode")
            }
            .padding(32)
        }
    }

    private var pairingView: some View {
        NavigationStack {
            List {
                Section {
                    PocketDockBrandHeader(
                        title: "Connect to your PC",
                        message: "Scan the code in PocketDock. Your iPhone pairs privately and encrypts every transfer."
                    )
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))

                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan PocketDock QR Code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .listRowBackground(Color.clear)
                    .accessibilityHint("Opens the camera and pairs with the code shown on your PC")
                }

                if let pairingURL {
                    Section {
                        LabeledContent {
                            Label(
                                pairingURL.scheme == "pocketdock" ? "Remote" : "Nearby",
                                systemImage: pairingURL.scheme == "pocketdock"
                                    ? "network.badge.shield.half.filled"
                                    : "wifi"
                            )
                            .foregroundStyle(.secondary)
                        } label: {
                            Text("Connection")
                        }

                        TextField("Six-digit code", text: $pin)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .multilineTextAlignment(.center)
                            .font(.title3.monospacedDigit().weight(.semibold))
                            .onChange(of: pin) { _, value in
                                let digits = value.filter(\.isNumber)
                                pin = String(digits.prefix(6))
                            }

                        Button {
                            Task { await pairSelectedComputer() }
                        } label: {
                            HStack {
                                if isPairing {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                                Text(isPairing ? "Connecting…" : "Connect Securely")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(pin.count != 6 || isPairing)
                    } header: {
                        Text("Ready to pair")
                    } footer: {
                        Text("The six-digit code confirms you’re connecting to the PC in front of you.")
                    }
                }

                if !model.connections.isEmpty {
                    Section("My Computers") {
                        ForEach(model.connections, id: \.id) { computer in
                            Button {
                                Task {
                                    await model.select(computer)
                                    if model.connectionState == .connected {
                                        showPairing = false
                                    }
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: computer.relayURL == nil
                                        ? "desktopcomputer"
                                        : "network.badge.shield.half.filled")
                                        .font(.title3)
                                        .foregroundStyle(.tint)
                                        .frame(width: 30)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(computer.pcName)
                                            .foregroundStyle(.primary)
                                        Text(computer.relayURL == nil ? "Nearby" : "Remote access")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !model.discovered.isEmpty {
                    Section("Nearby Computers") {
                        ForEach(model.discovered) { dock in
                            Button {
                                Task { await model.connectNearby(dock) }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "dot.radiowaves.left.and.right")
                                        .font(.title3)
                                        .foregroundStyle(.tint)
                                        .frame(width: 30)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(dock.name).foregroundStyle(.primary)
                                        Text(
                                            model.connections.contains {
                                                $0.pcName.localizedCaseInsensitiveCompare(dock.name)
                                                    == .orderedSame
                                            }
                                                ? "Resolved on your local network"
                                                : "Scan once to verify this computer"
                                        )
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Section {
                    Label("Open PocketDock Home on your PC and keep both devices on the same private network.", systemImage: "1.circle.fill")
                    Label("Tap Scan above, point at the full QR code, and approve the connection.", systemImage: "2.circle.fill")
                    Label("Prefer Chrome? The same PC QR code opens the full Chrome companion automatically.", systemImage: "3.circle.fill")
                } header: {
                    Text("How it works")
                } footer: {
                    Label("AES-256-GCM encryption · SHA-256 verification", systemImage: "lock.shield")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.visible)
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Add Computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.connection != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showPairing = false }
                    }
                }
            }
            .fullScreenCover(isPresented: $showScanner) {
                QRScannerView { value in
                    acceptPairingLink(value)
                }
            }
        }
    }

    @ViewBuilder
    private var dashboard: some View {
        if horizontalSizeClass == .regular {
            NavigationSplitView {
                List(PocketDockTab.allCases, selection: $selectedTab) { tab in
                    Label(tab.title, systemImage: tab.symbol)
                        .tag(tab)
                }
                .navigationTitle("PocketDock")
                .safeAreaInset(edge: .top) {
                    Image("PocketDockWordmark")
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 150)
                        .padding(.vertical, 10)
                }
            } detail: {
                tabContent(selectedTab)
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            TabView(selection: $selectedTab) {
                sendView
                    .tag(PocketDockTab.send)
                    .tabItem { Label("Send", systemImage: PocketDockTab.send.symbol) }
                receiveView
                    .tag(PocketDockTab.receive)
                    .tabItem { Label("Receive", systemImage: PocketDockTab.receive.symbol) }
                driveView
                    .tag(PocketDockTab.drive)
                    .tabItem { Label("Drive", systemImage: PocketDockTab.drive.symbol) }
                clipboardView
                    .tag(PocketDockTab.clipboard)
                    .tabItem { Label("Clipboard", systemImage: PocketDockTab.clipboard.symbol) }
                PocketDockMoreView()
                    .tag(PocketDockTab.more)
                    .tabItem { Label("More", systemImage: PocketDockTab.more.symbol) }
            }
            .toolbarBackground(.ultraThinMaterial, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
        }
    }

    @ViewBuilder
    private func tabContent(_ tab: PocketDockTab) -> some View {
        switch tab {
        case .send: sendView
        case .receive: receiveView
        case .drive: driveView
        case .sync: syncView
        case .clipboard: clipboardView
        case .more: PocketDockMoreView()
        }
    }

    private var sendView: some View {
        NavigationStack {
            List {
                connectionSection

                Section {
                    PhotosPicker(
                        selection: $photoItems,
                        matching: .any(of: [.images, .videos])
                    ) {
                        Label("Choose Photos & Videos", systemImage: "photo.on.rectangle.angled")
                    }
                    Button {
                        showFiles = true
                    } label: {
                        Label("Browse Files", systemImage: "folder")
                    }
                } header: {
                    Text("Send to \(model.connection?.pcName ?? "PC")")
                } footer: {
                    Text("Files keep their original quality and are verified after transfer.")
                }

                Section("Camera Roll Backup") {
                    Toggle("Automatic Backup", isOn: $model.backupPreferences.enabled)
                    Toggle("Favorites Only", isOn: $model.backupPreferences.favoritesOnly)
                    Toggle("Include Videos", isOn: $model.backupPreferences.includeVideos)
                    Toggle(
                        "Include Live Photo Video",
                        isOn: $model.backupPreferences.includeLivePhotoVideo
                    )
                    Toggle("Wait for Charging", isOn: $model.backupPreferences.pauseOnBattery)
                    Toggle(
                        "Pause on Cellular or Constrained Networks",
                        isOn: $model.backupPreferences.pauseOnConstrainedNetwork
                    )

                    if model.backupProgress.running || model.backupProgress.total > 0 {
                        VStack(alignment: .leading, spacing: 8) {
                            ProgressView(
                                value: Double(model.backupProgress.completed),
                                total: Double(max(1, model.backupProgress.total))
                            )
                            Text(model.backupProgress.message)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }

                    Button {
                        Task { await model.runPhotoBackup() }
                    } label: {
                        Label("Back Up New Items Now", systemImage: "photo.badge.arrow.down")
                    }
                    .disabled(
                        !model.backupPreferences.enabled || model.backupProgress.running
                    )
                }
                .onChange(of: model.backupPreferences) { _, _ in
                    Task { await model.saveBackupPreferences() }
                }

                Section("Contacts Backup") {
                    Button {
                        Task { await model.runContactBackup() }
                    } label: {
                        Label(
                            "Back Up Contacts as vCard",
                            systemImage: "person.crop.circle.badge.checkmark"
                        )
                    }
                    if !model.contactBackupMessage.isEmpty {
                        Text(model.contactBackupMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if model.transfers.isEmpty {
                        ContentUnavailableView(
                            "No Transfers Yet",
                            systemImage: "arrow.up.circle",
                            description: Text("Photos and files you send appear here.")
                        )
                    } else {
                        ForEach(model.transfers) { transfer in
                            transferRow(transfer)
                        }
                    }
                } header: {
                    HStack {
                        Text("Transfers")
                        Spacer()
                        if model.transfers.contains(where: \.completed) {
                            Button("Clear") {
                                withAnimation(reduceMotion ? nil : .default) {
                                    model.clearFinishedTransfers()
                                }
                            }
                            .font(.caption)
                            .textCase(nil)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Send")
            .toolbar { computerMenu }
            .refreshable { await model.refresh() }
            .fileImporter(
                isPresented: $showFiles,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    guard !urls.isEmpty else {
                        model.reportEmptyImporterSelection(context: "Send to PC")
                        return
                    }
                    Task { await model.upload(urls: urls) }
                case .failure(let error):
                    model.reportImporterFailure(error, context: "Send to PC")
                }
            }
            .dropDestination(for: URL.self) { urls, _ in
                Task { await model.upload(urls: urls) }
                return !urls.isEmpty
            } isTargeted: { _ in }
            .onChange(of: photoItems) { _, items in
                Task { await uploadPhotoItems(items) }
            }
        }
    }

    private var receiveView: some View {
        NavigationStack {
            List {
                connectionSection

                Section {
                    if model.sharedFiles.isEmpty {
                        ContentUnavailableView(
                            "Nothing Shared Yet",
                            systemImage: "tray.and.arrow.down",
                            description: Text("Choose Send to iPhone on your PC, then pull to refresh.")
                        )
                    } else {
                        ForEach(model.sharedFiles) { file in
                            Button {
                                Task {
                                    if let url = await model.download(file) {
                                        model.quickLookURL = url
                                    }
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    PocketDockFileIcon(filename: file.name)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(file.name)
                                            .lineLimit(1)
                                            .foregroundStyle(.primary)
                                        Text(ByteCountFormatter.string(
                                            fromByteCount: file.size,
                                            countStyle: .file
                                        ))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "square.and.arrow.down")
                                        .foregroundStyle(.tint)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Downloads, verifies, then opens the native Quick Look preview")
                        }
                    }
                } header: {
                    Text("Ready from \(model.connection?.pcName ?? "PC")")
                } footer: {
                    Text("Downloaded files open in Quick Look with native Share, AirDrop, Save to Files, markup, and media controls.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Receive")
            .toolbar { computerMenu }
            .refreshable { await model.refresh() }
        }
    }

    private var driveView: some View {
        NavigationStack {
            List {
                connectionSection

                if !model.drivePath.isEmpty {
                    Section {
                        Button {
                            Task { await model.upDriveFolder() }
                        } label: {
                            Label("Previous Folder", systemImage: "arrow.up.left")
                        }
                    }
                }

                Section {
                    if driveVisibleEntries.isEmpty {
                        ContentUnavailableView(
                            "PocketDock Drive",
                            systemImage: "externaldrive",
                            description: Text("Enable Drive and grant Browse permission for this iPhone on your PC.")
                        )
                    } else {
                        ForEach(driveVisibleEntries) { entry in
                            if entry.kind == "folder" {
                                Button {
                                    Task { await model.openDriveFolder(entry) }
                                } label: {
                                    HStack {
                                        Image(systemName: "folder.fill")
                                            .foregroundStyle(.tint)
                                            .frame(width: 30)
                                        Text(entry.name)
                                            .foregroundStyle(.primary)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.tertiary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            } else {
                                Button {
                                    Task { await model.previewDriveFile(entry) }
                                } label: {
                                    HStack(spacing: 12) {
                                        PocketDockFileIcon(filename: entry.name)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(entry.name)
                                                .lineLimit(1)
                                                .foregroundStyle(.primary)
                                            Text(ByteCountFormatter.string(
                                                fromByteCount: entry.size,
                                                countStyle: .file
                                            ))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: model.offlineDriveItems.contains {
                                            $0.id == entry.id
                                        } ? "checkmark.circle.fill" : "arrow.down.circle")
                                            .foregroundStyle(.tint)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button {
                                        Task { await model.previewDriveFile(entry) }
                                    } label: {
                                        Label("Quick Look", systemImage: "eye")
                                    }
                                    if !model.offlineDriveItems.contains(where: { $0.id == entry.id }) {
                                        Button {
                                            Task { await model.pinDriveFile(entry) }
                                        } label: {
                                            Label("Keep Offline", systemImage: "arrow.down.circle")
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let url = model.driveDownloadedURL {
                        ShareLink(item: url) {
                            Label("Save or Share Downloaded File", systemImage: "square.and.arrow.up")
                        }
                    }
                } header: {
                    Text(model.drivePath.isEmpty ? "Browse" : model.drivePath)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(
                model.drivePath.isEmpty
                    ? "Drive"
                    : (model.drivePath as NSString).lastPathComponent
            )
            .searchable(text: $model.driveSearchText, prompt: "Search PC and offline files")
            .onSubmit(of: .search) {
                Task { await model.searchDrive() }
            }
            .task(id: model.driveSearchText) {
                try? await Task.sleep(for: .milliseconds(300))
                await model.searchDrive()
            }
            .toolbar {
                computerMenu
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await model.refreshDrive() }
                    } label: {
                        Label("Refresh Drive", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isRefreshing)
                }
            }
            .refreshable { await model.refreshDrive() }
            .task { await model.refreshDrive() }
        }
    }

    private var syncView: some View {
        NavigationStack {
            List {
                connectionSection

                if model.syncProfiles.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "No Sync Profiles",
                            systemImage: "folder.badge.gearshape",
                            description: Text("Create a sync profile in PocketDock on your PC first.")
                        )
                    }
                }

                ForEach(model.syncProfiles) { profile in
                    Section {
                        LabeledContent("Direction", value: syncDirection(profile.direction))
                        LabeledContent(
                            "iPhone Folder",
                            value: model.syncFolderNames[profile.id] ?? "Not Selected"
                        )
                        Button {
                            folderProfile = profile
                        } label: {
                            Label("Choose Files Folder", systemImage: "folder")
                        }
                        Button {
                            Task { await model.runSync(profile) }
                        } label: {
                            Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(model.syncFolderNames[profile.id] == nil)
                    } header: {
                        Text(profile.name)
                    } footer: {
                        Text(
                            profile.deletionPolicy == "archive"
                                ? "Deleted items move to PocketDock Archive so they can be recovered."
                                : "PocketDock compares SHA-256 checksums before applying changes."
                        )
                    }
                }

                if !model.syncMessage.isEmpty {
                    Section("Status") {
                        Label(model.syncMessage, systemImage: "info.circle")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Sync")
            .toolbar { computerMenu }
            .refreshable { await model.refresh() }
            .fileImporter(
                isPresented: Binding(
                    get: { folderProfile != nil },
                    set: { if !$0 { folderProfile = nil } }
                ),
                allowedContentTypes: [.folder],
                allowsMultipleSelection: false
            ) { result in
                guard let profile = folderProfile else { return }
                switch result {
                case .success(let urls):
                    guard let folder = urls.first else {
                        model.reportEmptyImporterSelection(context: "Folder Sync")
                        folderProfile = nil
                        return
                    }
                    Task { await model.chooseSyncFolder(folder, profile: profile) }
                case .failure(let error):
                    model.reportImporterFailure(error, context: "Folder Sync")
                }
                if folderProfile != nil {
                    folderProfile = nil
                }
            }
        }
    }

    private var clipboardView: some View {
        NavigationStack {
            List {
                connectionSection

                Section {
                    TextEditor(text: $clipboardText)
                        .frame(minHeight: 118)
                        .accessibilityLabel("Text to send to PC")

                    Toggle("Pin on both devices", isOn: $clipboardPinned)
                    Picker("Keep for", selection: $clipboardExpiryMinutes) {
                        Text("Until cleared").tag(0)
                        Text("1 hour").tag(60)
                        Text("1 day").tag(1_440)
                        Text("1 week").tag(10_080)
                    }

                    Button {
                        Task {
                            await model.sendRichClipboard(
                                clipboardText,
                                pinned: clipboardPinned,
                                expiresMinutes: clipboardExpiryMinutes
                            )
                            if model.errorMessage == nil {
                                clipboardText = ""
                                clipboardPinned = false
                            }
                        }
                    } label: {
                        Label("Send to PC Clipboard", systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .listRowBackground(Color.clear)
                    .disabled(
                        clipboardText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )

                    Button {
                        showClipboardFile = true
                    } label: {
                        Label("Send Image or File Handoff", systemImage: "paperclip")
                    }
                } header: {
                    Text("Send to PC")
                } footer: {
                    Text("Pinned entries stay at the top. Expiring entries are removed from the shared history automatically.")
                }

                Section("Recent") {
                    if model.clipboard.isEmpty {
                        ContentUnavailableView(
                            "Clipboard Is Empty",
                            systemImage: "clipboard",
                            description: Text("Text shared from either device appears here.")
                        )
                    } else {
                        ForEach(model.clipboard) { entry in
                            Button {
                                copyToClipboard(entry.content)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: clipboardSymbol(entry.kind))
                                        .foregroundStyle(.tint)
                                        .frame(width: 28)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(entry.content)
                                            .lineLimit(2)
                                            .foregroundStyle(.primary)
                                        Text(entry.sourceDevice)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if entry.pinned == true {
                                        Image(systemName: "pin.fill")
                                            .font(.caption)
                                            .foregroundStyle(.orange)
                                    } else {
                                        Image(systemName: "doc.on.doc")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button {
                                    copyToClipboard(entry.content)
                                } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                                if let url = URL(string: entry.content),
                                   ["http", "https"].contains(url.scheme?.lowercased()) {
                                    Link(destination: url) {
                                        Label("Open Link", systemImage: "safari")
                                    }
                                }
                                Button {
                                    Task { await model.toggleClipboardPin(entry) }
                                } label: {
                                    Label(
                                        entry.pinned == true ? "Unpin" : "Pin",
                                        systemImage: entry.pinned == true ? "pin.slash" : "pin"
                                    )
                                }
                            }
                            .swipeActions(edge: .leading) {
                                Button {
                                    Task { await model.toggleClipboardPin(entry) }
                                } label: {
                                    Label(entry.pinned == true ? "Unpin" : "Pin", systemImage: "pin")
                                }
                                .tint(.orange)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await model.deleteClipboard(entry) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .accessibilityHint("Copies this item")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Clipboard")
            .toolbar { computerMenu }
            .refreshable { await model.refresh() }
            .fileImporter(
                isPresented: $showClipboardFile,
                allowedContentTypes: [.item],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    guard let url = urls.first else {
                        model.reportEmptyImporterSelection(context: "Clipboard")
                        return
                    }
                    Task { await model.sendClipboardAttachment(url) }
                case .failure(let error):
                    model.reportImporterFailure(error, context: "Clipboard")
                }
            }
        }
    }

    @ViewBuilder
    private var connectionSection: some View {
        Section {
            PocketDockConnectionRow(
                state: model.connectionState,
                computerName: model.connection?.pcName ?? "PocketDock PC",
                lastRefreshAt: model.lastRefreshAt
            ) {
                Task { await model.refresh() }
            }
            ForEach(model.optionalFeatureMessages, id: \.self) { message in
                Label(message, systemImage: "lock.trianglebadge.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func transferRow(_ transfer: MobileTransfer) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                PocketDockFileIcon(filename: transfer.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(transfer.name)
                        .lineLimit(1)
                    Text(transfer.error ?? transferStatus(transfer))
                        .font(.caption)
                        .foregroundStyle(transfer.error == nil ? .secondary : .red)
                }
                Spacer()
                if transfer.completed {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .accessibilityLabel("Verified")
                } else if transfer.paused || transfer.error != nil {
                    Button {
                        model.resumeTransfer(transfer.id)
                    } label: {
                        Image(systemName: "play.circle.fill")
                            .font(.title2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Resume transfer")
                } else {
                    Button {
                        model.pauseTransfer(transfer.id)
                    } label: {
                        Image(systemName: "pause.circle")
                            .font(.title2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Pause transfer")
                }
            }
            ProgressView(value: transfer.progress)
                .tint(transfer.error == nil ? .accentColor : .red)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int(transfer.progress * 100)) percent")
    }

    @ToolbarContentBuilder
    private var computerMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section("Computers") {
                    ForEach(model.connections, id: \.id) { computer in
                        Button {
                            Task { await model.select(computer) }
                        } label: {
                            Label(
                                computer.pcName,
                                systemImage: computer.id == model.connection?.id
                                    ? "checkmark.circle.fill"
                                    : "desktopcomputer"
                            )
                        }
                    }
                }
                Button {
                    pairingURL = nil
                    pin = ""
                    showPairing = true
                } label: {
                    Label("Add Computer", systemImage: "plus")
                }
                Button(role: .destructive) {
                    confirmForget = true
                } label: {
                    Label("Forget This Computer", systemImage: "trash")
                }
            } label: {
                Label(
                    model.connection?.pcName ?? "Computer",
                    systemImage: model.connectionState == .connected
                        ? "desktopcomputer.and.macbook"
                        : "exclamationmark.triangle"
                )
            }
            .accessibilityLabel("Connected computer")
            .accessibilityValue(model.connection?.pcName ?? "None")
        }
    }

    private func acceptPairingLink(_ value: String) {
        guard let url = URL(string: value) else {
            model.errorMessage = String(localized: "That QR code is not a PocketDock connection.")
            model.errorFeedback += 1
            return
        }
        pairingURL = url
        pin = pairingCode(in: url)
        showScanner = false
        if model.connection != nil {
            showPairing = true
        }

        if pin.count == 6 {
            Task { await pairSelectedComputer() }
        }
    }

    private func pairingCode(in url: URL) -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return ""
        }
        return components.queryItems?
            .first(where: { $0.name == "code" })?
            .value?
            .filter(\.isNumber) ?? ""
    }

    private func pairSelectedComputer() async {
        guard let pairingURL, pin.count == 6, !isPairing else { return }
        isPairing = true
        defer { isPairing = false }
        await model.pair(url: pairingURL, pin: pin)
        if model.connectionState == .connected {
            showPairing = false
            self.pairingURL = nil
            pin = ""
        }
    }

    private func uploadPhotoItems(_ items: [PhotosPickerItem]) async {
        var urls: [URL] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                let fileExtension = item.supportedContentTypes.first?
                    .preferredFilenameExtension
                let name = UUID().uuidString + (fileExtension.map { ".\($0)" } ?? "")
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                try? data.write(to: url, options: .atomic)
                urls.append(url)
            }
        }
        await model.upload(urls: urls)
        for url in urls {
            try? FileManager.default.removeItem(at: url)
        }
        photoItems = []
    }

    private func copyToClipboard(_ content: String) {
        UIPasteboard.general.string = content
        copyFeedback += 1
    }

    private func transferStatus(_ transfer: MobileTransfer) -> String {
        if transfer.completed { return String(localized: "Verified") }
        if transfer.paused { return String(localized: "Paused · ready to resume") }
        if transfer.progress == 0 { return String(localized: "Preparing…") }
        let speed = ByteCountFormatter.string(
            fromByteCount: Int64(transfer.bytesPerSecond),
            countStyle: .file
        )
        return "\(Int(transfer.progress * 100))% · \(speed)/s"
    }

    private func syncDirection(_ value: String) -> String {
        switch value {
        case "pc-to-iphone": return String(localized: "PC to iPhone")
        case "iphone-to-pc": return String(localized: "iPhone to PC")
        default: return String(localized: "Two-Way")
        }
    }

    private func clipboardSymbol(_ kind: String) -> String {
        switch kind {
        case "url": "link"
        case "image": "photo"
        case "file": "doc"
        default: "text.alignleft"
        }
    }

    private var driveVisibleEntries: [MobileDriveEntry] {
        model.driveSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? model.driveEntries
            : model.driveSearchResults
    }
}
