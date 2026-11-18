import XCTest
import WebKit
@testable import ZhuijuAI

/// 0.1.14 下载队列的**真 WKWebView**回归（下载专题，独立文件）。
///
/// 为什么单独一个文件而不是往 `InjectedUITests` 里加：批量下载/队列是本分支独占范围，
/// 共享测试文件留给集成时统一改，避免两边写同一个文件。
///
/// 这里证明什么：
/// 1. 选集页真的有批量入口（选择 / 一键全集 / 从本集往后 / 下载已选），
///    原位「下载本集」还在，点「一键全集」发出去的是一整批真实片源（逐集解析后）；
/// 2. 原生队列**真的入队**（`MediaDownloader.start` 写 UserDefaults 的记录），
///    两条任务不会被互相顶掉；把这份真实记录当快照推给网页后，设置面板按剧显示
///    「任务 N/M 集」并带暂停/继续/取消；点按钮发的是对应的原生桥接消息；
/// 3. 下载进度/暂停态由快照驱动渲染，不靠网页自己猜。
///
/// 明确不在这里证明（测试层边界）：暂停后 resumeData 的真实续传效果、后台/锁屏传输、
/// 系统通知与锁屏 UI —— 前两项由 `DownloadQueueTests`（状态机）和
/// `BackgroundTransferIntegrationTests`（真实后台传输）覆盖，最后一项是真机项。
@MainActor
final class DownloadQueueUITests: XCTestCase, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: UIWindow!
    private var loaded: XCTestExpectation?
    private var slotCounter = 0
    private let bridge = MessageRecorder()
    private var tasksKey: String { MediaDownloader.tasksKey }

    /// 捕获注入层发给原生层的消息（和 `WebViewController.PlayerBridge` 同一个通道）。
    final class MessageRecorder: NSObject, WKScriptMessageHandler {
        private let lock = NSLock()
        private var storage: [[String: Any]] = []

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any] else { return }
            lock.lock()
            storage.append(body)
            lock.unlock()
        }

        var bodies: [[String: Any]] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }

        func last() -> [String: Any]? { bodies.last }
    }

    /// 选集页骨架：节点名和站点模板一致，注入层要挂的东西都在。
    private static let fixtureHTML = """
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html, body { margin: 0; padding: 0; background: #07131b; color: #fff; }
      .main { width: 390px; }
      #player { position: relative; width: 390px; height: 220px; background: #000; }
      #player video { width: 100%; height: 100%; }
      #epGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px; }
      .ep { min-height: 38px; }
    </style>
    </head>
    <body>
    <div class="main">
      <button class="icon-btn" type="button" data-action="settings" aria-label="设置">设置</button>
      <div class="detail-info"><h1>测试剧</h1></div>
      <section class="player" id="player">
        <video id="video" playsinline preload="metadata"></video>
      </section>
      <div class="pp-toolbar" id="playTools">
        <button class="pp-tool" id="settingsBtn" type="button">显示设置</button>
        <button class="pp-tool on" id="dmBtn" type="button">弹幕 开</button>
        <button class="pp-tool" id="pipBtn" type="button">画中画</button>
      </div>
      <div class="pp-settings" id="settingsPanel" hidden></div>
      <div class="ep-grid" id="epGrid">
        <button class="ep on" type="button" data-ep="0">第1集</button>
        <button class="ep" type="button" data-ep="1">第2集</button>
        <button class="ep" type="button" data-ep="2">第3集</button>
        <button class="ep" type="button" data-ep="3">第4集</button>
      </div>
    </div>
    </body></html>
    """

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: tasksKey)
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(bridge, name: "iosPlayer")
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        webView.navigationDelegate = self
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(webView)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        loaded = expectation(description: "fixture loaded")
        webView.loadHTMLString(Self.fixtureHTML, baseURL: URL(string: "https://zhuiju.dpdns.org/player/?id=fixture")!)
        await fulfillment(of: [loaded!], timeout: 60)

        /* 下载门控读的是站点自己的登录 token（和真机同一条路） */
        /* 片库/队列/批量记忆都在 localStorage，测试类之间会互相污染：先清空再注入。 */
        _ = try await javaScript("""
        (function () {
          try {
            localStorage.removeItem('kj-ios-downloads');
            localStorage.removeItem('kj-ios-download');
            localStorage.removeItem('kj-ios-queue');
            localStorage.removeItem('kj-ios-batch');
            return true;
          } catch (error) { return false; }
        })();
        """)
        _ = try await javaScript("localStorage.setItem('kj-auth-token', 'fixture-token'); true;")

        /* 站点会用自己的 /api/play 解析每一集的真实片源。这里换成受控应答：
           本用例验的是注入层「批量解析 → 入队 / 跳过」这条链路，不是站点接口；
           真实接口的校验分支由 Node 夹具覆盖。必须在 AppBootstrap 之前装好，
           因为注入层会把 window.fetch 包一层并记住原始实现。 */
        _ = try await javaScript("""
        (function () {
          window.fetch = function (input) {
            var address = typeof input === 'string' ? input : (input && input.url) || '';
            var query = address.indexOf('?') >= 0 ? address.slice(address.indexOf('?') + 1) : '';
            var params = {};
            query.split('&').forEach(function (pair) {
              var parts = pair.split('=');
              if (parts[0]) params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
            });
            var idx = Number(params.ep);
            var body = { showId: 'fixture', idx: idx, episodeNumber: idx + 1, verified: true,
              kind: 'mp4', url: 'https://media.example/' + idx + '.mp4' };
            return Promise.resolve(new Response(JSON.stringify(body), {
              status: 200, headers: { 'content-type': 'application/json' }
            }));
          };
          return 'ok';
        })();
        """)

        let source = try String(
            contentsOf: XCTUnwrap(Bundle.main.url(forResource: "AppBootstrap", withExtension: "js")),
            encoding: .utf8
        )
        _ = try await javaScript("(function(){\n" + source + "\nreturn true;})();")
        let ready = try await awaitValue("window.__zhuijuIOSReady === true")
        XCTAssertTrue(ready, "AppBootstrap.js 没跑起来")
    }

    override func tearDown() async throws {
        MediaDownloader.shared.cancel(silent: true)
        UserDefaults.standard.removeObject(forKey: tasksKey)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "iosPlayer")
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        window.isHidden = true
        window = nil
        webView = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    // MARK: - 1. 选集页批量入口

    /// 批量入口必须在选集区上方，四个按钮齐；原位「下载本集」不能被挤掉。
    /// 「一键全集」要按集逐条解析并发出整批真实片源（不是拿播放页 URL 顶替）。
    func testEpisodePageOffersBatchDownloadAndKeepsTheSingleEpisodeEntry() async throws {
        _ = try await awaitValue("!!document.getElementById('iosBatchBar')")
        let raw = try await javaScript("""
        (function () {
          var bar = document.getElementById('iosBatchBar');
          var grid = document.getElementById('epGrid');
          if (!bar) return 'missing-bar';
          return JSON.stringify({
            buttons: Array.prototype.map.call(bar.querySelectorAll('button'), function (b) { return b.id; }),
            beforeGrid: bar.nextElementSibling === grid,
            single: !!document.getElementById('ppToolDownload'),
            singleInDanmakuSlot: !!(document.getElementById('dmBtn') &&
              document.getElementById('ppToolDownload').nextElementSibling === document.getElementById('dmBtn')),
            note: document.getElementById('iosBatchNote').textContent
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        XCTAssertNotEqual(text, "missing-bar", "选集区没有批量下载条")
        let info = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(info["buttons"] as? [String], ["iosBatchSelect", "iosBatchAll", "iosBatchForward", "iosBatchStart"],
                       "批量入口不齐：\(text)")
        XCTAssertEqual(info["beforeGrid"] as? Bool, true, "批量条要在选集区上方：\(text)")
        XCTAssertEqual(info["single"] as? Bool, true, "原位「下载本集」必须保留：\(text)")
        XCTAssertEqual(info["singleInDanmakuSlot"] as? Bool, true, "下载本集还在弹幕那一格：\(text)")

        /* 一键全集：四集都要解析成真实片源再入队 */
        _ = try await javaScript("document.getElementById('iosBatchAll').click(); true;")
        let sent = try await awaitMessage { $0["action"] as? String == "downloadBatch" }
        let items = try XCTUnwrap(sent["items"] as? [[String: Any]], "一键全集没有发出批量下载：\(sent)")
        XCTAssertEqual(items.count, 4, "这部剧有 4 集：\(sent)")
        XCTAssertEqual(items.compactMap { $0["url"] as? String },
                       ["https://media.example/0.mp4", "https://media.example/1.mp4",
                        "https://media.example/2.mp4", "https://media.example/3.mp4"],
                       "每一集都要用解析出来的真实片源：\(sent)")
        XCTAssertEqual(items.compactMap { $0["epKey"] as? String }, ["0", "1", "2", "3"])
        XCTAssertEqual(items.first?["showId"] as? String, "fixture")
        XCTAssertEqual(items.first?["name"] as? String, "测试剧 第1集.mp4", "文件名是真实剧名 + 集号：\(sent)")

        /* 从本集往后：先把当前集切到第 3 集 */
        _ = try await javaScript("""
        (function () {
          var eps = document.querySelectorAll('#epGrid .ep');
          eps.forEach(function (ep) { ep.className = 'ep'; });
          eps[2].className = 'ep on';
          return true;
        })();
        """)
        _ = try await javaScript("document.getElementById('iosBatchForward').click(); true;")
        let forward = try await awaitMessage { message in
            (message["action"] as? String) == "downloadBatch"
                && ((message["items"] as? [[String: Any]])?.first?["epKey"] as? String) == "2"
        }
        let forwardItems = try XCTUnwrap(forward["items"] as? [[String: Any]])
        XCTAssertEqual(forwardItems.compactMap { $0["epKey"] as? String }, ["2", "3"],
                       "从本集往后只下当前集和它后面的：\(forward)")

        /* 多选：选择模式点两集 → 下载已选 (2) → 只发这两集 */
        _ = try await javaScript("""
        (function () {
          document.getElementById('iosBatchSelect').click();
          var eps = document.querySelectorAll('#epGrid .ep');
          eps[0].click();
          eps[1].click();
          return document.getElementById('iosBatchStart').textContent;
        })();
        """)
        let startText = try await javaScript("document.getElementById('iosBatchStart').textContent") as? String
        XCTAssertEqual(startText, "下载已选 (2)", "多选数量要显示出来：\(String(describing: startText))")
        _ = try await javaScript("document.getElementById('iosBatchStart').click(); true;")
        let picked = try await awaitMessage { message in
            (message["action"] as? String) == "downloadBatch"
                && ((message["items"] as? [[String: Any]])?.count) == 2
                && ((message["items"] as? [[String: Any]])?.first?["epKey"] as? String) == "0"
        }
        XCTAssertEqual((picked["items"] as? [[String: Any]])?.compactMap { $0["epKey"] as? String }, ["0", "1"],
                       "多选只下用户选中的两集：\(picked)")

        /* 原位下载本集仍然发单集下载（REG-008 不回退） */
        _ = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          video.src = 'https://media.example/19.mp4';
          document.getElementById('ppToolDownload').click();
          return true;
        })();
        """)
        let single = try await awaitMessage { $0["action"] as? String == "download" }
        XCTAssertEqual(single["url"] as? String, "https://media.example/19.mp4", "这一格还是下载本集：\(single)")
        XCTAssertNil(single["path"], "下载本集不能变成打开本地文件")
    }

    // MARK: - 2. 真实队列入队 + 快照驱动设置面板

    /// 原生队列真的写盘：两条任务都要在（旧实现第二条会把第一条取消掉），
    /// 把这份**真实记录**当快照推给网页后，设置面板按剧显示任务数并带暂停/取消。
    func testTheRealQueueKeepsBothEpisodesAndTheSettingsSheetShowsThem() async throws {
        let unreachable = URL(string: "https://10.255.255.1/1.mp4")!
        let downloader = MediaDownloader()
        downloader.start(id: "queue-a", url: unreachable, name: "测试剧 第1集.mp4",
                         meta: ["showId": "fixture", "epKey": "0", "epLabel": "第1集", "title": "测试剧"],
                         onProgress: { _, _ in }, onFinish: { _ in })
        downloader.start(id: "queue-b", url: URL(string: "https://10.255.255.1/2.mp4")!, name: "测试剧 第2集.mp4",
                         meta: ["showId": "fixture", "epKey": "1", "epLabel": "第2集", "title": "测试剧"],
                         onProgress: { _, _ in }, onFinish: { _ in })
        downloader.start(id: "queue-c", url: URL(string: "https://10.255.255.1/3.mp4")!, name: "测试剧 第3集.mp4",
                         meta: ["showId": "fixture", "epKey": "2", "epLabel": "第3集", "title": "测试剧"],
                         onProgress: { _, _ in }, onFinish: { _ in })

        let records = storedRecords()
        XCTAssertEqual(records.count, 3, "三条任务都要入队：\(records)")
        let byId = Dictionary(uniqueKeysWithValues: records.compactMap { record -> (String, [String: Any])? in
            guard let id = record["id"] as? String else { return nil }
            return (id, record)
        })
        XCTAssertEqual(byId["queue-a"]?["status"] as? String, "running", "第一条要真的交给系统：\(records)")
        XCTAssertEqual(byId["queue-b"]?["status"] as? String, "running", "第二条也要跑（并发上限 2）：\(records)")
        XCTAssertEqual(byId["queue-c"]?["status"] as? String, "queued", "第三条排队等空位：\(records)")
        XCTAssertEqual(byId["queue-a"]?["showId"] as? String, "fixture")
        XCTAssertEqual(byId["queue-a"]?["epKey"] as? String, "0")

        /* 把真实记录当快照推给网页（和原生 flushDownloadEvents 下发的是同一份字段） */
        let tasks = records.map { record -> [String: Any] in
            [
                "id": record["id"] as? String ?? "",
                "showId": record["showId"] as? String ?? "",
                "epKey": record["epKey"] as? String ?? "",
                "epLabel": record["ep"] as? String ?? "",
                "title": record["title"] as? String ?? "",
                "name": record["name"] as? String ?? "",
                "status": record["status"] as? String ?? "",
                "received": record["received"] as? Int64 ?? 0,
                "total": record["total"] as? Int64 ?? 0,
                "path": record["path"] as? String ?? "",
                "size": record["size"] as? Int64 ?? 0,
                "reason": record["reason"] as? String ?? "",
            ]
        }
        try await pushSnapshot(tasks)

        let rendered = try await javaScript("""
        (function () {
          document.querySelector('[data-action="settings"]').click();
          var item = document.getElementById('iosDlShows').children[0];
          if (!item) return 'missing-show';
          var queue = item.querySelector('.ios-dl-queue');
          var actions = item.querySelector('.ios-dl-actions');
          return JSON.stringify({
            show: item.querySelector('.ios-dl-name').textContent,
            queue: queue ? queue.textContent : 'missing-queue',
            actions: actions ? Array.prototype.map.call(actions.children, function (b) { return b.textContent; }) : [],
            running: queue ? /进行中 2/.test(queue.textContent) : false,
            queued: queue ? /排队 1/.test(queue.textContent) : false
          });
        })();
        """)
        let renderedText = try XCTUnwrap(rendered as? String)
        XCTAssertNotEqual(renderedText, "missing-show", "真实队列没有出现在设置面板里")
        let ui = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(renderedText.utf8)) as? [String: Any])
        XCTAssertEqual(ui["show"] as? String, "测试剧", "按剧名分组：\(renderedText)")
        let queueText = try XCTUnwrap(ui["queue"] as? String)
        XCTAssertTrue(queueText.contains("任务 0/3 集"), "要显示整部剧的任务数：\(queueText)")
        XCTAssertEqual(ui["running"] as? Bool, true, "两条在跑：\(queueText)")
        XCTAssertEqual(ui["queued"] as? Bool, true, "一条排队：\(queueText)")
        XCTAssertEqual(ui["actions"] as? [String], ["暂停整部剧", "取消整部剧"], "整组操作不齐：\(renderedText)")

        /* 暂停整部剧 → 发的是原生暂停消息（暂停后的状态机由 DownloadQueueTests 钉住） */
        _ = try await javaScript("""
        (function () {
          document.querySelector('#iosDlShows .ios-dl-actions button[data-batch-action="pause"]').click();
          return true;
        })();
        """)
        let paused = try await awaitMessage { $0["action"] as? String == "downloadPause" }
        XCTAssertEqual(paused["showId"] as? String, "fixture", "暂停要带上是哪部剧：\(paused)")

        /* 暂停态快照 → 面板出现「继续下载」；点它发 downloadResume */
        var pausedTasks = tasks
        for index in pausedTasks.indices { pausedTasks[index]["status"] = "paused" }
        try await pushSnapshot(pausedTasks)
        let resumeShown = try await awaitValue("""
        (function () {
          var button = document.querySelector('#iosDlShows .ios-dl-actions button[data-batch-action="resume"]');
          return !!button && button.textContent === '继续下载';
        })()
        """)
        XCTAssertTrue(resumeShown, "暂停后要能看到「继续下载」")
        _ = try await javaScript("""
        (function () {
          document.querySelector('#iosDlShows .ios-dl-actions button[data-batch-action="resume"]').click();
          return true;
        })();
        """)
        let resumed = try await awaitMessage { $0["action"] as? String == "downloadResume" }
        XCTAssertEqual(resumed["showId"] as? String, "fixture")

        /* 取消整部剧 → downloadCancel；真实取消效果（不动已下载文件）见 DownloadQueueTests */
        _ = try await javaScript("""
        (function () {
          document.querySelector('#iosDlShows .ios-dl-actions button[data-batch-action="cancel"]').click();
          return true;
        })();
        """)
        let cancelled = try await awaitMessage { $0["action"] as? String == "downloadCancel" }
        XCTAssertEqual(cancelled["showId"] as? String, "fixture")
    }

    // MARK: - 工具

    private func storedRecords() -> [[String: Any]] {
        guard let data = UserDefaults.standard.data(forKey: tasksKey),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    /// 和 `WebViewController.sendDownloadSnapshot` 走同一条网页入口。
    private func pushSnapshot(_ tasks: [[String: Any]]) async throws {
        let data = try JSONSerialization.data(withJSONObject: tasks)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        _ = try await javaScript("window.__zhuijuDownloads('snapshot', \(json)); true;")
    }

    private func awaitMessage(timeout: Double = 10, _ match: ([String: Any]) -> Bool) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = bridge.bodies.last(where: match) { return hit }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTFail("没有等到期望的原生消息：\(bridge.bodies)")
        return [:]
    }

    private func javaScript(_ source: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any?, Error>) in
            webView.evaluateJavaScript(source) { (value: Any?, error: Error?) in
                if let error = error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: value)
                }
            }
        }
    }

    private func awaitValue(_ source: String, timeout: Double = 15) async throws -> Bool {
        let budget = Int(timeout * 1000)
        slotCounter += 1
        let slot = "slot\(slotCounter)"
        _ = try await javaScript("""
        (function () {
          window.__zhuijuTestSlots = window.__zhuijuTestSlots || {};
          var state = window.__zhuijuTestSlots['\(slot)'] = { done: false, value: false };
          var settle = function (value) { state.done = true; state.value = value === true; };
          var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(false); }, \(budget)); });
          var target;
          try { target = Promise.resolve((\(source))); } catch (error) { target = Promise.reject(error); }
          Promise.race([target, timeout]).then(settle, function () { settle(false); });
          return true;
        })();
        """)
        let deadline = Date().addingTimeInterval(timeout + 5)
        while Date() < deadline {
            let probe = try await javaScript("""
            (function () {
              var state = (window.__zhuijuTestSlots || {})['\(slot)'];
              if (!state || !state.done) return 'pending';
              return state.value ? 'done' : 'nope';
            })();
            """)
            if let text = probe as? String {
                if text == "done" { return true }
                if text == "nope" { return false }
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        return false
    }
}
