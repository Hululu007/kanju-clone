import XCTest
import WebKit
@testable import ZhuijuAI

@MainActor
@available(iOS 15.0, *)
final class PlaybackTests: XCTestCase, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: UIWindow!
    private var loaded: XCTestExpectation?
    private var slotCounter = 0

    override func setUp() async throws {
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
        webView.loadHTMLString("""
        <html><head><meta name="viewport" content="width=device-width"></head><body>
        <section id="player"><video id="video" controls playsinline></video></section>
        <button class="ep on" data-ep="18">第19集</button><button id="ep20" data-ep="19">第20集</button>
        <div id="playHint"></div><div id="playTools"></div><select id="lineSelect"></select>
        </body></html>
        """, baseURL: URL(string: "https://zhuiju.dpdns.org/"))
        // 模拟器冷启动时第一个 WKWebView 要等 WebContent 进程起来，macOS runner 排队时会超过 15 秒；
        // 这条只决定「页面是否加载完」，与 App 逻辑无关，所以给足冷启动时间。
        await fulfillment(of: [loaded!], timeout: 60)
        try await execute("""
        window.calls=[]; window.replies=[];
        window.fetch=async function(input,options){
          window.calls.push({url:typeof input==='string'?input:input.url,options:options,
            method:input instanceof Request?input.method:options.method,
            body:input instanceof Request?await input.clone().text():options.body,
            authorization:input instanceof Request?input.headers.get('authorization'):null});
          var reply=window.replies.shift()||{};
          if(reply.delay)await new Promise(function(resolve){setTimeout(resolve,reply.delay)});
          return new Response(JSON.stringify(reply.data||{}),{status:reply.status||200,headers:{'Content-Type':'application/json'}});
        };
        """)
        let source = try String(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "AppBootstrap", withExtension: "js")), encoding: .utf8)
        try await execute(source)
        let ready = try await awaitValue("window.__zhuijuIOSReady===true")
        XCTAssertTrue(ready)
    }

    override func tearDown() async throws {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        window.isHidden = true
        window = nil
        webView = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    /// Objective-C completion-handler bridge for WKWebView.
    ///
    /// The Swift `evaluateJavaScript(_:)` / `callAsyncJavaScript(...)` async overloads come from the
    /// WebKit Swift overlay (libswiftWebKit.dylib). That library is not shipped in the iOS 18.5
    /// simulator runtime nor in the Xcode 16.4 simulator toolchain, so a test bundle that references
    /// those overloads fails to dlopen ("Library not loaded: /usr/lib/swift/libswiftWebKit.dylib")
    /// before a single test runs. Only the Objective-C `evaluateJavaScript(_:completionHandler:)`
    /// entry point is used here, bridged back to async with a checked continuation.
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

    private func execute(_ source: String) async throws {
        _ = try await javaScript("(function(){\n" + source + "\nreturn true;})();")
    }

    /// Runs an async JavaScript expression in the page and polls for its resolved boolean result.
    /// Avoids `callAsyncJavaScript` (Swift overlay) by storing the promise outcome in a page slot.
    private func awaitValue(_ source: String) async throws -> Bool {
        slotCounter += 1
        let slot = "slot\(slotCounter)"
        let kick = """
        (function(){
          window.__zhuijuTestSlots = window.__zhuijuTestSlots || {};
          var state = window.__zhuijuTestSlots['\(slot)'] = {done:false,value:false};
          var settle = function(value){ state.done = true; state.value = value === true; };
          var timeout = new Promise(function(resolve){ setTimeout(function(){ resolve(false); }, 15000); });
          var target;
          try { target = Promise.resolve((\(source))); } catch (error) { target = Promise.reject(error); }
          Promise.race([target, timeout]).then(settle, function(){ settle(false); });
          return true;
        })();
        """
        _ = try await javaScript(kick)
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            let probe = try await javaScript("""
            (function(){
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

    func testLoginAndProgressKeepBodyAndAuthorization() async throws {
        let result = try await awaitValue("""
        (async function(){
          await fetch('https://kanju-api.kenzhao123.workers.dev/api/auth/login',{method:'POST',body:'{"username":"fixture-user"}'});
          await fetch(new Request('https://kanju-api.kenzhao123.workers.dev/api/user/progress',{method:'PUT',body:'{"idx":18}',headers:{Authorization:'Bearer fixture-token'}}));
          return calls[0].url==='https://zhuiju.dpdns.org/api/auth/login' && calls[0].options.credentials==='same-origin'
            && calls[0].options.method==='POST' && calls[1].options.credentials==='same-origin'
            && calls[1].method==='PUT' && calls[1].body==='{"idx":18}' && calls[1].authorization==='Bearer fixture-token';
        })()
        """)
        XCTAssertTrue(result)
    }

    func testRejectMismatchedEpisodeAndInsecureMedia() async throws {
        let result = try await awaitValue("""
        (async function(){
          var rejected=0;
          var invalid=[{idx:1,episodeNumber:2},{verified:false},{showId:'other'},{episodeNumber:2},{url:'http://example.com/video.mp4'},{kind:'html'}];
          for(var patch of invalid){
            replies.push({data:Object.assign({showId:'fixture',idx:18,episodeNumber:19,verified:true,kind:'mp4',url:'https://example.com/video.mp4'},patch)});
            try{await fetch('https://zhuiju.dpdns.org/api/play?show=fixture&ep=18')}catch(error){rejected++}
          }
          return rejected===invalid.length;
        })()
        """)
        XCTAssertTrue(result)
    }

    func testStaleEpisodeCannotOverrideNewSelection() async throws {
        let result = try await awaitValue("""
        (async function(){
          replies.push({delay:200,data:{showId:'fixture',idx:18,episodeNumber:19,verified:true,kind:'mp4',url:'https://example.com/19.mp4'}});
          var old=fetch('https://zhuiju.dpdns.org/api/play?show=fixture&ep=18').then(function(){return false},function(){return true});
          document.getElementById('ep20').click();
          document.querySelector('.ep.on').classList.remove('on');document.getElementById('ep20').classList.add('on');
          replies.push({data:{showId:'fixture',idx:19,episodeNumber:20,verified:true,kind:'mp4',url:'https://example.com/20.mp4'}});
          var current=await fetch('https://zhuiju.dpdns.org/api/play?show=fixture&ep=19');
          return (await current.json()).episodeNumber===20 && await old;
        })()
        """)
        XCTAssertTrue(result)
    }

    func testAccountExpiryDoesNotRedirectSiteGate() async throws {
        let result = try await awaitValue("""
        (async function(){replies.push({status:401,data:{error:'session_expired'}});
          var response=await fetch('https://zhuiju.dpdns.org/api/auth/me');
          return response.status===401&&!window.__zhuijuAccessRedirecting;
        })()
        """)
        XCTAssertTrue(result)
    }

    func testNativeMp4StartsAndAdvances() async throws {
        let fixtureURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample", withExtension: "mp4"))
        let encoded = try Data(contentsOf: fixtureURL).base64EncodedString()
        let result = try await awaitValue("""
        (async function(){
          var bytes=Uint8Array.from(atob('\(encoded)'),function(value){return value.charCodeAt(0)});
          var video=document.getElementById('video');
          video.src=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));video.muted=true;
          var playing=new Promise(function(resolve){video.addEventListener('timeupdate',function(){if(video.currentTime>0.15)resolve(true)})});
          await video.play();return await Promise.race([playing,new Promise(function(resolve){setTimeout(function(){resolve(false)},10000)})]);
        })()
        """)
        XCTAssertTrue(result)
    }

    func testLateMediaReadyRetriesPlayback() async throws {
        let result = try await awaitValue("""
        (async function(){
          var video=document.getElementById('video'),started=0;
          Object.defineProperty(video,'currentSrc',{configurable:true,get:function(){return 'https://fixture.invalid/19.mp4'}});
          Object.defineProperty(video,'readyState',{configurable:true,get:function(){return 2}});
          video.play=function(){started++;return Promise.resolve()};
          replies.push({data:{showId:'fixture',idx:18,episodeNumber:19,verified:true,kind:'mp4',url:'https://fixture.invalid/19.mp4'}});
          await fetch('https://zhuiju.dpdns.org/api/play?show=fixture&ep=18');
          video.dispatchEvent(new Event('canplay'));video.dispatchEvent(new Event('loadedmetadata'));
          return started===1;
        })()
        """)
        XCTAssertTrue(result)
    }

    func testNativeHlsCompatibilityAndLatePlay() async throws {
        let source = try String(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "NativeHls", withExtension: "js")), encoding: .utf8)
        try await execute("window.Hls=function Original(){};window.Hls.Events={ERROR:'error'};")
        try await execute(source)
        let result = try await awaitValue("""
        (async function(){
          var video=document.getElementById('video');video.muted=true;
          var address='http://127.0.0.1:8765/sample.m3u8';
          replies.push({data:{showId:'fixture',idx:18,episodeNumber:19,verified:true,kind:'hls',url:'https://fixture.invalid/sample.m3u8'}});
          await fetch('https://zhuiju.dpdns.org/api/play?show=fixture&ep=18');
          var hls=new Hls();hls.loadSource(address);hls.attachMedia(video);
          await video.play();
          return await new Promise(function(resolve){var timer=setTimeout(function(){resolve(false)},12000);
            video.addEventListener('timeupdate',function(){if(video.currentTime>0.15){clearTimeout(timer);resolve(video.videoWidth===320)}});
          });
        })()
        """)
        XCTAssertTrue(result)
    }
}
