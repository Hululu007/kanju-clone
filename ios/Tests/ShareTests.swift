import XCTest
@testable import ZhuijuAI

/// 外部播放（交给 VLC / Infuse / 系统播放器）的边界：只认 https 直链。
/// 这条限制不靠文档保证，靠代码里唯一的入口 `WebViewController.shareableURL`。
final class ShareTests: XCTestCase {
    func testOnlyHTTPSDirectLinksCanBeHandedToAnotherApp() {
        XCTAssertNil(WebViewController.shareableURL(nil))
        XCTAssertNil(WebViewController.shareableURL(""))
        XCTAssertNil(WebViewController.shareableURL("这不是地址"))
        XCTAssertNil(WebViewController.shareableURL("http://media.example/19.mp4"), "明文 http 不能交出去")
        XCTAssertNil(WebViewController.shareableURL("blob:https://zhuiju.dpdns.org/9f1c"), "MSE 加密流交出去也播不了")
        XCTAssertNil(WebViewController.shareableURL("data:video/mp4;base64,AAAA"), "data: 地址不交出")
        XCTAssertNil(WebViewController.shareableURL("file:///var/mobile/19.mp4"), "本地文件不交出")
        XCTAssertNil(WebViewController.shareableURL("https://"), "没有 host 不算地址")
    }

    func testHTTPSDirectLinkSurvives() {
        let link = WebViewController.shareableURL("https://media.example/19.mp4?token=abc")
        XCTAssertEqual(link?.scheme, "https")
        XCTAssertEqual(link?.host, "media.example")
        XCTAssertEqual(link?.absoluteString, "https://media.example/19.mp4?token=abc")
        XCTAssertEqual(WebViewController.shareableURL("HTTPS://media.example/19.mp4")?.host, "media.example",
                       "大小写不该影响判断")
    }
}
