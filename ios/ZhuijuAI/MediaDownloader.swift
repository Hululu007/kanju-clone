import Foundation
import UserNotifications

/// 一集一次、用户点一下下一个文件。
///
/// 三条边界写在代码里，而不是只在文档里：
/// 1. 同时只有一个任务 —— 再来一集先取消旧的，不做队列、不做批量抓取；
/// 2. 只接受 https 直链（调用方已用 `WebViewController.shareableURL` 校验过一次）；
/// 3. 落盘到沙盒 Documents/Downloads，用户可见、可取消、可自己清理。
///
/// 0.1.12 起改用后台会话（background URLSession）：
/// - 切到别的 App、锁屏时系统会继续传（由系统调度，不占前台执行时间）；
/// - 任务和最新进度落在 UserDefaults，进程被回收后重新拉起也能找回；
/// - 完成/失败会重放给网页，网页侧从 localStorage 恢复的进度条能对上；
/// - 完成时发一条本地通知（没授权就不发，下载本身不受影响）。
///
/// 一个进程只允许一个后台会话、一个标识，所以状态全部是类级的：
/// 任何时候 `MediaDownloader()` 拿到的都是同一个下载器。
///
/// 明确不能保证的：用户在后台把 App 强制退出（上滑清掉）时系统会停掉会话，
/// 这种情况会如实标记为「下载被系统中断」，不会假装完成。
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

    /// 一个下载任务在磁盘上的记录：进程被回收后靠它把状态接回来。
    struct Record: Codable {
        var id: String
        var url: String
        var name: String
        var title: String
        var ep: String
        var meta: [String: String]
        var received: Int64
        var total: Int64
        /// running / done / failed / cancelled
        var status: String
        var path: String
        var size: Int64
        var reason: String
        /// 终态是否已经交给过网页（progress 不算终态，每次都可以重发）
        var delivered: Bool
        var taskIdentifier: Int
        var updatedAt: Double
    }

    /// 后台会话的标识：App 被重新拉起时系统就是用它把回调交回来的，不能改。
    static let backgroundIdentifier = "org.dpdns.zhuiju.ios.downloads"
    static let tasksKey = "kj-ios-download-tasks"
    static let notifyAskedKey = "kj-ios-notify-asked"
    /// 进程里唯一的那份下载器：后台回调可能早于界面创建，必须共用同一套状态。
    static let shared = MediaDownloader()
    /// 系统在 `handleEventsForBackgroundURLSession` 里给的收尾回调。
    static var backgroundCompletion: (() -> Void)?

    private static var sessionStorage: URLSession?
    private static var records: [Record] = []
    private static var progressHandlers: [String: (Int64, Int64) -> Void] = [:]
    private static var finishHandlers: [String: (Result<[String: Any], Failure>) -> Void] = [:]
    private static var activeId: String?
    private static var activeTask: URLSessionDownloadTask?
    private static var finishedTasks: Set<Int> = []
    private static var movedFiles: [Int: [String: Any]] = [:]
    private static var lastPersistAt: TimeInterval = 0

    var isBusy: Bool { Self.activeId != nil }

    /// 给回归测试看的只读信息：确认这是后台会话、标识没改名。
    var sessionConfiguration: URLSessionConfiguration { Self.sessionInstance().configuration }

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

    // MARK: - 对外（实例方法都落到同一份状态上）

    func start(
        id: String,
        url: URL,
        name: String,
        meta: [String: Any]? = nil,
        onProgress: @escaping (Int64, Int64) -> Void,
        onFinish: @escaping (Result<[String: Any], Failure>) -> Void
    ) {
        Self.begin(id: id, url: url, name: name, meta: meta, onProgress: onProgress, onFinish: onFinish)
    }

    func cancel(silent: Bool = false) {
        Self.stop(silent: silent)
    }

    func restore(completion: (() -> Void)? = nil) {
        Self.reconcile(completion: completion)
    }

    func eventsForPage() -> [[String: Any]] {
        Self.pageEvents()
    }

    func handleBackgroundEvents(completion: @escaping () -> Void) {
        Self.adoptBackgroundEvents(completion: completion)
    }

    // MARK: - 会话

    private static func sessionInstance() -> URLSession {
        if let existing = sessionStorage { return existing }
        let configuration = URLSessionConfiguration.background(withIdentifier: backgroundIdentifier)
        /* 不交给系统随意调度：用户点完就在等这一集，能连就马上传。 */
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.waitsForConnectivity = true
        let created = URLSession(configuration: configuration, delegate: shared, delegateQueue: OperationQueue.main)
        sessionStorage = created
        return created
    }

    private static func begin(
        id: String,
        url: URL,
        name: String,
        meta: [String: Any]?,
        onProgress: @escaping (Int64, Int64) -> Void,
        onFinish: @escaping (Result<[String: Any], Failure>) -> Void
    ) {
        stop(silent: true)
        var flat: [String: String] = [:]
        for (key, value) in meta ?? [:] {
            if let text = value as? String { flat[key] = text }
            else if let number = value as? NSNumber { flat[key] = number.stringValue }
        }
        let record = Record(
            id: id,
            url: url.absoluteString,
            name: name,
            title: flat["title"] ?? "",
            ep: flat["epLabel"] ?? "",
            meta: flat,
            received: 0,
            total: 0,
            status: "running",
            path: "",
            size: 0,
            reason: "",
            delivered: false,
            taskIdentifier: 0,
            updatedAt: Date().timeIntervalSince1970
        )
        upsert(record)
        activeId = id
        progressHandlers[id] = onProgress
        finishHandlers[id] = onFinish
        requestNotificationPermissionOnce()

        let task = sessionInstance().downloadTask(with: url)
        task.taskDescription = id
        activeTask = task
        update(id) { $0.taskIdentifier = task.taskIdentifier }
        task.resume()
    }

    private static func stop(silent: Bool) {
        guard let id = activeId else { return }
        activeId = nil
        activeTask?.cancel()
        activeTask = nil
        let handler = finishHandlers.removeValue(forKey: id)
        progressHandlers.removeValue(forKey: id)
        update(id) { record in
            /* 已经落盘的完成态不能被一次取消改回 cancelled */
            guard record.status == "running" else { return }
            record.status = "cancelled"
            record.reason = "已取消"
            record.received = 0
        }
        if !silent { handler?(.failure(.cancelled)) }
    }

    /// 重新接上后台会话：App 被系统重新拉起时，这里把上一个进程留下的任务找回来。
    private static func reconcile(completion: (() -> Void)?) {
        let activeSession = sessionInstance()
        activeSession.getAllTasks { tasks in
            let alive = Set(tasks.compactMap { $0.taskDescription })
            var changed = false
            var list = loadRecords()
            for index in list.indices where list[index].status == "running" {
                if alive.contains(list[index].id) { continue }
                /* 系统没给完成回调、任务也不在了：如实标失败，不许假装完成。 */
                list[index].status = "failed"
                list[index].reason = "下载被系统中断（App 被强制退出或任务被清理）"
                list[index].delivered = false
                changed = true
            }
            records = list
            activeId = list.last(where: { $0.status == "running" })?.id
            if changed { persist(force: true) }
            completion?()
        }
    }

    /// 交给网页的事件：终态只交一次，进度每次都可以重发。
    private static func pageEvents() -> [[String: Any]] {
        records = loadRecords()
        var events: [[String: Any]] = []
        var needsSave = false
        for record in records {
            if record.status == "running" {
                events.append(["event": "progress", "id": record.id, "received": record.received, "total": record.total])
                continue
            }
            if record.delivered { continue }
            switch record.status {
            case "done":
                events.append(["event": "done", "id": record.id, "path": record.path, "name": record.name, "size": record.size])
            case "cancelled":
                events.append(["event": "cancelled", "id": record.id])
            case "failed":
                events.append(["event": "failed", "id": record.id, "reason": record.reason])
            default:
                continue
            }
            needsSave = true
        }
        if needsSave {
            for index in records.indices where records[index].status != "running" {
                records[index].delivered = true
            }
            persist(force: true)
        }
        return events
    }

    /// 后台回调收尾：会话已重建、状态已对账后再告诉系统，别提前收尾。
    private static func adoptBackgroundEvents(completion: @escaping () -> Void) {
        backgroundCompletion = completion
        reconcile(completion: {
            sessionInstance().getAllTasks { tasks in
                guard tasks.isEmpty else { return }
                if let pending = backgroundCompletion {
                    backgroundCompletion = nil
                    pending()
                }
            }
        })
    }

    // MARK: - 记录读写

    private static func loadRecords() -> [Record] {
        guard let data = UserDefaults.standard.data(forKey: tasksKey) else { return [] }
        return (try? JSONDecoder().decode([Record].self, from: data)) ?? []
    }

    private static func persist(force: Bool) {
        let now = Date().timeIntervalSince1970
        if !force && now - lastPersistAt < 1 { return }
        lastPersistAt = now
        /* 只留最近几条：真正的长期下载史在网页侧的片库里。 */
        let trimmed = Array(records.suffix(6))
        if let data = try? JSONEncoder().encode(trimmed) {
            UserDefaults.standard.set(data, forKey: tasksKey)
        }
    }

    private static func upsert(_ record: Record) {
        if let index = records.firstIndex(where: { $0.id == record.id }) {
            records[index] = record
        } else {
            records.append(record)
        }
        persist(force: true)
    }

    private static func update(_ id: String, force: Bool = true, _ mutate: (inout Record) -> Void) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        mutate(&records[index])
        records[index].updatedAt = Date().timeIntervalSince1970
        persist(force: force)
    }

    private static func record(_ id: String) -> Record? {
        records.first(where: { $0.id == id })
    }

    // MARK: - 通知

    private static func requestNotificationPermissionOnce() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: notifyAskedKey) else { return }
        defaults.set(true, forKey: notifyAskedKey)
        /* 授权是锦上添花：用户拒绝也不影响下载，所以结果直接忽略。 */
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private static func notifyFinished(_ record: Record) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = "下载完成"
            content.body = record.title.isEmpty ? record.name : "\(record.title) · \(record.ep.isEmpty ? record.name : record.ep)"
            center.add(UNNotificationRequest(identifier: record.id, content: content, trigger: nil))
        }
    }

    // MARK: - 收尾

    private static func complete(id: String, payload: [String: Any]) {
        update(id) { record in
            record.status = "done"
            record.path = payload["path"] as? String ?? ""
            record.size = (payload["size"] as? NSNumber)?.int64Value ?? 0
            record.received = record.size
            record.total = max(record.total, record.size)
            record.delivered = false
        }
        if let finished = record(id) { notifyFinished(finished) }
        activeId = nil
        activeTask = nil
        let handler = finishHandlers.removeValue(forKey: id)
        progressHandlers.removeValue(forKey: id)
        handler?(.success(payload))
    }

    private static func fail(id: String, failure: Failure) {
        update(id) { record in
            record.status = failure.isCancellation ? "cancelled" : "failed"
            record.reason = failure.message
            record.delivered = false
        }
        activeId = nil
        activeTask = nil
        let handler = finishHandlers.removeValue(forKey: id)
        progressHandlers.removeValue(forKey: id)
        handler?(.failure(failure))
    }
}

private extension MediaDownloader.Failure {
    var isCancellation: Bool {
        if case .cancelled = self { return true }
        return false
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
        guard let id = downloadTask.taskDescription else { return }
        Self.update(id, force: false) { record in
            record.status = "running"
            record.received = totalBytesWritten
            record.total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : record.total
        }
        Self.progressHandlers[id]?(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        guard Self.record(id)?.status == "running" else { return }
        if let response = downloadTask.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
            Self.fail(id: id, failure: .http(response.statusCode))
            return
        }
        guard let name = Self.record(id)?.name, let directory = Self.directory() else {
            Self.fail(id: id, failure: .disk("找不到本机存储目录"))
            return
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: location, to: target)
            var size: Int64 = 0
            if let attributes = try? FileManager.default.attributesOfItem(atPath: target.path),
               let number = attributes[.size] as? NSNumber {
                size = number.int64Value
            }
            Self.movedFiles[downloadTask.taskIdentifier] = ["path": target.path, "name": name, "size": size]
        } catch {
            Self.fail(id: id, failure: .disk(error.localizedDescription))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        /* 同一条任务可能被重复回调（完成 + 取消 + 重连）：只认第一次终态。 */
        guard !Self.finishedTasks.contains(task.taskIdentifier) else { return }
        Self.finishedTasks.insert(task.taskIdentifier)
        guard Self.record(id)?.status == "running" else { return }
        if let error = error as NSError? {
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
                Self.fail(id: id, failure: .cancelled)
            } else {
                Self.fail(id: id, failure: .network(error.localizedDescription))
            }
            return
        }
        if let payload = Self.movedFiles[task.taskIdentifier] {
            Self.movedFiles[task.taskIdentifier] = nil
            Self.complete(id: id, payload: payload)
        } else {
            Self.fail(id: id, failure: .network("下载没有拿到文件"))
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let completion = Self.backgroundCompletion else { return }
        Self.backgroundCompletion = nil
        completion()
    }
}
