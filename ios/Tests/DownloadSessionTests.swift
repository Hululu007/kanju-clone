import UserNotifications
import XCTest
@testable import ZhuijuAI

/// 后台下载的第二组回归：会话本身、进程被回收后的对账、以及终态只交给网页一次。
///
/// 第一组（`DownloadBackgroundTests`）能跑在修复前的代码上并失败；这一组用到了
/// 0.1.12 新增的后台会话 API，所以只能和修复一起进 CI。
final class DownloadSessionTests: XCTestCase {
    private let tasksKey = "kj-ios-download-tasks"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: tasksKey)
    }

    override func tearDown() {
        MediaDownloader.shared.cancel(silent: true)
        UserDefaults.standard.removeObject(forKey: tasksKey)
        super.tearDown()
    }

    private func write(_ records: [[String: Any]]) throws {
        let data = try JSONSerialization.data(withJSONObject: records)
        UserDefaults.standard.set(data, forKey: tasksKey)
    }

    private func read() -> [[String: Any]] {
        guard let data = UserDefaults.standard.data(forKey: tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    private func record(_ id: String, status: String, delivered: Bool = false) -> [String: Any] {
        [
            "id": id, "url": "https://media.example/19.mp4", "name": "追剧AI_第19集.mp4",
            "title": "测试剧", "ep": "第19集", "meta": ["title": "测试剧", "total": "12"],
            "received": 0, "total": 0, "status": status, "path": "", "size": 0,
            "reason": "", "delivered": delivered, "taskIdentifier": 0, "updatedAt": 0,
        ]
    }

    func testDownloadSessionIsBackgroundAndNamedForRelaunch() {
        let configuration = MediaDownloader.shared.sessionConfiguration
        XCTAssertEqual(configuration.identifier, MediaDownloader.backgroundIdentifier, "后台会话标识是系统找回任务的唯一凭据")
        XCTAssertTrue(configuration.identifier == "org.dpdns.zhuiju.ios.downloads")
        XCTAssertTrue(configuration.sessionSendsLaunchEvents, "系统要能把 App 拉起来把后台下载收尾")
        XCTAssertFalse(configuration.isDiscretionary, "用户点完就在等这一集，不该交给系统慢慢调度")
    }

    /// 进程被回收后重新拉起：上一个进程留下的 running 任务如果已经不在了，
    /// 只能如实标记「系统中断」，绝不能标成完成。
    func testRelaunchMarksOrphanedTasksAsInterruptedInsteadOfDone() throws {
        try write([record("bg-orphan", status: "running")])
        let restored = MediaDownloader()
        let settled = expectation(description: "restored")
        restored.restore { settled.fulfill() }
        wait(for: [settled], timeout: 15)

        let saved = read().first(where: { $0["id"] as? String == "bg-orphan" })
        XCTAssertEqual(saved?["status"] as? String, "failed", "任务没了就是失败，不许标完成：\(read())")
        XCTAssertTrue((saved?["reason"] as? String ?? "").contains("中断"), "原因要写清楚：\(read())")
        XCTAssertEqual(saved?["delivered"] as? Bool, false, "这个终态还要交给网页")
    }

    /// 后台跑完的终态只交给网页一次（重复 sync 不能反复弹「下载完成」）。
    func testFinishedDownloadIsReplayedToThePageOnlyOnce() throws {
        try write([record("bg-done", status: "done")])
        let restored = MediaDownloader()
        let first = restored.eventsForPage()
        XCTAssertEqual(first.count, 1, "后台跑完的结果要在回到网页时补给它：\(first)")
        XCTAssertEqual(first.first?["event"] as? String, "done")
        XCTAssertEqual(first.first?["id"] as? String, "bg-done")
        let second = restored.eventsForPage()
        XCTAssertTrue(second.isEmpty, "同一条终态不能反复交给网页：\(second)")
    }

    /// 进度不是终态：还在跑的任务每次 sync 都可以再报一次当前百分比。
    func testRunningDownloadKeepsReportingProgress() throws {
        var running = record("bg-run", status: "running")
        running["received"] = 42
        running["total"] = 100
        try write([running])
        let downloader = MediaDownloader()
        let first = downloader.eventsForPage()
        let second = downloader.eventsForPage()
        XCTAssertEqual(first.first?["event"] as? String, "progress")
        XCTAssertEqual(first.first?["received"] as? Int64, 42)
        XCTAssertEqual(second.count, 1, "进度可以重复报：\(second)")
    }

    /// 本地通知是加分项：没有授权时下载照样完成，记录照样落盘。
    func testCompletionDoesNotDependOnNotificationPermission() throws {
        let center = UNUserNotificationCenter.current()
        let settings = expectation(description: "notification settings")
        var status: UNAuthorizationStatus = .notDetermined
        center.getNotificationSettings { value in
            status = value.authorizationStatus
            settings.fulfill()
        }
        wait(for: [settings], timeout: 10)

        try write([record("bg-notify", status: "done")])
        let downloader = MediaDownloader()
        let events = downloader.eventsForPage()
        XCTAssertEqual(events.first?["event"] as? String, "done",
                       "通知授权状态是 \(status.rawValue)，但与「下载完成」这件事无关")
    }
}
