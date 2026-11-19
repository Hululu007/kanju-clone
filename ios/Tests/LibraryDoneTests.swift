import XCTest
import WebKit
@testable import ZhuijuAI

/// 0.1.18：此回归验证连续逐集下载完成后我的下载页正确记录各集。
///
/// 使用真 WKWebView 和原生 `MediaDownloader.eventsForPage()` 完成事件，
/// 逐集经过新版下载页入队，再确认每条真实落盘记录都能在「我的下载」逐集查看。
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
          /* 片库/队列/批量记忆都存在 localStorage，测试类之间会互相污染：
             这里清空，保证每个用例从「什么都没下过」开始（不是放宽断言）。 */
          try {
            localStorage.removeItem('kj-ios-downloads');
            localStorage.removeItem('kj-ios-download');
            localStorage.removeItem('kj-ios-queue');
            localStorage.removeItem('kj-ios-batch');
          } catch (error) { return 'blocked:' + (error && error.name); }

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

    func testFinishedSingleEpisodesAppearInMyDownloads() async throws {
        _ = try await javaScript("document.getElementById('iosTitleDownload').click(); true;")
        var items: [[String: Any]] = []
        for index in 0..<5 {
            _ = try await javaScript("document.getElementById('iosDlCell6-\(index)').click(); true;")
            let item = await awaitDownloadItem(index: index)
            items.append(try XCTUnwrap(item, "第\(index + 1)集没有通过单集入口入队"))
        }

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

        /* 按 WebViewController.flushDownloadEvents 的顺序交给网页，再打开我的下载 */
        for event in events {
            let json = try JSONSerialization.data(withJSONObject: event)
            let text = try XCTUnwrap(String(data: json, encoding: .utf8))
            _ = try await javaScript("window.__zhuijuDownload && window.__zhuijuDownload(\(text)); true;")
        }
        let rendered = try await javaScript("""
        (function () {
          document.getElementById('iosDlListBtn').click();
          var item = document.getElementById('iosMineBody').querySelector('.ip-show');
          if (!item) return 'missing-show';
          return JSON.stringify({
            title: item.querySelector('.ips-title').textContent,
            count: item.querySelector('.ips-meta').textContent,
            episodes: Array.prototype.map.call(item.parentNode.querySelectorAll('.ip-eptitle'), function (episode) {
              return episode.textContent;
            }),
            oldBatchActions: !!document.querySelector('[data-batch-action]'),
            showId: item.parentNode.getAttribute('data-show')
          });
        })();
        """)
        let text = try XCTUnwrap(rendered as? String)
        XCTAssertNotEqual(text, "missing-show", "完成 5 集后片库里一部剧都没有：\(text)")
        let ui = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(ui["title"] as? String, "测试剧", "片库条目要用真实剧名：\(text)")
        XCTAssertEqual(ui["showId"] as? String, "fixture", "5 个单集必须归到同一部剧：\(text)")
        XCTAssertEqual(ui["count"] as? String, "已下载 5 集 · 0.0 MB", "5 集完成必须写进片库：\(text)")
        XCTAssertEqual(ui["episodes"] as? [String], ["第1集", "第2集", "第3集", "第4集", "第5集"],
                       "5 个集号都要能点开：\(text)")
        XCTAssertEqual(ui["oldBatchActions"] as? Bool, false, "我的下载页不应残留整部剧批量操作")

        /* 幂等：原生换页/重启会把同一批 done 再送一遍，片库不能重复计数或重复提示 */
        for event in events {
            let json = try JSONSerialization.data(withJSONObject: event)
            let payload = try XCTUnwrap(String(data: json, encoding: .utf8))
            _ = try await javaScript("window.__zhuijuDownload && window.__zhuijuDownload(\(payload)); true;")
        }
        let again = try await javaScript("""
        (function () {
          var item = document.getElementById('iosMineBody').querySelector('.ip-show');
          if (!item) return 'missing-show';
          return JSON.stringify({
            count: item.querySelector('.ips-meta').textContent,
            episodes: item.parentNode.querySelectorAll('.ip-eptitle').length
          });
        })();
        """)
        let replayText = try XCTUnwrap(again as? String, "重送之后片库不在了：\(String(describing: again))")
        let replay = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(replayText.utf8)) as? [String: Any])
        XCTAssertEqual(replay["count"] as? String, "已下载 5 集 · 0.0 MB", "重送同一批 done 不得重复计数：\(replay)")
        XCTAssertEqual(replay["episodes"] as? Int, 5, "重送同一批 done 不得多出集：\(replay)")
    }

    private func awaitDownloadItem(index: Int, timeout: Double = 10) async -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for message in bridge.bodies.reversed() where message["action"] as? String == "downloadBatch" {
                guard let items = message["items"] as? [[String: Any]], items.count == 1,
                      items.first?["epKey"] as? String == String(index) else { continue }
                return items.first
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("第\(index + 1)集没有产生单集入队消息：\(bridge.bodies)")
        return nil
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
