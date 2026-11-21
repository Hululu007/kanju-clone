import Foundation
import CommonCrypto

/// HLS 整集下载：主清单 → 媒体清单 → 逐片下载（并发 ≤ 4、每片失败重试 3 次）→ AES-128 解密 → 合成一个文件。
///
/// 分工：
/// - 清单和密钥是小请求，用前台会话取；分片用**单独一条后台会话**下载，
///   切后台/锁屏时由系统继续传（和整文件下载那条会话分开，互不占位）。
/// - 解密与合成必须在 App 进程里做：进程被系统挂起时这一步停下来，
///   回到前台继续；已经下完的分片留在缓存目录里，不会从 0 重来。
///
/// 明确不做的：SAMPLE-AES / DRM（解析到这种线路直接如实失败）、
/// 锁屏期间完成解密合成（系统只允许后台传文件，不允许后台干活）。
final class HLSDownloader: NSObject {
    enum Container: String {
        case mp4
        case ts
    }

    /// 清单/密钥请求失败的载体：Result 的 Failure 必须是一个 Error 类型。
    struct HLSFailure: Error {
        var reason: String
    }

    struct Segment: Codable {
        var url: String
        var duration: Double
        var sequence: Int
        var byteRangeOffset: Int64
        var byteRangeLength: Int64
        var keyURI: String
        var keyIV: String
        var isInitialization: Bool
        var done: Bool
        var bytes: Int64
        var attempts: Int
    }

    struct Job: Codable {
        var id: String
        var name: String
        var manifestURL: String
        var mediaURL: String
        var referer: String
        var userAgent: String
        var container: String
        var totalDuration: Double
        var segments: [Segment]
        var keys: [String: String]
        /// plan（还没拿到清单）/ segments（正在下分片）/ finalize（正在合成）
        var phase: String
        var createdAt: Double
    }

    static let shared = HLSDownloader()

    /// 分片专用的后台会话标识；App 被重新拉起时系统靠它把回调交回来。
    static let backgroundIdentifier = "org.dpdns.zhuiju.ios.hls"
    static let jobsKey = "kj-ios-hls-jobs"
    static let maxSegmentConcurrency = 4
    static let maxSegmentRetries = 3
    static let maxPlaylistDepth = 3

    private static var jobs: [String: Job] = [:]
    private static var loaded = false
    private static var sessionStorage: URLSession?
    private static var foregroundStorage: URLSession?
    private static var tasks: [Int: URLSessionDownloadTask] = [:]
    private static var taskKeys: [Int: String] = [:]
    /// 每个系统分片任务属于哪一代 job：换清单/删除后，旧任务的晚到回调不能碰新 job 的状态。
    private static var taskGenerations: [Int: Int] = [:]
    private static var inFlight: Set<String> = []
    /// 失败分片的专属重试票：有票的分片 pump 不许抢跑，票号对不上的旧定时器直接作废。
    private static var retryScheduled: [String: Int] = [:]
    private static var retryTicket = 0
    /// 用户暂停过的任务：重试定时器和 pump 都不能再把分片拉起来。
    private static var paused: Set<String> = []
    /// job 的代次：每次开始/丢弃都加一，旧清单、密钥、分片回调凭代次作废。
    private static var generations: [String: Int] = [:]
    /// 正在解析的 job 及其代次；旧回调回来时不能把新一次的解析标记清掉。
    private static var planning: [String: Int] = [:]
    private static var finalizing: Set<String> = []
    private static var backgroundCompletion: (() -> Void)?
    /// 本进程是否已经跟系统对过账（把系统里真实存在的分片任务认领回来）。
    /// 没对账就发新任务 = 进程重建后给同一片再发第二条任务，白耗流量还可能写坏缓存。
    private static var sessionAdopted = false
    private static var adopting = false
    /// 收尾回调的兜底票号：正常由 `urlSessionDidFinishEvents` 归还，兜底到点也还，谁先到谁作废对方。
    private static var finishEventsTicket = 0
    /// 分片投递计数的落盘节流：一次投几百片，每片都整份写盘会卡住主线程。
    private static var lastAttemptsPersist = Date.distantPast

    /// 这条线路是不是 HLS：网页给的 kind 优先，其次看扩展名。
    static func isHLSSource(url: String, kind: String?) -> Bool {
        if (kind ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "hls" { return true }
        let path = (URL(string: url)?.path ?? url).lowercased()
        return path.hasSuffix(".m3u8") || path.hasSuffix(".m3u")
    }

    // MARK: - 对外

    func start(record: MediaDownloader.Record) {
        Self.begin(record)
    }

    static func hasJob(id: String) -> Bool {
        ensureLoaded()
        return jobs[id] != nil
    }

    /// 对账用：丢掉「记录已经是终态」的遗留任务（旧版本取消时只 pause 不 discard）。
    /// 暂停中的 job 不是僵尸：分片缓存要留着续传，只把可能残留的分片任务停掉、保持暂停态。
    static func discardZombies(isLive: (String) -> Bool, isPaused: (String) -> Bool) {
        ensureLoaded()
        let dead = jobs.keys.filter { !isLive($0) }
        for id in dead {
            paused.remove(id)
            cancelTasks(id: id)
            jobs.removeValue(forKey: id)
            bumpGeneration(id: id)
            try? FileManager.default.removeItem(at: segmentDirectory(id: id))
        }
        /* paused 是内存态，进程重启后是空的：从记录同步回来，防止对账把暂停任务重新调度。 */
        for id in jobs.keys where isPaused(id) {
            paused.insert(id)
            cancelTasks(id: id)
        }
        if !dead.isEmpty { persist() }
    }

    private static func generation(for id: String) -> Int { generations[id] ?? 0 }

    /// 换清单、删除、失败或合成完成时调用：旧代次的异步回调此后一律丢弃。
    @discardableResult
    private static func bumpGeneration(id: String) -> Int {
        let next = generation(for: id) + 1
        generations[id] = next
        planning.removeValue(forKey: id)
        return next
    }

    private static func isCurrent(id: String, gen: Int) -> Bool {
        jobs[id] != nil && generation(for: id) == gen
    }

    /// 暂停：停掉正在传的分片，状态和已下好的分片都留着，继续时接着下。
    static func pause(id: String) {
        paused.insert(id)
        cancelTasks(id: id)
    }

    /// 删除/取消：连缓存里的分片一起清掉。
    static func discard(id: String) {
        ensureLoaded()
        bumpGeneration(id: id)
        paused.remove(id)
        cancelTasks(id: id)
        jobs.removeValue(forKey: id)
        persist()
        try? FileManager.default.removeItem(at: segmentDirectory(id: id))
    }

    /// App 重启后对账：清单还没解析的继续解析，分片没下完的接着下，合成没做完的重新合成。
    static func resume(id: String) {
        ensureLoaded()
        guard let job = jobs[id] else { return }
        switch job.phase {
        case "segments":
            /* 先按磁盘补齐已经落盘、但进程死在落库前的分片，再接着下。 */
            reconcileDisk(id: id)
            pump(id: id)
        case "finalize":
            jobs[id]?.phase = "segments"
            finalize(id: id)
        default:
            plan(id: id)
        }
    }

    static func adoptBackgroundEvents(completion: @escaping () -> Void) {
        ensureLoaded()
        backgroundCompletion = completion
        /* 这里只记下回调，不归还：此刻只是「系统把我唤醒、事件正在送过来」，
           这一轮事件还没处理完。提前归还会让 App 在分片搬盘、状态落库之前就被挂起。 */
        armFinishEventsDeadline()
        adoptIfNeeded()
    }

    /// 给收尾回调上保险：系统把这一轮判成空、或代理回调迟到（重启后尤其）时，到点自己还。
    /// 一直不还，系统会终止 App，之后也不再为这条会话唤醒。
    private static func armFinishEventsDeadline() {
        finishEventsTicket += 1
        let ticket = finishEventsTicket
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            guard finishEventsTicket == ticket, backgroundCompletion != nil else { return }
            finishBackgroundEvents()
        }
    }

    /// 跟系统对账：把系统里真实存在的分片任务认领回来，再补齐没下完的分片。
    /// 一个进程只做一次；`ensureAdoption` 也走这里，不碰系统的收尾回调。
    private static func adoptIfNeeded() {
        guard !sessionAdopted, !adopting else { return }
        adopting = true
        backgroundSession().getAllTasks { systemTasks in
            for task in systemTasks {
                guard let key = task.taskDescription, let split = splitKey(key) else {
                    task.cancel()
                    continue
                }
                /* 系统交回来的可能是一条已经删掉的任务，或者已经下完的分片：
                   先跟持久记录核对，对不上就取消，绝不写缓存、绝不改进度。 */
                guard let job = jobs[split.id],
                      job.phase == "segments",
                      split.index < job.segments.count,
                      !job.segments[split.index].done,
                      !paused.contains(split.id) else {
                    task.cancel()
                    continue
                }
                taskKeys[task.taskIdentifier] = key
                taskGenerations[task.taskIdentifier] = generation(for: split.id)
                inFlight.insert(key)
                if let downloadTask = task as? URLSessionDownloadTask {
                    tasks[task.taskIdentifier] = downloadTask
                }
            }
            /* 先记「本进程已跟系统对过账」再发任务：pump 里有同一道门，
               否则下面几个 pump 会把自己挡住。 */
            adopting = false
            sessionAdopted = true
            /* 磁盘对账：上一条进程里落了盘、但没来得及落库的分片，直接算完成，不重下。 */
            for id in Array(jobs.keys) where jobs[id]?.phase == "segments" {
                reconcileDisk(id: id)
            }
            var ids: Set<String> = []
            for key in taskKeys.values {
                if let split = splitKey(key) { ids.insert(split.id) }
            }
            for id in ids where jobs[id]?.phase == "segments" {
                pump(id: id)
            }
            /* 系统没把后台任务交回来的（进程被回收、任务已死）：只要记录还在下，就接着下。
               以前只 pump 拿到回调的那几条，剩下的 job 永远停在 segments、记录永远是 running，
               于是那两个并发名额被俩僵尸占着，后面全部卡在「排队中」。 */
            for id in Array(jobs.keys) where jobs[id]?.phase == "segments" {
                guard !paused.contains(id), MediaDownloader.isRunning(id: id) else { continue }
                if taskKeys.values.contains(where: { $0.hasPrefix(id + "#") }) { continue }
                pump(id: id)
            }
            /* 认领完、补发完就结束这一趟：收尾回调不在这儿还。
               等 delegate 把这一轮事件（分片搬盘、状态落库）处理干净，再走 urlSessionDidFinishEvents。 */
        }
    }

    /// 本进程还没跟系统对过账：先认领，认领完它自己接着发分片。
    private static func ensureAdoption() {
        adoptIfNeeded()
    }

    /// 这一轮后台事件真的处理完了：把系统回调还给系统，只许还一次。
    private static func finishBackgroundEvents() {
        guard let pending = backgroundCompletion else { return }
        backgroundCompletion = nil
        /* 作废还没到点的兜底票，免得它把下一轮事件的回调提前还掉。 */
        finishEventsTicket += 1
        pending()
    }

    /// 磁盘对账：`seg-<序号>.part` 是「整片下完才改名」的，存在即可认为这一片已完成。
    /// 进程在落库前一刻被系统杀掉时，磁盘和系统任务比 UserDefaults 新：按磁盘补齐，
    /// 补齐后整集都齐了就直接合成，不会停在一个「其实已经下完」的活儿上，也不重复下载。
    @discardableResult
    private static func reconcileDisk(id: String) -> Bool {
        ensureLoaded()
        guard let job = jobs[id], job.phase == "segments" else { return false }
        let directory = segmentDirectory(id: id)
        var recovered: [Int: Int64] = [:]
        for index in job.segments.indices where !job.segments[index].done {
            let path = directory.appendingPathComponent("seg-" + String(index) + ".part")
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path.path),
                  let number = attributes[.size] as? NSNumber,
                  number.int64Value > 0 else { continue }
            recovered[index] = number.int64Value
        }
        if !recovered.isEmpty {
            update(id) { current in
                for (index, size) in recovered where index < current.segments.count {
                    current.segments[index].done = true
                    current.segments[index].bytes = size
                    current.segments[index].attempts = 0
                }
            }
            report(id: id)
        }
        if let latest = jobs[id], latest.segments.allSatisfy({ $0.done }) {
            finalize(id: id)
        }
        return !recovered.isEmpty
    }

    // MARK: - 会话

    private static func backgroundSession() -> URLSession {
        if let existing = sessionStorage { return existing }
        let configuration = URLSessionConfiguration.background(withIdentifier: backgroundIdentifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        /* 并发上限交给系统：整集分片一次全部投递进后台队列，由系统按这个连接数排队连发。
           旧实现靠进程内的「空位」一片一片发，App 一挂起就没人发下一片（REG-032）。 */
        configuration.httpMaximumConnectionsPerHost = maxSegmentConcurrency
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.waitsForConnectivity = true
        let created = URLSession(configuration: configuration, delegate: shared, delegateQueue: OperationQueue.main)
        sessionStorage = created
        return created
    }

    /// 清单/密钥这种小请求：前台会话，回调直接落在主队列，状态机不用加锁。
    private static func foregroundSession() -> URLSession {
        if let existing = foregroundStorage { return existing }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        let created = URLSession(configuration: configuration, delegate: nil, delegateQueue: OperationQueue.main)
        foregroundStorage = created
        return created
    }

    // MARK: - 状态持久化

    private static func ensureLoaded() {
        if loaded { return }
        loaded = true
        guard let data = UserDefaults.standard.data(forKey: jobsKey),
              let decoded = try? JSONDecoder().decode([String: Job].self, from: data) else { return }
        jobs = decoded
    }

    private static func persist() {
        guard let data = try? JSONEncoder().encode(jobs) else { return }
        UserDefaults.standard.set(data, forKey: jobsKey)
    }

    private static func update(_ id: String, _ mutate: (inout Job) -> Void) {
        ensureLoaded()
        guard var job = jobs[id] else { return }
        mutate(&job)
        jobs[id] = job
        persist()
    }

    /// 分片投递计数加一：内存立刻生效，落盘按秒节流。
    /// 一次投递几百片时每片都整份写盘会卡住主线程，而 `attempts` 只服务本轮的重试上限，
    /// 进程被杀的极端情况最多丢一个重试额度（重启后会重新给满）。
    private static func bumpAttempts(id: String, index: Int) {
        ensureLoaded()
        guard var job = jobs[id], index < job.segments.count else { return }
        job.segments[index].attempts += 1
        jobs[id] = job
        let now = Date()
        guard now.timeIntervalSince(lastAttemptsPersist) >= 1 else { return }
        lastAttemptsPersist = now
        persist()
    }

    // MARK: - 开始 / 解析清单

    private static func begin(_ record: MediaDownloader.Record) {
        ensureLoaded()
        /* 每开始一次就换一代：上一次的清单/密钥回调即使晚到，也写不进这一次的 job。 */
        bumpGeneration(id: record.id)
        paused.remove(record.id)
        let referer = record.meta["referer"] ?? ""
        /* 旧实现只把 App 令牌（`ZhuijuAI/0.1.19 iOS`）当 UA 发给片源 CDN：
           UA 写死的 CDN 会直接 403/断连，网页（真浏览器 UA）却能播。
           网页交上来的是真浏览器 UA 就照用，否则用带 App 令牌的浏览器 UA。 */
        let supplied = (record.meta["userAgent"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let userAgent = supplied.contains("Mozilla/") ? supplied : MediaDownloader.mediaUserAgent
        if var existing = jobs[record.id], existing.manifestURL == record.url {
            /* 暂停过或被系统回收过：保留已下好的分片，接着来。 */
            existing.name = record.name
            existing.referer = referer
            existing.userAgent = userAgent
            jobs[record.id] = existing
            persist()
            resume(id: record.id)
            return
        }
        /* 同一个 id 换了清单地址（重试/换线）：旧的清单和分片缓存全部作废，
           不能拿上一份清单的分片下标去拼新视频。 */
        if jobs[record.id] != nil {
            cancelTasks(id: record.id)
            jobs.removeValue(forKey: record.id)
            try? FileManager.default.removeItem(at: segmentDirectory(id: record.id))
        }
        let job = Job(
            id: record.id,
            name: record.name,
            manifestURL: record.url,
            mediaURL: "",
            referer: referer,
            userAgent: userAgent,
            container: Container.mp4.rawValue,
            totalDuration: 0,
            segments: [],
            keys: [:],
            phase: "plan",
            createdAt: Date().timeIntervalSince1970
        )
        jobs[record.id] = job
        persist()
        plan(id: record.id)
    }

    private static func plan(id: String) {
        ensureLoaded()
        guard let job = jobs[id], job.phase == "plan" else { return }
        guard planning[id] == nil else { return }
        guard URL(string: job.manifestURL) != nil else {
            fail(id: id, reason: "这条线路的地址无效")
            return
        }
        let gen = generation(for: id)
        planning[id] = gen
        loadPlaylist(url: job.manifestURL, referer: job.referer, userAgent: job.userAgent, depth: 0) { result in
            /* 只有本代次的回调能清解析标记；旧回调不能给新清单开第二扇门。 */
            if planning[id] == gen { planning.removeValue(forKey: id) }
            guard Self.isCurrent(id: id, gen: gen), jobs[id]?.phase == "plan" else { return }
            switch result {
            case .failure(let failure):
                fail(id: id, reason: failure.reason)
            case .success(let loaded):
                apply(id: id, gen: gen, playlist: loaded.playlist, mediaURL: loaded.url)
            }
        }
    }

    private static func loadPlaylist(
        url: String,
        referer: String,
        userAgent: String,
        depth: Int,
        completion: @escaping (Result<(playlist: HLSPlaylist, url: String), HLSFailure>) -> Void
    ) {
        guard let link = URL(string: url) else {
            completion(.failure(HLSFailure(reason: "清单地址无效")))
            return
        }
        var request = URLRequest(url: link)
        if !referer.isEmpty { request.setValue(referer, forHTTPHeaderField: "Referer") }
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        foregroundSession().dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(HLSFailure(reason: "拿不到 HLS 清单：" + error.localizedDescription)))
                return
            }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                completion(.failure(HLSFailure(reason: "清单服务器返回 " + String(http.statusCode))))
                return
            }
            guard let data = data, let text = String(data: data, encoding: .utf8) else {
                completion(.failure(HLSFailure(reason: "清单内容读不出来")))
                return
            }
            let playlist = HLSParser.parse(text, baseURL: link)
            if playlist.isMaster {
                guard depth < maxPlaylistDepth else {
                    completion(.failure(HLSFailure(reason: "HLS 清单层级太深")))
                    return
                }
                guard let variant = HLSParser.bestVariant(playlist.variants) else {
                    completion(.failure(HLSFailure(reason: "清单里没有可用码率")))
                    return
                }
                loadPlaylist(url: variant.url.absoluteString, referer: referer, userAgent: userAgent, depth: depth + 1, completion: completion)
                return
            }
            guard !playlist.segments.isEmpty else {
                completion(.failure(HLSFailure(reason: "清单里没有可下载的分片")))
                return
            }
            completion(.success((playlist: playlist, url: link.absoluteString)))
        }.resume()
    }

    private static func apply(id: String, gen: Int, playlist: HLSPlaylist, mediaURL: String) {
        ensureLoaded()
        guard Self.isCurrent(id: id, gen: gen), let job = jobs[id], job.phase == "plan" else { return }
        var segments: [Segment] = []
        var pendingKeys: [String] = []
        for segment in playlist.segments {
            var keyURI = ""
            var keyIV = ""
            if let key = segment.key {
                guard key.isAES128 else {
                    fail(id: id, reason: "这条线路用了 " + key.method + " 加密，App 不能整集下载")
                    return
                }
                guard let uri = key.uri else {
                    fail(id: id, reason: "HLS 密钥地址缺失，没法解密")
                    return
                }
                keyURI = uri.absoluteString
                let iv = key.iv ?? HLSParser.defaultIV(sequence: segment.sequence)
                keyIV = iv.base64EncodedString()
                if job.keys[keyURI] == nil, !pendingKeys.contains(keyURI) {
                    pendingKeys.append(keyURI)
                }
            }
            segments.append(Segment(
                url: segment.url.absoluteString,
                duration: segment.duration,
                sequence: segment.sequence,
                byteRangeOffset: segment.byteRange?.offset ?? -1,
                byteRangeLength: segment.byteRange?.length ?? -1,
                keyURI: keyURI,
                keyIV: keyIV,
                isInitialization: segment.isInitialization,
                done: false,
                bytes: 0,
                attempts: 0
            ))
        }
        let container = playlist.container
        fetchKeys(pendingKeys, referer: job.referer, userAgent: job.userAgent) { result in
            /* 密钥请求可能比换清单慢：晚回来的旧密钥/旧分片列表一律不写新 job。 */
            guard Self.isCurrent(id: id, gen: gen) else { return }
            switch result {
            case .failure(let failure):
                fail(id: id, reason: failure.reason)
            case .success(let fetched):
                guard var job = jobs[id] else { return }
                for (uri, value) in fetched { job.keys[uri] = value }
                job.segments = segments
                job.mediaURL = mediaURL
                job.container = container
                job.totalDuration = playlist.totalDuration
                job.name = renamed(job.name, container: container)
                job.phase = "segments"
                jobs[id] = job
                persist()
                pump(id: id)
            }
        }
    }

    private static func fetchKeys(
        _ uris: [String],
        referer: String,
        userAgent: String,
        completion: @escaping (Result<[String: String], HLSFailure>) -> Void
    ) {
        if uris.isEmpty {
            completion(.success([:]))
            return
        }
        for uri in uris where URL(string: uri) == nil {
            completion(.failure(HLSFailure(reason: "HLS 密钥地址无效")))
            return
        }
        var results: [String: String] = [:]
        var remaining = uris.count
        var failure: String?
        for uri in uris {
            guard let link = URL(string: uri) else { continue }
            var request = URLRequest(url: link)
            if !referer.isEmpty { request.setValue(referer, forHTTPHeaderField: "Referer") }
            request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            foregroundSession().dataTask(with: request) { data, response, error in
                remaining -= 1
                if let error = error {
                    if failure == nil { failure = "拿不到 HLS 密钥：" + error.localizedDescription }
                } else if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                    if failure == nil { failure = "密钥服务器返回 " + String(http.statusCode) }
                } else if let data = data, data.count == 16 {
                    results[uri] = data.base64EncodedString()
                } else if failure == nil {
                    failure = "HLS 密钥长度不对"
                }
                guard remaining == 0 else { return }
                if let failure = failure {
                    completion(.failure(HLSFailure(reason: failure)))
                } else {
                    completion(.success(results))
                }
            }.resume()
        }
    }

    // MARK: - 分片调度

    /// 把这一集**所有**还没下完的分片一次性投递给系统后台队列。
    ///
    /// 旧实现按「空位」算：系统里最多只允许 4 条分片任务，下一片必须等进程内收到完成回调再发。
    /// App 一挂起就没有代码发新片——4 条传完队列就空了，进度自然不动（REG-032 的真机现象）。
    /// 现在并发由会话的 `httpMaximumConnectionsPerHost` 限制，任务本身归系统所有，
    /// App 挂起、锁屏时都由系统继续传。
    private static func pump(id: String) {
        ensureLoaded()
        guard let job = jobs[id], job.phase == "segments" else { return }
        guard !paused.contains(id) else { return }
        /* 还没跟系统对过账：先认领系统里已经在跑的分片，否则重启后会给同一片再发一条任务。 */
        guard sessionAdopted else {
            ensureAdoption()
            return
        }
        for index in job.segments.indices {
            let key = job.id + "#" + String(index)
            /* 有重试票的分片由它自己的定时器拉起，别的回调不能提前抢跑。 */
            if job.segments[index].done || inFlight.contains(key) || retryScheduled[key] != nil { continue }
            startSegment(id: id, index: index)
        }
    }

    private static func startSegment(id: String, index: Int) {
        ensureLoaded()
        guard let job = jobs[id], index < job.segments.count else { return }
        let key = id + "#" + String(index)
        /* 同一片绝不发第二条系统任务：pump 会被多个回调重入，这里再兜一层。 */
        guard !inFlight.contains(key) else { return }
        let segment = job.segments[index]
        guard let link = URL(string: segment.url) else {
            retry(id: id, index: index, reason: "分片地址无效")
            return
        }
        var request = URLRequest(url: link)
        if !job.referer.isEmpty { request.setValue(job.referer, forHTTPHeaderField: "Referer") }
        request.setValue(job.userAgent, forHTTPHeaderField: "User-Agent")
        if segment.byteRangeLength > 0, segment.byteRangeOffset >= 0 {
            let end = segment.byteRangeOffset + segment.byteRangeLength - 1
            request.setValue("bytes=" + String(segment.byteRangeOffset) + "-" + String(end), forHTTPHeaderField: "Range")
        }
        let task = backgroundSession().downloadTask(with: request)
        task.taskDescription = key
        tasks[task.taskIdentifier] = task
        taskKeys[task.taskIdentifier] = key
        taskGenerations[task.taskIdentifier] = generation(for: id)
        inFlight.insert(key)
        /* 这一片真的起来了，之前挂的票（含更早的定时器）全部作废。 */
        retryScheduled.removeValue(forKey: key)
        bumpAttempts(id: id, index: index)
        task.resume()
    }

    /// 分片失败：给这一片挂一张专属重试票。
    /// 有票期间 pump 不会抢跑；定时器要核对票号，被新一轮重试、暂停或删除顶掉的旧票不许动手。
    private static func retry(id: String, index: Int, reason: String) {
        ensureLoaded()
        let key = id + "#" + String(index)
        let gen = generation(for: id)
        inFlight.remove(key)
        guard Self.isCurrent(id: id, gen: gen),
              let job = jobs[id], index < job.segments.count, !job.segments[index].done else { return }
        guard !paused.contains(id) else { return }
        let attempts = job.segments[index].attempts
        guard attempts <= maxSegmentRetries else {
            fail(id: id, reason: "分片下载失败（" + reason + "），已重试 " + String(maxSegmentRetries) + " 次")
            return
        }
        retryTicket += 1
        let ticket = retryTicket
        retryScheduled[key] = ticket
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            ensureLoaded()
            guard retryScheduled[key] == ticket else { return }
            retryScheduled.removeValue(forKey: key)
            guard Self.isCurrent(id: id, gen: gen), !paused.contains(id),
                  let current = jobs[id],
                  current.phase == "segments",
                  index < current.segments.count,
                  !current.segments[index].done else { return }
            pump(id: id)
        }
    }

    private static func finish(key: String, taskIdentifier: Int, location: URL?, response: URLResponse?, error: Error?) {
        ensureLoaded()
        /* 先按系统任务号取出这次回调的代次：旧任务晚到时连 inFlight 都不能碰，
           否则会把同一 id 新任务的状态删掉。 */
        let callbackGeneration = taskGenerations.removeValue(forKey: taskIdentifier)
        tasks.removeValue(forKey: taskIdentifier)
        guard let liveKey = taskKeys.removeValue(forKey: taskIdentifier), liveKey == key else { return }
        guard let split = splitKey(key) else { return }
        let id = split.id
        let index = split.index
        if let callbackGeneration = callbackGeneration {
            guard isCurrent(id: id, gen: callbackGeneration) else { return }
        }
        inFlight.remove(key)
        retryScheduled.removeValue(forKey: key)
        guard let job = jobs[id], index < job.segments.count else { return }
        /* 删掉的任务、暂停的任务、已经下完的片：晚到的回调直接丢弃，
           不能复活任务，也不能再写缓存/进度。 */
        guard !paused.contains(id), !job.segments[index].done else { return }
        let nsError = error.map { $0 as NSError }
        if let nsError = nsError, nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            /* 用户暂停/删除/换页：不算分片失败，也不消耗重试次数。 */
            return
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            retry(id: id, index: index, reason: "分片服务器返回 " + String(http.statusCode))
            return
        }
        if let nsError = nsError {
            retry(id: id, index: index, reason: nsError.localizedDescription)
            return
        }
        guard let location = location else {
            retry(id: id, index: index, reason: "分片没有落地")
            return
        }
        let directory = segmentDirectory(id: id)
        let target = directory.appendingPathComponent("seg-" + String(index) + ".part")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: location, to: target)
        } catch {
            retry(id: id, index: index, reason: "分片写不进本机：" + error.localizedDescription)
            return
        }
        var size: Int64 = 0
        if let attributes = try? FileManager.default.attributesOfItem(atPath: target.path),
           let number = attributes[.size] as? NSNumber {
            size = number.int64Value
        }
        update(id) { job in
            guard index < job.segments.count else { return }
            job.segments[index].done = true
            job.segments[index].bytes = size
            job.segments[index].attempts = 0
        }
        report(id: id)
        guard let current = jobs[id] else { return }
        let finished = current.segments.allSatisfy { $0.done }
        if finished {
            finalize(id: id)
        } else {
            pump(id: id)
        }
    }

    /// 进度按「已完成的片」折算成字节上报：百分比就是已完成时长 / 总时长，
    /// 这样长剧集不会因为一两个大分片提前跳到 100%。
    private static func report(id: String) {
        ensureLoaded()
        guard let job = jobs[id] else { return }
        var bytes: Int64 = 0
        var duration = 0.0
        for segment in job.segments where segment.done {
            bytes += segment.bytes
            if !segment.isInitialization { duration += segment.duration }
        }
        var total = bytes
        if duration > 0, job.totalDuration > duration {
            total = Int64(Double(bytes) * job.totalDuration / duration)
        }
        MediaDownloader.hlsProgress(id: id, received: bytes, total: max(total, bytes))
    }

    // MARK: - 解密 / 合成

    private static func finalize(id: String) {
        ensureLoaded()
        let gen = generation(for: id)
        guard isCurrent(id: id, gen: gen), var job = jobs[id], job.phase == "segments" else { return }
        guard !finalizing.contains(id) else { return }
        finalizing.insert(id)
        job.phase = "finalize"
        jobs[id] = job
        persist()

        guard let directory = MediaDownloader.directory() else {
            finalizing.remove(id)
            fail(id: id, reason: "找不到本机下载目录")
            return
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            finalizing.remove(id)
            fail(id: id, reason: "下载目录建不出来：" + error.localizedDescription)
            return
        }
        let target = directory.appendingPathComponent(job.name)
        if FileManager.default.fileExists(atPath: target.path) {
            try? FileManager.default.removeItem(at: target)
        }
        guard FileManager.default.createFile(atPath: target.path, contents: nil),
              let handle = FileHandle(forWritingAtPath: target.path) else {
            finalizing.remove(id)
            fail(id: id, reason: "这个文件写不进去")
            return
        }
        let directoryOfSegments = segmentDirectory(id: id)
        for (index, segment) in job.segments.enumerated() {
            let source = directoryOfSegments.appendingPathComponent("seg-" + String(index) + ".part")
            do {
                var data = try Data(contentsOf: source)
                if !segment.keyURI.isEmpty {
                    guard let keyText = job.keys[segment.keyURI],
                          let key = Data(base64Encoded: keyText),
                          let iv = Data(base64Encoded: segment.keyIV),
                          let plain = decrypt(data: data, key: key, iv: iv) else {
                        try? handle.close()
                        try? FileManager.default.removeItem(at: target)
                        finalizing.remove(id)
                        fail(id: id, reason: "分片解密失败（密钥或 IV 不对）")
                        return
                    }
                    data = plain
                }
                try handle.write(contentsOf: data)
            } catch {
                try? handle.close()
                try? FileManager.default.removeItem(at: target)
                finalizing.remove(id)
                fail(id: id, reason: "合成这一集失败：" + error.localizedDescription)
                return
            }
        }
        do {
            try handle.close()
        } catch {
            finalizing.remove(id)
            fail(id: id, reason: "文件收尾失败：" + error.localizedDescription)
            return
        }
        var size: Int64 = 0
        if let attributes = try? FileManager.default.attributesOfItem(atPath: target.path),
           let number = attributes[.size] as? NSNumber {
            size = number.int64Value
        }
        /* 合成期间用户删了这一集：文件已经写出来了也不能通完成事件把记录复活。 */
        guard isCurrent(id: id, gen: gen) else {
            try? FileManager.default.removeItem(at: target)
            finalizing.remove(id)
            return
        }
        try? FileManager.default.removeItem(at: directoryOfSegments)
        jobs.removeValue(forKey: id)
        bumpGeneration(id: id)
        persist()
        finalizing.remove(id)
        MediaDownloader.hlsComplete(id: id, path: target.path, size: size, name: job.name)
    }

    private static func decrypt(data: Data, key: Data, iv: Data) -> Data? {
        guard key.count == Int(kCCKeySizeAES128), iv.count == Int(kCCBlockSizeAES128) else { return nil }
        var output = Data(count: data.count + Int(kCCBlockSizeAES128))
        let capacity = output.count
        var written = 0
        let status = output.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> CCCryptorStatus in
            data.withUnsafeBytes { (input: UnsafeRawBufferPointer) -> CCCryptorStatus in
                key.withUnsafeBytes { (keyBytes: UnsafeRawBufferPointer) -> CCCryptorStatus in
                    iv.withUnsafeBytes { (ivBytes: UnsafeRawBufferPointer) -> CCCryptorStatus in
                        CCCrypt(
                            CCOperation(kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES128),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress,
                            key.count,
                            ivBytes.baseAddress,
                            input.baseAddress,
                            data.count,
                            raw.baseAddress,
                            capacity,
                            &written
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { return nil }
        output.count = written
        return output
    }

    private static func fail(id: String, reason: String) {
        ensureLoaded()
        cancelTasks(id: id)
        jobs.removeValue(forKey: id)
        bumpGeneration(id: id)
        persist()
        try? FileManager.default.removeItem(at: segmentDirectory(id: id))
        MediaDownloader.hlsFail(id: id, reason: reason)
    }

    private static func cancelTasks(id: String) {
        let prefix = id + "#"
        for (identifier, key) in Array(taskKeys) where key.hasPrefix(prefix) {
            tasks[identifier]?.cancel()
            tasks.removeValue(forKey: identifier)
            taskKeys.removeValue(forKey: identifier)
            taskGenerations.removeValue(forKey: identifier)
            inFlight.remove(key)
        }
        /* 暂停/删除时把还没到点的重试票一并作废，旧定时器醒来会发现票号对不上。 */
        for key in Array(retryScheduled.keys) where key.hasPrefix(prefix) {
            retryScheduled.removeValue(forKey: key)
        }
    }

    // MARK: - 小工具

    private static func splitKey(_ text: String) -> (id: String, index: Int)? {
        guard let separator = text.lastIndex(of: "#") else { return nil }
        let id = String(text[text.startIndex..<separator])
        let raw = String(text[text.index(after: separator)...])
        guard !id.isEmpty, let index = Int(raw), index >= 0 else { return nil }
        return (id, index)
    }

    private static func renamed(_ raw: String, container: String) -> String {
        var base = (raw as NSString).deletingPathExtension
        if base.isEmpty { base = "video" }
        let suffix = "." + container
        let allowed = max(1, 120 - suffix.count)
        return String(base.prefix(allowed)) + suffix
    }

    private static func segmentDirectory(id: String) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        var safe = ""
        for character in id {
            if character.isLetter || character.isNumber || character == "-" || character == "_" {
                safe.append(character)
            } else {
                safe.append("_")
            }
        }
        return base
            .appendingPathComponent("hls", isDirectory: true)
            .appendingPathComponent(String(safe.prefix(80)), isDirectory: true)
    }
}

extension HLSDownloader: URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        /* 分片级别的字节回调不单独上报：进度按「已完成的片」算，见 report(id:)。 */
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let key = downloadTask.taskDescription else { return }
        Self.finish(key: key, taskIdentifier: downloadTask.taskIdentifier, location: location, response: downloadTask.response, error: nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error, let key = task.taskDescription else { return }
        Self.finish(key: key, taskIdentifier: task.taskIdentifier, location: nil, response: task.response, error: error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        /* 这一轮事件（含分片搬盘、状态落库）到这里才算处理完，现在才把系统回调还回去。 */
        Self.finishBackgroundEvents()
    }
}
