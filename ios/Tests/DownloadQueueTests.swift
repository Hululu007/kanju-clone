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
