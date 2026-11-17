import Foundation

/// 一集一次、用户点一下下一个文件。
///
/// 三条边界写在代码里，而不是只在文档里：
/// 1. 同时只有一个任务 —— 再来一集先取消旧的，不做队列、不做批量抓取；
/// 2. 只接受 https 直链（调用方已用 `WebViewController.shareableURL` 校验过一次）；
/// 3. 落盘到沙盒 Documents/Downloads，用户可见、可取消、可自己清理。
final class MediaDownloader: NSObject {
    enum Failure: Error {
        case cancelled
        case http(Int)
        case network(String)
        case disk(String)

        var message: String {
            switch self {
            case .cancelled: return "已取消"
            case .http(let code): return "片源服务器返回 \(code)"
            case .network(let text): return text.isEmpty ? "网络中断" : text
            case .disk(let text): return text.isEmpty ? "写不进本机存储" : text
            }
        }
    }

    struct Job {
        let id: String
        let name: String
        let url: URL
    }

    private var session: URLSession?
    private var task: URLSessionDownloadTask?
    private var job: Job?
    private var progress: ((Int64, Int64) -> Void)?
    private var finish: ((Result<[String: Any], Failure>) -> Void)?
    /// `didFinishDownloadingTo` 先到、`didCompleteWithError` 后到：结果在这里交接。
    private var moved: [String: Any]?

    var isBusy: Bool { task != nil }

    /// 文件名清洗：只留文件名本身，路径分隔符、控制字符一律换掉，并补上视频扩展名。
    ///
    /// 只有当地址最后一段**真的带视频扩展名**时才用它 ——
    /// 否则 `.../play/19` 会变成 `19.mp4`，把网页给的集名丢掉；
    /// `.m3u8` 这类清单也不能冒充成视频文件。
    static func fileName(from raw: String?, fallback: String) -> String {
        let videoExtensions = [".mp4", ".m4v", ".mov", ".mkv", ".ts"]
        var name = fallback
        if let raw = raw, let parsed = URL(string: raw) {
            let last = parsed.lastPathComponent
            if !last.isEmpty, videoExtensions.contains(where: { last.lowercased().hasSuffix($0) }) {
                name = last
            }
        }
        let banned = CharacterSet(charactersIn: "/\\:*?\"<>|")
            .union(.controlCharacters)
            .union(.newlines)
        name = name.components(separatedBy: banned).joined(separator: "_")
        if !videoExtensions.contains(where: { name.lowercased().hasSuffix($0) }) { name += ".mp4" }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // 只剩一个扩展名（".mp4"）就是隐藏文件，退回固定名字
        if trimmed.isEmpty || trimmed.hasPrefix(".") { return "video.mp4" }
        return String(trimmed.prefix(120))
    }

    static func directory() -> URL? {
        guard let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        return base.appendingPathComponent("Downloads", isDirectory: true)
    }

    func start(
        id: String,
        url: URL,
        name: String,
        onProgress: @escaping (Int64, Int64) -> Void,
        onFinish: @escaping (Result<[String: Any], Failure>) -> Void
    ) {
        cancel(silent: true)
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.waitsForConnectivity = true
        let queue = OperationQueue.main
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        let task = session.downloadTask(with: url)
        self.session = session
        self.task = task
        self.job = Job(id: id, name: name, url: url)
        self.progress = onProgress
        self.finish = onFinish
        self.moved = nil
        task.resume()
    }

    func cancel(silent: Bool = false) {
        guard let running = task else { return }
        running.cancel()
        if !silent { finish?(.failure(.cancelled)) }
        cleanup()
    }

    private func cleanup() {
        session?.invalidateAndCancel()
        session = nil
        task = nil
        job = nil
        progress = nil
        finish = nil
        moved = nil
    }
}

extension MediaDownloader: URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        progress?(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let job = job else { return }
        if let response = downloadTask.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
            moved = nil
            finish?(.failure(.http(response.statusCode)))
            cleanup()
            return
        }
        guard let directory = Self.directory() else {
            finish?(.failure(.disk("找不到本机存储目录")))
            cleanup()
            return
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = directory.appendingPathComponent(job.name)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: location, to: target)
            var size: Int64 = 0
            if let attributes = try? FileManager.default.attributesOfItem(atPath: target.path),
               let number = attributes[.size] as? NSNumber {
                size = number.int64Value
            }
            moved = ["path": target.path, "name": job.name, "size": size]
        } catch {
            finish?(.failure(.disk(error.localizedDescription)))
            cleanup()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as NSError? {
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
                finish?(.failure(.cancelled))
            } else {
                finish?(.failure(.network(error.localizedDescription)))
            }
            cleanup()
            return
        }
        if let moved = moved {
            finish?(.success(moved))
        }
        cleanup()
    }
}
