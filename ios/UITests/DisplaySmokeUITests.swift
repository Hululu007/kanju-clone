import XCTest

/// 出包关卡：在模拟器里**启动真 App**、真点页面、逐张截图。
///
/// 和 `ios/Tests/` 里那些用例的分工：那边是「注入层逻辑 + 真 WKWebView」，这里是
/// 「原生外壳 + 起始地址 + 旋转 + 下载桥 + 设置面板」整条链路，而且每一步都留下
/// `XCUIScreen.main.screenshot()`（`lifetime = .keepAlways`，由 workflow 导出 PNG 上传）。
///
/// 页面来自同机受控夹具站（`ios/UITests/Fixtures/fixture_server.py`，端口 8765）：
/// 没有账号、不连公网，但片源是真的 mp4 —— 截图里必须有画面，不接受空白。
///
/// 起始地址通过 `KJ_TEST_HOME_URL` 传给 App（只在 Debug 构建里读，见 `KJTestLaunch.swift`）。
@MainActor
final class DisplaySmokeUITests: XCTestCase {
    private let fixtureBase = "http://127.0.0.1:8765"
    private let playerPath = "/player/index.html?id=demo&ep=19"

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KJ_TEST_HOME_URL"] = fixtureBase + playerPath
        app.launch()
        app.activate()
        return app
    }

    /// 每一步都留一张原图：名字固定、有序号，导出后就是 `01-playing.png` 这种。
    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachDiagnostics(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// 网页里的按钮：注入层挂的是 `<button>`，文字/aria-label 都会被读出来。
    /// 找不到就先把可访问性树留下来，省得靠猜。
    private func webElement(_ app: XCUIApplication, matching labels: [String], timeout: TimeInterval = 30) -> XCUIElement? {
        let web = app.webViews.firstMatch
        if !web.waitForExistence(timeout: timeout) { return nil }
        let predicates = labels.flatMap { label in
            [NSPredicate(format: "label == %@", label), NSPredicate(format: "label CONTAINS %@", label)]
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for predicate in predicates {
                let candidate = web.descendants(matching: .any).matching(predicate).firstMatch
                if candidate.exists {
                    return candidate
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        return nil
    }

    /// 沉浸态下控制栏会自己收起；点一下画面把它叫回来。
    private func revealControls(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42)).tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    }

    /// 轮询任意满足条件的可访问性文案：用来把「真的进队列/真的落成完成」和
    /// 页面上常驻的按钮文案区分开（审核意见：单集那条 assert 以前会匹配到「下载本集」本身）。
    /// 把网页的可访问性树一次性拍成文本（不再逐条解析元素）。
    /// 逐条 `element(boundBy:)` / `allElementsBoundByIndex` 在 DOM 变化时会抛
    /// 「No matches found for Element at index N」——那是测试自己的脆弱，不是产品问题。
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
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        return nil
    }

    private func requireWebElement(_ app: XCUIApplication, _ labels: [String], _ what: String,
                                   timeout: TimeInterval = 30) throws -> XCUIElement {        guard let element = webElement(app, matching: labels, timeout: timeout) else {
            attachDiagnostics(app, name: "missing-" + what)
            XCTFail("页面上找不到「\(labels.joined(separator: " / "))」（\(what)）")
            throw XCTSkip("已在上面记为失败")
        }
        return element
    }

    // MARK: - 主链路：播放 → 下载本集 → 全屏三档 → 设置里的下载列表

    func testTheAppPlaysDownloadsAndShootsEveryFitMode() throws {
        let app = launchApp()

        // 01 播放：点夹具页自己的播放按钮，视频真的开始播（控制栏变成「暂停」）
        let play = try requireWebElement(app, ["开始播放测试片"], "fixture-play", timeout: 60)
        play.tap()
        XCTAssertTrue(
            webElement(app, matching: ["暂停"], timeout: 30) != nil,
            "点了播放之后视频没有真的开始（控制栏没有变成「暂停」）"
        )
        attachScreenshot("01-playing")

        // 02 下载本集：工具条那一格永远是「下载本集」，所以**不能**拿它当入队证据。
        // 收紧后：必须等「下载进度：」这一行真的离开「尚未下载/需登录」，出现在连接/百分比/已完成态。
        let download = try requireWebElement(app, ["下载本集"], "toolbar-download")
        download.tap()
        let enqueued: (String) -> Bool = { text in
            // 常驻的「下载本集」永远在，不能拿它当入队证据
            if text.contains("下载本集") { return false }
            if text.contains("尚未下载") || text.contains("需登录") { return false }
            if text.contains("中断") || text.contains("失败") || text.contains("不可下载") { return false }
            // 真在下载时：工具条那一格变成「下载 N%」，面板那行是「下载进度：N% / 正在连接」
            if text.contains("%") && (text.contains("下载 ") || text.contains("下载进度：")) { return true }
            return text.contains("下载进度：") && (text.contains("正在连接") || text.contains("已完成"))
        }
        let progressText = waitForLabel(app, timeout: 60, enqueued)
        XCTAssertNotNil(progressText,
                        "点「下载本集」之后没有真的入队（下载进度还停在未下载/需登录/失败）：\(app.debugDescription)")
        attachScreenshot("02-download-episode")

        // 03 全屏（适应档）：进全屏后画面铺满、控制栏收起
        let full = try requireWebElement(app, ["全屏"], "toolbar-fullscreen")
        full.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(2.5))
        revealControls(app)
        attachScreenshot("03-fullscreen-adapt")
        XCTAssertTrue(webElement(app, matching: ["退出全屏"], timeout: 10) != nil, "没有进入全屏（找不到「退出全屏」）")

        // 04 裁剪：点「画面比例」那一格，档位切成裁剪，再截一张
        let fit = try requireWebElement(app, ["画面比例"], "fit-button")
        XCTAssertTrue(labels(of: fit).contains("适应"), "进全屏后画面档位不是「适应」：\(labels(of: fit))")
        fit.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        revealControls(app)
        attachScreenshot("04-fullscreen-cover")

        // 05 拉伸
        let fitCover = try requireWebElement(app, ["画面比例"], "fit-button-cover", timeout: 15)
        XCTAssertTrue(labels(of: fitCover).contains("裁剪"), "第二次点没有切到裁剪：\(labels(of: fitCover))")
        fitCover.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        revealControls(app)
        attachScreenshot("05-fullscreen-fill")

        // 退出全屏，回到竖屏
        let exit = try requireWebElement(app, ["退出全屏"], "exit-fullscreen")
        exit.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))

        // 06 设置里的下载列表：必须是**这一条**真实记录（剧名 + 第19集 + 看完状态），
        // 不能只靠「已下载」这种泛词蒙混（审核意见）。先断言成功，再截图。
        let settings = try requireWebElement(app, ["设置"], "settings-entry")
        settings.tap()
        XCTAssertNotNil(waitForLabel(app, timeout: 30) { $0.contains("测试剧") },
                        "设置面板里没有剧名（测试剧）：\(app.debugDescription)")
        /* 剧集 + 状态必须来自下载片库本身（页面自己的选集列表里也有「第19集」，不能算）。
           片库只会在两种文案里带上这一集：
             - 「正在下载 测试剧 · 第19集 · N%」（#iosDlRunning）
             - 下载完之后的集数行「已下载 1 集」+ 集标签「第19集」
           所以这里要求「正在下载 + 测试剧 + 第19集」在**同一条**文案里出现，或者出现集数行。 */
        let libraryEvidence = waitForLabel(app, timeout: 45) { text in
            if text.contains("正在下载") && text.contains("测试剧") && text.contains("第19集") { return true }
            return text.contains("已下载 ") && text.contains(" 集")
        }
        XCTAssertNotNil(libraryEvidence,
                        "设置里的下载片库没有这一条真实记录（测试剧 · 第19集 · 已下载 N 集）：\(app.debugDescription)")
        attachScreenshot("06-settings-download-list")
    }

    // MARK: - 记住上次选择：杀进程重进仍然是裁剪

    func testTheChosenFitModeSurvivesARelaunch() throws {
        var app = launchApp()
        let play = try requireWebElement(app, ["开始播放测试片"], "fixture-play", timeout: 60)
        play.tap()
        XCTAssertTrue(webElement(app, matching: ["暂停"], timeout: 30) != nil, "视频没有开始播放")

        let full = try requireWebElement(app, ["全屏"], "toolbar-fullscreen")
        full.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(2.5))
        revealControls(app)
        let fit = try requireWebElement(app, ["画面比例"], "fit-button")
        fit.tap()   // 适应 → 裁剪
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        let coverLabel = webElement(app, matching: ["画面比例"], timeout: 10).map { labels(of: $0) } ?? ""
        XCTAssertTrue(coverLabel.contains("裁剪"), "切到裁剪失败：\(coverLabel)")
        attachScreenshot("07-fit-cover-before-relaunch")

        app.terminate()
        app = launchApp()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 60), "重进之后页面没加载")
        let remembered = try requireWebElement(app, ["画面比例"], "fit-button-after-relaunch", timeout: 60)
        XCTAssertTrue(labels(of: remembered).contains("裁剪"),
                      "重进 App 之后忘了上次选的画面档位：\(labels(of: remembered))")
        attachScreenshot("08-fit-remembered-after-relaunch")
    }

    private func labels(of element: XCUIElement) -> String {
        [element.label, element.value as? String ?? "", element.identifier].joined(separator: " | ")
    }
}
