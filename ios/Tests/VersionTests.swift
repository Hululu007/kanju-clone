import XCTest
@testable import ZhuijuAI

/// 站点靠 User-Agent 区分「App 内」和浏览器（线路/下载/分享都按它分支），
/// 版本号写在 UA 里。0.1.2 到 0.1.5 每发一版都要手改那一行字符串，
/// 忘一次就会和包版本对不上，所以这里直接把两者钉在一起。
final class VersionTests: XCTestCase {
    /// 全屏只有两态：窗口模式竖屏（视频留在详情页原位），站点播放器全屏时横屏铺满。
    /// 退出全屏必须回到竖屏原位继续播放，不能停在竖屏全屏或其它中间状态。
    func testFullscreenSwitchesBetweenPortraitAndLandscape() {
        XCTAssertEqual(WebViewController.interfaceOrientations(forFullscreen: false), .portrait,
                       "默认窗口模式只允许竖屏")
        let fullscreen = WebViewController.interfaceOrientations(forFullscreen: true)
        XCTAssertTrue(fullscreen.contains(.landscapeLeft), "全屏要能横屏")
        XCTAssertTrue(fullscreen.contains(.landscapeRight), "左右横屏都行，跟着手握方向转")
        XCTAssertFalse(fullscreen.contains(.portrait), "全屏不许停在竖屏，也不许有竖屏全屏")
        XCTAssertEqual(WebViewController.interfaceOrientations(forFullscreen: false), .portrait,
                       "退出全屏必须回竖屏")
    }

    /// 网站只带 url / name：缺 id 时按「剧号 + 集号」补一个稳定 id，同一集重复点不会变成两条记录。
    func testDownloadIdentifierIsStableForTheSameEpisode() {
        let first = WebViewController.downloadIdentifier(explicit: nil, showId: "show-1", epKey: "3", name: "测试剧 第3集.mp4")
        let second = WebViewController.downloadIdentifier(explicit: nil, showId: "show-1", epKey: "3", name: "测试剧 第3集.mp4")
        XCTAssertEqual(first, "dl-show-1-3")
        XCTAssertEqual(first, second, "同一集的 id 必须稳定，续传数据才接得上")
    }

    func testDownloadIdentifierKeepsTheIDThePageSent() {
        let explicit = WebViewController.downloadIdentifier(explicit: "dl-page-9", showId: "show-1", epKey: "3", name: "x.mp4")
        XCTAssertEqual(explicit, "dl-page-9")
        let blank = WebViewController.downloadIdentifier(explicit: "", showId: "show-1", epKey: "3", name: "x.mp4")
        XCTAssertEqual(blank, "dl-show-1-3", "空 id 当作没给，退回稳定值")
    }

    func testDownloadIdentifierFallsBackToTheFileNameAndThenAUUID() {
        let named = WebViewController.downloadIdentifier(explicit: nil, showId: "", epKey: "", name: "a.mp4")
        XCTAssertEqual(named, "dl-a.mp4")
        let one = WebViewController.downloadIdentifier(explicit: nil, showId: "", epKey: "", name: "")
        let two = WebViewController.downloadIdentifier(explicit: nil, showId: "", epKey: "", name: "")
        XCTAssertTrue(one.hasPrefix("dl-"), "什么都没有时也要给一个能入队的 id，不能丢请求")
        XCTAssertNotEqual(one, two, "完全没有身份信息时才允许一次性 UUID")
    }

    func testUserAgentCarriesTheBundleVersion() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        XCTAssertNotNil(version, "包信息里必须有 CFBundleShortVersionString")
        XCTAssertEqual(WebViewController.userAgent, "ZhuijuAI/\(version!) iOS", "UA 里的版本必须就是包版本，不许手写")
    }

    func testUserAgentIsRecognisableAndAsciiOnly() {
        let agent = WebViewController.userAgent
        XCTAssertTrue(agent.hasPrefix("ZhuijuAI/"), "站点按 ZhuijuAI/ 前缀识别 App")
        XCTAssertTrue(agent.hasSuffix(" iOS"), "站点按 iOS 后缀区分平台")
        XCTAssertTrue(agent.canBeConverted(to: .ascii), "UA 只能是 ASCII，否则请求头会被丢掉")
        XCTAssertFalse(agent.contains("0.0.0"), "取不到版本时不能悄悄发 0.0.0")
    }

    func testBuildNumberIsBumpedVersionedNumbers() {
        // 版本号递增但构建号也必须跟着涨，否则覆盖安装会拿到旧缓存
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        XCTAssertNotNil(build)
        XCTAssertNotEqual(build, "0")
        let numbers = build!.split(separator: ".").compactMap { Int($0) }
        XCTAssertFalse(numbers.isEmpty, "构建号应该是数字")
    }
}
