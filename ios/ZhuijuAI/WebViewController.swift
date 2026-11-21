import AVKit
import LinkPresentation
import UniformTypeIdentifiers
import UIKit
import WebKit

final class WebViewController: UIViewController, UIDocumentInteractionControllerDelegate {
    private enum Site {
        static let defaultHome = URL(string: "https://zhuiju.dpdns.org/")!
        static let host = "zhuiju.dpdns.org"

        /// 出包关卡（XCUITest 截图工作流）要在没有账号、没有公网的模拟器里真点一遍页面。
        /// 起始地址只允许从**测试进程**的环境变量覆盖：正式包是 Release，`#if DEBUG`
        /// 之外读不到这条通道，线上地址永远是 defaultHome。
        static var testHome: URL? {
            #if DEBUG
            guard let raw = ProcessInfo.processInfo.environment["KJ_TEST_HOME_URL"],
                  let url = URL(string: raw) else { return nil }
            return url
            #else
            return nil
            #endif
        }

        static var home: URL { testHome ?? defaultHome }
        static var hostName: String { testHome?.host ?? host }
    }

    /// 网页通过 WKScriptMessageHandler 发来的动作。0.1.19 起播放器和全屏都归网站自己的播放器，
    /// 这里只剩下载、分享和本地文件这几件事。
    private enum PlayerAction: String {
        /// 网页请求把可播放地址交给系统分享面板（外部播放器 / AirPlay 的入口）。
        case share
        /// 下载一集到沙盒（0.1.19 起不再看 App 登录态，只看地址能不能下载）。
        case download
        /// 批量入队（选集页「一键全集」「从本集往后」「下载已选」都走这条）。
        case downloadBatch
        /// 整部剧暂停 / 继续 / 取消：只动队列，不删除已下载的文件。
        case downloadPause
        case downloadResume
        case downloadCancel
        case cancelDownload
        /// 网页回到前台/刚加载：把后台会话里的最新状态和终态补给它。
        case downloadSync
        /// 下载完成后用系统应用列表打开本地文件。
        case openLocal
        /// 已下载列表点一集：用系统播放器离线播放本地文件。
        case playLocal
        /// 已下载列表「用其他播放器打开」：把本地文件交给系统「打开方式」菜单。
        case openInOtherPlayer
        /// 已下载列表左滑删除：删掉这一集在本地的那个文件（只删这一个）。
        case deleteLocal
        /// 站点播放器进入 / 退出全屏：只切屏幕方向（全屏横屏、退出竖屏），不碰页面几何。
        case playerFullscreen
        /// 设置面板最上方「我的下载」：打开原生离线片库（不加载网页也能用）。
        case myDownloads
    }

    /// 系统分享面板里的链接项：声明成标准 URL（`public.url`）并带上链接元数据，
    /// 这样面板认得出它是一条网页/媒体地址，而不是一块纯文本。
    private final class LinkShareItem: NSObject, UIActivityItemSource {
        private let url: URL
        private let title: String

        init(url: URL, title: String) {
            self.url = url
            self.title = title
        }

        func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { url }

        func activityViewController(
            _ controller: UIActivityViewController,
            itemForActivityType type: UIActivity.ActivityType?
        ) -> Any? { url }

        func activityViewControllerLinkMetadata(_ controller: UIActivityViewController) -> LPLinkMetadata? {
            let metadata = LPLinkMetadata()
            metadata.originalURL = url
            metadata.url = url
            if !title.isEmpty { metadata.title = title }
            return metadata
        }
    }

    private final class PlayerBridge: NSObject, WKScriptMessageHandler {
        weak var target: WebViewController?

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            switch action {
            case PlayerAction.share.rawValue:
                target?.presentExternalShare(url: body["url"] as? String, title: body["title"] as? String)
            case PlayerAction.download.rawValue:
                target?.beginDownload(body)
            case PlayerAction.downloadBatch.rawValue:
                target?.beginBatchDownload(body)
            case PlayerAction.downloadPause.rawValue:
                target?.pauseDownloads(showId: body["showId"] as? String)
            case PlayerAction.downloadResume.rawValue:
                target?.resumeDownloads(showId: body["showId"] as? String)
            case PlayerAction.downloadCancel.rawValue:
                target?.cancelDownloads(showId: body["showId"] as? String)
            case PlayerAction.downloadSync.rawValue:
                target?.flushDownloadEvents()
            case PlayerAction.cancelDownload.rawValue:
                target?.cancelDownload()
            case PlayerAction.openLocal.rawValue:
                target?.presentLocalFile(path: body["path"] as? String, name: body["name"] as? String)
            case PlayerAction.playLocal.rawValue:
                target?.presentLocalPlayback(path: body["path"] as? String)
            case PlayerAction.openInOtherPlayer.rawValue:
                target?.presentOpenInMenu(path: body["path"] as? String)
            case "deleteDownload":
                target?.deleteDownloadedEpisode(body)
            case PlayerAction.deleteLocal.rawValue:
                target?.deleteLocalFile(path: body["path"] as? String)
            case PlayerAction.myDownloads.rawValue:
                target?.presentDownloadLibrary()
            case PlayerAction.playerFullscreen.rawValue:
                target?.setPlayerFullscreen(body["on"] as? Bool ?? false)
            default:
                /* 网页可能先上新动作、App 还没跟上：不认识的 action 直接忽略，不能因此崩或卡住。 */
                break
            }
        }
    }

    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let errorContainer = UIView()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    /// 断网/页面加载失败时的离线入口：不用等网页，直接进原生片库。
    private let offlineLibraryButton = UIButton(type: .system)
    private var progressObservation: NSKeyValueObservation?
    private let downloader = MediaDownloader.shared
    private var lastFailedURL: URL?
    private var safeAreaConstraints: [NSLayoutConstraint] = []
    /// 「打开方式」面板要一直有人持有，否则控制器提前释放，菜单会跟着消失。
    private var documentInteraction: UIDocumentInteractionController?
    /// 用户是在菜单里选了 App，还是把菜单关掉了：只有后者才算“取消”。
    private var sendingToExternalPlayer = false

    /// 站点用它区分「App 内」和浏览器。版本号从包信息里取，别再手写 ——
    /// 0.1.2 到 0.1.5 每版都靠改这一行字符串，一忘就会和包版本对不上。
    static var userAgent: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return "ZhuijuAI/\(version) iOS"
    }

    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if #available(iOS 15.4, *) {
            /* iPhone 的 WKWebView 默认关掉「元素全屏」：站点播放器调 requestFullscreen() 会被拒绝，
               真机上点全屏就像没反应。打开后站点自己的全屏 API 才真正生效，铺满交给 WebKit。 */
            configuration.preferences.isElementFullscreenEnabled = true
        }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.applicationNameForUserAgent = WebViewController.userAgent
        if #available(iOS 14.2, *) {
            configuration.allowsPictureInPictureMediaPlayback = true
        }
        let contentController = configuration.userContentController
        let bridge = PlayerBridge()
        bridge.target = self
        contentController.add(bridge, name: "iosPlayer")
        /* 夹具站的 origin 放行变量必须在 AppBootstrap.js 之前落到页面里。
           取值就复用上面 `Site.testHome` 那一条通道：测试没设环境变量时这里什么都不做，
           正式包（Release）读不到环境变量，线上页面照旧只认 zhuiju.dpdns.org。 */
        if let testHome = Site.testHome {
            var origin = "\(testHome.scheme ?? "http")://\(testHome.host ?? "127.0.0.1")"
            if let port = testHome.port { origin += ":\(port)" }
            contentController.addUserScript(WKUserScript(
                source: "window.__zhuijuTestOrigin = '\(origin)';",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        if let scriptURL = Bundle.main.url(forResource: "AppBootstrap", withExtension: "js"),
           let source = try? String(contentsOf: scriptURL, encoding: .utf8) {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            contentController.addUserScript(script)
        }
        if let hlsURL = Bundle.main.url(forResource: "hls.min", withExtension: "js"),
           let hlsSource = try? String(contentsOf: hlsURL, encoding: .utf8) {
            let script = WKUserScript(source: hlsSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            contentController.addUserScript(script)
        }
        if let scriptURL = Bundle.main.url(forResource: "NativeHls", withExtension: "js"),
           let source = try? String(contentsOf: scriptURL, encoding: .utf8) {
            contentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        // 页面内部自己用 .main 滚动；外层 WKScrollView 不应该再参与滚动。
        // .automatic 会在旋转/键盘弹出时反复调整 contentInset，表现为内容自己漂移。
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.backgroundColor = .black
        webView.backgroundColor = .black
        webView.isOpaque = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        return webView
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black
        configureLayout()
        configureErrorView()
        observeProgress()
        /* 队列状态变化（进度/终态/暂停/排队）先到界面，再转发给网页。
           批量下载没有逐条的 onFinish，靠这条通道把状态推回去。 */
        MediaDownloader.eventSink = { [weak self] events in
            guard let self = self else { return }
            var finished = false
            for event in events {
                self.sendDownloadEvent(event)
                if let name = event["event"] as? String, name != "progress" { finished = true }
            }
            if finished { self.sendDownloadSnapshot() }
            /* 原生片库和网页用的是同一批事件：这里只广播，不抢 eventSink。 */
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .downloadLibraryDidChange, object: nil)
            }
        }
        /* 从后台回来时把后台会话的最新进度/终态补到网页上：
           切出去下载时网页是挂起的，收不到 delegate 回调。 */
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        loadHome()
    }

    @objc private func appDidBecomeActive() {
        flushDownloadEvents()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .lightContent
    }

    /// 全屏只有两种状态，没有中间态：
    /// 1. 窗口模式（默认）：竖屏，视频留在详情页原来的位置，下面的剧集和简介照常滚动；
    /// 2. 全屏模式：点站点播放器自己的全屏按钮后横屏铺满整块屏幕。
    /// 退出全屏（站点退出按钮或返回）必须回到详情页原位继续播放，所以这里只改屏幕方向，
    /// 不重建页面、不动播放进度，也不碰网页的尺寸和样式。
    private static var playerFullscreenActive = false

    /// 两种状态各自允许的方向：平时只竖屏，全屏只横屏（左右都行，跟着手握方向转）。
    static func interfaceOrientations(forFullscreen fullscreen: Bool) -> UIInterfaceOrientationMask {
        fullscreen ? .landscape : .portrait
    }

    /// 界面和 AppDelegate 共用同一份判断：网页全屏是 WebKit 自己弹的控制器，
    /// 它不看我们 VC 的 supportedInterfaceOrientations，只认 AppDelegate 返回的全局掩码。
    static var supportedOrientations: UIInterfaceOrientationMask {
        /* 原生离线播放器在场：竖屏看列表、横拿自动进全屏（全屏时锁横屏）。
           其他页面仍然是只竖屏。 */
        if offlinePlayerActive {
            if offlineFullscreen { return .landscape }
            if offlineRotationLocked { return .portrait }
            return .allButUpsideDown
        }
        return interfaceOrientations(forFullscreen: playerFullscreenActive)
    }

    /// 离线播放器在场 / 处于全屏 / 刚主动退出全屏（先锁竖屏）。
    static var offlinePlayerActive = false
    static var offlineFullscreen = false
    static var offlineRotationLocked = false
    private weak var offlinePlayerController: OfflinePlayerViewController?

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        Self.supportedOrientations
    }

    override var shouldAutorotate: Bool {
        true
    }

    /// 网页播放器报告全屏状态：进入 → 锁横屏铺满；退出 → 回竖屏，页面与进度保持原样。
    fileprivate func setPlayerFullscreen(_ active: Bool) {
        guard Self.playerFullscreenActive != active else { return }
        Self.playerFullscreenActive = active
        applyOrientation(Self.supportedOrientations)
        /* WebKit 的网页全屏控制器带弹出 / 收起动画，动画期间的方向请求可能被系统拒绝；
           动画结束后再要一次，避免真机上「第一次进全屏还是竖屏」。 */
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self = self, Self.playerFullscreenActive == active else { return }
            self.applyOrientation(Self.supportedOrientations)
        }
    }

    /// 网页的退出事件可能丢（换页、进程被杀）：页面一重新加载就把全屏方向状态复位，
    /// 避免全局掩码一直停在横屏。只动方向，不碰播放器。
    fileprivate func resetPlayerFullscreen() {
        guard Self.playerFullscreenActive else { return }
        setPlayerFullscreen(false)
    }

    /// iOS 16 起可以主动请求旋转；更老的系统只能让系统重新评估一次支持方向。
    private func applyOrientation(_ mask: UIInterfaceOrientationMask) {
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            guard let scene = view.window?.windowScene else { return }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
        } else {
            /* iOS 15 没有主动改方向的公开 API：换完掩码后让系统重新问一次。 */
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    private func configureLayout() {
        progressView.progressTintColor = UIColor(red: 22.0 / 255.0, green: 224.0 / 255.0, blue: 90.0 / 255.0, alpha: 1)
        progressView.trackTintColor = .clear
        progressView.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(progressView)

        safeAreaConstraints = [
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ]
        NSLayoutConstraint.activate(safeAreaConstraints + [
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2),
        ])
    }

    /// 能交给外部播放器的地址：只有 https 直链。
    /// 明文 http、blob:/data:（MSE 加密流）、以及非 URL 一律返回 nil —— 交给别的 App 也没法播。
    /// 唯一例外是 XCUITest 的受控源：只在测试进程（起始地址被环境变量覆盖）时
    /// 放行 127.0.0.1 的 http，正式包里这条分支永远不成立。
    static func shareableURL(_ raw: String?) -> URL? {
        guard let raw = raw,
              !raw.isEmpty,
              let link = URL(string: raw),
              link.host?.isEmpty == false else { return nil }
        let scheme = link.scheme?.lowercased()
        if scheme == "https" { return link }
        if scheme == "http", Site.testHome != nil, isLoopback(link), isVideoPath(link) { return link }
        return nil
    }

    static func isLoopback(_ url: URL) -> Bool {
        let host = (url.host ?? "").lowercased()
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    static func isVideoPath(_ url: URL) -> Bool {
        let path = url.path.lowercased()
        return [".mp4", ".m4v", ".mov", ".mkv", ".ts"].contains { path.hasSuffix($0) }
    }

    /// 外部播放：把直链交给系统分享面板，由用户选已安装的播放器或 AirPlay。
    /// 加密流、blob: 和 DRM 内容在网页侧就已挡掉，这里再挡一次；
    /// 不引入任何第三方 SDK，也不需要用户登录。
    ///
    /// 一个真实边界：面板里出现哪些 App 由系统按「能不能处理 public.url」筛选，
    /// 只声明了视频文件类型（public.movie）的播放器不会出现在这里——
    /// 那类 App 要走「下载后用其他播放器打开」。
    fileprivate func presentExternalShare(url: String?, title: String?) {
        guard let link = Self.shareableURL(url) else { return }
        let presenter = presentedViewController ?? self
        let controller = UIActivityViewController(
            activityItems: [LinkShareItem(url: link, title: title ?? "")],
            applicationActivities: nil
        )
        if let popover = controller.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(controller, animated: true)
    }

    // MARK: - 下载

    /// 当前页面的 origin（scheme://host[:port]/）：下载请求没有带页面来源时，用它当 Referer。
    private func pageOrigin() -> String {
        guard let url = webView.url, let scheme = url.scheme, let host = url.host else { return "" }
        if let port = url.port { return scheme + "://" + host + ":" + String(port) + "/" }
        return scheme + "://" + host + "/"
    }

    /// 网站自己的下载按钮只带 url / name：这里既不查登录态，也不因缺 id 丢掉请求。
    fileprivate func beginDownload(_ body: [String: Any]) {
        let fallbackName = body["name"] as? String ?? "video.mp4"
        let showId = Self.showIdentifier(body)
        let epKey = body["epKey"] as? String ?? ""
        let id = Self.downloadIdentifier(
            explicit: body["id"] as? String,
            showId: showId,
            epKey: epKey,
            name: fallbackName
        )
        guard let link = Self.shareableURL(body["url"] as? String) else {
            sendDownloadEvent(["event": "failed", "id": id, "reason": "这条线路的地址不能下载"])
            return
        }
        let name = MediaDownloader.fileName(from: link.absoluteString, fallback: fallbackName)
        /* 单集消息也要把「哪部剧、哪一集」交给原生：下载页的格子、我的下载和离线播放都按这两个字段认。 */
        var meta: [String: Any] = body["meta"] as? [String: Any] ?? [:]
        if !showId.isEmpty { meta["showId"] = showId }
        if !epKey.isEmpty { meta["epKey"] = epKey }
        /* 整文件下载也要带和网页一致的 UA / Referer：不然防盗链/UA 白名单的线路直接 403。 */
        if meta["userAgent"] == nil { meta["userAgent"] = MediaDownloader.mediaUserAgent }
        if meta["referer"] == nil || (meta["referer"] as? String ?? "").isEmpty {
            meta["referer"] = pageOrigin()
        }
        if meta["epLabel"] == nil, let label = body["epLabel"] as? String { meta["epLabel"] = label }
        if meta["title"] == nil, let title = (body["show"] as? [String: Any])?["title"] as? String { meta["title"] = title }
        /* HLS 线路要把「这是清单」和页面来源一起带下去：原生据此走分片下载、并带上正确的 Referer。 */
        if let kind = body["kind"] as? String, !kind.isEmpty { meta["kind"] = kind }
        if let referer = body["referer"] as? String, !referer.isEmpty { meta["referer"] = referer }
        downloader.start(
            id: id,
            url: link,
            name: name,
            meta: meta,
            onProgress: { _, _ in },
            onFinish: { _ in /* 状态由 eventSink + snapshot 统一回传，避免同一条终态投两遍 */ }
        )
        sendDownloadSnapshot()
    }

    /// 网页消息里用来认剧的字段：新版用 showId，旧版放在 show.id / show.title 里。
    static func showIdentifier(_ body: [String: Any]) -> String {
        if let showId = body["showId"] as? String, !showId.isEmpty { return showId }
        if let show = body["show"] as? [String: Any] {
            if let id = show["id"] as? String, !id.isEmpty { return id }
            if let title = show["title"] as? String, !title.isEmpty { return title }
        }
        return ""
    }

    /// 下载任务的稳定 id：同一集重复点下载必须落到同一条记录（续传数据、暂停/继续都按 id 存）。
    /// 优先用网页给的 id，其次「剧号-集号」，再其次文件名，最后才用一次性 UUID。
    static func downloadIdentifier(explicit: String?, showId: String, epKey: String, name: String) -> String {
        if let explicit = explicit, !explicit.isEmpty { return explicit }
        let show = showId.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = epKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !show.isEmpty, !key.isEmpty { return "dl-\(show)-\(key)" }
        let fileName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !fileName.isEmpty { return "dl-" + fileName }
        return "dl-" + UUID().uuidString
    }

    /// 批量入队：一条消息带整批选集，原生层负责去重、并发上限和持久化。
    /// 不看登录态（新站没有 App 登录态）；某条缺 id 就按剧号+集号补，绝不整条丢掉。
    fileprivate func beginBatchDownload(_ body: [String: Any]) {
        guard let items = body["items"] as? [[String: Any]], !items.isEmpty else { return }
        let bodyShow = Self.showIdentifier(body)
        var requests: [MediaDownloader.Request] = []
        for item in items {
            let itemName = item["name"] as? String ?? "video.mp4"
            let itemShow = (item["showId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? bodyShow
            let itemEpKey = item["epKey"] as? String ?? ""
            let id = Self.downloadIdentifier(explicit: item["id"] as? String,
                                             showId: itemShow, epKey: itemEpKey, name: itemName)
            guard let link = Self.shareableURL(item["url"] as? String) else {
                sendDownloadEvent(["event": "failed", "id": id, "reason": "这条线路的地址不能下载"])
                continue
            }
            let name = MediaDownloader.fileName(from: link.absoluteString, fallback: itemName)
            var meta: [String: String] = (body["show"] as? [String: Any])?.reduce(into: [:]) { result, pair in
                if let text = pair.value as? String { result[pair.key] = text }
                else if let number = pair.value as? NSNumber { result[pair.key] = number.stringValue }
            } ?? [:]
            meta["showId"] = itemShow.isEmpty ? (meta["id"] ?? "") : itemShow
            meta["epKey"] = itemEpKey
            meta["epLabel"] = (item["epLabel"] as? String) ?? ""
            meta["title"] = (item["title"] as? String) ?? meta["title"] ?? ""
            if let kind = item["kind"] as? String, !kind.isEmpty { meta["kind"] = kind }
            if let referer = item["referer"] as? String, !referer.isEmpty { meta["referer"] = referer }
            /* UA / Referer 必须和网页播放时一致：片源 CDN 按 UA 拦的线路，下载才能和播放一样过。 */
            if meta["referer"] == nil || (meta["referer"] ?? "").isEmpty {
                meta["referer"] = item["referer"] as? String ?? pageOrigin()
            }
            meta["userAgent"] = MediaDownloader.mediaUserAgent
            requests.append(MediaDownloader.Request(id: id, url: link, name: name, meta: meta))
        }
        if !requests.isEmpty { downloader.enqueue(requests) }
        sendDownloadSnapshot()
    }

    fileprivate func pauseDownloads(showId: String?) {
        guard let showId = showId, !showId.isEmpty else { return }
        downloader.pause(showId: showId)
        sendDownloadSnapshot()
    }

    fileprivate func resumeDownloads(showId: String?) {
        guard let showId = showId, !showId.isEmpty else { return }
        downloader.resume(showId: showId)
        sendDownloadSnapshot()
    }

    fileprivate func cancelDownloads(showId: String?) {
        guard let showId = showId, !showId.isEmpty else { return }
        downloader.cancel(showId: showId)
        sendDownloadSnapshot()
    }

    fileprivate func cancelDownload() {
        downloader.cancel()
        sendDownloadSnapshot()
    }

    /// 把后台会话里的状态补回网页：进度每次都可以重发，完成/失败/取消只发一次。
    fileprivate func flushDownloadEvents() {
        downloader.restore { [weak self] in
            guard let self = self else { return }
            self.sendDownloadSnapshot()
            for event in self.downloader.eventsForPage() {
                self.sendDownloadEvent(event)
            }
            self.sendDownloadSnapshot()
        }
    }

    /// 队列快照：网页侧用它算整剧进度、恢复暂停/排队状态。
    private func sendDownloadSnapshot() {
        let tasks = downloader.snapshotForPage()
        guard JSONSerialization.isValidJSONObject(tasks),
              let data = try? JSONSerialization.data(withJSONObject: tasks),
              let text = String(data: data, encoding: .utf8) else { return }
        let script = "window.__zhuijuDownloads && window.__zhuijuDownloads(\"snapshot\", " + text + ");"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    /// 把下载好的本地文件交给系统：文件类型（public.movie / public.mpeg-4）是
    /// 播放器 App 能出现在列表里的方式，也是这类 App 唯一合法的入口。
    /// 兼容老网页的删除消息：只删这一集对应的那个文件，记录由网页侧先删。
    /// 路径由下载器按真实下载目录边界校验。
    fileprivate func deleteLocalFile(path: String?) {
        guard let raw = path?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return }
        if !downloader.removeDownloadedFile(at: raw) {
            notifyPlayerNotice("删除本地文件失败，这一集还留着")
        }
    }

    fileprivate func presentLocalPlayback(path: String?) {
        guard let fileURL = MediaDownloader.fileURL(forStoredPath: path) else {
            notifyPlayerNotice("这一集的文件已经不在了，请重新下载")
            return
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            NSLog("playLocal missing: %@", path ?? "")
            notifyPlayerNotice("这一集的文件已经不在了，请重新下载")
            return
        }
        let player = AVPlayer(url: fileURL)
        let controller = AVPlayerViewController()
        controller.player = player
        controller.modalPresentationStyle = .fullScreen
        let presenter = presentedViewController ?? self
        presenter.present(controller, animated: true) { player.play() }
        /* 记住当前在播哪个文件：删除这一集时先停播。 */
        localPlayerController = controller
        localPlayerFileURL = fileURL
        /* TS 分片合成出来的 .ts 文件系统播放器打不开：1.5 秒内没进入播放就收掉播放器，
           提示改用「用其他播放器打开」，不把用户丢在一个黑屏里。 */
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self, weak controller] in
            guard let controller = controller, controller.presentingViewController != nil else { return }
            guard let item = controller.player?.currentItem, item.status == .failed else { return }
            controller.dismiss(animated: true) {
                self?.notifyPlayerNotice("这个格式 App 内播不了，请点「用其他播放器打开」")
            }
        }
    }

    /// 下载器实际落盘的扩展名（MediaDownloader 只接受这五种，别的格式不会被下载成文件）。
    fileprivate static let externalPlayerExtensions: Set<String> = ["mp4", "m4v", "mov", "mkv", "ts"]

    /// 只有下载器真正的落盘目录（Documents/Downloads）里的文件才能交给外部播放器。
    /// 两边都标准化并解析符号链接，再按**完整路径组件**比较：
    /// `.../Documents-evil/x.mp4` 这种同前缀的兄弟目录不算在下载目录里。
    private func isInDownloadDirectory(_ fileURL: URL) -> Bool {
        guard let directory = MediaDownloader.directory() else { return false }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let target = fileURL.standardizedFileURL.resolvingSymlinksInPath()
        let rootComponents = root.pathComponents
        let targetComponents = target.pathComponents
        guard targetComponents.count > rootComponents.count else { return false }
        return Array(targetComponents.prefix(rootComponents.count)) == rootComponents
    }

    /// 「打开方式」用的系统类型。mp4/m4v/mov 用系统声明好的类型；
    /// mkv/ts 在部分系统上没有声明类型，用同扩展名、conforming 到 public.movie 的动态类型，
    /// 而不是把所有扩展名硬套成 public.movie。只处理下载器实际允许的扩展名，
    /// 取不到类型就返回 nil，由调用方明确提示，不猜别的格式能不能播。
    private func externalPlayerType(for fileURL: URL) -> UTType? {
        let ext = fileURL.pathExtension.lowercased()
        guard Self.externalPlayerExtensions.contains(ext) else { return nil }
        if let declared = UTType(filenameExtension: ext),
           declared.conforms(to: .movie) || declared.conforms(to: .audiovisualContent) {
            return declared
        }
        guard let derived = UTType(tag: ext, tagClass: .filenameExtension, conformingTo: .movie),
              derived.conforms(to: .movie) || derived.conforms(to: .audiovisualContent) else {
            return nil
        }
        return derived
    }

    /// 网页左滑删除一集：先真删本地文件，删成功才取消任务、写墓碑、清记录。
    /// 文件删不掉（被占用、权限、路径越界）就原样保留记录，并把失败回给网页；
    /// 旧实现把文件挪进 .trash，看着删了其实还占空间，失败也当成功。
    /// 当前 App 内离线播放的是哪个文件：删除同一集时要先停播再删文件。
    private weak var localPlayerController: AVPlayerViewController?
    private var localPlayerFileURL: URL?

    fileprivate func deleteDownloadedEpisode(_ body: [String: Any]) {
        let taskId = body["id"] as? String
        let showId = body["showId"] as? String ?? ""
        let epKey = body["epKey"] as? String ?? ""
        let fileURL = body["path"] as? String
        /* 删的就是正在播的那一集：先停播，否则播放器还占着文件，删了也白删。 */
        if let target = MediaDownloader.fileURL(forStoredPath: fileURL) {
            stopLocalPlayback(of: target)
        }
        guard downloader.removeDownloadedFile(at: fileURL) else {
            sendDeleteResult(ok: false, id: taskId, showId: showId, epKey: epKey,
                             reason: "删除本地文件失败，这一集还留在下载列表里",
                             record: downloadRecord(id: taskId, showId: showId, epKey: epKey))
            sendDownloadSnapshot()
            return
        }
        downloader.deleteEpisode(id: taskId, showId: showId, epKey: epKey)
        sendDownloadSnapshot()
        sendDeleteResult(ok: true, id: taskId, showId: showId, epKey: epKey, reason: "", record: nil)
    }

    /// 原生「我的下载」：设置面板最上方的入口和断网页的入口都走这里。
    /// 片库不读网页状态，飞行模式下也能按剧看全库、离线播放、分享单集。
    fileprivate func presentDownloadLibrary() {
        let library = DownloadLibraryViewController(downloader: downloader)
        /* 播放和停播仍交给本类：它已经管着离线播放器的生命周期（同一集删之前先停播）。 */
        library.onPlay = { [weak self] playlist, startIndex in
            self?.presentOfflinePlayer(playlist, startIndex: startIndex)
        }
        library.onStopPlayback = { [weak self] path in
            self?.stopLibraryPlayback(path: path)
        }
        let navigation = UINavigationController(rootViewController: library)
        navigation.modalPresentationStyle = .fullScreen
        navigation.overrideUserInterfaceStyle = .dark
        (presentedViewController ?? self).present(navigation, animated: true)
    }

    // MARK: - 离线播放器

    /// 真正的离线播放：片源是本机已下载完成的文件，控件和在线播放同一套。
    /// 方向只在这里统一切，其他页面（网页、片库）始终只竖屏。
    fileprivate func presentOfflinePlayer(_ playlist: OfflinePlaylist, startIndex: Int) {
        guard !playlist.episodes.isEmpty else {
            notifyPlayerNotice("这一部剧还没有下载完成的集")
            return
        }
        let player = OfflinePlayerViewController(playlist: playlist, startIndex: startIndex)
        player.owner = self
        Self.offlinePlayerActive = true
        Self.offlineFullscreen = false
        Self.offlineRotationLocked = false
        player.onFullscreenChange = { [weak self] fullscreen, explicit in
            Self.offlineFullscreen = fullscreen
            /* 只有用户自己点「退出全屏」才锁竖屏；旋转导致的切换不反向抢方向。 */
            Self.offlineRotationLocked = explicit && !fullscreen
            self?.applyOfflineOrientation()
        }
        player.onClose = { [weak self] in
            self?.finishOfflinePlayer()
        }
        offlinePlayerController = player
        (presentedViewController ?? self).present(player, animated: true)
    }

    /// 离线播放器收回：方向状态全部复位，回到只竖屏。
    fileprivate func finishOfflinePlayer() {
        Self.offlinePlayerActive = false
        Self.offlineFullscreen = false
        Self.offlineRotationLocked = false
        offlinePlayerController = nil
        applyOfflineOrientation()
    }

    /// 设备真的回到竖屏了，放开自动旋转（否则手还横着会立刻又进全屏）。
    fileprivate func unlockOfflineRotation() {
        guard Self.offlineRotationLocked else { return }
        Self.offlineRotationLocked = false
        applyOfflineOrientation()
    }

    private func applyOfflineOrientation() {
        setNeedsUpdateOfSupportedInterfaceOrientations()
        if #available(iOS 16.0, *) {
            let mask = Self.supportedOrientations
            view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    /// 片库删文件前停播：只处理路径真的指向同一个文件的情况。
    fileprivate func stopLibraryPlayback(path: String?) {
        guard let fileURL = MediaDownloader.fileURL(forStoredPath: path) else { return }
        stopLocalPlayback(of: fileURL)
        offlinePlayerController?.stopIfPlaying(fileURL)
    }

    /// 停掉正在播的这个离线文件：只处理同一个文件，别的播放页面不动。
    private func stopLocalPlayback(of fileURL: URL) {
        guard let controller = localPlayerController, let playing = localPlayerFileURL else { return }
        guard playing.standardizedFileURL.path == fileURL.standardizedFileURL.path else { return }
        controller.player?.pause()
        if controller.presentingViewController != nil {
            controller.dismiss(animated: false, completion: nil)
        }
        localPlayerController = nil
        localPlayerFileURL = nil
    }

    /// 这一集在原生快照里的样子：删除失败时网页靠它把片库那一行放回列表。
    private func downloadRecord(id: String?, showId: String, epKey: String) -> [String: Any]? {
        return downloader.snapshotForPage().first { entry in
            let sameId = !(id ?? "").isEmpty && (entry["id"] as? String) == id
            let sameEpisode = !showId.isEmpty && !epKey.isEmpty
                && (entry["showId"] as? String) == showId && (entry["epKey"] as? String) == epKey
            return sameId || sameEpisode
        }
    }

    /// 删除结果回给网页：成功才让那一行消失；失败时网页清掉自己的墓碑，把这一行放回去。
    private func sendDeleteResult(ok: Bool, id: String?, showId: String, epKey: String, reason: String, record: [String: Any]?) {
        var payload: [String: Any] = [
            "ok": ok,
            "id": id ?? "",
            "showId": showId,
            "epKey": epKey,
            "reason": reason,
        ]
        if let record = record {
            payload["path"] = record["path"] ?? ""
            payload["name"] = record["name"] ?? ""
            payload["size"] = record["size"] ?? 0
            payload["title"] = record["title"] ?? ""
            payload["epLabel"] = record["epLabel"] ?? ""
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        let script = "window.__zhuijuDownloads && window.__zhuijuDownloads(\"deleteResult\", " + text + ");"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    /// 已完成的一集交给系统「打开方式」菜单（UIDocumentInteractionController）。
    /// 系统会把本地文件复制进用户选中的播放器，不需要后台服务，也不给别的 App 传我们读不到的 file 地址。
    /// 下载中 / 未完成的集网页侧不会给入口；这里再挡一次缺文件、路径越界、格式不支持
    /// 和没有可接收 App 的情况。
    fileprivate func presentOpenInMenu(path: String?) {
        let raw = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty else {
            notifyPlayerNotice("这一集还没有下载完成")
            return
        }
        let fileURL = MediaDownloader.fileURL(forStoredPath: raw)
        guard let fileURL = fileURL, isInDownloadDirectory(fileURL) else {
            notifyPlayerNotice("这个文件不在 App 的下载目录里")
            return
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else {
            notifyPlayerNotice("这一集的文件已经不在了，请重新下载")
            return
        }
        guard let type = externalPlayerType(for: fileURL) else {
            notifyPlayerNotice("这个格式不能交给其他播放器，请用 App 内播放")
            return
        }
        /* 上一次的菜单没关干净：先收起来，避免同时挂两个控制器。 */
        if let current = documentInteraction {
            current.dismissMenu(animated: false)
            documentInteraction = nil
        }
        sendingToExternalPlayer = false
        let controller = UIDocumentInteractionController(url: fileURL)
        /* 类型来自系统声明或按扩展名派生的 conforming 类型；mkv/ts 能不能出现在某个播放器的菜单里
           取决于那个 App 自己声明的类型，真机未验证。 */
        controller.uti = type.identifier
        controller.delegate = self
        documentInteraction = controller
        /* iPad 上这是 popover，必须给锚点；放屏幕中间的小矩形，iPhone 会忽略。 */
        let anchor = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        let presented = controller.presentOpenInMenu(from: anchor, in: view, animated: true)
        if !presented {
            documentInteraction = nil
            notifyPlayerNotice("没有找到能打开这个视频的播放器")
        }
    }

    func documentInteractionController(
        _ controller: UIDocumentInteractionController,
        willBeginSendingToApplication bundleIdentifier: String?
    ) {
        sendingToExternalPlayer = true
    }

    func documentInteractionControllerDidDismissOpenInMenu(_ controller: UIDocumentInteractionController) {
        let cancelled = !sendingToExternalPlayer
        sendingToExternalPlayer = false
        if documentInteraction === controller { documentInteraction = nil }
        /* 选了 App 就直接切过去了，不用再弹提示；把菜单关掉才告诉用户「已取消」。 */
        if cancelled { notifyPlayerNotice("已取消") }
    }

    /// 原生把「打开方式」的结果告诉网页：网页侧用同一个 toast 显示。
    private func notifyPlayerNotice(_ message: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [message]),
              let text = String(data: data, encoding: .utf8) else { return }
        /* [message] 序列化成 ["..."]，去掉两端方括号就是给 JS 的字符串字面量。 */
        let quoted = String(text.dropFirst().dropLast())
        /* 这里要用 Swift 插值把转义后的字符串字面量拼进去；不插值直接写字面量的话，网页读到的是未定义变量，提示永远不会显示。 */
        let script = "window.__zhuijuPlayerNotice && window.__zhuijuPlayerNotice(\(quoted));"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    fileprivate func presentLocalFile(path: String?, name: String?) {
        guard let fileURL = MediaDownloader.fileURL(forStoredPath: path) else { return }
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        let presenter = presentedViewController ?? self
        let controller = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(controller, animated: true)
    }

    /// 回传给网页的下载事件（网页里的 `window.__zhuijuDownload`）。
    private func sendDownloadEvent(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        let script = "window.__zhuijuDownload && window.__zhuijuDownload(\(text));"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func configureErrorView() {
        errorContainer.backgroundColor = UIColor.black
        errorContainer.isHidden = true
        errorContainer.translatesAutoresizingMaskIntoConstraints = false

        errorLabel.text = "页面加载失败，请检查网络后重试"
        errorLabel.textColor = .white
        errorLabel.font = .preferredFont(forTextStyle: .body)
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.translatesAutoresizingMaskIntoConstraints = false

        retryButton.setTitle("重新加载", for: .normal)
        retryButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        retryButton.translatesAutoresizingMaskIntoConstraints = false

        offlineLibraryButton.setTitle("我的下载（离线可用）", for: .normal)
        offlineLibraryButton.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
        offlineLibraryButton.addTarget(self, action: #selector(openOfflineLibrary), for: .touchUpInside)
        offlineLibraryButton.translatesAutoresizingMaskIntoConstraints = false

        errorContainer.addSubview(errorLabel)
        errorContainer.addSubview(retryButton)
        errorContainer.addSubview(offlineLibraryButton)
        view.addSubview(errorContainer)
        NSLayoutConstraint.activate([
            errorContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            errorContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            errorContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            errorContainer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            errorLabel.centerXAnchor.constraint(equalTo: errorContainer.centerXAnchor),
            errorLabel.centerYAnchor.constraint(equalTo: errorContainer.centerYAnchor, constant: -24),
            errorLabel.leadingAnchor.constraint(greaterThanOrEqualTo: errorContainer.leadingAnchor, constant: 32),
            errorLabel.trailingAnchor.constraint(lessThanOrEqualTo: errorContainer.trailingAnchor, constant: -32),
            retryButton.centerXAnchor.constraint(equalTo: errorContainer.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: errorLabel.bottomAnchor, constant: 20),
            offlineLibraryButton.centerXAnchor.constraint(equalTo: errorContainer.centerXAnchor),
            offlineLibraryButton.topAnchor.constraint(equalTo: retryButton.bottomAnchor, constant: 12),
        ])
    }

    private func observeProgress() {
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            let progress = Float(webView.estimatedProgress)
            self?.progressView.setProgress(progress, animated: true)
            self?.progressView.isHidden = progress >= 1
        }
    }

    private func loadHome() {
        lastFailedURL = nil
        errorContainer.isHidden = true
        webView.load(URLRequest(url: Site.home))
    }

    @objc private func retry() {
        let url = lastFailedURL ?? webView.url ?? Site.home
        errorContainer.isHidden = true
        webView.load(URLRequest(url: url))
    }

    /// 页面加载不出来（飞行模式）时也能进「我的下载」：这条入口完全走原生。
    @objc private func openOfflineLibrary() {
        presentDownloadLibrary()
    }

    private func showError(_ error: Error) {
        let code = (error as NSError).code
        if ((error as NSError).domain == NSURLErrorDomain && code == NSURLErrorCancelled)
            || ((error as NSError).domain == "WebKitErrorDomain" && code == 102) {
            return
        }
        errorLabel.text = "页面加载失败，请检查网络后重试"
        errorContainer.isHidden = false
    }

    private func isSite(_ url: URL?) -> Bool {
        guard let url, url.user == nil, url.password == nil else { return false }
        if let testHome = Site.testHome, url.host?.lowercased() == testHome.host?.lowercased() {
            /* 测试夹具站是同机 http 服务：只放行它自己的 host，其它照样拦。 */
            return url.port == testHome.port
        }
        guard url.scheme?.lowercased() == "https" else { return false }
        return url.host?.lowercased() == Site.host && (url.port == nil || url.port == 443)
    }

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        if scheme == "https" || scheme == "mailto" || scheme == "tel" {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    private func presentJavaScriptPrompt(
        title: String,
        message: String,
        defaultText: String?,
        completion: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = defaultText
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completion(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completion(alert.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }
}

extension WebViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if let frame = navigationAction.targetFrame, !frame.isMainFrame {
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame == nil {
            if isSite(url) {
                webView.load(navigationAction.request)
            } else if navigationAction.navigationType == .linkActivated {
                openExternally(url)
            }
            decisionHandler(.cancel)
            return
        }
        if isSite(url) {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if navigationAction.navigationType == .linkActivated
            && (scheme == "https" || scheme == "mailto" || scheme == "tel") {
            openExternally(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        errorContainer.isHidden = true
        /* 换页之后网页已经不在全屏，end 事件可能永远不来：这里兜底回竖屏。 */
        resetPlayerFullscreen()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        errorContainer.isHidden = true
        progressView.isHidden = true
        captureMediaUserAgent(from: webView)
    }

    /// 把网页真实的 `navigator.userAgent` 交给原生下载器。
    /// 片源 CDN 经常按 UA 放行/拒绝：网页能播、下载却 403，根因就是下载请求发的不是浏览器 UA。
    /// 这里取网页自己的 UA（系统 Safari UA + 我们追加的 App 令牌），下载和播放才是同一种客户端。
    private func captureMediaUserAgent(from webView: WKWebView) {
        webView.evaluateJavaScript("navigator.userAgent") { value, _ in
            guard let ua = value as? String, ua.contains("Mozilla/") else { return }
            MediaDownloader.mediaUserAgent = ua
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        lastFailedURL = failingURL(from: error) ?? webView.url
        showError(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        lastFailedURL = failingURL(from: error) ?? webView.url
        showError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        lastFailedURL = webView.url
        /* 网页进程都没了，页内状态一起消失：方向也要跟着复位。 */
        resetPlayerFullscreen()
        webView.reload()
    }

    private func failingURL(from error: Error) -> URL? {
        (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
    }
}

extension WebViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, isSite(url) {
            webView.load(navigationAction.request)
        } else if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: "提示", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: "提示", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        presentJavaScriptPrompt(title: "输入", message: prompt, defaultText: defaultText, completion: completionHandler)
    }
}
