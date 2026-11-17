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
    }

    private final class PlayerBridge: NSObject, WKScriptMessageHandler {
        weak var target: WebViewController?

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            if action == PlayerAction.share.rawValue {
                target?.presentExternalShare(url: body["url"] as? String, title: body["title"] as? String)
                return
            }
            target?.apply(playerAction: action)
        }
    }

    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let errorContainer = UIView()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var progressObservation: NSKeyValueObservation?
    private var lastFailedURL: URL?
    private var safeAreaConstraints: [NSLayoutConstraint] = []
    private var fullscreenConstraints: [NSLayoutConstraint] = []
    private var isPlayerFullscreen = false

    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.applicationNameForUserAgent = "ZhuijuAI/0.1.4 iOS"
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
        view.backgroundColor = UIColor(red: 0.043, green: 0.071, blue: 0.125, alpha: 1)
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
        isPlayerFullscreen ? .landscape : .allButUpsideDown
    }

    override var shouldAutorotate: Bool {
        true
    }

    private func configureLayout() {
        progressView.progressTintColor = UIColor(red: 0.13, green: 0.72, blue: 0.95, alpha: 1)
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
    fileprivate func presentExternalShare(url: String?, title: String?) {
        guard let link = Self.shareableURL(url) else { return }
        let presenter = presentedViewController ?? self
        var items: [Any] = [link]
        if let title = title, !title.isEmpty { items.append(title) }
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(controller, animated: true)
    }

    fileprivate func apply(playerAction: String) {
        guard let action = PlayerAction(rawValue: playerAction) else { return }
        setPlayerFullscreen(action == .fullscreen)
    }

    private func setPlayerFullscreen(_ on: Bool) {
        guard isPlayerFullscreen != on else { return }
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
            guard let scene = view.window?.windowScene else { return }
            let mask: UIInterfaceOrientationMask = landscape ? .landscape : .portrait
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in
                // 旋转被系统拒绝时保持当前布局，不阻断播放
            }
        } else {
            // iOS 15 没有公开的强制旋转接口，用 KVC 触发同一套系统旋转流程
            let target: UIInterfaceOrientation = landscape ? .landscapeRight : .portrait
            UIDevice.current.setValue(target.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    private func configureErrorView() {
        errorContainer.backgroundColor = UIColor(red: 0.043, green: 0.071, blue: 0.125, alpha: 1)
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
