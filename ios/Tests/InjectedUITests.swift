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
    private static let fixtureHTML = """
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body>
      <button class="icon-btn" type="button" data-action="settings" aria-label="设置">设置</button>
      <header class="page-head">
        <a class="ph-back" href="/" aria-label="返回">返回</a>
        <h1 class="ph-title">百日谎言</h1>
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
      <button class="ep on" type="button" data-ep="18">第19集</button>
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

    // MARK: - REG-001 横屏全屏的片名标题

    func testLandscapePlaybackHidesTheTitleAndSurvivesAFullscreenRoundTrip() async throws {
        let raw = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          var full = document.getElementById('ppFull');
          var label = document.getElementById('playerLabel');
          var tools = document.getElementById('playTools');
          if (!full || !label) return 'missing:' + [!!full, !!label].join(',');
          var head = document.querySelector('.page-head');
          var shot = function (tag) {
            return tag + '=' + document.documentElement.hasAttribute('data-ios-immersive')
              + '/' + getComputedStyle(label).display
              + '/' + getComputedStyle(tools).display
              + '/' + (head ? getComputedStyle(head).display : 'no-head');
          };
          var log = ['landscape=' + window.matchMedia('(orientation: landscape)').matches];
          video.dispatchEvent(new Event('play', { bubbles: true }));
          log.push(shot('playing'));
          full.click();
          log.push(shot('fullscreen'));
          full.click();
          log.push(shot('exited'));
          video.dispatchEvent(new Event('play', { bubbles: true }));
          log.push(shot('replayed'));
          return log.join(' ');
        })();
        """)
        let log = try XCTUnwrap(raw as? String)
        XCTAssertTrue(log.contains("landscape=true"), "夹具不是横屏，这条用例就失去意义：\(log)")
        XCTAssertTrue(log.contains("playing=true/none/none/none"), "横屏播放时片名小签、上方工具条、以及顶上的站点头栏都必须收起：\(log)")
        XCTAssertTrue(log.contains("fullscreen=true/none/none/none"), "进全屏后标题必须收起：\(log)")
        XCTAssertTrue(log.contains("exited=false/inline/block/block"), "退出全屏应回到页内布局：\(log)")
        XCTAssertTrue(log.contains("replayed=true/none/none/none"),
                      "退出全屏后再播（换集/重播）必须重新沉浸，标题和头栏都不能留在画面上（0.1.9 / 0.1.10 的 bug）：\(log)")
    }

    /// 站点的全屏按钮走标准全屏 API，那条路只靠 `:fullscreen` 规则和 fullscreenchange。
    /// iPhone 模拟器没有元素全屏 API，所以这里验规则真的进了样式表（写错一个字符会被整条丢掉）。
    func testStandardFullscreenRulesHideTheTitle() async throws {
        let raw = try await javaScript("""
        (function () {
          var found = { label: 0, toolbar: 0, tabbar: 0 };
          var sheets = document.styleSheets;
          for (var s = 0; s < sheets.length; s++) {
            var rules;
            try { rules = sheets[s].cssRules; } catch (error) { continue; }
            for (var r = 0; r < rules.length; r++) {
              var selector = String(rules[r].selectorText || '');
              if (selector.indexOf(':fullscreen') < 0 && selector.indexOf(':-webkit-full-screen') < 0) continue;
              if (selector.indexOf('.p-label') >= 0) found.label++;
              if (selector.indexOf('.pp-toolbar') >= 0) found.toolbar++;
              if (selector.indexOf('.tabbar') >= 0) found.tabbar++;
            }
          }
          return JSON.stringify(found);
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let found = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Int])
        XCTAssertGreaterThan(found["label"] ?? 0, 0, "标准全屏里没有隐藏片名的规则，标题会压在视频上：\(text)")
        XCTAssertGreaterThan(found["toolbar"] ?? 0, 0, "标准全屏里工具条也要收起：\(text)")
        XCTAssertGreaterThan(found["tabbar"] ?? 0, 0, "标准全屏里底部导航也要收起：\(text)")
    }

    // MARK: - REG-002 工具条上的下载按钮（占「弹幕」那一格）

    func testToolbarDownloadButtonReplacesTheDanmakuSlot() async throws {
        let raw = try await javaScript("""
        (function () {
          /* 夹具里预置了一条「正在下载 42%」：先收尾回空闲态，再验按钮本身。
             下载要一个真实直链，否则注入层会如实拒绝（「还没拿到直链」）。 */
          window.__zhuijuDownload({ id: 'dl1', event: 'cancelled' });
          document.getElementById('video').src = 'https://media.example/19.mp4';
          var tools = document.getElementById('playTools');
          var dm = document.getElementById('dmBtn');
          var button = document.getElementById('ppToolDownload');
          if (!button) return 'missing-button';
          var ids = [];
          for (var i = 0; i < tools.children.length; i++) ids.push(tools.children[i].id);
          return JSON.stringify({
            dmHidden: dm ? getComputedStyle(dm).display === 'none' : 'no-dm',
            ids: ids,
            dmStillInDom: !!dm,
            label: button.textContent
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["dmHidden"] as? Bool, true, "弹幕按钮要让位（隐藏，不删除站点节点）：\(text)")
        XCTAssertEqual(result["dmStillInDom"] as? Bool, true)
        let ids = try XCTUnwrap(result["ids"] as? [String])
        let slot = try XCTUnwrap(ids.firstIndex(of: "ppToolDownload"), "工具条上必须有下载按钮：\(text)")
        XCTAssertEqual(ids.firstIndex(of: "dmBtn"), slot + 1, "下载要正好占住弹幕那一格（紧挨在它前面）：\(text)")
        XCTAssertEqual(result["label"] as? String, "下载本集")

        /* 点一下就要真的发起下载（夹具已塞登录 token 与直链） */
        let clicked = try await javaScript("""
        (function () {
          document.getElementById('ppToolDownload').click();
          return document.getElementById('ppToolDownload').textContent;
        })();
        """)
        XCTAssertEqual(clicked as? String, "下载 0%", "点了之后按钮要立刻显示进度：\(String(describing: clicked))")
        var message = try await awaitPlayerMessage()
        XCTAssertEqual(message["action"] as? String, "download", "工具条上的下载也要走原生传输：\(message)")
        XCTAssertEqual(message["url"] as? String, "https://media.example/19.mp4")

        /* 进度要显示在按钮上，完成就地变成交给播放器的入口 */
        let downloadId = try XCTUnwrap(message["id"] as? String)
        let afterProgress = try await javaScript("""
        (function () {
          window.__zhuijuDownload({ id: '\(downloadId)', event: 'progress', received: 43, total: 100 });
          return document.getElementById('ppToolDownload').textContent;
        })();
        """)
        XCTAssertEqual(afterProgress as? String, "下载 43%")
        let afterDone = try await javaScript("""
        (function () {
          window.__zhuijuDownload({ id: '\(downloadId)', event: 'done', path: '/tmp/追剧AI_第19集.mp4',
            name: '追剧AI_第19集.mp4', size: 10485760 });
          var button = document.getElementById('ppToolDownload');
          var label = button.textContent;
          button.click();
          return label;
        })();
        """)
        XCTAssertEqual(afterDone as? String, "用播放器打开", "下完就地变成交给播放器 App 的入口：\(String(describing: afterDone))")
        message = try await awaitPlayerMessage()
        XCTAssertEqual(message["action"] as? String, "openLocal", "点一下就交给系统播放器列表：\(message)")
        XCTAssertEqual(message["path"] as? String, "/tmp/追剧AI_第19集.mp4")
    }

    // MARK: - REG-002 首页设置面板里的下载进度

    func testSettingsSheetShowsTheRunningDownload() async throws {
        let raw = try await javaScript("""
        (function () {
          var trigger = document.querySelector('[data-action="settings"]');
          if (!trigger) return 'missing-trigger';
          trigger.click();
          var sheet = document.getElementById('iosSettingsSheet');
          var body = document.getElementById('iosSettingsBody');
          var box = document.getElementById('iosDownloadStatus');
          var label = document.getElementById('iosDownloadLabel');
          var fill = document.getElementById('iosDownloadFill');
          if (!sheet || !box || !label) return 'missing-sheet';
          var result = {
            opened: sheet.hidden === false,
            visible: getComputedStyle(sheet).display !== 'none',
            inSheet: !!body && body.contains(box),
            labelOnOpen: label.textContent,
            widthOnOpen: fill ? fill.style.width : '',
            buttonHiddenOnOpen: document.getElementById('iosOpenDownloaded').hidden
          };
          window.__zhuijuDownload({ id: 'dl1', event: 'progress', received: 55, total: 100 });
          result.labelAfterProgress = label.textContent;
          result.widthAfterProgress = fill ? fill.style.width : '';
          window.__zhuijuDownload({ id: 'dl1', event: 'done', path: '/tmp/x.mp4', name: '追剧AI_第3集.mp4', size: 10485760 });
          result.labelAfterDone = label.textContent;
          result.buttonHiddenAfterDone = document.getElementById('iosOpenDownloaded').hidden;
          result.storedState = JSON.parse(localStorage.getItem('kj-ios-download') || '{}').state || '';
          return JSON.stringify(result);
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["opened"] as? Bool, true, "点顶栏设置要打开面板（站点自己只弹「即将上线」）：\(text)")
        XCTAssertEqual(result["visible"] as? Bool, true, "面板必须是可见的，不能只是 hidden=false：\(text)")
        XCTAssertEqual(result["inSheet"] as? Bool, true, "下载进度要出现在这块面板里：\(text)")
        XCTAssertEqual(result["labelOnOpen"] as? String, "下载进度：42%", "换页回来要接上正在跑的进度：\(text)")
        XCTAssertEqual(result["widthOnOpen"] as? String, "42%")
        XCTAssertEqual(result["buttonHiddenOnOpen"] as? Bool, true, "还没下载完就不该给「用其他播放器播放」")
        XCTAssertEqual(result["labelAfterProgress"] as? String, "下载进度：55%", "原生回传的进度要实时反映：\(text)")
        XCTAssertEqual(result["widthAfterProgress"] as? String, "55%")
        XCTAssertEqual(result["labelAfterDone"] as? String, "下载进度：已完成 · 点下方选择播放器")
        XCTAssertEqual(result["buttonHiddenAfterDone"] as? Bool, false, "下完就要能交给播放器 App：\(text)")
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

    // MARK: - REG-003 默认第三方播放器

    func testCastButtonHandsTheLinkToTheSystemPlayerInOneTap() async throws {
        let raw = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          window.__pauseCalls = 0;
          window.__paused = false;
          video.pause = function () { window.__pauseCalls++; window.__paused = true; };
          Object.defineProperty(video, 'paused', { configurable: true, get: function () { return window.__paused; } });
          video.src = 'https://media.example/19.mp4';
          var cast = document.getElementById('ppCast');
          if (!cast) return 'missing-cast';
          cast.click();
          var menu = document.getElementById('ppCastMenu');
          return JSON.stringify({
            pauseCalls: window.__pauseCalls,
            paused: window.__paused,
            menuOpen: String(menu.className).indexOf('pc-cast-menu on') >= 0,
            preference: localStorage.getItem('kj-ios-ext-player')
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["menuOpen"] as? Bool, false, "默认应该直接交接，不该先弹菜单：\(text)")
        XCTAssertEqual(result["pauseCalls"] as? Int, 1, "交接前必须暂停 App 内播放：\(text)")
        XCTAssertEqual(result["paused"] as? Bool, true)
        XCTAssertEqual(result["preference"] as? String, "1", "用过一次要记住这个默认：\(text)")

        let message = try await awaitPlayerMessage()
        XCTAssertEqual(message["action"] as? String, "share", "一次点击就要把这一集交给系统播放器列表：\(message)")
        XCTAssertEqual(message["url"] as? String, "https://media.example/19.mp4")
    }

    func testCastMenuLeadsWithTheExternalPlayerRow() async throws {
        let raw = try await javaScript("""
        (function () {
          /* 长按只看 event.target，普通 Event 就够了（TouchEvent 构造器在 Safari 上要求真 Touch 对象）。 */
          document.getElementById('video').src = 'https://media.example/19.mp4';
          var cast = document.getElementById('ppCast');
          cast.dispatchEvent(new Event('touchstart', { bubbles: true }));
          return 'armed';
        })();
        """)
        XCTAssertEqual(raw as? String, "armed")
        /* 长按要开菜单：等计时器（650ms）到点 */
        try await Task.sleep(nanoseconds: 900_000_000)
        let menu = try await javaScript("""
        (function () {
          var menu = document.getElementById('ppCastMenu');
          if (!menu) return 'missing-menu';
          var rows = [];
          for (var i = 0; i < menu.children.length; i++) rows.push(menu.children[i].id);
          return JSON.stringify({ open: String(menu.className).indexOf('pc-cast-menu on') >= 0, rows: rows });
        })();
        """)
        let text = try XCTUnwrap(menu as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["open"] as? Bool, true, "长按「外放」要打开完整菜单：\(text)")
        let rows = try XCTUnwrap(result["rows"] as? [String])
        XCTAssertEqual(rows.first, "ppPlayExternal", "第三方播放器要排在菜单第一行：\(text)")
    }

    func testSettingsSheetCanTurnTheOneTapHandoffOff() async throws {
        let raw = try await javaScript("""
        (function () {
          document.querySelector('[data-action="settings"]').click();
          var toggle = document.getElementById('iosExtToggle');
          var before = toggle.textContent;
          toggle.click();
          var after = toggle.textContent;
          var preference = localStorage.getItem('kj-ios-ext-player');
          var cast = document.getElementById('ppCast');
          var menu = document.getElementById('ppCastMenu');
          menu.className = 'pc-cast-menu';
          cast.click();
          return JSON.stringify({
            before: before, after: after, preference: preference,
            menuOpenAfterOptOut: String(menu.className).indexOf('pc-cast-menu on') >= 0
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["before"] as? String, "播放方式：第三方播放器", "第一次安装的默认值就是第三方播放器：\(text)")
        XCTAssertEqual(result["after"] as? String, "播放方式：App 内播放")
        XCTAssertEqual(result["preference"] as? String, "0")
        XCTAssertEqual(result["menuOpenAfterOptOut"] as? Bool, true, "关掉默认后「外放」回到菜单：\(text)")
    }

    // MARK: - 桥接工具

    /// 等注入层发到 `iosPlayer` 通道的消息（原生回传是异步的，不能立刻断言）。
    private func awaitPlayerMessage(timeout: Double = 5) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let last = bridge.bodies.last { return last }
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
