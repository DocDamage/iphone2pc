import FileProvider

final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    private let directory: URL
    private let root: URL

    init(directory: URL, root: URL) {
        self.directory = directory
        self.root = root
    }

    func invalidate() {}

    func enumerateItems(
        for observer: NSFileProviderEnumerationObserver,
        startingAt page: NSFileProviderPage
    ) {
        do {
            let urls = try FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles]
            )
            let items = try urls.map { try FileProviderItem(url: $0, root: root) }
            observer.didEnumerate(items)
            observer.finishEnumerating(upTo: nil)
        } catch {
            observer.finishEnumeratingWithError(error)
        }
    }
}
