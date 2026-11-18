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
///
/// run 44292507284 的两条真问题（本文件已按证据修正）：
/// 1. 片源只有 6 秒，点到全屏时视频已经播完；注入层在「暂停/结束」态会把控制栏常显，
///    旧的 `revealControls` 又盲点画面中心，正好把控制栏**收起**——于是「退出全屏」「画面比例」
///    全找不到（附件 missing-fit-button 的可访问性树里连 #ppCtrl 都没有）。
///    现在播完 01 后先用**真的**「播放 / 暂停」按钮暂停：注入层的既有规则是暂停态保持控制栏常显，
///    不再靠坐标猜开关；`ensureControlsVisible` 只在真的没有控件时才点一次并留诊断。
/// 2. 先断言、后截图：任何一步失败都先留诊断截图 + 可访问性树，最终图只在断言成功后拍。
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

    /// 失败现场：诊断图 + 可访问性树 + 当前方向。diagnostic-* 不是必需图，只用于定位。
    private func attachDiagnostics(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "diagnostic-" + name
        shot.lifetime = .keepAlways
        add(shot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "diagnostic-tree-" + name
        tree.lifetime = .keepAlways
        add(tree)
        let orientation = XCTAttachment(string: "orientation=\(String(describing: XCUIDevice.shared.orientation))")
        orientation.name = "diagnostic-orientation-" + name
        orientation.lifetime = .keepAlways
        add(orientation)
    }

    private func fail(_ message: String, _ diagnostic: String, _ app: XCUIApplication) {
        attachDiagnostics(app, name: diagnostic)
        XCTFail(message)
    }

    /// 网页里的按钮：只按 **button role** 找（`.any` 会把文本节点/隐藏面板里的节点也算上，
    /// 44292507284 的批量那一步就是这么点错的）。exact 用 aria-label 精确匹配，
    /// dynamic 用 CONTAINS 匹配运行态文案（画面比例：适应/裁剪/拉伸）。
    private func webButton(_ app: XCUIApplication, labels: [String], exact: Bool = false,
                           timeout: TimeInterval = 15) -> XCUIElement? {
        let buttons = app.buttons
        let predicates = labels.map { label in
            NSPredicate(format: exact ? "label == %@" : "label CONTAINS %@", label)
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

    private func requireButton(_ app: XCUIApplication, labels: [String], exact: Bool = false,
                               what: String, timeout: TimeInterval = 15) -> XCUIElement? {
        guard let element = webButton(app, labels: labels, exact: exact, timeout: timeout) else {
            fail("页面上找不到「\(labels.joined(separator: " / "))」（\(what)）", "missing-" + what, app)
            return nil
        }
        return element
    }

    /// 一次性拍下网页可访问性树（逐条 `element(boundBy:)` 在 DOM 变化时会抛
    /// 「No matches found for Element at index N」，那是探针自己的脆弱，不是产品问题）。
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

    /// 仅在真的找不到控制栏时才点一次画面（产品手势：点一下叫出/再点收起）。
    /// 点完立刻验证，若第一次正好把它收起就再点一次；两次都失败就留诊断并判红。
    private func ensureControlsVisible(_ app: XCUIApplication, timeout: TimeInterval = 12) -> Bool {
        if webButton(app, labels: ["画面比例"], timeout: 2) != nil { return true }
        for attempt in 1...2 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42)).tap()
            if webButton(app, labels: ["画面比例"], timeout: timeout / 2) != nil { return true }
            _ = attempt
        }
        fail("点了画面两次仍看不到控制栏（画面比例/退出全屏）", "missing-controls", app)
        return false
    }

    /// 档位是持久化的（localStorage kj-ios-fit），同一台模拟器上前一条用例可能把它留在
    /// 拉伸；不能假设「点一下就是裁剪」。最多循环三档到目标，再返回那个真按钮。
    private func cycleToFit(_ app: XCUIApplication, _ target: String) -> XCUIElement? {
        var current = webButton(app, labels: ["画面比例"], timeout: 15)
        for _ in 0..<4 {
            guard let fit = current else { return nil }
            let text = [fit.label, fit.value as? String ?? "", fit.identifier].joined(separator: " ")
            if text.contains(target) { return fit }
            fit.tap()
            // 等档位文案真的翻转（不是拿到一个还没刷新的旧元素）
            let deadline = Date().addingTimeInterval(8)
            var next: XCUIElement?
            while Date() < deadline {
                if let candidate = webButton(app, labels: ["画面比例"], timeout: 1) {
                    let candidateText = [candidate.label, candidate.value as? String ?? "", candidate.identifier]
                        .joined(separator: " ")
                    if candidateText != text { next = candidate; break }
                }
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            }
            current = next
        }
        return nil
    }

    private func waitForFit(_ app: XCUIApplication, _ label: String, timeout: TimeInterval = 10) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let fit = webButton(app, labels: ["画面比例"], timeout: 1),
               [fit.label, fit.value as? String ?? "", fit.identifier].joined(separator: " ").contains(label) {
                return fit
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return nil
    }

    // MARK: - 主链路：播放 → 下载本集 → 全屏三档 → 设置里的下载列表

    func testTheAppPlaysDownloadsAndShootsEveryFitMode() {
        let app = launchApp()

        // 01 播放：点夹具页自己的播放按钮，视频真的开始播（控制栏变成「暂停」）
        let play = requireButton(app, labels: ["开始播放测试片"], exact: true,
                                 what: "fixture-play", timeout: 60)
        guard play != nil else { return }
        play!.tap()
        // 「播放 / 暂停」是常驻 aria-label，不能当播放证据；看真时间轴从 0:00 走到 0:0N。
        let playing = waitForLabel(app, timeout: 30) { text in
            text.contains("/ 0:06") && !text.contains("0:00 /") && text.contains(":")
        }
        if playing == nil {
            fail("点了播放之后视频没有真的开始（时间轴没有走动）", "playing-not-started", app)
            return
        }
        attachScreenshot("01-playing")

        // 让 6 秒片源停在暂停态：注入层既有规则是「暂停时控制栏常显」，
        // 这样进全屏后「画面比例 / 退出全屏」不需要靠坐标猜开关就能真点到。
        if let pause = webButton(app, labels: ["播放 / 暂停"], exact: true, timeout: 10) {
            pause.tap()
            _ = webButton(app, labels: ["播放"], exact: true, timeout: 8)
        }

        // 02 下载本集：工具条那一格永远是「下载本集」，所以**不能**拿它当入队证据。
        // 收紧后：必须等「下载进度：」这一行真的离开「尚未下载/需登录」，出现在连接/百分比/已完成态。
        let download = requireButton(app, labels: ["下载本集"], exact: true, what: "toolbar-download")
        guard download != nil else { return }
        download!.tap()
        let enqueued: (String) -> Bool = { text in
            if text.contains("下载本集") { return false }
            if text.contains("尚未下载") || text.contains("需登录") { return false }
            if text.contains("中断") || text.contains("失败") || text.contains("不可下载") { return false }
            if text.contains("%") && (text.contains("下载 ") || text.contains("下载进度：")) { return true }
            if text.contains("下载进度：") && (text.contains("正在连接") || text.contains("已完成")) { return true }
            // 6 秒小片源可能比第一次轮询还快下完：这行只在真有完成文件时出现。
            return text.contains("用其他播放器播放") && text.contains("已下载")
        }
        let progressText = waitForLabel(app, timeout: 60, enqueued)
        guard let progress = progressText else {
            fail("点「下载本集」之后没有真的入队（下载进度停在未下载/需登录/失败）", "single-not-enqueued", app)
            return
        }
        attachScreenshot("02-download-episode")
        _ = progress

        // 03 全屏（适应档）：按真的「全屏播放」按钮，轮询真的「退出全屏」出现；
        // 不能用归一化坐标盲点，也不能直接调 requestFullscreen 绕过产品手势。
        let full = requireButton(app, labels: ["全屏播放", "全屏"], exact: true, what: "toolbar-fullscreen")
        guard full != nil else { return }
        full!.tap()
        let exitButton = webButton(app, labels: ["退出全屏"], exact: true, timeout: 30)
        guard let exiting = exitButton else {
            fail("没有进入全屏（找不到「退出全屏」）", "not-fullscreen", app)
            return
        }
        guard ensureControlsVisible(app) else { return }
        // 断言已经成功，这张才是最终的 03。
        attachScreenshot("03-fullscreen-adapt")

        // 04 裁剪：档位按钮是「画面比例：X，点击切换」这一格。
        // 档位跨用例持久化，先真点循环到适应（最多 3 档），不假设默认值。
        let fit = cycleToFit(app, "适应")
        if fit == nil {
            fail("进全屏后循环不到「适应」档", "fit-not-contain", app)
            return
        }
        // 计算样式 object-fit=contain 由 FitModeTests 真 WKWebView 断言；这里点真按钮看显示结果。
        fit!.tap()
        let coverFit = waitForFit(app, "裁剪")
        guard let cover = coverFit else {
            fail("点画面比例后没有切到「裁剪」", "fit-not-cover", app)
            return
        }
        _ = cover
        attachScreenshot("04-fullscreen-cover")

        // 05 拉伸
        cover.tap()
        let fillFit = waitForFit(app, "拉伸")
        guard let fill = fillFit else {
            fail("第二次点画面比例后没有切到「拉伸」", "fit-not-fill", app)
            return
        }
        _ = fill
        attachScreenshot("05-fullscreen-fill")

        // 退出全屏，回到竖屏
        let exit = requireButton(app, labels: ["退出全屏"], exact: true, what: "exit-fullscreen")
        guard exit != nil else { return }
        exit!.tap()
        _ = webButton(app, labels: ["全屏播放"], exact: true, timeout: 15)

        // 06 设置里的下载列表：必须是**这一条**真实记录（剧名 + 第19集 + 状态），
        // 先断言下载片库本身，再截图；页面自己的选集列表里也有「第19集」，不能算。
        let settings = requireButton(app, labels: ["设置"], exact: true, what: "settings-entry")
        guard settings != nil else { return }
        settings!.tap()
        let libraryEvidence = waitForLabel(app, timeout: 45) { text in
            if text.contains("正在下载") && text.contains("测试剧") && text.contains("第19集") { return true }
            return text.contains("已下载 ") && text.contains(" 集")
        }
        guard let evidence = libraryEvidence else {
            fail("设置里的下载片库没有这一条真实记录（测试剧 · 第19集 · 已下载 N 集）", "library-missing", app)
            return
        }
        attachScreenshot("06-settings-download-list")
        _ = evidence
    }

    // MARK: - 记住上次选择：杀进程重进仍然是裁剪

    func testTheChosenFitModeSurvivesARelaunch() {
        var app = launchApp()
        let play = requireButton(app, labels: ["开始播放测试片"], exact: true,
                                 what: "fixture-play", timeout: 60)
        guard play != nil else { return }
        play!.tap()
        if waitForLabel(app, timeout: 30, { $0.contains("/ 0:06") && !$0.contains("0:00 /") }) == nil {
            fail("视频没有开始播放", "relaunch-playing", app)
            return
        }
        // 同样先暂停，避免 6 秒片源播完把控制栏状态翻到另一面。
        if let pause = webButton(app, labels: ["播放 / 暂停"], exact: true, timeout: 10) { pause.tap() }

        let full = requireButton(app, labels: ["全屏播放", "全屏"], exact: true,
                                 what: "toolbar-fullscreen", timeout: 15)
        guard full != nil else { return }
        full!.tap()
        if webButton(app, labels: ["退出全屏"], exact: true, timeout: 30) == nil {
            fail("重进用例没进入全屏", "relaunch-fullscreen", app)
            return
        }
        guard ensureControlsVisible(app) else { return }
        // 上一条用例会把档位留在拉伸；循环到裁剪再拍，避免跨用例状态污染。
        let coverFit = cycleToFit(app, "裁剪")
        guard let coverLabel = coverFit else {
            fail("切到裁剪失败", "relaunch-cover", app)
            return
        }
        attachScreenshot("07-fit-cover-before-relaunch")
        _ = coverLabel

        app.terminate()
        app = launchApp()
        if !app.webViews.firstMatch.waitForExistence(timeout: 60) {
            fail("重进之后页面没加载", "relaunch-page", app)
            return
        }
        let remembered = requireButton(app, labels: ["画面比例"], what: "fit-button-after-relaunch", timeout: 60)
        guard let rememberedFit = remembered else { return }
        let label = [rememberedFit.label, rememberedFit.value as? String ?? "", rememberedFit.identifier]
            .joined(separator: " ")
        if !label.contains("裁剪") {
            fail("重进 App 之后忘了上次选的画面档位：\(label)", "relaunch-not-remembered", app)
            return
        }
        attachScreenshot("08-fit-remembered-after-relaunch")
    }
}
