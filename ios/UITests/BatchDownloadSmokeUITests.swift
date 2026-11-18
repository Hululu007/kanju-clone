import XCTest

/// 出包关卡的第五项：选集页的**批量下载**。
///
/// 这一项只有在下载队列那条分支合入之后才可能通过，所以这里**不做 skip**：
/// 入口不存在就直接失败（并留下可访问性树），避免「悄悄跳过」被当成出包门槛全过。
/// 阶段分支（还没合入队列）跑出这一条红，是如实结果，不是回退。
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
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "09-batch-download"
        shot.lifetime = .keepAlways
        add(shot)

        let queued = web.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "排队", "下载中")).firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 30), "点了批量下载之后没有看到队列状态（排队/下载中）")
    }
}
