import UIKit
import WebKit

final class WebViewController: UIViewController {
    private enum Site {
        static let home = URL(string: "https://zhuiju.dpdns.org/")!
        static let host = "zhuiju.dpdns.org"
    }

    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let errorContainer = UIView()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var progressObservation: NSKeyValueObservation?
    private var lastFailedURL: URL?

    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.applicationNameForUserAgent = "ZhuijuAI/0.1.0 iOS"
        if #available(iOS 14.2, *) {
            configuration.allowsPictureInPictureMediaPlayback = true
        }
        if let scriptURL = Bundle.main.url(forResource: "AppBootstrap", withExtension: "js"),
           let source = try? String(contentsOf: scriptURL, encoding: .utf8) {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            configuration.userContentController.addUserScript(script)
        }
        if let hlsURL = Bundle.main.url(forResource: "hls.min", withExtension: "js"),
           let hlsSource = try? String(contentsOf: hlsURL, encoding: .utf8) {
            let script = WKUserScript(source: hlsSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            configuration.userContentController.addUserScript(script)
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
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

    private func configureLayout() {
        progressView.progressTintColor = UIColor(red: 0.13, green: 0.72, blue: 0.95, alpha: 1)
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
        if code == NSURLErrorCancelled || code == NSURLErrorFrameLoadInterruptedByPolicyChange {
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
            } else {
                openExternally(url)
            }
            decisionHandler(.cancel)
            return
        }
        if isSite(url) || url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "https" || scheme == "mailto" || scheme == "tel" {
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
