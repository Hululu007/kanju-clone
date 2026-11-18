import Network
import XCTest
@testable import ZhuijuAI

/// 0.1.14 持久下载队列的回归（纯逻辑 + 落盘状态机，不联网）。
///
/// 真机/真后台传输由 `BackgroundTransferIntegrationTests` 覆盖；
/// 这里钉住的是队列本身的规则：
/// - 同时最多两条（并发上限）；
/// - 同一部剧同一集在排队/下载/暂停时不会重复入队；
/// - 一集失败绝不让整部剧看起来「全部完成」；
/// - 总字节未知时不编百分比；
/// - HLS / 网页地址 / 非视频扩展名如实拒绝；
/// - 暂停/继续/取消只动状态，已下载的文件不被删除；
/// - 重启后排队中的任务还会被调度。
final class DownloadQueueTests: XCTestCase {
    private var key: String { MediaDownloader.tasksKey }

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        MediaDownloader.shared.cancel(silent: true)
        UserDefaults.standard.removeObject(forKey: key)
        super.tearDown()
    }

    private func record(
        _ id: String,
        showId: String = "show-1",
        epKey: String = "1",
        status: String = "queued",
        received: Int64 = 0,
        total: Int64 = 0,
        at: Double = 0,
        path: String = ""
    ) -> MediaDownloader.Record {
        var record = MediaDownloader.Record(
            id: id,
            url: "https://media.example/\(id).mp4",
            name: "\(id).mp4",
            title: "测试剧",
            ep: "第\(epKey)集",
            meta: ["showId": showId, "epKey": epKey, "title": "测试剧"],
            received: received,
            total: total,
            status: status,
            path: path,
            size: 0,
            reason: "",
            delivered: false,
            taskIdentifier: 0,
            updatedAt: at
        )
        record.showId = showId
        record.epKey = epKey
        return record
    }

    private func write(_ list: [MediaDownloader.Record]) throws {
        UserDefaults.standard.set(try JSONEncoder().encode(list), forKey: key)
    }

    private func saved(_ id: String) -> [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return list.first { $0["id"] as? String == id }
    }

    // MARK: - 并发上限

    func testTheQueueNeverRunsMoreThanTwoDownloadsAtOnce() {
        let queued = (1...5).map { record("q\($0)", epKey: String($0), at: Double($0)) }
        XCTAssertEqual(MediaDownloader.maxConcurrent, 2, "用户要的是两集一起下，不是整部剧一起拉满")
        XCTAssertEqual(MediaDownloader.planStarts(queued).map(\.id), ["q1", "q2"], "先排队的先下，只占满两个位置")

        let oneRunning = [record("r1", epKey: "9", status: "running")] + queued
        XCTAssertEqual(MediaDownloader.planStarts(oneRunning).map(\.id), ["q1"], "已经有一条在跑，只再开一条")

        let twoRunning = [
            record("r1", epKey: "8", status: "running"),
            record("r2", epKey: "9", status: "running"),
        ] + queued
        XCTAssertTrue(MediaDownloader.planStarts(twoRunning).isEmpty, "两个位置都占着时不许再开第三条")
    }

    // MARK: - 去重

    func testTheSameShowEpisodeIsNeverQueuedTwiceWhileItIsStillActive() {
        let list = [
            record("a", epKey: "3", status: "queued"),
            record("b", epKey: "4", status: "running"),
            record("c", epKey: "5", status: "paused"),
        ]
        XCTAssertEqual(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "3"), 0)
        XCTAssertEqual(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "4"), 1)
        XCTAssertEqual(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "5"), 2)
        XCTAssertNil(MediaDownloader.duplicateIndex(in: list, showId: "show-2", epKey: "3"),
                     "另一部剧的同一集号不是同一集")
        XCTAssertNil(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "6"))
        XCTAssertNil(MediaDownloader.duplicateIndex(in: [], showId: "show-1", epKey: ""),
                     "没有集标识就不该按空值去重")
    }

    func testAFinishedOrFailedEpisodeCanBeDownloadedAgain() {
        let list = [
            record("done", epKey: "1", status: "done"),
            record("failed", epKey: "2", status: "failed"),
            record("cancelled", epKey: "3", status: "cancelled"),
        ]
        XCTAssertNil(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "1"))
        XCTAssertNil(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "2"))
        XCTAssertNil(MediaDownloader.duplicateIndex(in: list, showId: "show-1", epKey: "3"),
                     "失败/取消过的集必须还能重新下载")
    }

    // MARK: - 整部剧的进度

    func testOneFailedEpisodeNeverLetsTheWholeShowLookComplete() {
        let list = [
            record("a", epKey: "1", status: "done", received: 100, total: 100),
            record("b", epKey: "2", status: "done", received: 100, total: 100),
            record("c", epKey: "3", status: "failed"),
        ]
        let summary = MediaDownloader.summary(list, showId: "show-1")
        XCTAssertEqual(summary.done, 2)
        XCTAssertEqual(summary.failed, 1)
        XCTAssertTrue(summary.finished, "没有排队/在跑的任务就算跑完了")
        XCTAssertFalse(summary.allDone, "有一集失败就不能说整部剧全部完成")
    }

    func testAnUnknownLengthNeverProducesAFabricatedPercentage() {
        let list = [
            record("a", epKey: "1", status: "done", received: 700, total: 0),
            record("b", epKey: "2", status: "running", received: 300, total: 0),
        ]
        let summary = MediaDownloader.summary(list, showId: "show-1")
        XCTAssertFalse(summary.knownBytes, "服务器没给总长度时界面不许算百分比")
        XCTAssertEqual(summary.received, 1000, "只报真实收到的字节")
        XCTAssertFalse(summary.allDone)
    }

    // MARK: - 线路支持范围

    func testHlsPagesAndPlainHttpAreRejectedWithARealReason() {
        func reason(_ raw: String) -> String? {
            MediaDownloader.rejection(of: URL(string: raw)!)
        }
        XCTAssertNil(reason("https://media.example/19.mp4"))
        XCTAssertNil(reason("https://media.example/19.m4v"))
        XCTAssertNotNil(reason("https://media.example/19.m3u8"), "HLS 分片不能整集下载")
        XCTAssertTrue(reason("https://media.example/19.m3u8")!.contains("HLS"))
        XCTAssertNotNil(reason("https://zhuiju.dpdns.org/player/?id=show&ep=1"), "播放页不是视频")
        XCTAssertNotNil(reason("https://media.example/19.html"))
        XCTAssertNotNil(reason("http://media.example/19.mp4"), "明文 http 不在支持范围")
        XCTAssertNotNil(reason("blob:https://media.example/abc"))
        XCTAssertNotNil(reason("https://media.example/19.png"), "图片不是视频")
        XCTAssertNil(reason("http://127.0.0.1:8765/sample.mp4"),
                     "受控源是本机回环：CI 的真实后台传输就跑在这个地址上")
    }

    // MARK: - 暂停 / 继续 / 取消

    func testPauseMarksQueuedEpisodesPausedAndResumePutsThemBackInTheQueue() throws {
        try write([
            record("a", epKey: "1", status: "queued"),
            record("b", epKey: "2", status: "queued"),
            record("c", epKey: "3", status: "done", received: 10, total: 10),
        ])
        let downloader = MediaDownloader()
        downloader.pause(showId: "show-1")
        XCTAssertEqual(saved("a")?["status"] as? String, "paused")
        XCTAssertEqual(saved("b")?["status"] as? String, "paused")
        XCTAssertEqual(saved("c")?["status"] as? String, "done", "暂停不许改已完成的任务")

        downloader.resume(showId: "show-1")
        let resumed = [saved("a")?["status"] as? String, saved("b")?["status"] as? String]
        XCTAssertTrue(resumed.allSatisfy { $0 == "queued" || $0 == "running" }, "继续后要回到队列：\(resumed)")
        XCTAssertEqual(saved("c")?["status"] as? String, "done")
        downloader.cancel(showId: "show-1")
    }

    func testCancelStopsTheTasksButKeepsFilesThatAreAlreadyDownloaded() throws {
        let directory = try XCTUnwrap(MediaDownloader.directory())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("queue-cancel-kept.mp4")
        try Data(repeating: 5, count: 12).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }

        try write([
            record("kept", epKey: "1", status: "done", received: 12, total: 12, path: file.path),
            record("running", epKey: "2", status: "queued"),
        ])
        MediaDownloader().cancel(showId: "show-1")

        XCTAssertEqual(saved("kept")?["status"] as? String, "done", "取消只停任务，不改已完成的记录")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "取消不能删除已经下好的文件")
        XCTAssertEqual(saved("running")?["status"] as? String, "cancelled")
        XCTAssertEqual(saved("running")?["path"] as? String, "", "取消的任务不能带完成路径")
    }

    // MARK: - 重启恢复

    func testQueuedEpisodesAreScheduledAgainAfterARelaunch() throws {
        try write([
            record("q1", epKey: "1", status: "queued", at: 1),
            record("q2", epKey: "2", status: "queued", at: 2),
            record("q3", epKey: "3", status: "queued", at: 3),
        ])
        let downloader = MediaDownloader()
        let settled = expectation(description: "reconciled")
        downloader.restore { settled.fulfill() }
        wait(for: [settled], timeout: 20)

        let first = saved("q1")?["status"] as? String
        XCTAssertEqual(first, "running", "重启后队列要接着跑：\(String(describing: first))")
        XCTAssertTrue((saved("q1")?["taskIdentifier"] as? Int ?? 0) > 0, "任务要真的交给系统")
        downloader.cancel(silent: true)
    }

    func testANewQueueRecordCarriesTheShowAndEpisodeForDeduplication() throws {
        try write([record("old", status: "done", received: 10, total: 10)])
        let downloader = MediaDownloader()
        downloader.start(
            id: "new-1",
            url: URL(string: "https://media.example/7.mp4")!,
            name: "测试剧 第7集.mp4",
            meta: ["showId": "show-9", "epKey": "7", "epLabel": "第7集", "title": "测试剧"],
            onProgress: { _, _ in },
            onFinish: { _ in }
        )
        XCTAssertEqual(saved("new-1")?["showId"] as? String, "show-9")
        XCTAssertEqual(saved("new-1")?["epKey"] as? String, "7")
        XCTAssertEqual(saved("new-1")?["status"] as? String, "running")
        downloader.cancel(silent: true)
    }
}

// MARK: - REG-012 暂停 / 继续的异步竞态（真实运行 task + 可控回调顺序）

/// 受控"慢速"片源：先回 200/206 + 一小段字节，然后**故意不再发送**。
/// 这样 URLSession 的任务会稳定停在 running 且有已收字节（暂停时系统能给出真实
/// resumeData），测试可以自己决定 pause / resume 的先后，不受公网速度影响。
/// 这不是产品代码，只在测试目标里用。
final class StallingMediaServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "kanju.tests.stalling-server")
    private let lock = NSLock()
    private var connections: [NWConnection] = []
    private let supportsRange: Bool
    private let totalBytes = 2_000_000
    private let firstChunk = 40_000

    init(supportsRange: Bool) throws {
        self.supportsRange = supportsRange
        self.listener = try NWListener(using: .tcp, on: .any)
    }

    func start() throws -> UInt16 {
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self = self else { return }
            connection.start(queue: self.queue)
            self.lock.lock()
            self.connections.append(connection)
            self.lock.unlock()
            self.serve(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success, let port = listener.port else {
            throw NSError(domain: "StallingMediaServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "受控源没起来"])
        }
        return port.rawValue
    }

    func stop() {
        listener.cancel()
        lock.lock()
        let all = connections
        connections = []
        lock.unlock()
        for connection in all { connection.cancel() }
    }

    private func serve(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, error in
            guard let self = self, error == nil, let data = data,
                  let request = String(data: data, encoding: .utf8) else { return }
            let start = self.rangeStart(in: request)
            var header = "HTTP/1.1 \(start > 0 ? "206 Partial Content" : "200 OK")\r\n"
            header += "Content-Type: video/mp4\r\n"
            header += "Content-Length: \(self.totalBytes - start)\r\n"
            if self.supportsRange {
                header += "Accept-Ranges: bytes\r\n"
                if start > 0 {
                    header += "Content-Range: bytes \(start)-\(self.totalBytes - 1)/\(self.totalBytes)\r\n"
                }
            }
            header += "Connection: keep-alive\r\n\r\n"
            var payload = Data(header.utf8)
            payload.append(Data(repeating: 7, count: self.firstChunk))
            connection.send(content: payload, completion: .contentProcessed { _ in
                /* 有意不再发送：任务保持 running，等测试决定 pause / resume / cancel */
            })
        }
    }

    private func rangeStart(in request: String) -> Int {
        guard supportsRange else { return 0 }
        for line in request.split(separator: "\r\n") where line.lowercased().hasPrefix("range:") {
            guard let value = line.split(separator: "=").last,
                  let first = value.split(separator: "-").first,
                  let start = Int(first) else { return 0 }
            return start
        }
        return 0
    }
}

extension DownloadQueueTests {
    private func waitUntil(timeout: Double = 20, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return false
    }

    private func received(_ id: String) -> Int64 {
        (saved(id)?["received"] as? NSNumber)?.int64Value ?? 0
    }

    private func runningCount() -> Int {
        guard let data = UserDefaults.standard.data(forKey: MediaDownloader.tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return 0 }
        return list.filter { ($0["status"] as? String) == "running" }.count
    }

    private func startRace(_ downloader: MediaDownloader, id: String, port: UInt16) {
        downloader.start(
            id: id,
            url: URL(string: "http://127.0.0.1:\(port)/\(id).mp4")!,
            name: "\(id).mp4",
            meta: ["showId": "race", "epKey": "1", "epLabel": "第1集", "title": "测试剧"],
            onProgress: { _, _ in },
            onFinish: { _ in }
        )
    }

    /// 审核指出的核心竞态：pause 刚把状态改成 paused 并交给
    /// `cancel(byProducingResumeData:)`，用户立刻点继续 → 新任务已经建好，
    /// 旧任务的回调随后才回来。旧实现会把旧任务的 resumeData 写进这条**新**记录，
    /// 下次续传就会拿着错的数据去接。修复后：回调必须核对状态 + 任务身份（generation）。
    func testPauseThenImmediateResumeNeverWritesTheOldTasksResumeDataIntoTheNewTask() throws {
        let server = try StallingMediaServer(supportsRange: true)
        let port = try server.start()
        defer { server.stop() }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-stale", port: port)
        XCTAssertTrue(waitUntil { self.received("race-stale") > 0 },
                      "受控源没有把任务推进到有数据的 running 状态：\(String(describing: saved("race-stale")))")
        let firstTask = (saved("race-stale")?["taskIdentifier"] as? NSNumber)?.intValue ?? 0

        /* 用户连点：先暂停，立刻继续（旧任务的 cancel 回调还没回来） */
        downloader.pause(showId: "race")
        downloader.resume(showId: "race")
        XCTAssertTrue(waitUntil(timeout: 10) { (self.saved("race-stale")?["status"] as? String) != "paused" },
                      "继续之后不能还停在暂停：\(String(describing: saved("race-stale")))")

        /* 给旧任务的异步回调足够时间回来（它必须被丢弃） */
        Thread.sleep(forTimeInterval: 1.5)
        let record = saved("race-stale")
        XCTAssertNil(record?["resumeData"] as? String,
                     "旧任务的 resumeData 不能写进已经重新开始的新任务：\(String(describing: record))")
        XCTAssertNotEqual(record?["status"] as? String, "paused", "队列不能停在暂停：\(String(describing: record))")
        let secondTask = (record?["taskIdentifier"] as? NSNumber)?.intValue ?? 0
        XCTAssertGreaterThan(secondTask, 0, "继续后必须有真实任务：\(String(describing: record))")
        XCTAssertNotEqual(secondTask, firstTask, "继续后应该是一条新任务（旧任务已取消）")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent, "并发不许超过上限")
        downloader.cancel(silent: true)
    }

    /// 片源不支持续传（拿不到 resumeData）：暂停 + 立即继续也必须能继续跑，
    /// 不许停在 paused，也不许写一个假的 resumeData 或假进度。
    func testPauseAndResumeWithoutResumeDataStillRestartsFromZeroAndNeverStalls() throws {
        let server = try StallingMediaServer(supportsRange: false)
        let port = try server.start()
        defer { server.stop() }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-nodata", port: port)
        XCTAssertTrue(waitUntil { self.received("race-nodata") > 0 },
                      "受控源没有把任务推进到 running：\(String(describing: saved("race-nodata")))")

        downloader.pause(showId: "race")
        XCTAssertEqual(saved("race-nodata")?["status"] as? String, "paused", "暂停要先落成 paused")
        downloader.resume(showId: "race")
        XCTAssertTrue(waitUntil(timeout: 10) {
            let status = self.saved("race-nodata")?["status"] as? String
            return status == "running" || status == "queued"
        }, "没有 resumeData 也必须能继续，不能停在暂停：\(String(describing: saved("race-nodata")))")
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertNil(saved("race-nodata")?["resumeData"] as? String, "不许伪造 resumeData")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent)
        downloader.cancel(silent: true)
    }

    /// 反复暂停 / 继续：同一条记录、不重复入队、不超并发、最终还能跑。
    func testRepeatedPauseAndResumeKeepsOneRecordPerEpisodeAndNeverExceedsTheLimit() throws {
        let server = try StallingMediaServer(supportsRange: true)
        let port = try server.start()
        defer { server.stop() }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-repeat", port: port)
        XCTAssertTrue(waitUntil { self.received("race-repeat") > 0 }, "受控源没有把任务推进到 running")

        for round in 0..<3 {
            downloader.pause(showId: "race")
            downloader.resume(showId: "race")
            Thread.sleep(forTimeInterval: 0.2)
            XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent,
                                     "第 \(round + 1) 轮暂停/继续后并发超限")
        }
        Thread.sleep(forTimeInterval: 1.0)
        guard let data = UserDefaults.standard.data(forKey: MediaDownloader.tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return XCTFail("状态没有落盘")
        }
        XCTAssertEqual(list.filter { ($0["id"] as? String) == "race-repeat" }.count, 1,
                       "同一集不能被暂停/继续复制成多条记录：\(list)")
        XCTAssertNotEqual(saved("race-repeat")?["status"] as? String, "paused", "最后一轮继续后不该停在暂停")
        XCTAssertNil(saved("race-repeat")?["resumeData"] as? String, "反复操作不能留下旧 resumeData")
        downloader.cancel(silent: true)
    }

    /// 暂停后用户改成取消：晚到的 resumeData 回调不能再改状态、不能带完成路径。
    func testCancelWhileThePauseCallbackIsStillPendingStaysCancelled() throws {
        let server = try StallingMediaServer(supportsRange: true)
        let port = try server.start()
        defer { server.stop() }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-cancel", port: port)
        XCTAssertTrue(waitUntil { self.received("race-cancel") > 0 }, "受控源没有把任务推进到 running")

        downloader.pause(showId: "race")
        downloader.cancel(showId: "race")
        Thread.sleep(forTimeInterval: 1.5)
        let record = saved("race-cancel")
        XCTAssertEqual(record?["status"] as? String, "cancelled", "取消后晚到的回调不能改回暂停/运行：\(String(describing: record))")
        XCTAssertNil(record?["resumeData"] as? String, "取消后不该留续传数据：\(String(describing: record))")
        XCTAssertEqual(record?["path"] as? String ?? "", "", "取消的任务不能带完成路径")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent)
    }
}
