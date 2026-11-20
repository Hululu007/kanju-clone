import Foundation
import UserNotifications

/// 持久下载队列：单集和批量走同一条队列。
///
/// 边界写在代码里，而不是只在文档里：
/// 1. 全队列最多同时跑 `maxConcurrent`（2）条，其余排队等空位；
/// 2. 同一部剧的同一集（showId + 集标识）在排队/下载/暂停时不会重复入队；
/// 3. 任务、进度、暂停用的 resumeData 都落 UserDefaults，进程被回收后重新拉起还能接上；
/// 4. 暂停用 `cancel(byProducingResumeData:)` 拿到真实续传数据，拿不到就如实从 0 重来；
/// 5. 取消只停任务、只标状态，不删除已经下载完成（或已经落盘）的文件；
/// 6. 一集失败只影响这一集，绝不把整部剧标成完成；
/// 7. 接受 https 直链的 MP4/M4V/MOV/MKV/TS 和 HLS 清单（.m3u8/.m3u）；网页地址、其它扩展名如实拒绝；
///    HLS 走 HLSDownloader：逐片下载、AES-128 解密、合成一个文件（边界见那个文件顶部）；
/// 8. 总长度未知（服务器没给 Content-Length）时不编百分比，只报已收字节。
///
/// 0.1.12 起用后台会话（background URLSession），切到别的 App、锁屏时由系统继续传。
/// 一个进程只允许一个后台会话、一个标识，所以状态全部是类级的。
///
/// 明确不能保证的：用户在后台把 App 强制退出（上滑清掉）时系统会停掉会话，
/// 这种情况会如实标记为「下载被系统中断」，不会假装完成。
final class MediaDownloader: NSObject {
    enum Failure: Error {
        case cancelled
        case http(Int)
        case network(String)
        case disk(String)
        /// 线路本身不支持整集下载（HLS / 网页地址 / 非视频扩展名）
        case unsupported(String)

        var message: String {
            switch self {
            case .cancelled: return "已取消"
            case .http(let code): return "片源服务器返回 \(code)"
            case .network(let text): return text.isEmpty ? "网络中断" : text
            case .disk(let text): return text.isEmpty ? "写不进本机存储" : text
            case .unsupported(let text): return text.isEmpty ? "这条线路不能整集下载" : text
            }
        }
    }

    /// 网页请求入队的一集：id 由网页生成，showId + epKey 是去重键。
    struct Request {
        var id: String
        var url: URL
        var name: String
        var meta: [String: String]

        var showId: String { meta["showId"] ?? meta["id"] ?? "" }
        var epKey: String { meta["epKey"] ?? "" }
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
        /// queued / running / paused / done / failed / cancelled
        var status: String
        var path: String
        var size: Int64
        var reason: String
        /// 终态是否已经交给过网页（progress 不算终态，每次都可以重发）
        var delivered: Bool
        var taskIdentifier: Int
        var updatedAt: Double
        /* 0.1.14 新增：去重与暂停续传。旧记录没有这两个字段，解码时按缺省处理。 */
        var showId: String? = nil
        var epKey: String? = nil
        var resumeData: String? = nil
        /// 每启动一次任务 +1：暂停回调靠它确认「这个 resumeData 属于我现在看的这条任务」，
        /// 避免用户立即继续、新任务已经建好之后，旧任务的回调把数据写进新记录。
        var generation: Int? = nil
        /// 用户显式删除的时间戳（墓碑）。墓碑只留在原生记录里，不会进快照，
        /// 因此晚到的完成回调、重启、重新进页都不可能把这一集带回来。
        var deletedAt: Double? = nil
    }

    /// 同一时刻最多跑几条：用户要的是「两集一起下」，不是把整部剧一起拉满。
    static let maxConcurrent = 2

    #if DEBUG
    /// **仅测试构建**：把暂停时 `cancel(byProducingResumeData:)` 的回调推迟投递，
    /// 用来确定性地复现「用户已经继续/取消，旧任务的回调才回来」这个顺序。
    /// Release 不编译这段，产品行为不受影响。
    static var testResumeDataCallbackDelay: TimeInterval = 0
    /// **仅测试构建**：系统这次回调到底给了多少字节的 resumeData（-1 = 没给）。
    /// 测试靠它证明「竞态这一轮真的走的是有数据的旧任务」，不然绿了也可能是空跑。
    static var testLastResumeDataBytes: Int = -1
    /// **仅测试构建**：把真实那条落盘函数暴露给状态机测试用（不是伪下载、不伪装 delegate，
    /// 只是让测试能给这个真实函数喂一条「属于旧任务的 payload」）。
    static func testStoreResumeData(id: String, generation: Int, data: Data?) {
        storeResumeData(id: id, generation: generation, data: data)
    }
    #endif

    /// 后台会话的标识：App 被重新拉起时系统就是用它把回调交回来的，不能改。
    static let backgroundIdentifier = "org.dpdns.zhuiju.ios.downloads"
    static let tasksKey = "kj-ios-download-tasks"
    static let notifyAskedKey = "kj-ios-notify-asked"
    /// 进程里唯一的那份下载器：后台回调可能早于界面创建，必须共用同一套状态。
    static let shared = MediaDownloader()
    /// 系统在 `handleEventsForBackgroundURLSession` 里给的收尾回调。
    static var backgroundCompletion: (() -> Void)?
    /// 状态变化时通知界面（进度、终态、暂停、排队变化）。界面再转发给网页。
    static var eventSink: (([[String: Any]]) -> Void)?

    private static var sessionStorage: URLSession?
    private static var records: [Record] = []
    private static var progressHandlers: [String: (Int64, Int64) -> Void] = [:]
    private static var finishHandlers: [String: (Result<[String: Any], Failure>) -> Void] = [:]
    private static var tasks: [String: URLSessionDownloadTask] = [:]
    private static var finishedTasks: Set<Int> = []
    private static var movedFiles: [Int: [String: Any]] = [:]
    private static var lastProgressEventAt: [String: TimeInterval] = [:]
    private static var lastPersistAt: TimeInterval = 0

    var isBusy: Bool {
        Self.freshRecords().contains { $0.status == "running" || $0.status == "queued" }
    }

    /// 给回归测试看的只读信息：确认这是后台会话、标识没改名。
    var sessionConfiguration: URLSessionConfiguration { Self.sessionInstance().configuration }

    // MARK: - 纯逻辑（可单元测试，不碰网络）

    /// 这条线路能不能整集下载。返回 nil 表示可以，否则是给用户看的原因。
    ///
    /// 收 https 的视频直链和 HLS 清单：播放页地址、blob:/data: 一律拒绝 ——
    /// 把播放网页当成视频下下来的，是一张 HTML 而不是剧集。
    /// HLS 清单本身能下，真正的分片、解密、合成在 HLSDownloader 里。
    static func rejection(of url: URL) -> String? {
        let scheme = (url.scheme ?? "").lowercased()
        let host = (url.host ?? "").lowercased()
        #if DEBUG
        /* 只有测试构建（DEBUG）认受控源；Release 包永远只收 https，生产规则不因测试放宽。 */
        let controlledLoopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        #else
        let controlledLoopback = false
        #endif
        if scheme != "https" && !(scheme == "http" && controlledLoopback) {
            return "只支持 https 直链下载，这条线路是 \(scheme.isEmpty ? "未知协议" : scheme)"
        }
        if url.host?.isEmpty != false { return "这条线路没有有效的主机名" }
        let path = url.path.lowercased()
        if path.hasSuffix(".m3u8") || path.hasSuffix(".m3u") {
            /* HLS 清单：交给 HLSDownloader 逐片下载、解密、合成。 */
            return nil
        }
        if path.hasSuffix(".html") || path.hasSuffix(".htm") {
            return "这是播放网页，不是视频文件，不能下载"
        }
        /* 站点自己的播放页/详情页是没有扩展名的路由：不能拿来当视频下。 */
        let pageMarkers = ["/player", "/watch", "/detail", "/show/", "/episode"]
        if path.hasSuffix("/") || pageMarkers.contains(where: { path.contains($0) }) {
            return "这是播放网页，不是视频文件，不能下载"
        }
        let videoExtensions = [".mp4", ".m4v", ".mov", ".mkv", ".ts"]
        if !videoExtensions.contains(where: { path.hasSuffix($0) }) {
            /* 没有扩展名的直链（`/play/19`）放过：它可能是 CDN 直出，
               真正下载时按内容校验，失败就如实报错。 */
            if path.contains(".") { return "这条线路的文件类型不能整集下载" }
        }
        return nil
    }

    /// 队列调度（纯函数）：当前还能再启动哪几条。
    static func planStarts(_ list: [Record], limit: Int = maxConcurrent) -> [Record] {
        let running = list.filter { $0.status == "running" }.count
        var slots = max(0, limit - running)
        guard slots > 0 else { return [] }
        var picked: [Record] = []
        for record in list.sorted(by: { $0.updatedAt < $1.updatedAt }) where record.status == "queued" {
            if slots <= 0 { break }
            picked.append(record)
            slots -= 1
        }
        return picked
    }

    /// 去重：同一部剧的同一集正在排队/下载/暂停时不重复入队。
    static func duplicateIndex(in list: [Record], showId: String, epKey: String) -> Int? {
        guard !epKey.isEmpty else { return nil }
        return list.firstIndex { record in
            guard (record.showId ?? "") == showId, (record.epKey ?? "") == epKey else { return false }
            return record.status == "queued" || record.status == "running" || record.status == "paused"
        }
    }

    /// 一部剧的总体进度：总集数未知时 `knownTotal=false`，界面不许造百分比。
    struct Summary {
        var total = 0
        var done = 0
        var failed = 0
        var cancelled = 0
        var running = 0
        var queued = 0
        var paused = 0
        var received: Int64 = 0
        var bytesTotal: Int64 = 0
        var knownBytes: Bool { bytesTotal > 0 }
        /// 只有「所有任务都成功」才算整部剧完成；有失败就是部分失败。
        var finished: Bool { queued == 0 && running == 0 && paused == 0 && done > 0 }
        var allDone: Bool { finished && failed == 0 && cancelled == 0 }
    }

    static func summary(_ list: [Record], showId: String) -> Summary {
        var result = Summary()
        for record in list where record.status != "cancelled" || (record.showId ?? "") == showId {
            guard (record.showId ?? "") == showId else { continue }
            result.total += 1
            switch record.status {
            case "done": result.done += 1
            case "failed": result.failed += 1
            case "cancelled": result.cancelled += 1
            case "running": result.running += 1
            case "queued": result.queued += 1
            case "paused": result.paused += 1
            default: break
            }
            if record.status != "cancelled" {
                result.received += record.received
                result.bytesTotal += record.total
            }
        }
        return result
    }

    /// 文件名清洗：只留文件名本身，路径分隔符、控制字符一律换掉，并补上视频扩展名。
    ///
    /// 只有当地址最后一段**真的带视频扩展名**时才用它 ——
    /// 否则 `.../play/19` 会变成 `19.mp4`，把网页给的集名丢掉；
    /// `.m3u8` 这类清单也不能冒充成视频文件。
    static func fileName(from raw: String?, fallback: String) -> String {
        let videoExtensions = [".mp4", ".m4v", ".mov", ".mkv", ".ts"]
        var name = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        /* 调用方给的通常就是「真实剧名 第X集.mp4」，它优先：
           站点直链最后一段往往只是 `19.mp4`，拿它顶掉会把剧名丢掉（REG-009）。
           只有调用方没给名字（或只给了 `video.mp4` 这类占位名）时才退回链接里的文件名。 */
        let genericNames = ["video", "download", "movie"]
        let stem = (name as NSString).deletingPathExtension.lowercased()
        let genericName = name.isEmpty || genericNames.contains(stem)
        if genericName || !videoExtensions.contains(where: { name.lowercased().hasSuffix($0) }) {
            if let raw = raw, let parsed = URL(string: raw) {
                let last = parsed.lastPathComponent
                if !last.isEmpty, videoExtensions.contains(where: { last.lowercased().hasSuffix($0) }) {
                    name = last
                }
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

    /// 下载目录名只写一处：记录里存相对路径时也用它拼回来。
    static let downloadsFolder = "Downloads"

    static func directory() -> URL? {
        guard let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        return base.appendingPathComponent(downloadsFolder, isDirectory: true)
    }

    /// 落盘时只记相对路径（`Downloads/文件名`）。沙盒容器的绝对路径会随重装/换包变化，
    /// 存绝对路径等于给下一条记录埋一颗「删不掉」的雷。
    static func relativePath(for raw: String?) -> String {
        guard let name = storedFileName(raw) else { return "" }
        return downloadsFolder + "/" + name
    }

    /// 把网页传来的 / 记录里的路径解析成**当前**下载目录里的文件地址：
    /// 先确认写法确实指向下载目录，再取最后一段文件名拼到当前 Documents/Downloads；
    /// 旧容器的绝对路径、相对路径、裸文件名三种写法都落到同一个地方，跨版本换容器也能删/能播。
    static func fileURL(forStoredPath raw: String?) -> URL? {
        guard let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
              let directory = directory() else { return nil }
        /* 只取最后一段文件名，但必须先校验来路：不能什么路径都按文件名塞进下载目录。 */
        let name = (text as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", name != "/",
              storedPathIsInsideDownloads(text, name: name) else { return nil }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = root.appendingPathComponent(name).standardizedFileURL
        guard candidate.pathComponents.count == root.pathComponents.count + 1,
              Array(candidate.pathComponents.prefix(root.pathComponents.count)) == root.pathComponents else {
            return nil
        }
        return candidate
    }

    /// 收到路径的写法校验：只认裸文件名、`Downloads/文件名`、旧容器 `…/Documents/Downloads/文件名`。
    /// 其它路径（`/tmp/x.mp4`、`../../outside.mp4`、`Downloads/子目录/x.mp4`）不解析：
    /// 只凭文件名就把越界路径映射成下载目录里的同名文件，删除时会误删别人的文件。
    private static func storedPathIsInsideDownloads(_ text: String, name: String) -> Bool {
        /* 裸文件名：网页只给了名字。 */
        if !text.contains("/") { return true }
        /* 记录里存的相对路径。 */
        if text == downloadsFolder + "/" + name { return true }
        /* 旧版本的沙盒绝对路径：必须整段以 /Documents/Downloads/<文件名> 结尾，
           前面是哪个容器都不管；中间多一层目录的不认。 */
        let legacySuffix = "/Documents/" + downloadsFolder + "/" + name
        return text.count >= legacySuffix.count && String(text.suffix(legacySuffix.count)) == legacySuffix
    }

    /// 落盘用的文件名：和 `fileURL(forStoredPath:)` 同一套规则，取最后一段、`..`/`.`/空串不认。
    private static func storedFileName(_ raw: String?) -> String? {
        guard let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let name = (text as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", name != "/" else { return nil }
        return name
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
        var flat: [String: String] = [:]
        for (key, value) in meta ?? [:] {
            if let text = value as? String { flat[key] = text }
            else if let number = value as? NSNumber { flat[key] = number.stringValue }
        }
        let request = Request(id: id, url: url, name: name, meta: flat)
        Self.enqueue([request], progress: [id: onProgress], finish: [id: onFinish])
    }

    /// 批量入队：单集和批量共用同一条持久队列。
    @discardableResult
    func enqueue(_ requests: [Request]) -> [String] {
        Self.enqueue(requests)
    }

    /// 左滑删除一集：取消任务、把这一集写进独立墓碑存储（不再进快照）、通知网页刷新。
    /// 本地文件由调用方先用 removeDownloadedFile 删掉；文件删不掉就不该走到这里。
    func deleteEpisode(id: String?, showId: String, epKey: String) {
        Self.deleteEpisode(id: id, showId: showId, epKey: epKey)
    }

    /// 真正删掉这一集的本地文件（不是挪进回收站，删了才真的释放空间）。
    /// 只接受 Documents/Downloads 里的普通文件，而且只动这一个文件：
    /// 路径越界、目标是目录、删除失败都返回 false，由调用方保留记录并告诉用户；
    /// 文件本来就不在了也算成功，记录照样要删。
    func removeDownloadedFile(at path: String?) -> Bool {
        Self.removeDownloadedFile(at: path)
    }

    @discardableResult
    static func removeDownloadedFile(at path: String?) -> Bool {
        guard let raw = path?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return true }
        guard let directory = directory(), let source = fileURL(forStoredPath: raw) else {
            NSLog("refuse to delete file outside download directory: %@", raw)
            return false
        }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let rootComponents = root.pathComponents
        let sourceComponents = source.pathComponents
        /* 只认下载目录里的直接子项：同前缀的兄弟目录、下载目录本身一律不动。 */
        guard sourceComponents.count == rootComponents.count + 1,
              Array(sourceComponents.prefix(rootComponents.count)) == rootComponents else {
            NSLog("refuse to delete file outside download directory: %@", raw)
            return false
        }
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: source.path, isDirectory: &isDirectory) else { return true }
        guard !isDirectory.boolValue else {
            NSLog("refuse to delete a directory: %@", raw)
            return false
        }
        do {
            try fileManager.removeItem(at: source)
        } catch {
            NSLog("delete downloaded file failed: %@", String(describing: error))
            return false
        }
        /* 旧版本把删掉的文件挪进 .trash：同一个文件名的历史副本顺手清掉，别继续白占空间。 */
        let legacyTrash = root.appendingPathComponent(".trash", isDirectory: true)
            .appendingPathComponent(source.lastPathComponent)
        if fileManager.fileExists(atPath: legacyTrash.path) {
            try? fileManager.removeItem(at: legacyTrash)
        }
        return true
    }

    private static func deleteEpisode(id: String?, showId: String, epKey: String) {
        records = loadRecords()
        var changed = false
        let deletedAt = Date().timeIntervalSince1970
        /* 墓碑独立落库，不依赖这条记录还在不在：记录被 400 条上限裁掉，删除结论也不会丢。 */
        rememberTombstone(showId: showId, epKey: epKey, at: deletedAt)
        for index in records.indices {
            let record = records[index]
            let sameId = !(id ?? "").isEmpty && record.id == id
            let sameEpisode = !showId.isEmpty && !epKey.isEmpty
                && (record.showId ?? "") == showId && (record.epKey ?? "") == epKey
            guard sameId || sameEpisode else { continue }
            records[index].deletedAt = deletedAt
            rememberTombstone(showId: records[index].showId ?? "", epKey: records[index].epKey ?? "", at: deletedAt)
            records[index].status = "cancelled"
            records[index].reason = "已删除"
            records[index].path = ""
            records[index].received = 0
            records[index].resumeData = nil
            records[index].delivered = false
            if let task = tasks.removeValue(forKey: record.id) { task.cancel() }
            /* HLS 的分片任务和缓存也一起清掉：删了就要真的不占空间。 */
            HLSDownloader.discard(id: record.id)
            progressHandlers.removeValue(forKey: record.id)
            finishHandlers.removeValue(forKey: record.id)
            changed = true
        }
        if changed {
            persist(force: true)
            emitStateEvents()
            pump()
        }
    }

    /// 暂停一整部剧（正在传的取 resumeData、排队的转 paused）。
    func pause(showId: String) { Self.pause(showId: showId) }

    /// 继续一整部剧（paused → queued，再按并发上限调度）。
    func resume(showId: String) { Self.resume(showId: showId) }

    /// 取消一整部剧：只停任务、只标状态，已下载的文件不动。
    func cancel(showId: String) { Self.cancel(showId: showId) }

    /// 取消全部（含排队的）。`silent` 给测试收尾用，不回调。
    func cancel(silent: Bool = false) { Self.stop(silent: silent) }

    func restore(completion: (() -> Void)? = nil) {
        Self.reconcile(completion: completion)
    }

    func eventsForPage() -> [[String: Any]] {
        Self.pageEvents()
    }

    /// 队列快照：网页侧据此算「按剧总体进度」和每条任务的状态，重启后也能对齐。
    func snapshotForPage() -> [[String: Any]] {
        Self.snapshot()
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

    // MARK: - 入队 / 调度

    private static func freshRecords() -> [Record] {
        records = loadRecords()
        return records
    }

    @discardableResult
    private static func enqueue(
        _ requests: [Request],
        progress: [String: (Int64, Int64) -> Void] = [:],
        finish: [String: (Result<[String: Any], Failure>) -> Void] = [:]
    ) -> [String] {
        records = loadRecords()
        var accepted: [String] = []
        let tombstones = deletedKeys()
        let requestedKeys = Set(requests.map { key(showId: $0.showId, epKey: $0.epKey) })
        /* 已删掉的集：旧记录可以清掉（墓碑在独立存储里），但墓碑本身不能在这里删，
           否则用户删过的历史随时会被下一条入队请求带回界面。 */
        for deadKey in tombstones where !requestedKeys.contains(deadKey) {
            let parts = deadKey.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            if parts.count == 2 {
                records.removeAll { (($0.showId ?? "") == String(parts[0])) && (($0.epKey ?? "") == String(parts[1])) }
            }
        }
        var rejected: [(String, String, [String: String])] = []
        for request in requests {
            if let reason = rejection(of: request.url) {
                rejected.append((request.id, reason, request.meta))
                continue
            }
            let showId = request.showId
            let epKey = request.epKey
            if epKey.isEmpty {
                continue
            }
            let episodeKey = key(showId: showId, epKey: epKey)
            if tombstones.contains(episodeKey) {
                forgetTombstone(showId: showId, epKey: epKey)
                records.removeAll { (($0.showId ?? "") == showId) && (($0.epKey ?? "") == epKey) }
            }
            if let index = duplicateIndex(in: records, showId: showId, epKey: epKey) {
                /* 已经在队列里：不重复入队（同一部剧同一集只跑一条） */
                accepted.append(records[index].id)
                continue
            }
            /* 之前下过 / 失败过：重新入队时用新记录覆盖旧记录（换文件也要能重下） */
            if let index = records.firstIndex(where: { ($0.showId ?? "") == showId && ($0.epKey ?? "") == epKey && !epKey.isEmpty }) {
                records.remove(at: index)
            }
            var record = Record(
                id: request.id,
                url: request.url.absoluteString,
                name: request.name,
                title: request.meta["title"] ?? "",
                ep: request.meta["epLabel"] ?? "",
                meta: request.meta,
                received: 0,
                total: 0,
                status: "queued",
                path: "",
                size: 0,
                reason: "",
                delivered: false,
                taskIdentifier: 0,
                updatedAt: Date().timeIntervalSince1970
            )
            record.showId = showId
            record.epKey = epKey
            records.append(record)
            accepted.append(request.id)
            progressHandlers[request.id] = progress[request.id]
            finishHandlers[request.id] = finish[request.id]
        }
        for (id, reason, meta) in rejected {
            /* 不支持就如实拒绝：留一条 failed 记录，网页能显示真实原因，不会静默消失 */
            var record = Record(
                id: id, url: "", name: meta["name"] ?? "", title: meta["title"] ?? "",
                ep: meta["epLabel"] ?? "", meta: meta, received: 0, total: 0, status: "failed",
                path: "", size: 0, reason: reason, delivered: false, taskIdentifier: 0,
                updatedAt: Date().timeIntervalSince1970
            )
            record.showId = meta["showId"] ?? meta["id"] ?? ""
            record.epKey = meta["epKey"] ?? ""
            records.append(record)
        }
        if !requests.isEmpty { requestNotificationPermissionOnce() }
        persist(force: true)
        pump()
        emitStateEvents()
        return accepted
    }

    private static func pump() {
        for record in planStarts(records) {
            launch(record)
        }
        persist(force: true)
    }

    private static func launch(_ record: Record) {
        /* HLS 走分片下载器：一条记录内部并发下分片，全部到齐后合成一个文件。 */
        if HLSDownloader.isHLSSource(url: record.url, kind: record.meta["kind"]) {
            update(record.id) { current in
                current.status = "running"
                current.taskIdentifier = 0
                current.resumeData = nil
                current.reason = ""
            }
            HLSDownloader.shared.start(record: record)
            return
        }
        let session = sessionInstance()
        let task: URLSessionDownloadTask?
        if let text = record.resumeData, let data = Data(base64Encoded: text) {
            task = session.downloadTask(withResumeData: data)
        } else if let url = URL(string: record.url) {
            task = session.downloadTask(with: url)
        } else {
            task = nil
        }
        guard let downloadTask = task else {
            fail(id: record.id, failure: .network("下载地址无效"))
            return
        }
        downloadTask.taskDescription = record.id
        tasks[record.id] = downloadTask
        update(record.id) { current in
            current.status = "running"
            current.taskIdentifier = downloadTask.taskIdentifier
            current.resumeData = nil
            current.reason = ""
            current.generation = (current.generation ?? 0) + 1
        }
        downloadTask.resume()
    }

    /// 暂停一部剧：正在传的用系统给的 resumeData，排队的直接转 paused。
    private static func pause(showId: String) {
        records = loadRecords()
        var changed = false
        for record in records where record.status == "queued" && matches(record, showId) {
            update(record.id) { $0.status = "paused"; $0.reason = "已暂停" }
            changed = true
        }
        let running = records.filter { $0.status == "running" && matches($0, showId) }.map(\.id)
        for id in running {
            /* 先把状态改成 paused：delegate 收到取消回调时就不会再写成「失败」 */
            update(id) { $0.status = "paused"; $0.reason = "已暂停" }
            changed = true
            /* HLS 的分片任务不在 tasks 里：单独停掉，已经下好的分片留着。 */
            HLSDownloader.pause(id: id)
            if let task = tasks.removeValue(forKey: id) {
                let generation = record(id)?.generation ?? 0
                task.cancel(byProducingResumeData: { data in
                    #if DEBUG
                    testLastResumeDataBytes = data?.count ?? -1
                    #endif
                    /* 回调来自系统内部队列：回到主队列再改状态，和 pause/resume/pump 串行，
                       并且要核对「还是那条被暂停的任务」，否则宁可丢弃。 */
                    let deliver = {
                        storeResumeData(id: id, generation: generation, data: data)
                    }
                    #if DEBUG
                    let delay = testResumeDataCallbackDelay
                    #else
                    let delay: TimeInterval = 0
                    #endif
                    if delay > 0 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: deliver)
                    } else {
                        DispatchQueue.main.async(execute: deliver)
                    }
                })
            }
        }
        progressHandlers[showId] = nil
        if changed { persist(force: true); emitStateEvents() }
    }

    private static func resume(showId: String) {
        records = loadRecords()
        var changed = false
        for record in records where record.status == "paused" && matches(record, showId) {
            update(record.id) { $0.status = "queued"; $0.reason = "" }
            changed = true
        }
        if changed { persist(force: true); pump(); emitStateEvents() }
    }

    /// 暂停回调落 resumeData：必须同时满足「还是暂停态」和「还是那条任务（generation 一致）」。
    /// - 用户已经点了继续/取消：新任务已经建好或状态已变 → 丢弃旧数据，绝不污染新任务；
    /// - 系统没给 resumeData（片源不支持 Range）：保持 paused 且 resumeData 为空，
    ///   继续时从 0 重下，进度如实归零，不伪造续传。
    private static func storeResumeData(id: String, generation: Int, data: Data?) {
        records = loadRecords()
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        guard records[index].status == "paused", (records[index].generation ?? 0) == generation else { return }
        records[index].resumeData = (data?.isEmpty == false) ? data!.base64EncodedString() : nil
        records[index].updatedAt = Date().timeIntervalSince1970
        persist(force: true)
        emitStateEvents()
    }

    /// 取消一部剧：停任务、标状态。已下载的文件保留。
    private static func cancel(showId: String) {
        records = loadRecords()
        var changed = false
        for record in records where matches(record, showId) && (record.status == "queued" || record.status == "paused" || record.status == "running") {
            update(record.id) { current in
                current.status = "cancelled"
                current.reason = "已取消"
                current.delivered = false
                current.resumeData = nil
                /* 取消后不保留一个「下了多少」的假进度 */
                current.received = 0
            }
            changed = true
            if let task = tasks.removeValue(forKey: id(of: record)) { task.cancel() }
            HLSDownloader.pause(id: record.id)
        }
        if changed { persist(force: true); pump(); emitStateEvents() }
    }

    /// 取消全部（含排队）。测试收尾与「清空队列」共用。
    private static func stop(silent: Bool) {
        records = loadRecords()
        for record in records where record.status == "queued" || record.status == "paused" || record.status == "running" {
            update(record.id) { current in
                guard current.status != "done" else { return }
                current.status = "cancelled"
                current.reason = "已取消"
                current.received = 0
                current.resumeData = nil
                current.delivered = false
            }
            if let task = tasks.removeValue(forKey: id(of: record)) { task.cancel() }
            HLSDownloader.pause(id: record.id)
        }
        let handlers = finishHandlers
        finishHandlers.removeAll()
        progressHandlers.removeAll()
        if !silent {
            for (_, handler) in handlers { handler(.failure(.cancelled)) }
        }
        persist(force: true)
        emitStateEvents()
    }

    private static func matches(_ record: Record, _ showId: String) -> Bool {
        guard !showId.isEmpty else { return false }
        return (record.showId ?? "") == showId
    }

    private static func id(of record: Record) -> String { record.id }

    /// 重新接上后台会话：App 被系统重新拉起时，这里把上一个进程留下的任务找回来。
    ///
    /// running 但系统里已经没有这条任务 → 如实标「系统中断」；
    /// queued / paused 的按原状态保留并重新调度（重启后队列不会凭空消失）。
    private static func reconcile(completion: (() -> Void)?) {
        let activeSession = sessionInstance()
        records = loadRecords()
        activeSession.getAllTasks { systemTasks in
            let alive = Set(systemTasks.compactMap { $0.taskDescription })
            var changed = false
            for index in records.indices where records[index].status == "running" {
                if alive.contains(records[index].id) { continue }
                /* HLS 的分片跑在另一条后台会话里：状态还在就接着下，不能按整文件任务误判失败。 */
                if HLSDownloader.hasJob(id: records[index].id) {
                    HLSDownloader.resume(id: records[index].id)
                    continue
                }
                /* 系统没给完成回调、任务也不在了：如实标失败，不许假装完成。 */
                records[index].status = "failed"
                records[index].reason = "下载被系统中断（App 被强制退出或任务被清理）"
                records[index].delivered = false
                changed = true
            }
            for task in systemTasks {
                guard let id = task.taskDescription,
                      let index = records.firstIndex(where: { $0.id == id }) else { continue }
                records[index].status = "running"
                records[index].taskIdentifier = task.taskIdentifier
                tasks[id] = task as? URLSessionDownloadTask
            }
            if changed { persist(force: true) }
            /* 上次没跑完的队列接着跑（并发仍然最多两条） */
            pump()
            completion?()
        }
    }

    /// 交给网页的终态/进度事件：终态只交一次，进度每次都可以重发。
    private static func pageEvents() -> [[String: Any]] {
        records = loadRecords()
        var events: [[String: Any]] = []
        var needsSave = false
        for record in records where !Self.isDeleted(record) {
            if record.status == "running" {
                events.append([
                    "event": "progress", "id": record.id,
                    "received": record.received, "total": record.total,
                    "showId": record.showId ?? "", "epKey": record.epKey ?? "",
                ])
                continue
            }
            if record.delivered { continue }
            switch record.status {
            case "done":
                events.append([
                    "event": "done", "id": record.id, "path": record.path, "name": record.name, "size": record.size,
                    "showId": record.showId ?? "", "epKey": record.epKey ?? "", "ep": record.ep,
                    /* 网页片库靠这些字段把完成项并回同一部剧（重启后也不依赖当前页面） */
                    "title": record.title, "epLabel": record.ep,
                    "cover": record.meta["cover"] ?? "", "showTotal": record.meta["total"] ?? "",
                ])
            case "cancelled":
                events.append(["event": "cancelled", "id": record.id,
                               "showId": record.showId ?? "", "epKey": record.epKey ?? ""])
            case "failed":
                events.append(["event": "failed", "id": record.id, "reason": record.reason,
                               "showId": record.showId ?? "", "epKey": record.epKey ?? ""])
            default:
                continue
            }
            needsSave = true
        }
        if needsSave {
            for index in records.indices where !Self.isDeleted(records[index]) && records[index].status != "running" && records[index].status != "queued" && records[index].status != "paused" {
                records[index].delivered = true
            }
            persist(force: true)
        }
        return events
    }

    /// 队列快照：所有任务的真实状态（含排队/暂停），网页据此算整剧进度。
    private static func snapshot() -> [[String: Any]] {
        records = loadRecords()
        return records.filter { !Self.isDeleted($0) }.map { record in
            [
                "id": record.id,
                "showId": record.showId ?? "",
                "epKey": record.epKey ?? "",
                "epLabel": record.ep,
                "title": record.title,
                "name": record.name,
                "status": record.status,
                "received": record.received,
                "total": record.total,
                "path": record.path,
                "size": record.size,
                "reason": record.reason,
            ]
        }
    }

    /// 把内存里的状态推给界面（界面再转发给网页）。
    private static func emitStateEvents() {
        guard let sink = eventSink else { return }
        records = loadRecords()
        var payload: [[String: Any]] = []
        for record in records where !Self.isDeleted(record) {
            var item: [String: Any] = [
                "event": record.status == "running" ? "progress" : record.status,
                "id": record.id,
                "showId": record.showId ?? "",
                "epKey": record.epKey ?? "",
                "status": record.status,
                "received": record.received,
                "total": record.total,
                "reason": record.reason,
                "name": record.name,
                "path": record.path,
                "size": record.size,
                "title": record.title,
                "epLabel": record.ep,
                "cover": record.meta["cover"] ?? "",
                "showTotal": record.meta["total"] ?? "",
            ]
            if record.status == "done" || record.status == "failed" || record.status == "cancelled" { item["event"] = record.status }
            payload.append(item)
        }
        sink(payload)
    }

    /// 后台回调收尾：会话已重建、状态已对账后再告诉系统，别提前收尾。
    private static func adoptBackgroundEvents(completion: @escaping () -> Void) {
        backgroundCompletion = completion
        reconcile(completion: {
            sessionInstance().getAllTasks { systemTasks in
                guard systemTasks.isEmpty else { return }
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
        var list = (try? JSONDecoder().decode([Record].self, from: data)) ?? []
        /* 老版本记录的是沙盒绝对路径：读出来就迁成相对路径，下一次 persist 落库。
           迁移只改写法，不动文件，也不影响「文件真的在还是在」。 */
        for index in list.indices where !list[index].path.isEmpty {
            let relative = relativePath(for: list[index].path)
            if list[index].path != relative { list[index].path = relative }
        }
        return list
    }

    private static func persist(force: Bool) {
        let now = Date().timeIntervalSince1970
        if !force && now - lastPersistAt < 1 { return }
        lastPersistAt = now
        /* 队列里可能有整部剧的集数：保留最近 400 条，够长又不会把 UserDefaults 撑爆。
           真正的长期下载史在网页侧的片库里。 */
        let trimmed = Array(records.suffix(400))
        if let data = try? JSONEncoder().encode(trimmed) {
            UserDefaults.standard.set(data, forKey: tasksKey)
        }
    }

    private static let tombstonePrefix = "kj-ios-download-deleted-"
    /// 墓碑独立存储：一个键装下所有 showId|epKey，值是删除时间戳。
    /// 只从下载记录里读墓碑是不够的：记录会被 persist 的 suffix(400) 裁掉，
    /// 裁掉之后旧快照、晚到回调又能把已删的集写回来。墓碑单独落库就不受记录裁剪影响。
    private static let tombstoneStoreKey = "kj-ios-download-tombstones-v1"
    /// 有界清理：只保留最近 2000 条删除。正常用户远用不到，也不会把默认值存储撑爆。
    private static let tombstoneLimit = 2000
    private static var tombstoneCache: [String: Double] = [:]
    private static var tombstonesLoaded = false

    private static func key(showId: String, epKey: String) -> String { showId + "|" + epKey }

    private static func tombstones() -> [String: Double] {
        if tombstonesLoaded { return tombstoneCache }
        tombstoneCache = loadTombstones()
        tombstonesLoaded = true
        return tombstoneCache
    }

    private static func loadTombstones() -> [String: Double] {
        let defaults = UserDefaults.standard
        var merged: [String: Double] = [:]
        if let saved = defaults.dictionary(forKey: tombstoneStoreKey) {
            for (marker, value) in saved {
                if let number = value as? NSNumber, number.doubleValue > 0 {
                    merged[marker] = number.doubleValue
                }
            }
        }
        /* build24 之前一个删除项一个键：读进来迁移到独立存储，迁完把老键清掉。 */
        var legacyKeys: [String] = []
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(tombstonePrefix) {
            if let number = defaults.object(forKey: key) as? NSNumber, number.doubleValue > 0 {
                merged[String(key.dropFirst(tombstonePrefix.count))] = number.doubleValue
            }
            legacyKeys.append(key)
        }
        /* 老记录上的 deletedAt 也是一份删除证据：一起并进来，记录被裁掉也不丢。 */
        for record in loadRecords() {
            guard let removedAt = record.deletedAt, removedAt > 0 else { continue }
            let showId = record.showId ?? ""
            let epKey = record.epKey ?? ""
            guard !showId.isEmpty, !epKey.isEmpty else { continue }
            merged[key(showId: showId, epKey: epKey)] = max(merged[key(showId: showId, epKey: epKey)] ?? 0, removedAt)
        }
        saveTombstones(merged)
        for key in legacyKeys { defaults.removeObject(forKey: key) }
        return merged
    }

    /// 存墓碑：按删除时间保留最近的 tombstoneLimit 条，只有超出的老记录才会被丢掉。
    private static func saveTombstones(_ tombstones: [String: Double]) {
        let defaults = UserDefaults.standard
        guard !tombstones.isEmpty else {
            defaults.removeObject(forKey: tombstoneStoreKey)
            return
        }
        var stored: [String: Double] = [:]
        for (marker, stamp) in tombstones.sorted(by: { $0.value > $1.value }).prefix(tombstoneLimit) {
            stored[marker] = stamp
        }
        defaults.set(stored, forKey: tombstoneStoreKey)
    }

    private static func rememberTombstone(showId: String, epKey: String, at stamp: Double) {
        guard !showId.isEmpty, !epKey.isEmpty else { return }
        var next = tombstones()
        next[key(showId: showId, epKey: epKey)] = stamp
        saveTombstones(next)
        tombstoneCache = next
        tombstonesLoaded = true
    }

    private static func forgetTombstone(showId: String, epKey: String) {
        guard !showId.isEmpty, !epKey.isEmpty else { return }
        var next = tombstones()
        guard next.removeValue(forKey: key(showId: showId, epKey: epKey)) != nil else { return }
        saveTombstones(next)
        tombstoneCache = next
        tombstonesLoaded = true
    }

    private static func deletedKeys() -> Set<String> { Set(tombstones().keys) }

    private static func isDeleted(_ record: Record) -> Bool {
        if (record.deletedAt ?? 0) > 0 { return true }
        let showId = record.showId ?? ""
        let epKey = record.epKey ?? ""
        guard !showId.isEmpty, !epKey.isEmpty else { return false }
        return tombstones()[key(showId: showId, epKey: epKey)] != nil
    }

    private static func update(_ id: String, force: Bool = true, _ mutate: (inout Record) -> Void) {
        if !records.contains(where: { $0.id == id }) { records = loadRecords() }
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        mutate(&records[index])
        records[index].updatedAt = Date().timeIntervalSince1970
        persist(force: force)
    }

    private static func record(_ id: String) -> Record? {
        if let hit = records.first(where: { $0.id == id }) { return hit }
        records = loadRecords()
        return records.first(where: { $0.id == id })
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
        if let current = record(id), Self.isDeleted(current) { return }
        update(id) { record in
            record.status = "done"
            /* 只存相对路径：真机换一次容器，旧绝对路径就不存在了（删除会永远失败）。 */
            record.path = Self.relativePath(for: payload["path"] as? String)
            if let finalName = payload["name"] as? String, !finalName.isEmpty { record.name = finalName }
            record.size = (payload["size"] as? NSNumber)?.int64Value ?? 0
            record.received = record.size
            record.total = max(record.total, record.size)
            record.delivered = false
            record.resumeData = nil
            record.reason = ""
        }
        if let finished = record(id) { notifyFinished(finished) }
        tasks.removeValue(forKey: id)
        let handler = finishHandlers.removeValue(forKey: id)
        progressHandlers.removeValue(forKey: id)
        emitStateEvents()
        handler?(.success(payload))
        pump()
    }

    // MARK: - HLS 分片下载回调（由 HLSDownloader 调用）

    /// 分片进度：已下好的分片按字节汇总，再按「已完成时长 / 总时长」折算总量，
    /// 网页侧算出来的百分比就是「已完成的分片 / 总片数」，长剧集不会提前跳到 100%。
    static func hlsProgress(id: String, received: Int64, total: Int64) {
        guard let current = record(id), current.status == "running", !Self.isDeleted(current) else { return }
        update(id, force: false) { item in
            item.received = received
            item.total = total
        }
        let now = Date().timeIntervalSince1970
        guard now - (lastProgressEventAt[id] ?? 0) >= 0.25 else { return }
        lastProgressEventAt[id] = now
        guard let latest = record(id) else { return }
        var event: [String: Any] = [
            "event": "progress", "id": id, "showId": latest.showId ?? "",
            "epKey": latest.epKey ?? "", "epLabel": latest.ep, "title": latest.title,
            "received": latest.received, "total": latest.total,
        ]
        event["cover"] = latest.meta["cover"] ?? ""
        event["showTotal"] = latest.meta["total"] ?? ""
        eventSink?([event])
    }

    /// HLS 合成完成：和整文件下载走同一条完成路径（记录、通知、网页事件完全一致）。
    static func hlsComplete(id: String, path: String, size: Int64, name: String) {
        complete(id: id, payload: ["path": path, "size": size, "name": name])
    }

    static func hlsFail(id: String, reason: String) {
        fail(id: id, failure: .network(reason))
    }

    private static func fail(id: String, failure: Failure) {
        if let current = record(id), Self.isDeleted(current) { return }
        update(id) { record in
            record.status = failure.isCancellation ? "cancelled" : "failed"
            record.reason = failure.message
            record.delivered = false
            record.resumeData = nil
        }
        tasks.removeValue(forKey: id)
        let handler = finishHandlers.removeValue(forKey: id)
        progressHandlers.removeValue(forKey: id)
        emitStateEvents()
        handler?(.failure(failure))
        pump()
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
        guard let id = downloadTask.taskDescription, let current = Self.record(id), current.status == "running", !Self.isDeleted(current) else { return }
        Self.update(id, force: false) { record in
            record.received = totalBytesWritten
            record.total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : record.total
        }
        Self.progressHandlers[id]?(totalBytesWritten, totalBytesExpectedToWrite)
        let now = Date().timeIntervalSince1970
        let isLastChunk = totalBytesExpectedToWrite > 0 && totalBytesWritten >= totalBytesExpectedToWrite
        let shouldSendEvent = isLastChunk || now - (Self.lastProgressEventAt[id] ?? 0) >= 0.25
        if shouldSendEvent, let record = Self.record(id) {
            Self.lastProgressEventAt[id] = now
            var event: [String: Any] = [
                "event": "progress", "id": id, "showId": record.showId ?? "",
                "epKey": record.epKey ?? "", "epLabel": record.ep, "title": record.title,
                "received": record.received, "total": record.total,
            ]
            event["cover"] = record.meta["cover"] ?? ""
            event["showTotal"] = record.meta["total"] ?? ""
            Self.eventSink?([event])
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        guard let current = Self.record(id), current.status == "running", !Self.isDeleted(current) else { return }
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
        Self.tasks.removeValue(forKey: id)
        /* 暂停/取消是我们自己先改的状态：这里不能再写成失败。 */
        guard let current = Self.record(id), current.status == "running", !Self.isDeleted(current) else { return }
        if let error = error as NSError? {
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
                Self.fail(id: id, failure: .cancelled)
            } else {
                /* 带上 domain/code：模拟器里 4097（nsurlsessiond 没起来）和真正的网络错误
                   在设置面板里长得一样，排查时必须有据可依。 */
                Self.fail(id: id, failure: .network("网络中断（\(error.domain) \(error.code)）: \(error.localizedDescription)"))
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
