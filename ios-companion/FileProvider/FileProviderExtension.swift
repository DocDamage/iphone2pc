import FileProvider

final class FileProviderExtension: NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain
    private let root: URL

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.idrivepulse.companion"
        ) else { fatalError("The iDrivePulse app group is unavailable.") }
        root = container.appendingPathComponent("File Provider", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        super.init(domain: domain)
    }

    override func invalidate() {}

    private func url(for identifier: NSFileProviderItemIdentifier) throws -> URL {
        if identifier == .rootContainer { return root }
        let candidate = root.appendingPathComponent(identifier.rawValue).standardizedFileURL
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else {
            throw NSFileProviderError(.noSuchItem)
        }
        return candidate
    }

    override func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        do {
            if identifier == .rootContainer {
                completionHandler(RootProviderItem(), nil)
            } else {
                completionHandler(try FileProviderItem(url: url(for: identifier), root: root), nil)
            }
        } catch { completionHandler(nil, error) }
        progress.completedUnitCount = 1
        return progress
    }

    override func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        do {
            let source = try url(for: itemIdentifier)
            completionHandler(source, try FileProviderItem(url: source, root: root), nil)
        } catch { completionHandler(nil, nil, error) }
        progress.completedUnitCount = 1
        return progress
    }

    override func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        do {
            let parent = try self.url(for: itemTemplate.parentItemIdentifier)
            let destination = parent.appendingPathComponent(itemTemplate.filename)
            if itemTemplate.contentType == .folder {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
            } else if let url {
                try FileManager.default.copyItem(at: url, to: destination)
            } else {
                FileManager.default.createFile(atPath: destination.path, contents: Data())
            }
            completionHandler(try FileProviderItem(url: destination, root: root), [], false, nil)
            signal(itemTemplate.parentItemIdentifier)
        } catch { completionHandler(nil, [], false, error) }
        progress.completedUnitCount = 1
        return progress
    }

    override func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion version: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options: NSFileProviderModifyItemOptions,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        do {
            var destination = try url(for: item.itemIdentifier)
            if changedFields.contains(.filename) {
                let renamed = destination.deletingLastPathComponent().appendingPathComponent(item.filename)
                try FileManager.default.moveItem(at: destination, to: renamed)
                destination = renamed
            }
            if let newContents {
                let staged = destination.appendingPathExtension("idrivepulse-new")
                try? FileManager.default.removeItem(at: staged)
                try FileManager.default.copyItem(at: newContents, to: staged)
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: staged)
            }
            completionHandler(try FileProviderItem(url: destination, root: root), [], false, nil)
            signal(item.parentItemIdentifier)
        } catch { completionHandler(nil, [], false, error) }
        progress.completedUnitCount = 1
        return progress
    }

    override func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions,
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        do {
            let target = try url(for: identifier)
            let parent = try FileProviderItem(url: target, root: root).parentItemIdentifier
            try FileManager.default.removeItem(at: target)
            completionHandler(nil)
            signal(parent)
        } catch { completionHandler(error) }
        progress.completedUnitCount = 1
        return progress
    }

    override func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
        FileProviderEnumerator(directory: try url(for: containerItemIdentifier), root: root)
    }

    private func signal(_ identifier: NSFileProviderItemIdentifier) {
        NSFileProviderManager(for: domain)?.signalEnumerator(for: identifier) { _ in }
    }
}

private final class RootProviderItem: NSObject, NSFileProviderItem {
    let itemIdentifier = NSFileProviderItemIdentifier.rootContainer
    let parentItemIdentifier = NSFileProviderItemIdentifier.rootContainer
    let filename = "iDrivePulse"
    let typeIdentifier = "public.folder"
    let capabilities: NSFileProviderItemCapabilities = [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems]
}
