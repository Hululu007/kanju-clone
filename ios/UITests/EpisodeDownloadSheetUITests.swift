import XCTest

/// 验证独立下载页的入口、选集状态以及逐集入队。
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

    private func downloadEntry(_ web: XCUIElement, timeout: TimeInterval = 30) -> XCUIElement? {
        let predicate = NSPredicate(format: "label == %@", "下载")
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let candidate = web.descendants(matching: .any).matching(predicate).firstMatch
            if candidate.exists { return candidate }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return nil
    }

    /// 列表里的一条：aria-label 是「集名 + 状态」，选集网格里的那个按钮只有纯集名，
    /// 所以用「集名 + 空格」开头来区分（光写集名会点到网格，变成切集）。
    private func rowPredicate(_ label: String) -> NSPredicate {
        NSPredicate(format: "label BEGINSWITH %@", label + " ")
    }

    /// 列表在折叠线以下时先滚动再点：直接 tap 会报 "not hittable"，
    /// 失败信息里只有坐标，看不出是滚动问题还是入口没挂上。
    private func tapWhenVisible(_ app: XCUIApplication, _ element: XCUIElement, _ web: XCUIElement) {
        for _ in 0..<4 {
            if element.isHittable {
                element.tap()
                return
            }
            web.swipeUp()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        let frame = element.frame
        app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
            .tap()
    }

    func testTitleDownloadOpensTheStandaloneEpisodeGrid() throws {
        let app = launchApp()
        let web = web(app)

        // 站点的投屏入口必须已经不可见（不是删掉节点，是让位）。
        // 注意别把自己的控制栏算进去：那一格「外放」的无障碍名里也有「投屏」两个字，
        // 它是 App 内既有的第三方播放器入口，和站点那个投屏按钮是两回事。
        let siteCast = web.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ OR label == %@", "投屏到电视", "投屏"))
            .firstMatch
        XCTAssertFalse(siteCast.exists, "选集旁仍然能看到站点那个「投屏」入口，它应该让位给下载按钮")

        guard let entry = downloadEntry(web) else {
            _ = fail(app, "download-entry", "剧名旁没有下载入口")
            return
        }
        attach(app, "010-download-entry")
        XCTAssertTrue(entry.isHittable, "下载按钮存在但点不到")

        // 展开之前，列表还没出现
        XCTAssertNil(element(web, containing: "点一下立即加入下载", timeout: 3),
                     "还没点下载按钮，选集下载列表就已经展开了")

        entry.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))

        let total = requireElement(app, web, "共 5 集 · 点一下立即加入下载", "page-total", timeout: 15)
        XCTAssertTrue(total.exists, "下载页没有写总集数")
        XCTAssertNotNil(element(web, containing: "第19集", timeout: 10),
                        "展开后的列表里没有选集条目")
        XCTAssertNotNil(element(web, containing: "查看下载列表", timeout: 10), "独立下载页没有片库入口")
        attach(app, "011-download-panel")

        // 每一条都带真实状态。不能写死成「未下载」：同一台模拟器上先跑过的用例
        // 可能已经把这一集下完了，那它就该显示「已下载」——这也正是本需求要的状态区分。
        let stateful = web.descendants(matching: .any).matching(rowPredicate("第19集")).firstMatch
        XCTAssertTrue(stateful.exists, "展开的列表里第19集那一条没有「集名 + 状态」")
        let stateLabels = ["已下载", "下载中", "排队中", "已暂停", "失败", "未下载"]
        XCTAssertTrue(stateLabels.contains { (stateful.label).contains($0) },
                      "第19集那一条没带下载状态：\(stateful.label)")
    }

    func testTappingAnEpisodeDownloadsOnlyThatEpisode() throws {
        let app = launchApp()
        let web = web(app)

        guard let entry = downloadEntry(web) else {
            _ = fail(app, "download-entry", "剧名旁没有下载入口")
            return
        }
        entry.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        _ = requireElement(app, web, "点一下立即加入下载", "page-total", timeout: 15)
        XCTAssertFalse(web.buttons["全选"].exists)
        XCTAssertFalse(web.buttons["下载已选"].exists)

        let row20 = web.descendants(matching: .any).matching(rowPredicate("第20集")).firstMatch
        let row21 = web.descendants(matching: .any).matching(rowPredicate("第21集")).firstMatch
        guard row20.waitForExistence(timeout: 15) else {
            _ = fail(app, "sheet-row-20", "展开的列表里没有第20集那一条")
            return
        }
        XCTAssertTrue(row21.exists)
        let untouchedLabel = row21.label
        tapWhenVisible(app, row20, web)
        let completed = requireElement(app, web, "第20集 已下载", "episode-done", timeout: 60)
        XCTAssertTrue(completed.exists, "第20集没有下载完成")
        XCTAssertEqual(row21.label, untouchedLabel, "点第20集时不应下载第21集")
        attach(app, "013-download-queue-states")

        let library = requireElement(app, web, "查看下载列表", "downloads-entry")
        guard library.exists else { return }
        library.tap()
        XCTAssertNotNil(element(web, containing: "我的下载", timeout: 15))
        XCTAssertNotNil(element(web, containing: "第20集", timeout: 15))
        attach(app, "014-single-episode-in-downloads")
    }
}
