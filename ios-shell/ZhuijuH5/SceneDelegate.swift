import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        // 深底：网页首帧之前不出现白闪
        window.backgroundColor = .black
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
