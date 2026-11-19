import XCTest

/// 新版单集下载页和「我的下载」出包门禁。
///
/// 出包时通过真实播放页入口下载一集，再验证它落到「我的下载」列表。
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

    private func attachScreenshot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func attachDiagnostics(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "diagnostic-" + name
        shot.lifetime = .keepAlways
        add(shot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "diagnostic-tree-" + name
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func fail(_ message: String, _ name: String, _ app: XCUIApplication) {
        attachDiagnostics(app, name: name)
        XCTFail(message)
    }

    /// 只按 button role 找，避免文本节点冒充可操作按钮。
    private func webButton(_ app: XCUIApplication, labels: [String], exact: Bool = true,
                           timeout: TimeInterval = 20) -> XCUIElement? {
        let buttons = app.buttons
        let predicates = labels.map {
            NSPredicate(format: exact ? "label == %@" : "label CONTAINS %@", $0)
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for predicate in predicates {
                let candidate = buttons.matching(predicate).firstMatch
                if candidate.exists && candidate.isHittable { return candidate }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return nil
    }

    /// 一次性拍下网页可访问性树，避免 DOM 变化时索引失效。
    private func labelTexts(_ app: XCUIApplication) -> [String] {
        var texts: [String] = []
        for node in webLabels(app) {
            texts.append([node.label, node.value as? String ?? "", node.identifier].joined(separator: " | "))
        }
        return texts
    }

    /// 收集页面当前可读文案供断言使用。
    private func webLabels(_ app: XCUIApplication) -> [XCUIElementSnapshot] {
        let web = app.webViews.firstMatch
        guard web.exists, let snapshot = try? web.snapshot() else { return [] }
        var nodes: [XCUIElementSnapshot] = []
        func walk(_ node: XCUIElementSnapshot) {
            nodes.append(node)
            for child in node.children { walk(child) }
        }
        walk(snapshot)
        return nodes
    }

    /// 这个文案在网页可访问性树里出现在几个节点上（页面选集按钮一个、片库集标签一个）。
    /// 用包含匹配：片库的集标签可能被合成成一行，但不论哪一种，页面那边只会算一个。
    private func waitForLabel(_ app: XCUIApplication, timeout: TimeInterval,
                              _ accept: (String) -> Bool) -> String? {
        guard app.webViews.firstMatch.waitForExistence(timeout: timeout) else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for text in labelTexts(app) where accept(text) { return text }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return nil
    }

    /// 真队列跑到这一集写入片库。
    func testTheEpisodePageOffersSingleDownloadAndShowsItsLibraryEntry() {
        let app = launchApp()
        if !app.webViews.firstMatch.waitForExistence(timeout: 60) {
            fail("受控夹具页没有加载", "single-download-page", app)
            return
        }

        let legacy = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "一键全集")).firstMatch
        XCTAssertFalse(legacy.exists, "新版下载页不得显示旧的一键全集按钮")
        guard let entry = webButton(app, labels: ["下载"], exact: false, timeout: 30) else {
            fail("播放页标题旁没有单集下载入口", "missing-single-download-entry", app)
            return
        }
        entry.tap()
        guard let episode = webButton(app, labels: ["第19集"], exact: false, timeout: 30) else {
            fail("单集下载页没有第19集", "missing-single-episode", app)
            return
        }
        attachScreenshot("09-download-page")
        episode.tap()
        guard let downloads = webButton(app, labels: ["查看下载列表"], exact: true, timeout: 30) else {
            fail("下载页没有查看下载列表入口", "missing-my-downloads-entry", app)
            return
        }
        downloads.tap()
        let evidence = waitForLabel(app, timeout: 60) { $0.contains("第19集") && $0.contains("已下载") }
        guard evidence != nil, labelTexts(app).contains(where: { $0.contains("测试剧") }) else {
            fail("我的下载页没有测试剧第19集记录：\(labelTexts(app))", "single-library-missing", app)
            return
        }
        attachScreenshot("10-my-downloads-single-episode")
    }
}
