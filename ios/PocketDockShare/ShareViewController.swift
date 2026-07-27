import Social
import UniformTypeIdentifiers

final class ShareViewController: SLComposeServiceViewController {
    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        let group = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.docdamage.pocketdock"
        )
        let providers = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap(\.attachments) ?? []

        Task {
            var paths: [String] = []
            if !contentText.isEmpty, let group {
                let textURL = group.appendingPathComponent("Shared-\(UUID().uuidString).txt")
                if let data = contentText.data(using: .utf8) {
                    try? data.write(to: textURL)
                    paths.append(textURL.path)
                }
            }
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.item.identifier) {
                if let url = try? await provider.loadItem(forTypeIdentifier: UTType.item.identifier) as? URL,
                   let group {
                    let destination = group.appendingPathComponent(
                        "\(UUID().uuidString)-\(url.lastPathComponent)"
                    )
                    if (try? FileManager.default.copyItem(at: url, to: destination)) != nil {
                        paths.append(destination.path)
                    }
                }
            }
            UserDefaults(suiteName: "group.com.docdamage.pocketdock")?
                .set(paths, forKey: "pendingSharePaths")
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }

    override func configurationItems() -> [Any]! { [] }
}
