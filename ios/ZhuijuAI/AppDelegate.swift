import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        /* 后台下载会话要在启动时就把 delegate 接上：完成事件可能早于界面 */
        _ = MediaDownloader.shared
        return true
    }

    /// 全屏方向策略和 WebViewController 共用：平时竖屏，站点播放器全屏时横屏。
    /// WebKit 的网页全屏控制器属于系统，不继承我们的 VC 方向，只能从这里统一回答。
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        WebViewController.supportedOrientations
    }

    /// 后台下载（URLSession background）把控制权交回来：
    /// 重新接上会话、对账任务状态，处理完再调用系统的 completionHandler。
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == MediaDownloader.backgroundIdentifier else {
            completionHandler()
            return
        }
        MediaDownloader.shared.handleBackgroundEvents(completion: completionHandler)
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}
