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
        /* 0.1.12 这里断言的是「变成用播放器打开」，那正是 REG-008 的真机回归，不是需求。
           这一格必须一直是下载入口：下完再点会重新下载，而不是把文件交给播放器。 */
        XCTAssertEqual(afterDone as? String, "下载本集", "下完一集之后这一格还是下载入口：\(String(describing: afterDone))")
        message = try await awaitPlayerMessage()
        XCTAssertEqual(message["action"] as? String, "download", "下完再点还是下载，不是交给播放器：\(message)")
        XCTAssertNil(message["path"], "这里不能是 openLocal 的本地文件路径")
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

    // MARK: - REG-005 全屏只剩画面

    /// 横屏全屏时画面上方那条 60px 深灰带（真机截图里完全挡住画面）。
    /// 站点把滚动容器写成 `.main{margin-top:60px;height:calc(100vh - 60px)}`，
    /// 注入层只把 `#player` 设成 fixed 时，WebKit 会拿这个滚动容器当参照，
    /// 于是播放器少了顶部 60px，漏出页面背景。这里量的是真实几何值。
    func testFullscreenCoversTheWholeScreenAndHidesItsControls() async throws {
        let mounted = try await awaitValue("!!document.getElementById('ppFull') && !!document.getElementById('ppCtrl')")
        XCTAssertTrue(mounted, "注入层没挂上控制栏，这条用例就失去了意义")
        let raw = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          var player = document.getElementById('player');
          var main = document.querySelector('.main');
          var full = document.getElementById('ppFull');
          if (!full || !main) return 'missing:' + [!!full, !!main].join(',');
          /* 全屏里“正在播放”是收起控制栏的前提，这里把暂停态钉住 */
          window.__paused = false;
          Object.defineProperty(video, 'paused', { configurable: true, get: function () { return window.__paused; } });
          video.dispatchEvent(new Event('play', { bubbles: true }));
          full.click();
          var shot = function (tag) {
            var p = player.getBoundingClientRect();
            var m = main.getBoundingClientRect();
            var top = document.elementFromPoint(window.innerWidth / 2, 8);
            var bottom = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 8);
            var bar = document.getElementById('ppCtrl');
            var style = getComputedStyle(bar);
            return {
              tag: tag,
              immersive: document.documentElement.hasAttribute('data-ios-immersive'),
              player: [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)],
              main: [Math.round(m.left), Math.round(m.top), Math.round(m.width), Math.round(m.height)],
              topInPlayer: !!(top && (top === player || player.contains(top))),
              topTag: top ? (top.id || top.tagName) : 'none',
              bottomInPlayer: !!(bottom && (bottom === player || player.contains(bottom))),
              barHidden: style.visibility === 'hidden' || Number(style.opacity) === 0
            };
          };
          var log = [shot('fullscreen')];
          video.click();
          log.push(shot('tapped'));
          video.click();
          log.push(shot('tappedTwice'));
          return JSON.stringify(log);
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let shots = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]])
        XCTAssertEqual(shots.count, 3, "三次测量的返回不对：\(text)")

        let fullscreen = shots[0]
        XCTAssertEqual(fullscreen["immersive"] as? Bool, true, "点全屏要进沉浸态：\(text)")
        XCTAssertEqual(rect(fullscreen["player"]), [0, 0, 844, 390], "全屏时播放器必须铺满整块屏幕，顶部不能少 60px：\(text)")
        XCTAssertEqual(rect(fullscreen["main"]), [0, 0, 844, 390], "注入层必须把站点那个从 60px 开始的滚动容器也铺满（它就是顶部深灰带的来源）：\(text)")
        XCTAssertEqual(fullscreen["topInPlayer"] as? Bool, true, "屏幕最上面一行必须已经是视频，不能是页面背景/顶栏：\(text) top=\(fullscreen["topTag"] ?? "")")
        XCTAssertEqual(fullscreen["barHidden"] as? Bool, true, "刚进全屏、正在播放时控制栏就该收起，不留遮罩：\(text)")

        let tapped = shots[1]
        XCTAssertEqual(tapped["barHidden"] as? Bool, false, "点一下屏幕要把控制栏叫出来：\(text)")
        XCTAssertEqual(tapped["topInPlayer"] as? Bool, true, "叫出控制栏后画面顶部依然不能被遮住：\(text)")

        let tappedTwice = shots[2]
        XCTAssertEqual(tappedTwice["barHidden"] as? Bool, true, "再点一下要收起，不等计时器：\(text)")
        XCTAssertEqual(tappedTwice["bottomInPlayer"] as? Bool, true, "收起后底下也不能留一条底栏或渐变：\(text)")

        /* 点开控制栏后不再动手，几秒后它要自己消失 */
        _ = try await javaScript("document.getElementById('video').click(); 'tapped'")
        try await Task.sleep(nanoseconds: 3_600_000_000)
        let auto = try await javaScript("""
        (function () {
          var bar = document.getElementById('ppCtrl');
          var style = getComputedStyle(bar);
          var bottom = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 8);
          var player = document.getElementById('player');
          return JSON.stringify({
            hidden: style.visibility === 'hidden' || Number(style.opacity) === 0,
            bottomInPlayer: !!(bottom && (bottom === player || player.contains(bottom)))
          });
        })();
        """)
        let autoText = try XCTUnwrap(auto as? String)
        let autoResult = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(autoText.utf8)) as? [String: Any])
        XCTAssertEqual(autoResult["hidden"] as? Bool, true, "播放中几秒不动，控制栏必须自己收起：\(autoText)")
        XCTAssertEqual(autoResult["bottomInPlayer"] as? Bool, true, "自动收起后画面上不能留任何遮罩：\(autoText)")

        /* 退出全屏回到页内：控制栏要回来，否则连退出/换集都点不到。
           真机退出全屏会锁回竖屏（横屏+播放中会自动进沉浸，这是 0.1.9 起的设计），
           模拟器里把网页帧转回竖屏来复现这一步；控制栏还有 0.18s 淡入，等它走完再读。 */
        _ = try await javaScript("document.getElementById('ppFull').click(); 'exited'")
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        webView.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController?.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 800_000_000)
        let exited = try await javaScript("""
        (function () {
          var style = getComputedStyle(document.getElementById('ppCtrl'));
          return JSON.stringify({
            immersive: document.documentElement.hasAttribute('data-ios-immersive'),
            visible: !(style.visibility === 'hidden' || Number(style.opacity) === 0)
          });
        })();
        """)
        let exitText = try XCTUnwrap(exited as? String)
        let exitResult = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(exitText.utf8)) as? [String: Any])
        XCTAssertEqual(exitResult["immersive"] as? Bool, false, "退出后要回到页内布局：\(exitText)")
        XCTAssertEqual(exitResult["visible"] as? Bool, true, "页内布局里控制栏必须在：\(exitText)")
    }

    // MARK: - REG-006 设置里的下载片库

    /// 设置里要能看清「下载了哪些剧、每部下了哪几集、共几集、在下的到哪了」。
    /// 总集数未知时只写「已下载 N 集」——不得编一个分母。
    func testSettingsSheetListsDownloadedShowsAndTheRunningTask() async throws {
        let raw = try await javaScript("""
        (function () {
          localStorage.setItem('kj-ios-downloads', JSON.stringify({ shows: [
            { id: 'show-a', title: '百日谎言', cover: 'https://zhuiju.dpdns.org/posters/a.jpg', total: 12,
              eps: [{ key: '18', label: '第19集', name: '追剧AI_第19集.mp4', path: '/tmp/a19.mp4', size: 1, at: 2 },
                    { key: '19', label: '第20集', name: '追剧AI_第20集.mp4', path: '/tmp/a20.mp4', size: 1, at: 3 }] },
            { id: 'movie-b', title: '某部电影', cover: '', total: 0,
              eps: [{ key: '0', label: '正片', name: '追剧AI_正片.mp4', path: '/tmp/b.mp4', size: 2, at: 1 }] }
          ] }));
          window.__zhuijuDownload({ id: 'dl1', event: 'progress', received: 42, total: 100 });
          document.querySelector('[data-action="settings"]').click();
          var library = document.getElementById('iosDownloadLibrary');
          var running = document.getElementById('iosDlRunning');
          if (!library || !running) return 'missing-library';
          var items = document.getElementById('iosDlShows').children;
          var first = items[0];
          var second = items[1];
          var cover = first.querySelector('.ios-dl-cover');
          var chips = first.querySelector('.ios-dl-eps').children;
          var movieCover = second.querySelector('.ios-dl-cover');
          return JSON.stringify({
            visible: getComputedStyle(library).display !== 'none',
            inSheet: document.getElementById('iosSettingsBody').contains(library),
            count: items.length,
            title: first.querySelector('.ios-dl-name').textContent,
            cover: cover ? cover.getAttribute('src') : null,
            coverAlt: cover ? cover.alt : null,
            counter: first.querySelector('.ios-dl-count').textContent,
            chips: [].map.call(chips, function (chip) { return chip.textContent; }),
            movieCover: movieCover ? 'has' : 'none',
            movieCounter: second.querySelector('.ios-dl-count').textContent,
            runningVisible: getComputedStyle(running).display !== 'none',
            runningText: running.textContent
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["visible"] as? Bool, true, "设置面板里要能看到下载片库：\(text)")
        XCTAssertEqual(result["inSheet"] as? Bool, true, "片库要在设置面板里：\(text)")
        XCTAssertEqual(result["count"] as? Int, 2, "两部片子各一条：\(text)")
        XCTAssertEqual(result["title"] as? String, "百日谎言")
        XCTAssertEqual(result["cover"] as? String, "https://zhuiju.dpdns.org/posters/a.jpg", "片名旁边要有封面：\(text)")
        XCTAssertEqual(result["coverAlt"] as? String, "百日谎言")
        XCTAssertEqual(result["counter"] as? String, "已下载 2/12 集")
        XCTAssertEqual(result["chips"] as? [String], ["第19集", "第20集"], "要列清楚下了哪几集：\(text)")
        XCTAssertEqual(result["movieCover"] as? String, "none", "没有封面就不摆一张假图：\(text)")
        XCTAssertEqual(result["movieCounter"] as? String, "已下载 1 集", "总集数未知时不许编分母：\(text)")
        XCTAssertEqual(result["runningVisible"] as? Bool, true, "正在下载的那一集也要列在这里：\(text)")
        let runningText = try XCTUnwrap(result["runningText"] as? String)
        XCTAssertTrue(runningText.contains("42%"), "下载中的进度要实时显示：\(text)")

        /* 下载完成：这一集要落到片库里，不需要用户手动记。
           先收尾 setUp 里预置的那条任务，再走一次真实开始→完成链路。 */
        let afterDone = try await javaScript("""
        (function () {
          window.__zhuijuDownload({ id: 'dl1', event: 'cancelled' });
          document.getElementById('video').src = 'https://media.example/19.mp4';
          var button = document.getElementById('ppToolDownload');
          if (!button) return 'missing-toolbar';
          button.click();
          var started = JSON.parse(localStorage.getItem('kj-ios-download') || '{}');
          return JSON.stringify({ id: started.id || '', busy: !!started.busy });
        })();
        """)
        let startText = try XCTUnwrap(afterDone as? String)
        let start = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(startText.utf8)) as? [String: Any])
        let downloadId = try XCTUnwrap(start["id"] as? String, "点工具条上的下载要真发出一条任务：\(startText)")
        XCTAssertEqual(start["busy"] as? Bool, true)

        let finished = try await javaScript("""
        (function () {
          window.__zhuijuDownload({ id: '\(downloadId)', event: 'done', path: '/tmp/追剧AI_第19集.mp4', name: '追剧AI_第19集.mp4', size: 10485760 });
          var saved = JSON.parse(localStorage.getItem('kj-ios-downloads') || '{}');
          var shows = saved.shows || [];
          var added = null;
          for (var i = 0; i < shows.length; i++) { if (shows[i].title === '测试剧') added = shows[i]; }
          var items = document.getElementById('iosDlShows').children;
          var firstItem = items[0];
          return JSON.stringify({
            added: !!added,
            addedTotal: added ? added.total : -1,
            addedLabels: added ? [].map.call(added.eps, function (ep) { return ep.label; }) : [],
            firstTitle: firstItem.querySelector('.ios-dl-name').textContent,
            firstCounter: firstItem.querySelector('.ios-dl-count').textContent
          });
        })();
        """)
        let doneText = try XCTUnwrap(finished as? String)
        let done = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(doneText.utf8)) as? [String: Any])
        XCTAssertEqual(done["added"] as? Bool, true, "下载完成后这一集要自动进片库：\(doneText)")
        XCTAssertEqual(done["addedTotal"] as? Int, 1, "选集按钮数就是已知总集数：\(doneText)")
        XCTAssertEqual(done["addedLabels"] as? [String], ["第19集"])
        XCTAssertEqual(done["firstTitle"] as? String, "测试剧", "刚下完的剧排在最前面：\(doneText)")
        XCTAssertEqual(done["firstCounter"] as? String, "已下载 1/1 集")
    }

    // MARK: - REG-009 下载文件/锁屏信息用的是 App 名，不是剧名

    /// 真机上文件、下载列表、通知里都是「追剧AI 第19集」，看不出是哪部剧。
    func testDownloadedFileAndNowPlayingUseTheShowTitle() async throws {
        _ = try await awaitValue("!!document.getElementById('ppToolDownload')")
        let raw = try await javaScript("""
        (function () {
          document.getElementById('video').src = 'https://media.example/19.mp4';
          document.getElementById('ppToolDownload').click();
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
        XCTAssertEqual(message["name"] as? String, "测试剧 第19集.mp4",
                       "文件名要用真实剧名，不能用 App 名冒充：\(message)")
        XCTAssertEqual(result["mediaSessionTitle"] as? String, "测试剧",
                       "锁屏读的是真实媒体会话元数据，不是 DOM 标题：\(text)")
        XCTAssertEqual(result["mediaSessionArtist"] as? String, "第19集")
    }

    // MARK: - REG-008 工具条上的下载入口被换成了「用播放器打开」

    /// 真机原话：下载完一集之后，工具条那一格变成「用播放器打开」，下一次想下载就找不到入口了。
    /// 这一格必须永远是下载入口；播放器入口留在「外放」菜单和设置面板里。
    func testToolbarDownloadStaysADownloadEntryAfterAFinishedDownload() async throws {
        let mounted = try await awaitValue("!!document.getElementById('ppToolDownload')")
        XCTAssertTrue(mounted, "工具条上没有下载入口，这条用例没有意义")
        let raw = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          video.src = 'https://media.example/19.mp4';
          /* 上一集已经下完：真机上是原生回传 done，这里走同一条回传函数 */
          window.__zhuijuDownload({ id: 'dl1', event: 'done', path: '/tmp/追剧AI_第3集.mp4',
            name: '追剧AI_第3集.mp4', size: 10485760 });
          var button = document.getElementById('ppToolDownload');
          var dm = document.getElementById('dmBtn');
          if (!button) return 'missing-button';
          return JSON.stringify({
            text: button.textContent,
            display: getComputedStyle(button).display,
            inDanmakuSlot: !!(dm && button.nextElementSibling === dm),
            playerRowVisible: !!document.getElementById('ppOpenLocal') && !document.getElementById('ppOpenLocal').hidden
          });
        })();
        """)
        let text = try XCTUnwrap(raw as? String)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(result["text"] as? String, "下载本集",
                       "下完一集之后这一格必须还是下载入口，不能变成「用播放器打开」（0.1.12 真机回归）：\(text)")
        XCTAssertNotEqual(result["display"] as? String, "none", "下载入口必须看得见：\(text)")
        XCTAssertEqual(result["inDanmakuSlot"] as? Bool, true, "下载入口还在原来那一格：\(text)")
        XCTAssertEqual(result["playerRowVisible"] as? Bool, true, "播放器入口在「外放」菜单里，不该占用下载那一格：\(text)")

        /* 点它必须走原生下载队列（download），不能是 openLocal/share */
        let clicked = try await javaScript("""
        (function () {
          document.getElementById('video').src = 'https://media.example/19.mp4';
          document.getElementById('ppToolDownload').click();
          return document.getElementById('ppToolDownload').textContent;
        })();
        """)
        XCTAssertEqual(clicked as? String, "下载 0%", "点下载本集要立刻开始下载：\(String(describing: clicked))")
        let message = try await awaitPlayerMessage()
        XCTAssertEqual(message["action"] as? String, "download",
                       "这一格点下去必须是下载，不能是把文件交给播放器：\(message)")
        XCTAssertEqual(message["url"] as? String, "https://media.example/19.mp4")
        let downloadId = try XCTUnwrap(message["id"] as? String)

        /* 下载中 + 完成：按钮始终是下载，片库里有剧名/集号/进度 */
        let flow = try await javaScript("""
        (function () {
          var button = document.getElementById('ppToolDownload');
          var running = null;
          window.__zhuijuDownload({ id: '\(downloadId)', event: 'progress', received: 42, total: 100 });
          if (!document.getElementById('iosSettingsSheet') || document.getElementById('iosSettingsSheet').hidden) {
            document.querySelector('[data-action="settings"]').click();
          }
          running = document.getElementById('iosDlRunning');
          var runningText = running ? running.textContent : 'missing';
          window.__zhuijuDownload({ id: '\(downloadId)', event: 'done', path: '/tmp/追剧AI_第19集.mp4',
            name: '追剧AI_第19集.mp4', size: 10485760 });
          var item = document.getElementById('iosDlShows').children[0];
          var openRow = document.getElementById('iosOpenDownloaded');
          return JSON.stringify({
            runningText: runningText,
            textAfterDone: button.textContent,
            firstShow: item ? item.querySelector('.ios-dl-name').textContent : '',
            firstCount: item ? item.querySelector('.ios-dl-count').textContent : '',
            firstEpisode: item ? item.querySelector('.ios-dl-eps').children[0].textContent : '',
            settingsPlayerEntry: !!openRow && !openRow.hidden
          });
        })();
        """)
        let flowText = try XCTUnwrap(flow as? String)
        let flowResult = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(flowText.utf8)) as? [String: Any])
        let runningText = try XCTUnwrap(flowResult["runningText"] as? String)
        XCTAssertTrue(runningText.contains("42%"), "下载中要在片库里看到实时进度：\(flowText)")
        XCTAssertTrue(runningText.contains("测试剧"), "下载中要能看到剧名：\(flowText)")
        XCTAssertTrue(runningText.contains("第19集"), "下载中要能看到集号：\(flowText)")
        XCTAssertEqual(flowResult["textAfterDone"] as? String, "下载本集",
                       "下载完成后这一格还要是下载入口：\(flowText)")
        XCTAssertEqual(flowResult["firstShow"] as? String, "测试剧")
        XCTAssertEqual(flowResult["firstCount"] as? String, "已下载 1/1 集")
        XCTAssertEqual(flowResult["firstEpisode"] as? String, "第19集")
        XCTAssertEqual(flowResult["settingsPlayerEntry"] as? Bool, true,
                       "「用播放器打开」在设置里保留，不该挤掉下载入口：\(flowText)")

        /* 下载完再点一次仍然是下载（不是打开文件），并真的发出新的下载任务 */
        let again = try await javaScript("""
        (function () {
          document.getElementById('ppToolDownload').click();
          return document.getElementById('ppToolDownload').textContent;
        })();
        """)
        XCTAssertEqual(again as? String, "下载 0%", "下完再点也要能重新下载这一集：\(String(describing: again))")
        let second = try await awaitPlayerMessage()
        XCTAssertEqual(second["action"] as? String, "download", "下完再点仍然是下载，不是交给播放器：\(second)")
    }

    // MARK: - 桥接工具

    /// JSONSerialization 给的矩形是 NSNumber 数组：拆成 [Int] 再比，避免桥接不稳。
    private func rect(_ value: Any?) -> [Int]? {
        guard let list = value as? [Any] else { return nil }
        return list.compactMap { ($0 as? NSNumber)?.intValue }
    }

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
