import XCTest
import WebKit

/// REG-011 画面模式（适应 / 裁剪 / 拉伸）的模拟器回归：真 WKWebView + 真 AppBootstrap.js。
///
/// 和 `InjectedUITests` 一样不联网、不需要账号；区别是这个文件只守「画面档位」这一件事，
/// 不去动共享的夹具文件，避免和下载侧并行开发互相踩。
///
/// 钉住三件事：
/// 1. 控制栏真有那一格，点一下按 适应 → 裁剪 → 拉伸 循环，按钮文字跟着走；
/// 2. `object-fit` 真的落到 `#player video` 的计算样式上（不是只写了个 data 属性）；
/// 3. 选择落 localStorage，换集（新的一次 play）和新页面都按记住的那一档来。
@MainActor
@available(iOS 15.0, *)
final class FitModeTests: XCTestCase, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: UIWindow!
    private var loaded: XCTestExpectation?

    /// 站点播放页骨架：注入层要挂的节点全在（#player > #video、.pp-toolbar、#dmBtn、选集区）。
    private static let fixtureHTML = """
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html, body { margin: 0; padding: 0; background: #07131b; }
      #player { position: relative; width: 844px; height: 390px; background: #000; overflow: hidden; }
      #player video { width: 100%; height: 100%; display: block; object-fit: contain; }
    </style></head>
    <body>
    <header class="page-head"><h1 class="ph-title">测试剧</h1></header>
    <div class="main">
      <section class="player" id="player">
        <video id="video" playsinline preload="metadata"></video>
        <span class="p-label" id="playerLabel">测试剧 · 第19集</span>
      </section>
      <div class="pp-toolbar" id="playTools">
        <button class="pp-tool" id="settingsBtn" type="button">显示设置</button>
        <button class="pp-tool on" id="dmBtn" type="button">弹幕 开</button>
      </div>
      <div class="pp-settings" id="settingsPanel" hidden></div>
      <p class="pp-hint" id="playHint">点播放即可观看</p>
      <div class="ep-grid" id="epGrid">
        <button class="ep on" type="button" data-ep="19">第19集</button>
        <button class="ep" type="button" data-ep="20">第20集</button>
      </div>
    </div>
    </body></html>
    """

    override func setUp() async throws {
        try await mountPage(rememberedFit: nil)
    }

    override func tearDown() async throws {
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        window?.isHidden = true
        window = nil
    }

    /// 载入夹具页并注入包里的真 AppBootstrap.js。`rememberedFit` 用来模拟「上次选的那一档」。
    private func mountPage(rememberedFit: String?) async throws {
        webView?.stopLoading()
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 844, height: 390), configuration: configuration)
        webView.navigationDelegate = self
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 844, height: 390))
        let controller = UIViewController()
        controller.view.addSubview(webView)
        window.rootViewController = controller
        window.makeKeyAndVisible()

        loaded = expectation(description: "fixture loaded")
        webView.loadHTMLString(Self.fixtureHTML, baseURL: URL(string: "https://zhuiju.dpdns.org/player/?id=fixture"))
        await fulfillment(of: [XCTUnwrap(loaded)], timeout: 60)

        if let rememberedFit {
            _ = try await javaScript("localStorage.setItem('kj-ios-fit', '\(rememberedFit)');")
        }
        let source = try String(
            contentsOf: XCTUnwrap(Bundle.main.url(forResource: "AppBootstrap", withExtension: "js")),
            encoding: .utf8
        )
        _ = try await javaScript("(function(){\n" + source + "\nreturn true;})();")
        let ready = try await awaitValue("window.__zhuijuIOSReady === true")
        XCTAssertTrue(ready, "AppBootstrap.js 没跑起来")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    // MARK: - 工具

    private func javaScript(_ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value) }
            }
        }
    }

    private func awaitValue(_ expression: String, timeout: TimeInterval = 5) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = try await javaScript("(function(){ try { return !!(\(expression)); } catch (e) { return false; } })();") as? Bool,
               value {
                return true
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }

    private func objectFit() async throws -> String {
        let raw = try await javaScript("""
        (function () {
          var video = document.getElementById('video');
          if (!video) return 'no-video';
          return String(getComputedStyle(video).objectFit || '');
        })();
        """)
        return (raw as? String) ?? ""
    }

    private func fitAttribute() async throws -> String {
        let raw = try await javaScript("String(document.documentElement.getAttribute('data-ios-fit') || '')")
        return (raw as? String) ?? ""
    }

    private func fitLabel() async throws -> String {
        let raw = try await javaScript("""
        (function () {
          var button = document.getElementById('ppFit');
          return button ? String(button.textContent || '') : 'no-button';
        })();
        """)
        return (raw as? String) ?? ""
    }

    private func tapFit() async throws {
        _ = try await javaScript("""
        (function () {
          var button = document.getElementById('ppFit');
          if (!button) return 'missing';
          button.click();
          return 'tapped';
        })();
        """)
    }

    private func storedFit() async throws -> String {
        let raw = try await javaScript("String(localStorage.getItem('kj-ios-fit') || '')")
        return (raw as? String) ?? ""
    }

    // MARK: - 用例

    func testTheFitButtonCyclesContainCoverAndFillAndRemembersTheChoice() async throws {
        XCTAssertTrue(try await awaitValue("!!document.getElementById('ppFit')", timeout: 8),
                      "控制栏没有画面档位那一格（#ppFit）")
        XCTAssertEqual(try await fitLabel(), "适应", "默认档位应当是适应（不裁画面、不加灰罩）")
        XCTAssertEqual(try await fitAttribute(), "contain", "默认档位要真的写到 html[data-ios-fit] 上")
        XCTAssertEqual(try await objectFit(), "contain", "默认档位要落到 video 的计算样式")

        try await tapFit()
        XCTAssertEqual(try await fitLabel(), "裁剪", "点一下应当切到裁剪")
        XCTAssertEqual(try await fitAttribute(), "cover")
        XCTAssertEqual(try await objectFit(), "cover", "裁剪档必须真的铺满（object-fit: cover）")
        XCTAssertEqual(try await storedFit(), "cover", "裁剪档要记住")

        try await tapFit()
        XCTAssertEqual(try await fitLabel(), "拉伸")
        XCTAssertEqual(try await fitAttribute(), "fill")
        XCTAssertEqual(try await objectFit(), "fill", "拉伸档必须真的不等比铺满（object-fit: fill）")
        XCTAssertEqual(try await storedFit(), "fill")

        try await tapFit()
        XCTAssertEqual(try await fitLabel(), "适应", "循环回到适应")
        XCTAssertEqual(try await fitAttribute(), "contain")
        XCTAssertEqual(try await objectFit(), "contain")
        XCTAssertEqual(try await storedFit(), "contain")
    }

    func testARememberedFitAppliesToANewEpisodeAndSurvivesANewPage() async throws {
        try await mountPage(rememberedFit: "cover")

        XCTAssertTrue(try await awaitValue("!!document.getElementById('ppFit')", timeout: 8))
        XCTAssertEqual(try await objectFit(), "cover", "重新进页面要按上次记住的「裁剪」来")
        XCTAssertEqual(try await fitLabel(), "裁剪")

        /* 换集：站点重渲染播放器、视频换源后重新 play，档位不能被默认值顶回去 */
        _ = try await javaScript("""
        (function () {
          document.getElementById('video').removeAttribute('src');
          var selected = document.querySelector('.ep.on');
          if (selected) selected.classList.remove('on');
          var next = document.querySelector('.ep[data-ep="20"]');
          if (next) next.classList.add('on');
          var video = document.getElementById('video');
          video.dispatchEvent(new Event('play'));
          video.dispatchEvent(new Event('loadedmetadata'));
          return true;
        })();
        """)
        XCTAssertTrue(try await awaitValue("document.documentElement.getAttribute('data-ios-fit') === 'cover'", timeout: 5),
                      "换集后档位被重置了")
        XCTAssertEqual(try await objectFit(), "cover", "换集后 video 仍然是裁剪")

        /* 再挂一次页面（等价于退出重进 App）：localStorage 里的选择要跟过来 */
        try await mountPage(rememberedFit: nil)
        XCTAssertTrue(try await awaitValue("!!document.getElementById('ppFit')", timeout: 8))
        XCTAssertEqual(try await objectFit(), "cover", "重进之后忘掉了上次的档位")
        XCTAssertEqual(try await fitLabel(), "裁剪")
    }
}
