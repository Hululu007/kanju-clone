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

    func testCompletedDownloadIsRecordedAsDoneWithTheRealFile() {
        let done = expectation(description: "download finished")
        var failure: String?
        var calls = 0
        downloader.start(id: "bg-2", url: sampleURL, name: "bg-2.mp4", onProgress: { _, _ in }, onFinish: { result in
            calls += 1
            if case .failure(let error) = result { failure = error.message }
            done.fulfill()
        })
        wait(for: [done], timeout: 60)
        XCTAssertNil(failure, "本地测试服务器上的样例文件必须能下完：\(failure ?? "")")
        let record = storedRecord(id: "bg-2")
        XCTAssertEqual(record?["status"] as? String, "done", "完成态要落盘，否则回到 App 看不到结果：\(storedRecords())")
        let path = record?["path"] as? String ?? ""
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "完成的文件必须真的在沙盒里：\(path)")

        /* 重复回调不能再交一次结果（后台会话可能把同一条任务交回来两次） */
        let settled = expectation(description: "settled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { settled.fulfill() }
        wait(for: [settled], timeout: 5)
        XCTAssertEqual(calls, 1, "同一条任务的完成回调只能跑一次")
        XCTAssertEqual(storedRecord(id: "bg-2")?["status"] as? String, "done")
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
