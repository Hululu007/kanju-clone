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
        path: String = "",
        url: String? = nil
    ) -> MediaDownloader.Record {
        var record = MediaDownloader.Record(
            id: id,
            url: url ?? "https://media.example/\(id).mp4",
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
        /* 起始记录指向受控慢速源：重启后队列要真的把任务交给系统，
           而不是拿一个不可达的域名去赌「失败得够慢」。 */
        try write([
            record("q1", epKey: "1", status: "queued", at: 1,
                   url: ControlledRaceSource.url("stall-relaunch-1.mp4").absoluteString),
            record("q2", epKey: "2", status: "queued", at: 2,
                   url: ControlledRaceSource.url("stall-relaunch-2.mp4").absoluteString),
            record("q3", epKey: "3", status: "queued", at: 3,
                   url: ControlledRaceSource.url("stall-relaunch-3.mp4").absoluteString),
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

// MARK: - REG-012 暂停 / 继续的异步竞态（真实后台 task + 进程外受控慢速源）

/// 竞态测试的片源：CI 里由 `ios/Tests/Fixtures/controlled_source.py` 在**进程外**启动。
///
/// 为什么不在测试进程里起 NWListener：iOS 14+ 的本地网络隐私会拦掉外部对 App 自身
/// 监听 socket 的入站连接（失败日志里就是紧跟 listener 启动的
/// `nw_listener_socket_inbox_create_socket setsockopt SO_NECP_LISTENUUID failed`
/// 加上 20 秒 received=0；同一后台会话连进程外的 python 源是正常的）。
/// 源进程只负责喂真实字节，传输仍然是系统的后台会话在做。
enum ControlledRaceSource {
    static let port: UInt16 = 8766
    static func url(_ name: String) -> URL {
        URL(string: "http://127.0.0.1:\(port)/\(name)")!
    }
    static var healthURL: URL { url("health") }
}

extension DownloadQueueTests {
    private struct SourceUnavailable: Error {}

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

    private func status(_ id: String) -> String {
        (saved(id)?["status"] as? String) ?? ""
    }

    private func taskIdentifier(_ id: String) -> Int {
        (saved(id)?["taskIdentifier"] as? NSNumber)?.intValue ?? 0
    }

    /// 受控源必须真的在跑：拿不到就明确失败，不用 skip 蒙混过去。
    private func requireControlledSource() throws {
        let sem = DispatchSemaphore(value: 0)
        var reachable = false
        var detail = "no response"
        var request = URLRequest(url: ControlledRaceSource.healthURL)
        request.timeoutInterval = 15
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error { detail = String(describing: error) }
            reachable = (response as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 20)
        guard reachable else {
            XCTFail("受控竞态源 \(ControlledRaceSource.healthURL) 不可达"
                    + "（CI 由 ios/Tests/Fixtures/controlled_source.py --port 8766 提供）：\(detail)")
            throw SourceUnavailable()
        }
    }

    /// 只有测试构建才有的投递延迟钩子：确定性地把「旧任务的取消回调」推到
    /// resume/cancel 之后才执行，用来复现真实用户连点时的顺序。
    private func setPendingCallbackDelay(_ value: TimeInterval) {
        MediaDownloader.testResumeDataCallbackDelay = value
    }

    private func startRace(_ downloader: MediaDownloader, id: String, path: String) {
        downloader.start(
            id: id,
            url: ControlledRaceSource.url(path),
            name: "\(id).mp4",
            meta: ["showId": "race", "epKey": "1", "epLabel": "第1集", "title": "测试剧"],
            onProgress: { _, _ in },
            onFinish: { _ in }
        )
    }

    /// 等真实后台任务收到第一批真实字节（拿到 resumeData 的前提）。
    private func waitForRealBytes(_ id: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(waitUntil { self.received(id) > 0 },
                      "受控源没有把任务推进到有数据的 running 状态：\(String(describing: saved(id)))",
                      file: file, line: line)
        XCTAssertTrue(waitUntil { self.taskIdentifier(id) > 0 },
                      "任务没有真实 taskIdentifier：\(String(describing: saved(id)))",
                      file: file, line: line)
    }

    /// 审核指出的核心竞态：pause 刚把状态改成 paused 并交给
    /// `cancel(byProducingResumeData:)`，用户立刻点继续 → 新任务已经建好，
    /// 旧任务的回调随后才回来。旧实现会把旧任务的 resumeData 写进这条**新**记录，
    /// 下次续传就会拿着错的数据去接。修复后：回调必须核对状态 + 任务身份（generation）。
    ///
    /// 分两段，因为竞态断言只在前半段成立时才有意义：
    /// 1. 先证明这个受控源真的能给出 resumeData（否则旧实现的 `guard let data` 直接早退，
    ///    两种实现看起来一样，红绿证据就成了假的）；
    /// 2. 再做「暂停后立刻继续」的竞态。
    func testPauseThenImmediateResumeNeverWritesTheOldTasksResumeDataIntoTheNewTask() throws {
        try requireControlledSource()
        defer { setPendingCallbackDelay(0) }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-stale", path: "stall-stale.mp4")
        waitForRealBytes("race-stale")

        /* 第一段：真暂停一次，必须拿到真实 resumeData（这是这一段的关键前提） */
        setPendingCallbackDelay(0)
        downloader.pause(showId: "race")
        XCTAssertEqual(status("race-stale"), "paused", "暂停要先落成 paused")
        let gotResumeData = waitUntil(timeout: 25) {
            (self.saved("race-stale")?["resumeData"] as? String)?.isEmpty == false
        }
        XCTAssertTrue(gotResumeData,
                      "受控源没有产生真实 resumeData（后台会话没给续传数据），竞态断言无从谈起："
                      + "\(String(describing: saved("race-stale")))")
        guard gotResumeData else { return }

        let beforeResume = received("race-stale")
        downloader.resume(showId: "race")
        XCTAssertTrue(waitUntil(timeout: 20) { self.status("race-stale") == "running" },
                      "从 resumeData 继续之后任务没有跑起来：\(String(describing: saved("race-stale")))")
        let resumedTask = taskIdentifier("race-stale")
        XCTAssertGreaterThan(resumedTask, 0, "继续后必须有真实任务：\(String(describing: saved("race-stale")))")
        /* 必须是**继续之后新收到的**字节：只看到旧进度就说明新任务其实还没传起来，
           那么下面那次暂停也拿不到 resumeData，竞态会被空跑过去。 */
        XCTAssertTrue(waitUntil(timeout: 30) { self.received("race-stale") > beforeResume },
                      "继续后的任务没有真的收到新字节：\(String(describing: saved("race-stale")))")

        /* 第二段：真正的竞态——暂停后立刻继续，旧任务的回调被推迟到新任务建好之后才回来 */
        MediaDownloader.testLastResumeDataBytes = -2
        setPendingCallbackDelay(1.0)
        downloader.pause(showId: "race")
        XCTAssertEqual(status("race-stale"), "paused", "第二轮暂停要先落成 paused")
        downloader.resume(showId: "race")
        XCTAssertTrue(waitUntil(timeout: 15) { self.status("race-stale") != "paused" },
                      "继续之后不能还停在暂停：\(String(describing: saved("race-stale")))")

        /* 给旧任务的异步回调足够时间回来（它必须被丢弃） */
        Thread.sleep(forTimeInterval: 2.5)
        /* 系统是否给了数据要如实记下来：这条真实传输测试负责「没被污染」，
           「有数据的旧任务晚到必须被丢弃」由下面的状态机测试确定性证明
           （模拟器里后台会话不一定在第二次取消时给出 resumeData，硬要求 >0 会变成
           在环境上赌运气，反而把真缺陷藏起来）。 */
        let carried = MediaDownloader.testLastResumeDataBytes
        XCTAssertNotEqual(carried, -2, "暂停回调还没到，竞态顺序根本没被复现（-2 = 没回调）")
        let record = saved("race-stale")
        XCTAssertNil(record?["resumeData"] as? String,
                     "旧任务的 resumeData 不能写进已经重新开始的新任务：\(String(describing: record))")
        XCTAssertNotEqual(record?["status"] as? String, "paused", "队列不能停在暂停：\(String(describing: record))")
        let secondTask = taskIdentifier("race-stale")
        XCTAssertGreaterThan(secondTask, 0, "继续后必须有真实任务：\(String(describing: record))")
        XCTAssertNotEqual(secondTask, resumedTask, "继续后应该是一条新任务（旧任务已取消）")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent, "并发不许超过上限")
        downloader.cancel(silent: true)
    }

    /// 片源不支持续传（拿不到 resumeData）：暂停 + 立即继续也必须能继续跑，
    /// 不许停在 paused，也不许写一个假的 resumeData 或假进度。
    func testPauseAndResumeWithoutResumeDataStillRestartsFromZeroAndNeverStalls() throws {
        try requireControlledSource()
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-nodata", path: "norange-nodata.mp4")
        waitForRealBytes("race-nodata")
        let firstTask = taskIdentifier("race-nodata")

        downloader.pause(showId: "race")
        XCTAssertEqual(status("race-nodata"), "paused", "暂停要先落成 paused")
        /* 系统给不出 resumeData：保持 paused、数据为空，绝不伪造 */
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertNil(saved("race-nodata")?["resumeData"] as? String, "不许伪造 resumeData")
        XCTAssertEqual(status("race-nodata"), "paused", "没有 resumeData 时仍是暂停态：\(String(describing: saved("race-nodata")))")

        downloader.resume(showId: "race")
        XCTAssertTrue(waitUntil(timeout: 15) { self.status("race-nodata") != "paused" },
                      "没有 resumeData 也必须能继续，不能停在暂停：\(String(describing: saved("race-nodata")))")
        XCTAssertTrue(waitUntil(timeout: 15) { self.taskIdentifier("race-nodata") != firstTask },
                      "继续后必须是新任务（从 0 重来）：\(String(describing: saved("race-nodata")))")
        XCTAssertNil(saved("race-nodata")?["resumeData"] as? String, "不许伪造 resumeData")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent)
        downloader.cancel(silent: true)
    }

    /// 反复暂停 / 继续：同一条记录、不重复入队、不超并发、最终还能跑。
    func testRepeatedPauseAndResumeKeepsOneRecordPerEpisodeAndNeverExceedsTheLimit() throws {
        try requireControlledSource()
        defer { setPendingCallbackDelay(0) }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-repeat", path: "stall-repeat.mp4")
        waitForRealBytes("race-repeat")

        setPendingCallbackDelay(0.4)
        for round in 0..<3 {
            downloader.pause(showId: "race")
            downloader.resume(showId: "race")
            Thread.sleep(forTimeInterval: 0.6)
            XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent,
                                     "第 \(round + 1) 轮暂停/继续后并发超限")
        }
        Thread.sleep(forTimeInterval: 1.5)
        guard let data = UserDefaults.standard.data(forKey: MediaDownloader.tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return XCTFail("状态没有落盘")
        }
        XCTAssertEqual(list.filter { ($0["id"] as? String) == "race-repeat" }.count, 1,
                       "同一集不能被暂停/继续复制成多条记录：\(list)")
        XCTAssertNotEqual(status("race-repeat"), "paused", "最后一轮继续后不该停在暂停")
        XCTAssertNil(saved("race-repeat")?["resumeData"] as? String, "反复操作不能留下旧 resumeData")
        downloader.cancel(silent: true)
    }

    /// 暂停后用户改成取消：晚到的 resumeData 回调不能再改状态、不能带完成路径。
    func testCancelWhileThePauseCallbackIsStillPendingStaysCancelled() throws {
        try requireControlledSource()
        defer { setPendingCallbackDelay(0) }
        let downloader = MediaDownloader()
        startRace(downloader, id: "race-cancel", path: "stall-cancel.mp4")
        waitForRealBytes("race-cancel")

        setPendingCallbackDelay(1.0)
        downloader.pause(showId: "race")
        downloader.cancel(showId: "race")
        Thread.sleep(forTimeInterval: 2.5)
        let record = saved("race-cancel")
        XCTAssertEqual(record?["status"] as? String, "cancelled",
                       "取消后晚到的回调不能改回暂停/运行：\(String(describing: record))")
        XCTAssertNil(record?["resumeData"] as? String, "取消后不该留续传数据：\(String(describing: record))")
        XCTAssertEqual(record?["path"] as? String ?? "", "", "取消的任务不能带完成路径")
        XCTAssertLessThanOrEqual(runningCount(), MediaDownloader.maxConcurrent)
    }
}

// MARK: - REG-012 状态机确定性证明（真实传输测试的补充，不是替身）

extension DownloadQueueTests {
    /// 直接落一条暂停记录，并把 generation 写成指定值（模拟「已经继续到第 N 代任务」）。
    private func seedPaused(_ id: String, generation: Int) throws {
        try write([
            record(id, status: "paused", url: "http://127.0.0.1:8766/stall-seed.mp4"),
        ])
        let data = try XCTUnwrap(UserDefaults.standard.data(forKey: MediaDownloader.tasksKey))
        var array = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        array[0]["generation"] = generation
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: array),
                                  forKey: MediaDownloader.tasksKey)
    }

    /// 审核指出的那一条，确定性版本：旧任务的回调带着**非空**数据回来时，
    /// 只要记录已经不是「暂停」或已经不是那条任务，就必须整条丢弃。
    func testALateResumeDataPayloadFromAnOlderTaskIsAlwaysDiscarded() throws {
        try seedPaused("sm-late", generation: 3)
        // 同一条任务、还是暂停态：数据必须留下（证明下面那条不是「什么都不写」也能过）
        MediaDownloader.testStoreResumeData(id: "sm-late", generation: 3, data: Data(repeating: 9, count: 128))
        XCTAssertNotNil(saved("sm-late")?["resumeData"] as? String,
                        "属于当前这条暂停任务的 resumeData 必须落盘：\(String(describing: saved("sm-late")))")

        // 用户已经继续：新任务 generation 变成 4，旧任务的 payload 必须被丢弃
        try seedPaused("sm-late", generation: 4)
        MediaDownloader.testStoreResumeData(id: "sm-late", generation: 3, data: Data(repeating: 9, count: 128))
        XCTAssertNil(saved("sm-late")?["resumeData"] as? String,
                     "旧任务（generation 3）的 resumeData 不能写进新任务（generation 4）：\(String(describing: saved("sm-late")))")

        // 用户已经取消：晚到的 payload 同样不能改状态、不能留数据
        try write([record("sm-late", status: "cancelled", url: "http://127.0.0.1:8766/stall-seed.mp4")])
        MediaDownloader.testStoreResumeData(id: "sm-late", generation: 0, data: Data(repeating: 9, count: 128))
        let cancelled = saved("sm-late")
        XCTAssertEqual(cancelled?["status"] as? String, "cancelled", "取消后晚到的回调不能改状态")
        XCTAssertNil(cancelled?["resumeData"] as? String, "取消后不该留续传数据：\(String(describing: cancelled))")
    }
}
