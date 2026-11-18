import XCTest
import WebKit
@testable import ZhuijuAI

/// 0.1.14 复审阻塞：批量 5 集全部完成，队列显示 5/5、100%，
/// 但设置里的片库还是「已下载 0/5 集」「下载进度：尚未下载」。
///
/// 这里用真 WKWebView + **原生自己生成的 done 事件**（`MediaDownloader.eventsForPage()`）
/// 复现：先真点「一键全集」写出 5 集任务，再把 5 条真实完成记录交给网页，
/// 断言设置面板的片库出现 5/5 集、剧名和 5 个集号。
/// 修前：这些 done 事件在网页入口被 id 不匹配直接丢掉，片库 0/5 → 红。
@MainActor
final class LibraryDoneTests: XCTestCase, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: UIWindow!
    private var loaded: XCTestExpectation?
    private let bridge = Recorder()
    private var tasksKey: String { MediaDownloader.tasksKey }

    final class Recorder: NSObject, WKScriptMessageHandler {
        private let lock = NSLock()
        private var storage: [[String: Any]] = []
        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            lock.lock(); storage.append(body); lock.unlock()
        }
        var bodies: [[String: Any]] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }
    }

    private static let fixtureHTML = """
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html,body{margin:0;padding:0;background:#07131b;color:#fff}
      .main{width:390px}
      #player{width:390px;height:220px;background:#000}
      #epGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:8px}
      .ep{min-height:38px}
    </style></head><body><div class="main">
      <button type="button" data-action="settings">设置</button>
      <div class="detail-info"><h1>测试剧</h1></div>
      <section id="player"><video id="video" playsinline preload="metadata"></video></section>
      <div id="playTools"><button id="settingsBtn" type="button">显示设置</button>
      <button id="dmBtn" type="button">弹幕</button></div>
      <div id="settingsPanel" hidden></div>
      <div id="epGrid">
        <button class="ep on" type="button" data-ep="0">第1集</button>
        <button class="ep" type="button" data-ep="1">第2集</button>
        <button class="ep" type="button" data-ep="2">第3集</button>
        <button class="ep" type="button" data-ep="3">第4集</button>
        <button class="ep" type="button" data-ep="4">第5集</button>
      </div>
    </div></body></html>
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

        _ = try await javaScript("""
        (function () {
          localStorage.setItem('kj-auth-token', 'fixture-token');
          window.fetch = function (input) {
            var address = typeof input === 'string' ? input : (input && input.url) || '';
            var query = address.indexOf('?') >= 0 ? address.slice(address.indexOf('?') + 1) : '';
            var params = {};
            query.split('&').forEach(function (pair) {
              var parts = pair.split('=');
              if (parts[0]) params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
            });
            var idx = Number(params.ep);
            return Promise.resolve(new Response(JSON.stringify({
              showId: 'fixture', idx: idx, episodeNumber: idx + 1, verified: true,
              kind: 'mp4', url: 'https://media.example/' + idx + '.mp4'
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
          };
          return true;
        })();
        """)
        let source = try String(
            contentsOf: XCTUnwrap(Bundle.main.url(forResource: "AppBootstrap", withExtension: "js")),
            encoding: .utf8
        )
        _ = try await javaScript("(function(){\n" + source + "\nreturn true;})();")
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

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    func testAllFiveFinishedBatchEpisodesAppearInTheDownloadLibrary() async throws {
        /* 1. 真点「一键全集」：网页写出批量任务并记住剧名/总集数 */
        _ = try await javaScript("document.getElementById('iosBatchAll').click(); true;")
        let batch = await awaitFirstBatchMessage()
        let items = try XCTUnwrap(batch["items"] as? [[String: Any]], "没有发出批量任务：\(batch)")
        XCTAssertEqual(items.count, 5)
        let show = try XCTUnwrap(batch["show"] as? [String: Any])
        XCTAssertEqual(show["title"] as? String, "测试剧")

        /* 2. 写 5 条真实完成记录（文件真的存在），让原生自己生成 done 事件 */
        var records: [[String: Any]] = []
        for (index, item) in items.enumerated() {
            let id = try XCTUnwrap(item["id"] as? String)
            let epKey = try XCTUnwrap(item["epKey"] as? String)
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent("library-done-\(UUID().uuidString)-\(index).mp4")
            let bytes = Data(repeating: UInt8(index + 1), count: 1024 + index)
            try bytes.write(to: file)
            records.append([
                "id": id,
                "url": item["url"] as? String ?? "",
                "name": item["name"] as? String ?? "",
                "title": "测试剧",
                "ep": item["epLabel"] as? String ?? "第\(index + 1)集",
                "meta": [
                    "showId": "fixture", "epKey": epKey, "title": "测试剧",
                    "epLabel": item["epLabel"] as? String ?? "", "cover": "https://img.example/cover.jpg",
                    "total": "5",
                ],
                "received": bytes.count, "total": bytes.count, "status": "done",
                "path": file.path, "size": bytes.count, "reason": "", "delivered": false,
                "taskIdentifier": 100 + index, "updatedAt": Date().timeIntervalSince1970,
                "showId": "fixture", "epKey": epKey,
            ])
        }
        let data = try JSONSerialization.data(withJSONObject: records)
        UserDefaults.standard.set(data, forKey: tasksKey)
        let events = MediaDownloader().eventsForPage()
        XCTAssertEqual(events.count, 5, "原生必须给出 5 条完成事件：\(events)")
        XCTAssertTrue(events.allSatisfy { ($0["event"] as? String) == "done" })

        /* 3. 按 WebViewController.flushDownloadEvents 的顺序交给网页，再打开设置 */
        for event in events {
            let json = try JSONSerialization.data(withJSONObject: event)
            let text = try XCTUnwrap(String(data: json, encoding: .utf8))
            _ = try await javaScript("window.__zhuijuDownload && window.__zhuijuDownload(\(text)); true;")
        }
        let rendered = try await javaScript("""
        (function () {
          document.querySelector('[data-action="settings"]').click();
          var item = document.getElementById('iosDlShows').children[0];
          if (!item) return 'missing-show';
          var chips = item.querySelector('.ios-dl-eps');
          return JSON.stringify({
            title: item.querySelector('.ios-dl-name').textContent,
            count: item.querySelector('.ios-dl-count').textContent,
            episodes: chips ? Array.prototype.map.call(chips.children, function (c) { return c.textContent; }) : [],
            progress: document.getElementById('iosDownloadLabel').textContent
          });
        })();
        """)
        let text = try XCTUnwrap(rendered as? String)
        XCTAssertNotEqual(text, "missing-show", "完成 5 集后片库里一部剧都没有：\(text)")
        let ui = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(ui["title"] as? String, "测试剧", "片库条目要用真实剧名：\(text)")
        XCTAssertEqual(ui["count"] as? String, "已下载 5/5 集", "5 集完成必须写进片库：\(text)")
        XCTAssertEqual(ui["episodes"] as? [String], ["第1集", "第2集", "第3集", "第4集", "第5集"],
                       "5 个集号都要能点开：\(text)")
        /* 当前这一集（第1集）就是批量里刚下完的那一集：脚下那行不能还写「尚未下载」 */
        XCTAssertEqual(ui["progress"] as? String, "下载进度：已完成 · 点下方选择播放器",
                       "批量下完的当前集，单集进度行必须显示已完成：\(text)")

        /* 幂等：原生换页/重启会把同一批 done 再送一遍，片库不能重复计数或重复提示 */
        for event in events {
            let json = try JSONSerialization.data(withJSONObject: event)
            let payload = try XCTUnwrap(String(data: json, encoding: .utf8))
            _ = try await javaScript("window.__zhuijuDownload && window.__zhuijuDownload(\(payload)); true;")
        }
        let again = try await javaScript("""
        (function () {
          var item = document.getElementById('iosDlShows').children[0];
          if (!item) return 'missing-show';
          var chips = item.querySelector('.ios-dl-eps');
          return JSON.stringify({
            count: item.querySelector('.ios-dl-count').textContent,
            episodes: chips ? Array.prototype.map.call(chips.children, function (c) { return c.textContent; }) : []
          });
        })();
        """)
        let replayText = try XCTUnwrap(again as? String, "重送之后片库不在了：\(String(describing: again))")
        let replay = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(replayText.utf8)) as? [String: Any])
        XCTAssertEqual(replay["count"] as? String, "已下载 5/5 集", "重送同一批 done 不得重复计数：\(replay)")
        XCTAssertEqual(replay["episodes"] as? [String], ["第1集", "第2集", "第3集", "第4集", "第5集"],
                       "重送同一批 done 不得多出集：\(replay)")
    }

    private func awaitFirstBatchMessage(timeout: Double = 10) async -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = bridge.bodies.last(where: { ($0["action"] as? String) == "downloadBatch" }) { return hit }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("没有等到批量下载消息：\(bridge.bodies)")
        return [:]
    }

    private func javaScript(_ source: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any?, Error>) in
            webView.evaluateJavaScript(source) { value, error in
                if let error = error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
        }
    }
}
