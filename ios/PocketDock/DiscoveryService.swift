import Foundation
import Network

final class DiscoveryService: @unchecked Sendable {
    var onChange: (([DiscoveredDock]) -> Void)?
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "PocketDock.discovery")
    private var resolved: [String: DiscoveredDock] = [:]
    private var probes: [String: NWConnection] = [:]

    func start() {
        let browser = NWBrowser(for: .bonjour(type: "_pocketdock._tcp", domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            let active = Set(results.compactMap { result -> String? in
                guard case let .service(name, _, _, _) = result.endpoint else { return nil }
                self.resolve(endpoint: result.endpoint, serviceName: name)
                return name
            })
            for key in self.resolved.keys where !active.contains(self.resolved[key]?.name ?? "") {
                self.resolved.removeValue(forKey: key)
            }
            self.publish()
        }
        browser.start(queue: queue)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        probes.values.forEach { $0.cancel() }
        probes.removeAll()
        resolved.removeAll()
        browser = nil
    }

    private func resolve(endpoint: NWEndpoint, serviceName: String) {
        guard probes[serviceName] == nil else { return }
        let connection = NWConnection(to: endpoint, using: .tcp)
        probes[serviceName] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard
                    let remote = connection?.currentPath?.remoteEndpoint,
                    case let .hostPort(host, port) = remote
                else {
                    connection?.cancel()
                    self.probes.removeValue(forKey: serviceName)
                    return
                }
                let hostText = "\(host)"
                let item = DiscoveredDock(
                    id: "\(serviceName)|\(hostText)|\(port.rawValue)",
                    name: serviceName,
                    host: hostText,
                    port: Int(port.rawValue)
                )
                self.resolved[item.id] = item
                self.publish()
                connection?.cancel()
                self.probes.removeValue(forKey: serviceName)
            case .failed, .cancelled:
                self.probes.removeValue(forKey: serviceName)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func publish() {
        let docks = resolved.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        DispatchQueue.main.async { [weak self] in self?.onChange?(docks) }
    }
}
