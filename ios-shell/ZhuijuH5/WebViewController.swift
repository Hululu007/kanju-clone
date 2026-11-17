import UIKit
import WebKit

/// H5 shell：整屏一个 WKWebView 加载线上站点，App 只提供外壳能力
/// （内联播放、画中画、后台音频、返回手势、下拉刷新、站外跳 Safari、离线重试）。
/// 这里刻意不接任何原生业务桥接：网页是唯一的功能来源，iOS 原生已经有 ios/ 那一套。
final class WebViewController: UIViewController {
    private enum Site {
        static let home = URL(string: "https://zhuiju.dpdns.org/")!
        static let host = "zhuiju.dpdns.org"
    }

    /// 首帧之前先把底色刷深，避免深色页面出现白闪。
    private static let darkPaintScript = """
    (function () {
      'use strict';
      function paint() {
        if (document.documentElement) document.documentElement.style.backgroundColor = '#0b1014';
        if (document.body) document.body.style.backgroundColor = '#0b1014';
      }
      paint();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', paint);
      }
    }());
    """

    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let offlineView = UIView()
    private let offlineLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let refreshControl = UIRefreshControl()
    private var progressObservation: NSKeyValueObservation?
    private var lastFailedURL: URL?

    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        configuration.applicationNameForUserAgent = "ZhuijuAIH5/\(version) iOS"
        if #available(iOS 14.2, *) {
            configuration.allowsPictureInPictureMediaPlayback = true
        }

        let contentController = configuration.userContentController
        contentController.addUserScript(
            WKUserScript(
                source: WebViewController.darkPaintScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        // 从 android/app/src/phone/assets/app-bootstrap.js 移植：把对 Worker API 的 fetch
        // 改写成同源请求，并在横屏播放时接管播放器布局。必须在文档开头注入，
        // 晚于页面的首个 fetch 就等于没打补丁。
        if let bootstrapURL = Bundle.main.url(forResource: "AppBootstrap", withExtension: "js"),
           let bootstrap = try? String(contentsOf: bootstrapURL, encoding: .utf8) {
            contentController.addUserScript(
                WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        // iOS 自带 HLS，不需要 hls.js；页面检测到 canPlayType('application/vnd.apple.mpegurl')
        // 就会直接走原生播放。

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // 左右边缘返回/前进手势
        webView.allowsBackForwardNavigationGestures = true
        // 页面自己管滚动，外层滚动视图不再因为安全区/键盘反复改 contentInset
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // 下拉刷新需要回弹
        webView.scrollView.bounces = true
        webView.scrollView.alwaysBounceVertical = true
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
        view.backgroundColor = .black
        configureLayout()
        configureOfflineView()
        configureRefreshControl()
        observeProgress()
        loadHome()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }

    private func configureLayout() {
        progressView.progressTintColor = UIColor(red: 22.0 / 255.0, green: 224.0 / 255.0, blue: 90.0 / 255.0, alpha: 1)
        progressView.trackTintColor = .clear
        progressView.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(progressView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2),
        ])
    }

    private func configureOfflineView() {
        offlineView.backgroundColor = UIColor(red: 11.0 / 255.0, green: 16.0 / 255.0, blue: 20.0 / 255.0, alpha: 1)
        offlineView.isHidden = true
        offlineView.translatesAutoresizingMaskIntoConstraints = false

        offlineLabel.text = "连不上 追剧AI\n请检查网络后重试"
        offlineLabel.textColor = .white
        offlineLabel.font = .preferredFont(forTextStyle: .body)
        offlineLabel.numberOfLines = 0
        offlineLabel.textAlignment = .center
        offlineLabel.translatesAutoresizingMaskIntoConstraints = false

        retryButton.setTitle("重新加载", for: .normal)
        retryButton.setTitleColor(UIColor(red: 22.0 / 255.0, green: 224.0 / 255.0, blue: 90.0 / 255.0, alpha: 1), for: .normal)
        retryButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        retryButton.translatesAutoresizingMaskIntoConstraints = false

        offlineView.addSubview(offlineLabel)
        offlineView.addSubview(retryButton)
        view.addSubview(offlineView)
        NSLayoutConstraint.activate([
            offlineView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            offlineView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            offlineView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            offlineView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            offlineLabel.centerXAnchor.constraint(equalTo: offlineView.centerXAnchor),
            offlineLabel.centerYAnchor.constraint(equalTo: offlineView.centerYAnchor, constant: -24),
            offlineLabel.leadingAnchor.constraint(greaterThanOrEqualTo: offlineView.leadingAnchor, constant: 32),
            offlineLabel.trailingAnchor.constraint(lessThanOrEqualTo: offlineView.trailingAnchor, constant: -32),
            retryButton.centerXAnchor.constraint(equalTo: offlineView.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: offlineLabel.bottomAnchor, constant: 20),
        ])
    }

    private func configureRefreshControl() {
        refreshControl.tintColor = UIColor(white: 0.6, alpha: 1)
        refreshControl.addTarget(self, action: #selector(handleRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
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
        offlineView.isHidden = true
        webView.load(URLRequest(url: Site.home))
    }

    @objc private func retry() {
        let url = lastFailedURL ?? webView.url ?? Site.home
        offlineView.isHidden = true
        webView.load(URLRequest(url: url))
    }

    @objc private func handleRefresh() {
        if webView.url == nil {
            loadHome()
        } else {
            webView.reload()
        }
    }

    private func showOffline() {
        refreshControl.endRefreshing()
        offlineView.isHidden = false
    }

    private func isSite(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https" else { return false }
        return url.host?.lowercased() == Site.host && (url.port == nil || url.port == 443)
    }

    /// 站外链接一律交给 Safari：shell 不做任何第三方导航，也不接管未知 scheme。
    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto", "tel"].contains(scheme) else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
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
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            decisionHandler(.allow)
            return
        }
        // window.open / target=_blank：站内就地加载，站外丢给 Safari
        if navigationAction.targetFrame == nil {
            if isSite(url) {
                webView.load(navigationAction.request)
            } else {
                openExternally(url)
            }
            decisionHandler(.cancel)
            return
        }
        if isSite(url) || url.scheme?.lowercased() == "about" {
            decisionHandler(.allow)
            return
        }
        openExternally(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        offlineView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offlineView.isHidden = true
        progressView.isHidden = true
        refreshControl.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        lastFailedURL = failingURL(from: error) ?? webView.url
        handleFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        lastFailedURL = failingURL(from: error) ?? webView.url
        handleFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        lastFailedURL = webView.url
        webView.reload()
    }

    /// 取消（导航被打断、被新导航顶掉）不是错误，不该弹离线页。
    private func handleFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        showOffline()
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
        } else if let url = navigationAction.request.url {
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
        (presentedViewController ?? self).present(alert, animated: true)
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
        (presentedViewController ?? self).present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: "输入", message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        (presentedViewController ?? self).present(alert, animated: true)
    }
}
