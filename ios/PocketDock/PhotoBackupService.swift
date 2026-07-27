import BackgroundTasks
import Foundation
import Network
import Photos
import UIKit

actor PhotoBackupService {
    private let preferencesKey = "PocketDock.backup-preferences"

    func preferences() -> BackupPreferences {
        guard
            let data = UserDefaults.standard.data(forKey: preferencesKey),
            let preferences = try? JSONDecoder().decode(BackupPreferences.self, from: data)
        else { return BackupPreferences() }
        return preferences
    }

    func savePreferences(_ preferences: BackupPreferences) {
        UserDefaults.standard.set(
            try? JSONEncoder().encode(preferences),
            forKey: preferencesKey
        )
    }

    func schedule() {
        let request = BGProcessingTaskRequest(
            identifier: "com.docdamage.pocketdock.transfer"
        )
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = preferences().pauseOnBattery
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func cancelScheduled() {
        BGTaskScheduler.shared.cancel(
            taskRequestWithIdentifier: "com.docdamage.pocketdock.transfer"
        )
    }

    func backUpNewAssets(
        connectionId: UUID,
        client: PocketDockClient,
        progress: @escaping @Sendable (BackupProgress) -> Void
    ) async throws {
        let preferences = preferences()
        guard preferences.enabled else {
            throw PocketDockError.server("Automatic Camera Roll backup is disabled.")
        }
        try await checkConditions(preferences)
        let schedule = try await client.backupSchedule()
        guard schedule.allowedNow else {
            throw PocketDockError.server(
                "Automatic backup is waiting for the PC schedule (\(schedule.start)–\(schedule.end))."
            )
        }
        let authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard authorization == .authorized || authorization == .limited else {
            throw PocketDockError.server("Photo Library access was not granted.")
        }

        let lastDateKey = "PocketDock.last-photo-backup.\(connectionId.uuidString)"
        let lastDate = UserDefaults.standard.object(forKey: lastDateKey) as? Date
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        var predicates: [NSPredicate] = []
        if let lastDate {
            predicates.append(NSPredicate(format: "creationDate > %@", lastDate as NSDate))
        }
        if preferences.favoritesOnly {
            predicates.append(NSPredicate(format: "favorite == YES"))
        }
        if !predicates.isEmpty {
            options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        }
        let assets = PHAsset.fetchAssets(with: options)
        var selected: [PHAsset] = []
        assets.enumerateObjects { asset, _, _ in
            if asset.mediaType == .image || (preferences.includeVideos && asset.mediaType == .video) {
                selected.append(asset)
            }
        }
        var state = BackupProgress(
            total: selected.count,
            completed: 0,
            currentName: "",
            running: true,
            message: selected.isEmpty ? "Everything is backed up" : "Preparing Camera Roll"
        )
        progress(state)
        var newestDate = lastDate

        for asset in selected {
            try Task.checkCancellation()
            try await checkConditions(preferences)
            let activeSchedule = try await client.backupSchedule()
            guard activeSchedule.allowedNow else {
                throw PocketDockError.server(
                    "Automatic backup paused at the end of the PC backup window."
                )
            }
            let resources = PHAssetResource.assetResources(for: asset).filter { resource in
                switch resource.type {
                case .photo, .fullSizePhoto, .alternatePhoto:
                    return asset.mediaType == .image
                case .video, .fullSizeVideo:
                    return asset.mediaType == .video
                case .pairedVideo:
                    return preferences.includeLivePhotoVideo
                default:
                    return false
                }
            }
            for resource in resources {
                state.currentName = resource.originalFilename
                state.message = "Encrypting \(resource.originalFilename)"
                progress(state)
                let resourceName = resource.originalFilename
                let progressState = state
                let temporary = FileManager.default.temporaryDirectory
                    .appendingPathComponent(
                        "\(UUID().uuidString)-\(resourceName)"
                    )
                defer { try? FileManager.default.removeItem(at: temporary) }
                try await write(resource: resource, to: temporary)
                try await client.upload(fileURL: temporary) { fraction, _ in
                    var update = progressState
                    update.message = "\(Int(fraction * 100))% · \(resourceName)"
                    progress(update)
                }
            }
            state.completed += 1
            progress(state)
            if let creationDate = asset.creationDate,
               newestDate == nil || creationDate > newestDate! {
                newestDate = creationDate
            }
        }
        if let newestDate {
            UserDefaults.standard.set(newestDate, forKey: lastDateKey)
        }
        state.running = false
        state.message = selected.isEmpty
            ? "Camera Roll is already backed up"
            : "\(state.completed) new items backed up and verified"
        progress(state)
        schedule()
    }

    private func write(resource: PHAssetResource, to destination: URL) async throws {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { continuation in
            PHAssetResourceManager.default().writeData(
                for: resource,
                toFile: destination,
                options: options
            ) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func checkConditions(_ preferences: BackupPreferences) async throws {
        if ProcessInfo.processInfo.thermalState == .serious ||
            ProcessInfo.processInfo.thermalState == .critical {
            throw PocketDockError.server(
                "Automatic backup paused because the iPhone is too warm."
            )
        }
        UIDevice.current.isBatteryMonitoringEnabled = true
        if preferences.pauseOnBattery,
           UIDevice.current.batteryState == .unplugged {
            throw PocketDockError.server(
                "Automatic backup is waiting until the iPhone is charging."
            )
        }
        let network = await currentNetworkState()
        guard network.connected else {
            throw PocketDockError.server("Automatic backup is waiting for a network.")
        }
        if preferences.pauseOnConstrainedNetwork && (network.expensive || network.constrained) {
            throw PocketDockError.server(
                "Automatic backup is paused on this cellular or constrained network."
            )
        }
    }

    private func currentNetworkState() async -> (
        connected: Bool,
        expensive: Bool,
        constrained: Bool
    ) {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            let queue = DispatchQueue(label: "PocketDock.backup-network")
            monitor.pathUpdateHandler = { path in
                continuation.resume(returning: (
                    path.status == .satisfied,
                    path.isExpensive,
                    path.isConstrained
                ))
                monitor.cancel()
            }
            monitor.start(queue: queue)
        }
    }
}
