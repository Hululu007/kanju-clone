import XCTest

/// 出包关卡的第五项：选集页的**批量下载**。
///
/// 这一项只有在下载队列那条分支合入之后才可能通过，所以这里**不做 skip**：
/// 入口不存在就直接失败（并留下可访问性树），避免「悄悄跳过」被当成出包门槛全过。
///
/// 审核意见（0.1.14 第 2 轮）已修：点完批量入口**先拿到真实入队状态再截图**，
/// 截图里必须能看到「任务 x/y 集 · 进行中 n · 排队 n」这种由真实队列算出来的行，
/// 而不是 tap 之后立刻拍一张看起来差不多的画面。
@MainActor
final class BatchDownloadSmokeUITests: XCTestCase {
    private let fixtureBase = "http://127.0.0.1:8765"

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KJ_TEST_HOME_URL"] = fixtureBase + "/player/index.html?id=demo&ep=19"
        app.launch()
        app.activate()
        return app
    }

    private func labels(of element: XCUIElement) -> String {
        [element.label, element.value as? String ?? "", element.identifier].joined(separator: " | ")
    }

    /// 在页面里轮询任意满足条件的可访问性文案。
    private func waitForLabel(_ app: XCUIApplication, timeout: TimeInterval,
                              _ accept: (String) -> Bool) -> String? {
        let web = app.webViews.firstMatch
        guard web.waitForExistence(timeout: timeout) else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let all = web.descendants(matching: .any)
            for index in 0..<all.count {
                let text = labels(of: all.element(boundBy: index))
                if accept(text) { return text }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        return nil
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTheEpisodePageOffersABatchDownloadEntryThatReallyQueues() throws {
        let app = launchApp()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "受控夹具页没有加载")

        let names = ["一键全集", "批量下载", "下载已选", "从本集往后", "批量"]
        let deadline = Date().addingTimeInterval(30)
        var entry: XCUIElement?
        while Date() < deadline && entry == nil {
            for name in names {
                let candidate = web.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
                if candidate.exists { entry = candidate; break }
            }
            if entry == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.4)) }
        }

        guard let entry else {
            let dump = XCTAttachment(string: app.debugDescription)
            dump.name = "missing-batch-entry"
            dump.lifetime = .keepAlways
            add(dump)
            XCTFail("选集页没有批量下载入口（一键全集 / 下载已选 / 从本集往后）：下载队列功能还没合入，这一项未完成")
            return
        }

        entry.tap()

        /* 真实入队证据：设置面板里按剧算出来的队列行（任务 done/total 集 · 进行中 N · 排队 N）。
           没有它就不截图——截图必须是「批量真的进队列」的那一刻。 */
        var opened = false
        if let settings = waitForLabel(app, timeout: 20, { $0.contains("设置") }) {
            let candidate = web.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "设置")).firstMatch
            if candidate.exists, candidate.isHittable {
                candidate.tap()
                opened = true
            }
            _ = settings
        }
        XCTAssertTrue(opened, "找不到设置入口，批量队列状态没法核对")

        let queueLine = waitForLabel(app, timeout: 60) { text in
            text.contains("任务 ") && text.contains("/") && (text.contains("进行中") || text.contains("排队"))
        }
        XCTAssertNotNil(queueLine,
                        "点了批量下载之后没有看到真实队列进度（任务 x/y 集 · 进行中 n · 排队 n）：\(app.debugDescription)")
        let episodeSeen = waitForLabel(app, timeout: 30) { $0.contains("第19集") }
        XCTAssertNotNil(episodeSeen, "队列里没有这一集（第19集）：\(app.debugDescription)")

        attach(app, name: "09-batch-download")
    }
}
