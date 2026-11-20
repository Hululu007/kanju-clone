import XCTest
import WebKit
@testable import ZhuijuAI

/// 下载队列的**真 WKWebView**回归（下载专题，独立文件）。
///
/// 为什么单独一个文件而不是往 `InjectedUITests` 里加：下载队列是独立回归范围，
/// 共享测试文件留给集成时统一改，避免两边写同一个文件。
///
/// 这里证明什么：
/// 1. 标题旁下载入口打开新版单集下载页，点一集只发送一个队列项；
/// 2. 原生队列**真的入队**（`MediaDownloader.start` 写 UserDefaults 的记录），
///    两条任务不会被互相顶掉；把这份真实记录当快照推给网页后，我的下载页按剧显示
///    展示进行中的单集及真实传输状态；
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

    /// 播放页骨架：节点名和站点模板一致，注入层要挂的东西都在。
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
        <button class="pp-tool" id="ppDownload" type="button" data-pw-act="dl">下载</button>
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
        /* 片库/队列记忆都在 localStorage，测试类之间会互相污染：先清空再注入。 */
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
           本用例验的是注入层「单集解析 → 入队 / 跳过」这条链路，不是站点接口；
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
            var episodeNumber = Number(params.ep);
            var idx = episodeNumber - 1;
            var body = { showId: 'fixture', idx: idx, episodeNumber: episodeNumber, verified: true,
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

    // MARK: - 1. 新版单集下载入口

    /// 新版由标题旁的下载按钮打开独立下载页；点一集立即解析并入队。
    func testEpisodePageDownloadsOneEpisodeFromTheNewDownloadPage() async throws {
        _ = try await awaitValue("!!document.querySelector('[data-pw-act=dl]')")
        let raw = try await javaScript("""
        (function () {
          return JSON.stringify({
            legacyBatch: !!document.getElementById('iosBatchBar'),
            titleDownload: !!document.querySelector('[data-pw-act=dl]'),
            toolbarDownload: !!document.getElementById('ppToolDownload')
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let info = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(info["legacyBatch"] as? Bool, false, "旧多选/全集入口已移除：\(text)")
        XCTAssertEqual(info["titleDownload"] as? Bool, true, "新版下载入口必须存在：\(text)")
        XCTAssertEqual(info["toolbarDownload"] as? Bool, false, "播放器工具条不应保留第二个下载入口：\(text)")

        _ = try await javaScript("""
        (function () {
          document.querySelector('[data-pw-act=dl]').click();
          var cell = document.getElementById('iosDlCell6-0');
          if (!cell) return 'missing-cell';
          cell.click();
          return 'queued';
        })();
        """)
        let single = try await awaitMessage { $0["action"] as? String == "downloadBatch" }
        let items = try XCTUnwrap(single["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 1, "新入口一次只能发起一个单集下载：\(single)")
        XCTAssertEqual(items.first?["title"] as? String, "测试剧")
        XCTAssertEqual(items.first?["epKey"] as? String, "0")
        XCTAssertEqual(items.first?["url"] as? String, "https://media.example/0.mp4")
    }

    // MARK: - 2. 真实队列入队与我的下载页

    /// 原生队列持久化三条单集任务；我的下载只显示运行剧名、集数和接收状态。
    func testRealQueueProgressAppearsInMyDownloads() async throws {
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
          document.querySelector('[data-pw-act=dl]').click();
          document.getElementById('iosDlListBtn').click();
          var item = document.getElementById('iosMineQueue');
          if (!item) return 'missing-show';
          var rows = item.querySelectorAll('.ios-dl-task');
          if (!rows.length) return 'missing-rows';
          var first = rows[0];
          return JSON.stringify({
            title: first.querySelector('.ios-dl-task-title').textContent,
            meta: first.querySelector('.ios-dl-task-meta').textContent,
            rows: rows.length,
            settingsLibrary: !!document.getElementById('iosDownloadLibrary')
          });
        })();
        """)
        let renderedText = try XCTUnwrap(rendered as? String)
        XCTAssertNotEqual(renderedText, "missing-show", "真实队列没有出现在我的下载页")
        XCTAssertNotEqual(renderedText, "missing-rows", "真实队列没有按集列出")
        let ui = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(renderedText.utf8)) as? [String: Any])
        XCTAssertTrue((ui["title"] as? String ?? "").contains("测试剧"), "我的下载显示剧名：\(renderedText)")
        XCTAssertTrue((ui["meta"] as? String ?? "").contains("%") || (ui["meta"] as? String ?? "").contains("MB"),
                      "每一集下面要有进度条百分比和已下载大小：\(renderedText)")
        XCTAssertEqual(ui["rows"] as? Int, 3, "三集各占一行（两集在跑、一集排队）：\(renderedText)")
        XCTAssertEqual(ui["settingsLibrary"] as? Bool, false, "队列状态不能回到旧设置片库：\(renderedText)")
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
