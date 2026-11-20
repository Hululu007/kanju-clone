import XCTest
import WebKit

/// 注入层的模拟器回归：真 WKWebView、真 DOM、真 CSS、真 WebKit 消息通道。
///
/// 和 `bootstrap.test.mjs` 的分工：Node 夹具能伪造 DOM，但证明不了「样式真的生效」和
/// 「WKWebView 里点一下真的会走这条路」。这里用固定夹具页面（不联网、不需要站点密码）
/// 加 App 包里那份真正的 `AppBootstrap.js`，在模拟器里把 0.1.10 的三项修复点一遍：
/// 横屏全屏的标题、首页设置面板里的下载进度、默认第三方播放器。
///
/// 仍然测不了、只能真机验收的部分：真实片源能否播放/HLS 解码、后台音频、画中画、
/// 系统分享面板里到底列出哪些播放器 App、音频焦点是否真的交出去。
@MainActor
@available(iOS 15.0, *)
final class InjectedUITests: XCTestCase, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: UIWindow!
    private var loaded: XCTestExpectation?
    private var slotCounter = 0
    private let bridge = PlayerMessageRecorder()

    /// 捕获注入层发给原生层的消息（`iosPlayer` 通道）。
    /// 写成非 MainActor 的普通类，和 `WebViewController.PlayerBridge` 一样：
    /// 这个协议在这个 SDK 里不是 MainActor 隔离的。
    final class PlayerMessageRecorder: NSObject, WKScriptMessageHandler {
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
    }

    /// 播放页 + 首页共用的最小骨架：注入层要挂的节点全都在，和站点模板同名同 class。
    /// 外面那层 `.main` 和它的内联样式照抄站点的移动端布局（顶栏 60px + 从它下面开始的
    /// 滚动容器）：真机上横屏全屏顶部那条 60px 深灰带就出在这里。
    private static let fixtureHTML = """
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html, body { margin: 0; padding: 0; background: #07131b; }
      .main { height: calc(100vh - 60px); margin-top: 60px; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; }
      .page-head { position: fixed; top: 0; left: 0; right: 0; height: 60px; z-index: 40; background: linear-gradient(180deg, rgba(10,20,28,.92), rgba(10,20,28,.6)); }
    </style>
    </head>
    <body>
    <div class="main">
      <button class="icon-btn" type="button" data-action="settings" aria-label="设置">设置</button>
      <header class="page-head">
        <a class="ph-back" href="/" aria-label="返回">返回</a>
        <h1 class="ph-title">测试剧</h1>
        <button class="ph-menu" type="button" aria-label="打开菜单">菜单</button>
      </header>
      <section class="player" id="player">
        <video id="video" playsinline preload="metadata"></video>
        <span class="p-label" id="playerLabel">测试剧 · 第19集</span>
      </section>
      <div class="pp-toolbar" id="playTools">
        <button class="pp-tool" id="settingsBtn" type="button">显示设置</button>
        <button class="pp-tool on" id="dmBtn" type="button">弹幕 开</button>
        <button class="pp-tool" id="pipBtn" type="button">画中画</button>
        <button class="pp-tool" id="nextEpBtn" type="button">下一集</button>
      </div>
      <div class="pp-settings" id="settingsPanel" hidden></div>
      <div class="line-bar" id="lineBar" hidden></div>
      <p class="pp-hint" id="playHint">点播放即可观看</p>
      <nav class="tabbar"><button class="tab" type="button">首页</button></nav>
      <div class="ep-grid" id="epGrid"><button class="ep on" type="button" data-ep="18">第19集</button></div>
    </div>
    </body></html>
    """

    override func setUp() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(bridge, name: "iosPlayer")
        /* 844×390 就是横屏：注入层的 landscape() 先看 matchMedia，再看宽高，
           两个条件在这一帧尺寸下都成立，和真机转到横屏等价。 */
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 844, height: 390), configuration: configuration)
        webView.navigationDelegate = self
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 844, height: 390))
        let controller = UIViewController()
        controller.view.addSubview(webView)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        loaded = expectation(description: "fixture loaded")
        webView.loadHTMLString(Self.fixtureHTML, baseURL: URL(string: "https://zhuiju.dpdns.org/player/?id=fixture"))
        await fulfillment(of: [loaded!], timeout: 60)

        /* 注入层把下载状态和「播放方式」放在 localStorage 里：先确认夹具页面真的能用它，
           否则这些用例会在一个假前提下变绿。 */
        let storage = try await javaScript("""
        (function () {
          try {
            localStorage.setItem('probe', '1');
            localStorage.removeItem('probe');
            localStorage.setItem('kj-auth-token', 'fixture-token');
            localStorage.setItem('kj-ios-download', JSON.stringify({
              id: 'dl1', name: '追剧AI_第3集.mp4', path: '', busy: true, percent: 42,
              error: '', state: 'running'
            }));
            return 'ok';
          } catch (error) { return 'blocked:' + (error && error.name); }
        })();
        """) as? String
        XCTAssertEqual(storage, "ok", "夹具页面的 localStorage 不可用，下载状态与播放方式偏好都读不到")

        let source = try String(
            contentsOf: XCTUnwrap(Bundle.main.url(forResource: "AppBootstrap", withExtension: "js")),
            encoding: .utf8
        )
        _ = try await javaScript("(function(){\n" + source + "\nreturn true;})();")
        let ready = try await awaitValue("window.__zhuijuIOSReady === true")
        XCTAssertTrue(ready, "AppBootstrap.js 没跑起来")
    }

    override func tearDown() async throws {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "iosPlayer")
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        window.isHidden = true
        window = nil
        webView = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    // MARK: - REG-002 单集下载页

    func testSingleEpisodeDownloadUsesTheDownloadPage() async throws {
        let raw = try await javaScript("""
        (function () {
          var button = document.querySelector('[data-pw-act=dl]');
          if (!button) return 'missing-button';
          button.click();
          var cell = document.getElementById('iosDlCell6-18');
          if (!cell) return 'missing-cell';
          cell.click();
          return JSON.stringify({
            label: button.textContent,
            toolbarEntry: !!document.getElementById('ppToolDownload'),
            pageOpen: document.getElementById('iosDlPage').hidden === false,
            cellLabel: cell.getAttribute('aria-label')
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["toolbarEntry"] as? Bool, false, "播放器工具条不留旧下载入口：\(text)")
        XCTAssertEqual(result["pageOpen"] as? Bool, true, "标题下载入口打开独立下载页：\(text)")
        XCTAssertTrue((result["cellLabel"] as? String ?? "").contains("第19集"))
        let message = try await awaitPlayerMessage(matching: { $0["action"] as? String == "downloadBatch" })
        let items = try XCTUnwrap(message["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 1, "点击一格只入队一集：\(message)")
        XCTAssertEqual(items.first?["epKey"] as? String, "18")
        XCTAssertEqual(items.first?["url"] as? String, "https://media.example/18.mp4")
    }

    // MARK: - 下载状态与设置面板边界

    func testSettingsSheetShowsTheRunningDownload() async throws {
        let raw = try await javaScript("""
        (function () {
          var trigger = document.querySelector('[data-action="settings"]');
          if (!trigger) return 'missing-trigger';
          trigger.click();
          var sheet = document.getElementById('iosSettingsSheet');
          var body = document.getElementById('iosSettingsBody');
          if (!sheet) return 'missing-sheet';
          var result = {
            opened: sheet.hidden === false,
            visible: getComputedStyle(sheet).display !== 'none',
            hasDownloadLibrary: !!document.getElementById('iosDownloadLibrary'),
            accountRows: Array.prototype.map.call(body.querySelectorAll('[data-setting-action]'), function (row) {
              return row.querySelector('b').textContent + ':' + row.querySelector('small').textContent;
            }),
            obsoleteProgress: !!document.getElementById('iosDownloadStatus')
          };
          window.__zhuijuDownload({ id: 'dl1', event: 'progress', received: 55, total: 100 });
          window.__zhuijuDownload({ id: 'dl1', event: 'done', path: '/tmp/x.mp4', name: '追剧AI_第3集.mp4', size: 10485760 });
          result.storedState = JSON.parse(localStorage.getItem('kj-ios-download') || '{}').state || '';
          return JSON.stringify(result);
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["opened"] as? Bool, true, "点顶栏设置要打开面板（站点自己只弹「即将上线」）：\(text)")
        XCTAssertEqual(result["visible"] as? Bool, true, "面板必须是可见的，不能只是 hidden=false：\(text)")
        XCTAssertEqual(result["hasDownloadLibrary"] as? Bool, false, "下载列表不能塞回设置面板：\(text)")
        XCTAssertEqual(result["accountRows"] as? [String], ["个人资料:即将上线", "账号安全:修改密码 · 即将上线"])
        XCTAssertEqual(result["obsoleteProgress"] as? Bool, false, "旧下载进度条不得重新出现：\(text)")
        XCTAssertEqual(result["storedState"] as? String, "done", "完成状态要落盘，否则换页回来又变回旧的：\(text)")
    }

    func testSettingsSheetCanBeClosedAndReopened() async throws {
        let raw = try await javaScript("""
        (function () {
          var trigger = document.querySelector('[data-action="settings"]');
          trigger.click();
          var sheet = document.getElementById('iosSettingsSheet');
          var opened = sheet.hidden === false;
          document.getElementById('iosSettingsClose').click();
          var closed = sheet.hidden === true && getComputedStyle(sheet).display === 'none';
          trigger.click();
          var reopened = sheet.hidden === false;
          return [opened, closed, reopened].join(',');
        })();
        """)
        XCTAssertEqual(raw as? String, "true,true,true", "面板要能关、能再打开：\(String(describing: raw))")
    }

    // MARK: - 播放设置与第三方播放器

    // MARK: - REG-005 全屏只剩画面

    // MARK: - REG-006 我的下载逐集列表

    /// 我的下载页要能看清「下载了哪些剧、每部下了哪几集、共几集、在下的到哪了」。
    /// 总集数未知时只写「已下载 N 集」——不得编一个分母。
    func testMyDownloadsPageListsDownloadedShowsAndTheRunningTask() async throws {
        let raw = try await javaScript("""
        (function () {
          localStorage.setItem('kj-ios-downloads', JSON.stringify({ shows: [
            { id: 'show-a', title: '百日谎言', cover: 'https://zhuiju.dpdns.org/posters/a.jpg', total: 12,
              eps: [{ key: '18', label: '第19集', name: '追剧AI_第19集.mp4', path: '/tmp/a19.mp4', size: 1, at: 2 },
                    { key: '19', label: '第20集', name: '追剧AI_第20集.mp4', path: '/tmp/a20.mp4', size: 1, at: 3 }] },
            { id: 'movie-b', title: '某部电影', cover: '', total: 0,
              eps: [{ key: '0', label: '正片', name: '追剧AI_正片.mp4', path: '/tmp/b.mp4', size: 2, at: 1 }] }
          ] }));
          window.__zhuijuDownload({ id: 'dl1', event: 'progress', showId: 'fixture', epKey: '18',
            title: '测试剧', epLabel: '第19集', received: 42, total: 100 });
          document.querySelector('[data-action="settings"]').click();
          var library = document.getElementById('iosMinePage');
          var running = document.getElementById('iosMineQueue');
          if (library || document.getElementById('iosDlRunning')) return 'legacy-library';
          document.getElementById('iosSettingsClose').click();
          document.querySelector('[data-pw-act=dl]').click();
          document.getElementById('iosDlListBtn').click();
          library = document.getElementById('iosMinePage');
          running = document.getElementById('iosMineQueue');
          var items = library.querySelectorAll('.ip-show');
          var first = items[0];
          var second = items[1];
          var cover = first.querySelector('img');
          var movieCover = second.querySelector('img');
          return JSON.stringify({
            visible: library.hidden === false,
            settingsHasLibrary: !!document.getElementById('iosDownloadLibrary'),
            count: items.length,
            title: first.querySelector('.ips-title').textContent,
            cover: cover ? cover.getAttribute('src') : null,
            coverAlt: cover ? cover.alt : null,
            counter: first.querySelector('.ips-meta').textContent,
            episodes: first.parentNode.querySelectorAll('.ip-eptitle').length,
            movieCover: movieCover ? 'has' : 'none',
            movieCounter: second.querySelector('.ips-meta').textContent,
            runningVisible: !!running && library.hidden === false,
            runningText: running ? running.textContent : ''
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["visible"] as? Bool, true, "我的下载页要显示已下载片库：\(text)")
        XCTAssertEqual(result["settingsHasLibrary"] as? Bool, false, "片库不属于设置面板：\(text)")
        XCTAssertEqual(result["count"] as? Int, 2, "两部片子各一条：\(text)")
        XCTAssertEqual(result["title"] as? String, "百日谎言")
        XCTAssertEqual(result["cover"] as? String, "https://zhuiju.dpdns.org/posters/a.jpg", "片名旁边要有封面：\(text)")
        XCTAssertEqual(result["coverAlt"] as? String, "百日谎言")
        XCTAssertEqual(result["counter"] as? String, "已下载 2 集 · 0.0 MB")
        XCTAssertEqual(result["episodes"] as? Int, 2, "每一集各有一行：\(text)")
        XCTAssertEqual(result["movieCover"] as? String, "none", "没有封面就不摆一张假图：\(text)")
        XCTAssertEqual(result["movieCounter"] as? String, "已下载 1 集 · 0.0 MB", "总集数未知时不许编分母：\(text)")
        XCTAssertEqual(result["runningVisible"] as? Bool, true, "运行中的下载要在我的下载页可见：\(text)")
        let runningText = try XCTUnwrap(result["runningText"] as? String)
        XCTAssertTrue(runningText.contains("42%"), "下载中的进度要实时显示：\(text)")
    }

    // MARK: - REG-009 下载文件/锁屏信息用的是 App 名，不是剧名

    /// 真机上文件、下载列表、通知里都是「追剧AI 第19集」，看不出是哪部剧。
    func testDownloadedFileAndNowPlayingUseTheShowTitle() async throws {
        _ = try await awaitValue("!!document.querySelector('[data-pw-act=dl]')")
        let raw = try await javaScript("""
        (function () {
          document.querySelector('[data-pw-act=dl]').click();
          document.getElementById('iosDlCell6-18').click();
          var session = navigator.mediaSession || null;
          return JSON.stringify({
            showTitle: (document.querySelector('.ph-title') || {}).textContent || '',
            mediaSessionTitle: session && session.metadata ? session.metadata.title : '',
            mediaSessionArtist: session && session.metadata ? session.metadata.artist : ''
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["showTitle"] as? String, "测试剧")
        let message = try await awaitPlayerMessage()
        let item = try XCTUnwrap((message["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(item["name"] as? String, "测试剧 第19集.mp4",
                       "文件名要用真实剧名，不能用 App 名冒充：\(message)")
        XCTAssertEqual(result["mediaSessionTitle"] as? String, "测试剧",
                       "锁屏读的是真实媒体会话元数据，不是 DOM 标题：\(text)")
        XCTAssertEqual(result["mediaSessionArtist"] as? String, "第19集")
    }

    // MARK: - REG-008 标题下载入口保持独立

    /// 下载状态变化后仍通过标题按钮进入下载页，不复活工具条旧入口。
    func testTitleDownloadEntryStaysSeparateAfterAFinishedDownload() async throws {
        let mounted = try await awaitValue("!!document.querySelector('[data-pw-act=dl]')")
        XCTAssertTrue(mounted, "标题旁没有下载入口")
        let raw = try await javaScript("""
        (function () {
          document.querySelector('[data-pw-act=dl]').click();
          var cell = document.getElementById('iosDlCell6-18');
          cell.click();
          if (!cell) return 'missing-cell';
          return JSON.stringify({
            titleEntry: !!document.querySelector('[data-pw-act=dl]'),
            toolbarEntry: !!document.getElementById('ppToolDownload'),
            pageOpen: document.getElementById('iosDlPage').hidden === false,
            cellState: cell.getAttribute('aria-label')
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["titleEntry"] as? Bool, true)
        XCTAssertEqual(result["toolbarEntry"] as? Bool, false, "新 UI 只有标题旁的下载入口")
        XCTAssertEqual(result["pageOpen"] as? Bool, true)
        XCTAssertTrue((result["cellState"] as? String ?? "").contains("第19集"))
        let message = try await awaitPlayerMessage(matching: { $0["action"] as? String == "downloadBatch" })
        let items = try XCTUnwrap(message["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 1, "一个单集格只会加入一集：\(message)")
        XCTAssertEqual(items.first?["epLabel"] as? String, "第19集")
    }

    // MARK: - 桥接工具

    /// JSONSerialization 给的矩形是 NSNumber 数组：拆成 [Int] 再比，避免桥接不稳。
    private func rect(_ value: Any?) -> [Int]? {
        guard let list = value as? [Any] else { return nil }
        return list.compactMap { ($0 as? NSNumber)?.intValue }
    }

    /// 等注入层发到 `iosPlayer` 通道的消息（原生回传是异步的，不能立刻断言）。
    private func awaitPlayerMessage(timeout: Double = 5, matching match: ([String: Any]) -> Bool = { _ in true }) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let message = bridge.bodies.last(where: match) { return message }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("注入层没有向原生层发出任何消息")
        return [:]
    }

    /// Objective-C completion-handler 桥。理由同 `PlaybackTests.javaScript`：
    /// 模拟器工具链里没有 libswiftWebKit.dylib，不能用 Swift overlay 的 async 重载。
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

    /// 轮询页内布尔表达式（注入层的挂载有几次延时补挂，不能只看当下）。
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
