import Foundation
import UIKit

struct BackgroundHTTPResponse: @unchecked Sendable {
    let data: Data
    let response: HTTPURLResponse
    let fileURL: URL?
}

final class BackgroundTransferSession: NSObject, @unchecked Sendable, URLSessionDelegate, URLSessionTaskDelegate,
    URLSessionDataDelegate, URLSessionDownloadDelegate {
    static let shared = BackgroundTransferSession()
    nonisolated(unsafe) static var backgroundCompletionHandler: (() -> Void)?

    private var continuations: [Int: CheckedContinuation<BackgroundHTTPResponse, Error>] = [:]
    private var buffers: [Int: Data] = [:]
    private var responses: [Int: HTTPURLResponse] = [:]
    private var downloadedFiles: [Int: URL] = [:]
    private let lock = NSLock()

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(
            withIdentifier: "com.docdamage.pocketdock.background-transfer"
        )
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func upload(request: URLRequest, fromFile fileURL: URL) async throws -> BackgroundHTTPResponse {
        let task = session.uploadTask(with: request, fromFile: fileURL)
        task.taskDescription = "PocketDock protected upload chunk"
        return try await wait(for: task)
    }

    func download(request: URLRequest) async throws -> BackgroundHTTPResponse {
        let task = session.downloadTask(with: request)
        task.taskDescription = "PocketDock protected download chunk"
        return try await wait(for: task)
    }

    private func wait(for task: URLSessionTask) async throws -> BackgroundHTTPResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                continuations[task.taskIdentifier] = continuation
                buffers[task.taskIdentifier] = Data()
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func activate() {
        _ = session
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        if let response = response as? HTTPURLResponse {
            lock.lock()
            responses[dataTask.taskIdentifier] = response
            lock.unlock()
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffers[dataTask.taskIdentifier, default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("PocketDock-\(UUID().uuidString).download")
        try? FileManager.default.moveItem(at: location, to: destination)
        lock.lock()
        downloadedFiles[downloadTask.taskIdentifier] = destination
        if let response = downloadTask.response as? HTTPURLResponse {
            responses[downloadTask.taskIdentifier] = response
        }
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        let continuation = continuations.removeValue(forKey: task.taskIdentifier)
        let data = buffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        let response = responses.removeValue(forKey: task.taskIdentifier)
        let fileURL = downloadedFiles.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let continuation else {
            if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
            return
        }
        if let error {
            continuation.resume(throwing: error)
        } else if let response {
            continuation.resume(returning: BackgroundHTTPResponse(
                data: data,
                response: response,
                fileURL: fileURL
            ))
        } else {
            continuation.resume(throwing: PocketDockError.server("The background transfer returned no response."))
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            Self.backgroundCompletionHandler?()
            Self.backgroundCompletionHandler = nil
        }
    }
}

final class PocketDockAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        BackgroundTransferSession.shared.activate()
        BackgroundTransferSession.backgroundCompletionHandler = completionHandler
    }
}
