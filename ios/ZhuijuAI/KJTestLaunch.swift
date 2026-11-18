import Foundation

/// 出包关卡（XCUITest 截图工作流）专用的测试入口。
///
/// 只存在两种取法，且都只在 Debug 构建里生效：
/// 1. 起始地址 —— 模拟器里没有账号、也不该走公网，所以由测试进程用环境变量
///    `KJ_TEST_HOME_URL` 指定同机受控夹具站；
/// 2. 注入层的放行变量 —— `AppBootstrap.js` 只认站点 origin，夹具站是
///    `http://127.0.0.1:PORT`，用这一个变量把「只有这个 origin 可以进」写进页面。
///
/// Release 包（线上 App、设备 IPA）里这两条都编译不进去，起始地址永远回到站点首页。
enum KJTestLaunch {
    static var home: URL? {
        #if DEBUG
        guard let raw = ProcessInfo.processInfo.environment["KJ_TEST_HOME_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              url.scheme != nil, url.host != nil else { return nil }
        return url
        #else
        return nil
        #endif
    }

    /// 起始地址的 origin，注入层用它决定放不放行当前页面。
    static var testOrigin: String? {
        #if DEBUG
        guard let home = home, let scheme = home.scheme, let host = home.host else { return nil }
        var origin = "\(scheme)://\(host)"
        if let port = home.port { origin += ":\(port)" }
        return origin
        #else
        return nil
        #endif
    }

    /// 在 `AppBootstrap.js` 之前跑的那一行脚本：把放行的 origin 交给注入层。
    static var bootstrapPrelude: String? {
        guard let origin = testOrigin else { return nil }
        let escaped = origin
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return "window.__zhuijuTestOrigin = '\(escaped)';"
    }
}
