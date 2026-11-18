import XCTest

/// 出包关卡的第五项：选集页的**批量下载**。
///
/// 这一项只有在下载队列那条分支合入之后才可能通过，所以这里**不做 skip**：
/// 入口不存在就直接失败（并留下可访问性树），避免「悄悄跳过」被当成出包门槛全过。
///
/// run 44292507284 的两条真问题（本文件已按诊断树修正）：
/// 1. 旧代码在 `.any` 里找第一个含「一键全集/批量」的节点，实际 tap 到的却是
///    「从本集往后」；现在只按 **button role** + 精确 label 找真按钮。
/// 2. 旧代码用 `label CONTAINS "设置"` 的 `.any` 第一个匹配，tap 到了工具条的
///    「显示设置」（站点自己的面板），而按剧汇总的队列行渲染在注入层设置面板里
///    （`downloadRoot()`：只有 `[data-action="settings"]` 打开的那一张）。现在精确点「设置」。
///
/// 真实入队证据必须是原生队列快照算出来的「任务 x/y 集 · 进行中 n · 排队 n」，
/// 且 x/y 至少 2 集；仅有「已加入下载队列：N 集」这条桥接文案不算通过。
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

    /// 只按 button role 找；exact 用精确 label，避免「显示设置」冒充「设置」、
    /// 文本节点冒充「一键全集」。
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

    /// 一次性拍下网页可访问性树（逐条 element(boundBy:) 在 DOM 变化时会抛索引错）。
    private func labelTexts(_ app: XCUIApplication) -> [String] {
        let web = app.webViews.firstMatch
        guard web.exists, let snapshot = try? web.snapshot() else { return [] }
        var texts: [String] = []
        func walk(_ node: XCUIElementSnapshot) {
            texts.append([node.label, node.value as? String ?? "", node.identifier].joined(separator: " | "))
            for child in node.children { walk(child) }
        }
        walk(snapshot)
        return texts
    }

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

    /// 「任务 0/5 集 · 进行中 2 · 排队 3」这种由真实队列生成的行。
    /// 光有「已加入下载队列：5 集」不算：那只是点击时的桥接文案。
    private static func queueLine(_ text: String) -> Bool {
        guard text.contains("任务 "), text.contains("/"), text.contains(" 集") else { return false }
        return text.contains("进行中") || text.contains("排队") || text.contains("已暂停")
            || text.contains("全部完成") || text.contains("部分失败")
    }

    private static func queueTotal(_ text: String) -> Int? {
        guard let start = text.range(of: "任务 "),
              let slash = text.range(of: "/", range: start.upperBound..<text.endIndex),
              let end = text.range(of: " 集", range: slash.upperBound..<text.endIndex),
              let total = Int(text[slash.upperBound..<end.lowerBound].trimmingCharacters(in: .whitespaces)) else {
            return nil
        }
        return total
    }

    func testTheEpisodePageOffersABatchDownloadEntryThatReallyQueues() {
        let app = launchApp()
        if !app.webViews.firstMatch.waitForExistence(timeout: 60) {
            fail("受控夹具页没有加载", "batch-page", app)
            return
        }

        // 一键全集是主入口；若站点某版没有，再退到「下载已选」（仍按真按钮 role）。
        guard let entry = webButton(app, labels: ["一键全集", "下载已选"], timeout: 30) else {
            fail("选集页没有批量下载入口（一键全集 / 下载已选）：下载队列功能还没合入，这一项未完成",
                 "missing-batch-entry", app)
            return
        }
        entry.tap()

        // 打开注入层的设置面板（[data-action="settings"]），队列汇总只渲染在它的片库里。
        guard let settings = webButton(app, labels: ["设置"], exact: true, timeout: 30) else {
            fail("找不到「设置」入口，批量队列状态没法核对", "missing-settings", app)
            return
        }
        settings.tap()

        let line = waitForLabel(app, timeout: 60, Self.queueLine)
        guard let queue = line else {
            fail("点了批量下载之后没有看到真实队列进度（任务 x/y 集 · 进行中 n · 排队 n）",
                 "batch-queue-missing", app)
            return
        }
        guard let total = Self.queueTotal(queue), total >= 2 else {
            fail("队列行不是批量（少于 2 集）：\(queue)", "batch-not-multiple", app)
            return
        }
        // 片库里必须真的按剧出现（不是页面自己的选集按钮），并且至少两集记录。
        let texts = labelTexts(app)
        guard texts.contains(where: { $0.contains("测试剧") }) else {
            fail("下载片库里没有这一部剧（测试剧）", "batch-show-missing", app)
            return
        }
        let episodeChips = Set(texts.filter { $0.contains("第") && $0.contains("集") }
            .map { $0.trimmingCharacters(in: .whitespaces) })
        guard episodeChips.count >= 2 else {
            fail("下载片库里少于 2 条集记录：\(episodeChips)", "batch-episodes-missing", app)
            return
        }

        // 所有断言都成功后才拍最终图；失败时上面已留下诊断图 + 可访问性树。
        attachScreenshot("09-batch-download")
    }
}
