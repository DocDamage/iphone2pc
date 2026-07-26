import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var library: PortableLibrary
    @EnvironmentObject private var wireless: WirelessTransfer
    @State private var importing = false
    @State private var pendingDelete: PortableLibrary.Item?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(library.message, systemImage: "checkmark.shield.fill")
                        .foregroundStyle(.secondary)
                }
                Section("Portable Files") {
                    if library.items.isEmpty {
                        ContentUnavailableView(
                            "No Portable Files", systemImage: "externaldrive",
                            description: Text("Import beats, stems, projects, archives, or any other files.")
                        )
                    }
                    ForEach(library.items) { item in
                        HStack(spacing: 12) {
                            Image(systemName: icon(for: item.url.pathExtension))
                                .font(.title2).foregroundStyle(.cyan)
                            VStack(alignment: .leading) {
                                Text(item.name).lineLimit(2)
                                Text(ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Menu {
                                ShareLink(item: item.url) { Label("Export anywhere", systemImage: "square.and.arrow.up") }
                                Button { library.publishToFiles(item) } label: { Label("Publish in Files", systemImage: "folder") }
                                if wireless.paired {
                                    Button { Task { await wireless.upload(item.url) } } label: { Label("Send to PC", systemImage: "desktopcomputer") }
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                        .swipeActions {
                            Button(role: .destructive) { pendingDelete = item } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
                Section("USB access") {
                    Text("When connected to a trusted PC, iDrivePulse can open this folder through Apple’s app-document service. Files remain inside this app’s sandbox and are also visible in the iPhone Files app.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Secure wireless PC") {
                    TextField("https://PC-address:8766", text: $wireless.endpoint)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                    SecureField("6-digit pairing code", text: $wireless.pairingCode)
                        .keyboardType(.numberPad)
                    TextField("Certificate SHA-256", text: $wireless.certificateFingerprint)
                        .textInputAutocapitalization(.never).font(.caption.monospaced())
                    HStack {
                        Button(wireless.paired ? "Re-pair" : "Pair") { Task { await wireless.pair() } }
                        if wireless.paired {
                            Button("Refresh") { Task { await wireless.refresh() } }
                            Button("Forget", role: .destructive) { wireless.forget() }
                        }
                    }
                    Text(wireless.message).font(.footnote).foregroundStyle(.secondary)
                    ForEach(wireless.files) { file in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(file.name).lineLimit(1)
                                Text(ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                Task {
                                    if let data = await wireless.download(file) { library.storeDownloaded(data, named: file.name) }
                                }
                            } label: { Image(systemName: "arrow.down.circle") }
                        }
                    }
                }
            }
            .navigationTitle("iDrivePulse")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { Task { await library.writeIntegrityManifest() } } label: { Image(systemName: "number") }
                        .accessibilityLabel("Create checksum manifest")
                    Button { importing = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Import files")
                }
            }
            .refreshable { library.refresh() }
            .task { await FileProviderSetup.register() }
            .fileImporter(
                isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true
            ) { result in
                if case .success(let urls) = result { library.importFiles(urls) }
                if case .failure(let error) = result { library.message = error.localizedDescription }
            }
            .confirmationDialog(
                "Delete this file?", isPresented: Binding(
                    get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
                ), titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let item = pendingDelete { library.delete(item) }
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            }
        }
    }

    private func icon(for extensionName: String) -> String {
        switch extensionName.lowercased() {
        case "wav", "aif", "aiff", "mp3", "m4a", "flac", "caf": return "waveform"
        case "zip", "7z", "rar": return "archivebox"
        case "mid", "midi": return "pianokeys"
        default: return "doc.fill"
        }
    }
}
