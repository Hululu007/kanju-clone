import AVFoundation
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        configureAudioSession()
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        // Info.plist 里已经写了 $(PRODUCT_MODULE_NAME).SceneDelegate，这里再显式指定一次：
        // 模块名一旦跟着 PRODUCT_NAME 改过，plist 里那个字符串就会失效。
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // 切后台时再激活一次：会话可能被电话/其他 App 抢走，抢回来才能续播。
        configureAudioSession()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        configureAudioSession()
    }

    /// H5 shell 里没有任何原生播放器，声音全部来自 WKWebView 里的 <video>。
    /// 宿主 App 不把会话设成 .playback，锁屏/切后台就会被系统掐断。
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            try session.setActive(true)
        } catch {
            NSLog("[ZhuijuAIH5] audio session setup failed: \(error.localizedDescription)")
        }
    }
}
