import FileProvider
import UniformTypeIdentifiers

final class FileProviderItem: NSObject, NSFileProviderItem {
    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    let typeIdentifier: String
    let documentSize: NSNumber?
    let contentModificationDate: Date?
    let capabilities: NSFileProviderItemCapabilities
    let itemVersion: NSFileProviderItemVersion

    init(url: URL, root: URL) throws {
        let values = try url.resourceValues(forKeys: [
            .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .contentAccessDateKey
        ])
        let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
        itemIdentifier = NSFileProviderItemIdentifier(relative)
        let parent = url.deletingLastPathComponent()
        parentItemIdentifier = parent == root ? .rootContainer
            : NSFileProviderItemIdentifier(parent.path.replacingOccurrences(of: root.path + "/", with: ""))
        filename = url.lastPathComponent
        if values.isDirectory == true {
            typeIdentifier = UTType.folder.identifier
            capabilities = [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems,
                            .allowsRenaming, .allowsReparenting, .allowsDeleting]
            documentSize = nil
        } else {
            typeIdentifier = UTType(filenameExtension: url.pathExtension)?.identifier ?? UTType.data.identifier
            capabilities = [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting]
            documentSize = NSNumber(value: values.fileSize ?? 0)
        }
        contentModificationDate = values.contentModificationDate
        let stamp = UInt64(max(0, contentModificationDate?.timeIntervalSince1970 ?? 0)).bigEndian
        let size = UInt64(max(0, values.fileSize ?? 0)).bigEndian
        itemVersion = NSFileProviderItemVersion(
            contentVersion: withUnsafeBytes(of: stamp) { Data($0) } + withUnsafeBytes(of: size) { Data($0) },
            metadataVersion: withUnsafeBytes(of: stamp) { Data($0) }
        )
        super.init()
    }
}
