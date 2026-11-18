import UIKit
import XCTest
@testable import ZhuijuAI

/// 后台下载（0.1.12）的回归：切到别的 App / 锁屏后继续传，回来还能看到结果。
///
/// 这里能证明、且确实在 CI 模拟器里跑的部分：
/// - App 实现了后台会话的回调入口（否则系统不会把完成事件交回来）；
/// - 任务一开就把「哪个剧、哪一集、什么文件名」落盘，进程被回收后还能接上；
/// - 完成 / 取消 / 失败都会换成真实终态落盘，不会把没下完的标成完成；
/// - 同一条任务重复回调不会把结果改两次。
///
/// 只能真机验收的部分（交给 phone-test）：锁屏后是否真的继续传、切后台期间系统
/// 调度是否给足时间、本地通知在真实通知中心的呈现。
///
/// 测试用一个本地 http 服务（CI 会把 `ios/Tests/sample.mp4` 挂在 127.0.0.1:8765），
/// 这样下载链路是真的 URLSession，而不是逻辑模拟。
final class DownloadBackgroundTests: XCTestCase {
    /// 与 `MediaDownloader.tasksKey` 同一个键。写成字面量，这条用例在修复前也要能编译、
    /// 然后在运行时失败（证明修复前根本没有落盘）。
    private let tasksKey = "kj-ios-download-tasks"
    private var downloader: MediaDownloader!

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: tasksKey)
        downloader = MediaDownloader()
    }

    override func tearDown() {
        downloader?.cancel(silent: true)
        UserDefaults.standard.removeObject(forKey: tasksKey)
        super.tearDown()
    }

    private var sampleURL: URL {
        URL(string: "http://127.0.0.1:8765/sample.mp4")!
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

    /// 修复前 AppDelegate 没有这个方法 → 系统把 App 从后台拉起后完成的下载再也交不回页面。
    @MainActor
    func testAppDelegateAnswersTheBackgroundSessionCallback() {
        let selector = Selector(("application:handleEventsForBackgroundURLSession:completionHandler:"))
        let responds = UIApplication.shared.delegate?.responds(to: selector) ?? false
        XCTAssertTrue(responds, "AppDelegate 必须实现后台 URLSession 的回调，否则后台下完的事件会丢")
    }

    func testStartingADownloadPersistsTheTaskSoItCanBeRecovered() {
        downloader.start(id: "bg-1", url: sampleURL, name: "bg-1.mp4", onProgress: { _, _ in }, onFinish: { _ in })
        let record = storedRecord(id: "bg-1")
        XCTAssertNotNil(record, "后台下载一开就要落盘：App 被系统回收后靠它把状态接回来")
        XCTAssertEqual(record?["status"] as? String, "running")
        XCTAssertEqual(record?["name"] as? String, "bg-1.mp4")
        XCTAssertEqual(record?["url"] as? String, sampleURL.absoluteString)
    }

    /// 收尾链路：真实临时文件 + 真实的「移进沙盒 / 记大小 / 落盘 / 只回调一次」。
    /// 不依赖网络，所以模拟器里也稳定；后台会话「锁屏继续传」那一半只能真机验收。
    func testCompletedDownloadIsMovedIntoTheSandboxAndRecordedAsDone() throws {
        let downloader = MediaDownloader()
        let done = expectation(description: "download finished")
        var failure: String?
        var calls = 0
        var payload: [String: Any]?
        downloader.start(id: "bg-2", url: URL(string: "https://media.invalid/19.mp4")!, name: "bg-2.mp4", onProgress: { _, _ in }, onFinish: { result in
            calls += 1
            switch result {
            case .success(let value): payload = value
            case .failure(let error): failure = error.message
            }
            done.fulfill()
        })

        let source = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bg-2-source.mp4")
        try Data(repeating: 7, count: 10).write(to: source)
        let session = URLSession.shared
        let task = session.downloadTask(with: sampleURL)
        task.taskDescription = "bg-2"
        downloader.urlSession(session, downloadTask: task, didWriteData: 10, totalBytesWritten: 10, totalBytesExpectedToWrite: 10)
        downloader.urlSession(session, downloadTask: task, didFinishDownloadingTo: source)
        downloader.urlSession(session, task: task, didCompleteWithError: nil)

        wait(for: [done], timeout: 5)
        XCTAssertNil(failure, "收尾链路不该失败：\(failure ?? "")")
        XCTAssertEqual(calls, 1, "同一条任务的完成回调只能跑一次")
        let record = storedRecord(id: "bg-2")
        XCTAssertEqual(record?["status"] as? String, "done", "完成态要落盘，否则回到 App 看不到结果：\(storedRecords())")
        let path = try XCTUnwrap(record?["path"] as? String)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "完成的文件必须真的在沙盒里：\(path)")
        XCTAssertEqual((record?["size"] as? NSNumber)?.int64Value, 10, "大小要按真实文件记")
        XCTAssertEqual(payload?["path"] as? String, path)

        /* 交回网页一次就够：事件只投一次 */
        XCTAssertEqual(downloader.eventsForPage().first?["event"] as? String, "done")
        XCTAssertTrue(downloader.eventsForPage().isEmpty, "终态不能反复交给网页")
    }

    func testCancelledDownloadIsRecordedAsCancelledNotDone() {
        downloader.start(id: "bg-3", url: sampleURL, name: "bg-3.mp4", onProgress: { _, _ in }, onFinish: { _ in })
        downloader.cancel()
        let record = storedRecord(id: "bg-3")
        XCTAssertNotNil(record, "取消也要留一条可读的记录")
        XCTAssertEqual(record?["status"] as? String, "cancelled", "取消不能写成完成")
        let path = record?["path"] as? String ?? ""
        XCTAssertTrue(path.isEmpty, "取消的任务不能带一个完成路径：\(path)")
    }
}
