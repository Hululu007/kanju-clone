import CryptoKit
import XCTest
@testable import ZhuijuAI

/// **真实后台会话**的集成回归（0.1.12 第 1 轮整改新增）。
///
/// 和 `DownloadBackgroundTests` 的分工：
/// - `DownloadBackgroundTests` 是单元测试：手工调用 delegate 只验「收尾那几步」，
///   **不能**证明后台传输本身（审核意见明确要求不得拿它当集成验证）。
/// - 这里不调用任何 delegate：任务交给 `URLSessionConfiguration.background`，
///   传输由系统的 `nsurlsessiond` 执行，delegate 由系统触发。测试只观察结果并断言
///   「任务 id / 媒体元数据 / 文件内容 hash / 完成记录 / 重连恢复」一致。
///
/// 受控源就是 CI 里 `python3 -m http.server 8765 --directory ios/Tests` 提供的
/// `sample.mp4`（工作流里用 ffmpeg 现生成），不联网。
///
/// 已知环境坑：headless CI 的模拟器里 `com.apple.nsurlsessiond` 偶尔没有就绪，
/// 后台会话会直接以 NSCocoaErrorDomain 4097（XPC 连不上）失败——那是**环境**问题，
/// 不是本地网络或产品逻辑问题（同一地址前台请求正常）。工作流里会先把该服务叫起来，
/// 并把 `launchctl print` 的结果打进日志，方便区分「环境没起来」和「传输真的错了」。
final class BackgroundTransferIntegrationTests: XCTestCase {
    private let tasksKey = "kj-ios-download-tasks"
    private let sourceURL = URL(string: "http://127.0.0.1:8765/sample.mp4")!

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: tasksKey)
    }

    override func tearDown() {
        MediaDownloader.shared.cancel(silent: true)
        UserDefaults.standard.removeObject(forKey: tasksKey)
        super.tearDown()
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func storedRecords() -> [[String: Any]] {
        guard let data = UserDefaults.standard.data(forKey: tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return list
    }

    private func storedRecord(id: String) -> [String: Any]? {
        storedRecords().first(where: { $0["id"] as? String == id })
    }

    /// 受控源是否可达 + 期望的文件内容（前台只用来取样，不参与后台验证）。
    private func expectedFile() throws -> (data: Data, digest: String) {
        let ready = expectation(description: "fixture source reachable")
        var body: Data?
        var failure = ""
        let task = URLSession.shared.dataTask(with: sourceURL) { data, response, error in
            if let error = error {
                failure = String(describing: error)
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                failure = "HTTP \(http.statusCode)"
            } else {
                body = data
            }
            ready.fulfill()
        }
        task.resume()
        wait(for: [ready], timeout: 60)
        XCTAssertEqual(failure, "", "受控测试源不可达（CI 的 127.0.0.1:8765 静态服务器），这不是产品问题")
        let data = try XCTUnwrap(body, "受控测试源没有内容")
        XCTAssertGreaterThan(data.count, 0)
        return (data, Self.sha256(data))
    }

    /// 系统跑完的真实后台下载：任务 id、媒体元数据、文件 hash、完成记录都必须对上。
    func testBackgroundSessionTransfersTheControlledFileAndRecordsItConsistently() throws {
        let expected = try expectedFile()
        let downloader = MediaDownloader()
        XCTAssertEqual(downloader.sessionConfiguration.identifier, MediaDownloader.backgroundIdentifier,
                       "必须真的用后台会话，不能用 URLSession.shared 冒充")
        XCTAssertTrue(downloader.sessionConfiguration.sessionSendsLaunchEvents,
                      "后台会话要允许系统把 App 拉起来收尾")

        let done = expectation(description: "background transfer finished")
        var outcome: Result<[String: Any], MediaDownloader.Failure>?
        downloader.start(
            id: "bg-real",
            url: sourceURL,
            name: "bg-real.mp4",
            meta: ["title": "百日谎言", "epLabel": "第19集", "total": "12", "epKey": "18"],
            onProgress: { _, _ in },
            onFinish: { result in
                outcome = result
                done.fulfill()
            }
        )
        /* 传输本身由系统的后台会话执行；这里只是等它回调。 */
        wait(for: [done], timeout: 180)

        guard case .success(let payload)? = outcome else {
            XCTFail("真实后台传输没有成功：\(String(describing: outcome))；记录=\(storedRecords())")
            return
        }
        let path = try XCTUnwrap(payload["path"] as? String)
        let fileURL = URL(fileURLWithPath: path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "后台跑完的文件必须落在沙盒里：\(path)")
        let downloaded = try Data(contentsOf: fileURL)
        XCTAssertEqual(downloaded.count, expected.data.count, "下载到的字节数必须和受控源一致")
        XCTAssertEqual(Self.sha256(downloaded), expected.digest, "下载到的内容 hash 必须和受控源一致（不是半截文件）")

        let record = try XCTUnwrap(storedRecord(id: "bg-real"), "完成记录必须落盘：\(storedRecords())")
        XCTAssertEqual(record["status"] as? String, "done")
        XCTAssertEqual(record["title"] as? String, "百日谎言", "媒体元数据要跟着任务一起留下")
        XCTAssertEqual(record["ep"] as? String, "第19集")
        XCTAssertEqual(record["path"] as? String, path)
        XCTAssertEqual((record["size"] as? NSNumber)?.int64Value, Int64(expected.data.count))
        let identifier = try XCTUnwrap(record["taskIdentifier"] as? Int)
        XCTAssertGreaterThan(identifier, 0, "任务 id 必须是系统真实分配的那个")

        /* 重连（新的下载器视图 = 冷启动后再看）必须和完成记录一致：状态还是 done，
           不允许被对账改成「系统中断」。 */
        let reconnected = MediaDownloader()
        let settled = expectation(description: "reconciled")
        reconnected.restore { settled.fulfill() }
        wait(for: [settled], timeout: 60)
        XCTAssertEqual(storedRecord(id: "bg-real")?["status"] as? String, "done",
                       "重连对账不能把已完成的后台任务改成中断：\(storedRecords())")

        /* 终态只交给网页一次，且事件里带着真实文件路径 */
        let events = reconnected.eventsForPage().filter { ($0["id"] as? String) == "bg-real" }
        XCTAssertEqual(events.count, 1, "完成事件要交给网页，而且只交一次：\(events)")
        XCTAssertEqual(events.first?["event"] as? String, "done")
        XCTAssertEqual(events.first?["path"] as? String, path)
        XCTAssertTrue(reconnected.eventsForPage().isEmpty, "同一条终态不能反复重放")
    }

    /// 后台会话必须按「真实任务」更新进度：进度事件来自系统回调，不是我们自己算的。
    func testBackgroundSessionReportsProgressBeforeItFinishes() throws {
        let expected = try expectedFile()
        XCTAssertGreaterThan(expected.data.count, 0)

        let downloader = MediaDownloader()
        let progressed = expectation(description: "progress reported by the session")
        progressed.assertForOverFulfill = false
        var sawProgress = false
        var seenBytes: Int64 = 0
        let done = expectation(description: "finished")
        downloader.start(
            id: "bg-progress",
            url: sourceURL,
            name: "bg-progress.mp4",
            onProgress: { received, _ in
                seenBytes = max(seenBytes, received)
                if !sawProgress {
                    sawProgress = true
                    progressed.fulfill()
                }
            },
            onFinish: { _ in done.fulfill() }
        )
        wait(for: [progressed, done], timeout: 180)
        XCTAssertTrue(sawProgress, "真实后台会话必须回报过进度：\(storedRecords())")
        XCTAssertEqual(seenBytes, Int64(expected.data.count), "最终收到的字节数要等于文件大小")
        /* 终态落盘比 onFinish 回调略晚一拍（后台会话的 finish 回调由系统投递），
           这里等到「落盘变 done」为止，而不是拿一个可能还没写下去的值断言——
           但确实必须变成 done，超过 20 秒还是 running 就是真缺陷。 */
        let doneStatus = waitForStoredStatus(id: "bg-progress", is: "done", timeout: 20)
        XCTAssertTrue(doneStatus,
                      "后台会话结束后状态必须落成 done，不能停在 \(String(describing: storedRecord(id: "bg-progress")?["status"]))：\(storedRecords())")
        XCTAssertEqual(storedRecord(id: "bg-progress")?["status"] as? String, "done")
        let finishedPath = try XCTUnwrap(storedRecord(id: "bg-progress")?["path"] as? String)
        XCTAssertTrue(FileManager.default.fileExists(atPath: finishedPath), "完成的文件必须真的在沙盒里：\(finishedPath)")
    }

    /// 轮询落盘状态：真实后台会话的完成事件和落盘之间有一拍先后，
    /// 断言前等到它真的到了，而不是把环境时序当成产品缺陷（也不放宽要求）。
    private func waitForStoredStatus(id: String, is expected: String, timeout: Double) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if storedRecord(id: id)?["status"] as? String == expected { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return storedRecord(id: id)?["status"] as? String == expected
    }
}
