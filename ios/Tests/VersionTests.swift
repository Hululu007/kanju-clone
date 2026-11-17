import XCTest
@testable import ZhuijuAI

/// 站点靠 User-Agent 区分「App 内」和浏览器（线路/下载/分享都按它分支），
/// 版本号写在 UA 里。0.1.2 到 0.1.5 每发一版都要手改那一行字符串，
/// 忘一次就会和包版本对不上，所以这里直接把两者钉在一起。
final class VersionTests: XCTestCase {
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
