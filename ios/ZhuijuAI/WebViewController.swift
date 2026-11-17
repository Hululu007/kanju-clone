import LinkPresentation
import UIKit
import WebKit

final class WebViewController: UIViewController {
    private enum Site {
        static let home = URL(string: "https://zhuiju.dpdns.org/")!
        static let host = "zhuiju.dpdns.org"
    }

    /// 播放器全屏状态由网页内的「全屏」按钮通过 WKScriptMessageHandler 通知。
    private enum PlayerAction: String {
        case fullscreen
        case inline
        /// 网页请求把可播放地址交给系统分享面板（外部播放器 / AirPlay 的入口）。
        case share
        /// 下载一集到沙盒（网页已做过登录门控，这里再核一次）。
        case download
        case cancelDownload
        /// 下载完成后用系统应用列表打开本地文件。
        case openLocal
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
            case PlayerAction.cancelDownload.rawValue:
                target?.cancelDownload()
            case PlayerAction.openLocal.rawValue:
                target?.presentLocalFile(path: body["path"] as? String, name: body["name"] as? String)
            default:
                target?.apply(playerAction: action)
            }
        }
    }

    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let errorContainer = UIView()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var progressObservation: NSKeyValueObservation?
    private let downloader = MediaDownloader()
    private var lastFailedURL: URL?
    private var safeAreaConstraints: [NSLayoutConstraint] = []
    private var fullscreenConstraints: [NSLayoutConstraint] = []
    private var isPlayerFullscreen = false

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
        loadHome()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .lightContent
    }

    override var prefersStatusBarHidden: Bool {
        isPlayerFullscreen
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        isPlayerFullscreen
    }

    /// 全屏时锁横屏，其余时候保留系统自动旋转。
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        Self.orientationMask(isFullscreen: isPlayerFullscreen)
    }

    static func orientationMask(isFullscreen: Bool) -> UIInterfaceOrientationMask {
        isFullscreen ? .landscape : .portrait
    }

    override var shouldAutorotate: Bool {
        true
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
        // 全屏播放时铺满整块屏幕，横屏不因刘海安全区留下黑边
        fullscreenConstraints = [
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
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
    static func shareableURL(_ raw: String?) -> URL? {
        guard let raw = raw,
              !raw.isEmpty,
              let link = URL(string: raw),
              link.scheme?.lowercased() == "https",
              link.host?.isEmpty == false else { return nil }
        return link
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

    /// 网页侧已经做过登录门控；这里再核一次 `signedIn`，不接匿名下载请求。
    fileprivate func beginDownload(_ body: [String: Any]) {
        guard body["signedIn"] as? Bool == true,
              let id = body["id"] as? String, !id.isEmpty else { return }
        guard let link = Self.shareableURL(body["url"] as? String) else {
            sendDownloadEvent(["event": "failed", "id": id, "reason": "这条线路的地址不能下载"])
            return
        }
        let name = MediaDownloader.fileName(from: link.absoluteString, fallback: body["name"] as? String ?? "video.mp4")
        downloader.start(
            id: id,
            url: link,
            name: name,
            onProgress: { [weak self] received, total in
                self?.sendDownloadEvent([
                    "event": "progress", "id": id,
                    "received": received, "total": total,
                ])
            },
            onFinish: { [weak self] result in
                switch result {
                case .success(let payload):
                    var event = payload
                    event["event"] = "done"
                    event["id"] = id
                    self?.sendDownloadEvent(event)
                case .failure(let error):
                    self?.sendDownloadEvent(["event": "failed", "id": id, "reason": error.message])
                }
            }
        )
    }

    fileprivate func cancelDownload() {
        downloader.cancel()
    }

    /// 把下载好的本地文件交给系统：文件类型（public.movie / public.mpeg-4）是
    /// 播放器 App 能出现在列表里的方式，也是这类 App 唯一合法的入口。
    fileprivate func presentLocalFile(path: String?, name: String?) {
        guard let path = path, !path.isEmpty else { return }
        let fileURL = URL(fileURLWithPath: path)
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

    fileprivate func apply(playerAction: String) {
        guard let action = PlayerAction(rawValue: playerAction) else { return }
        setPlayerFullscreen(action == .fullscreen)
    }

    private func setPlayerFullscreen(_ on: Bool) {
        guard isPlayerFullscreen != on else {
            if !on { requestRotation(landscape: false) }
            return
        }
        isPlayerFullscreen = on
        NSLayoutConstraint.deactivate(on ? safeAreaConstraints : fullscreenConstraints)
        NSLayoutConstraint.activate(on ? fullscreenConstraints : safeAreaConstraints)
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        }
        requestRotation(landscape: on)
    }

    private func requestRotation(landscape: Bool) {
        if #available(iOS 16.0, *) {
            let mask: UIInterfaceOrientationMask = landscape ? .landscape : .portrait
            let update = { [weak self] in
                guard let self = self, let scene = self.view.window?.windowScene else { return }
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in
                    // 控制器 orientation mask 已同步更新，系统之后可继续尝试旋转。
                }
            }
            update()
            // 某些 iOS 版本在视频 surface 切换期间会忽略第一次 geometry 请求。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: update)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: update)
        } else {
            // iOS 15 没有公开的强制旋转接口，用 KVC 触发同一套系统旋转流程
            let target: UIInterfaceOrientation = landscape ? .landscapeRight : .portrait
            UIDevice.current.setValue(target.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
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

        errorContainer.addSubview(errorLabel)
        errorContainer.addSubview(retryButton)
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
        guard let url, url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { return false }
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
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        errorContainer.isHidden = true
        progressView.isHidden = true
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
