import XCTest

/// 0.1.15：播放页「视频下方、选集旁边」那个投屏入口换成下载按钮 —— 点它**不跳页、不弹层**，
/// 就在这一页里、按钮下面展开可下载的集数列表（带总数、单选/多选/全选、每集状态），
/// 选完直接进 0.1.14 那条共享下载队列。
///
/// 这条用例先写、先红：它照着需求断言真实 App 里的按钮与展开列表，实现之前不可能通过。
@MainActor
final class EpisodeDownloadSheetUITests: XCTestCase {
    private let fixtureBase = "http://127.0.0.1:8765"
    private let playerPath = "/player/index.html?id=demo&ep=19"

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KJ_TEST_HOME_URL"] = fixtureBase + playerPath
        app.launch()
        app.activate()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// 找不到元素时留下可访问性树 + 截图，记为失败，然后用一个空元素让调用方自然结束。
    /// 不抛错、也不 fatalError：崩溃会把「断言失败」变成「进程挂掉」，日志里看不出原因。
    private func fail(_ app: XCUIApplication, _ name: String, _ message: String) -> XCUIElement {
        let dump = XCTAttachment(string: app.debugDescription)
        dump.name = "missing-" + name
        dump.lifetime = .keepAlways
        add(dump)
        attach(app, name)
        XCTFail(message)
        return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", "__never__")).firstMatch
    }

    private func web(_ app: XCUIApplication) -> XCUIElement {
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 60), "受控夹具页没有加载")
        return webView
    }

    /// 按 label 找网页里的元素（注入层挂的都是 `<button>`，文字与 aria-label 都会被读出来）。
    private func element(_ web: XCUIElement, containing text: String, timeout: TimeInterval = 20) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let candidate = web.descendants(matching: .any).matching(predicate).firstMatch
            if candidate.exists, candidate.isHittable || candidate.exists { return candidate }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return nil
    }

    private func requireElement(_ app: XCUIApplication, _ web: XCUIElement, _ text: String,
                               _ what: String, timeout: TimeInterval = 20) -> XCUIElement {
        if let found = element(web, containing: text, timeout: timeout) { return found }
        return fail(app, what, "页面上找不到「\(text)」（\(what)）")
    }

    // MARK: - 入口：投屏换成了下载

    func testTheCastEntryNextToTheEpisodesIsADownloadButtonThatExpandsInPlace() throws {
        let app = launchApp()
        let web = web(app)

        // 站点的投屏入口必须已经不可见（不是删掉节点，是让位）
        XCTAssertNil(element(web, containing: "投屏", timeout: 5),
                     "选集旁仍然能看到「投屏」入口，它应该让位给下载按钮")

        // 选集旁现在是下载按钮
        let entry = requireElement(app, web, "下载", "download-entry")
        attach(app, "010-download-entry")
        XCTAssertTrue(entry.isHittable, "下载按钮存在但点不到")

        // 展开之前，列表还没出现
        XCTAssertNil(element(web, containing: "共 5 集", timeout: 3),
                     "还没点下载按钮，选集下载列表就已经展开了")

        entry.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))

        // 列表在同一个页面里展开：总数写清楚，当前页没被替换掉
        let total = requireElement(app, web, "共 5 集", "sheet-total", timeout: 15)
        XCTAssertTrue(total.exists, "展开后的列表没有写总集数")
        XCTAssertNotNil(element(web, containing: "第19集", timeout: 10),
                        "展开后的列表里没有选集条目")
        XCTAssertNotNil(element(web, containing: "开始播放测试片", timeout: 10),
                        "点了下载按钮之后页面被换掉了（原来的播放页元素不见了），要求是在原页面里展开")
        attach(app, "011-download-panel")

        // 每一条都带状态：刚进来全是「未下载」
        XCTAssertNotNil(element(web, containing: "未下载", timeout: 10),
                        "展开的列表没有显示每集的下载状态")
    }

    // MARK: - 单选 / 多选 / 全选 → 进共享队列，并显示已下载与下载中

    func testSelectingEpisodesQueuesThemAndShowsDownloadedAndDownloadingStates() throws {
        let app = launchApp()
        let web = web(app)

        let entry = requireElement(app, web, "下载", "download-entry")
        entry.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        _ = requireElement(app, web, "共 5 集", "sheet-total", timeout: 15)

        // 单选：点第 20 集那一条
        let row20 = requireElement(app, web, "第20集", "sheet-row-20", timeout: 10)
        row20.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        XCTAssertNotNil(element(web, containing: "已选 1 集", timeout: 10),
                        "单选一集之后计数没变")

        // 全选
        let selectAll = requireElement(app, web, "全选", "select-all", timeout: 10)
        selectAll.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        XCTAssertNotNil(element(web, containing: "已选 5 集", timeout: 10),
                        "点全选之后没有选中全部 5 集")
        attach(app, "012-download-panel-all-selected")

        // 入队：走的是 0.1.14 那条共享队列（原生并发上限 2）
        let start = requireElement(app, web, "下载已选", "start-batch", timeout: 10)
        start.tap()
        XCTAssertNotNil(element(web, containing: "下载中", timeout: 60)
                        ?? element(web, containing: "排队", timeout: 60),
                        "点了下载已选之后没有看到任何一集进入下载中/排队")
        attach(app, "013-download-queue-states")

        // 队列真的在跑：至少一集是「下载中 N%」或者已完成显示「已下载」
        let progressed = element(web, containing: "下载中", timeout: 120)
            ?? element(web, containing: "已下载", timeout: 120)
        XCTAssertNotNil(progressed, "队列跑了几分钟，仍然没有任何一集显示下载中或已下载")
        attach(app, "014-download-final-states")
    }
}
