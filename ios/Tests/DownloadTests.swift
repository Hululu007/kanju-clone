import XCTest
@testable import ZhuijuAI

/// 下载落盘前的两道纯逻辑：文件名清洗与目录。
/// 真机才能验证的部分（进度、取消、写盘）不在这里冒充验证过。
final class DownloadTests: XCTestCase {
    func testFileNameKeepsTheEpisodeNameFromTheUrl() {
        let name = MediaDownloader.fileName(
            from: "https://media.example/19.mp4?token=abc",
            fallback: "video.mp4"
        )
        XCTAssertEqual(name, "19.mp4")
    }

    func testFileNameFallsBackWhenTheUrlHasNoExtension() {
        XCTAssertEqual(MediaDownloader.fileName(from: "https://media.example/play/19", fallback: "追剧AI.mp4"), "追剧AI.mp4")
        XCTAssertEqual(MediaDownloader.fileName(from: nil, fallback: "追剧AI_第19集.mp4"), "追剧AI_第19集.mp4")
        XCTAssertEqual(MediaDownloader.fileName(from: "https://media.example/", fallback: ""), "video.mp4")
    }

    func testFileNameStripsPathSeparatorsAndControlCharacters() {
        let name = MediaDownloader.fileName(from: "https://media.example/a%2Fb%5Cc%3Ad.mp4", fallback: "x")
        XCTAssertFalse(name.contains("/"), "路径分隔符不能带进沙盒目录")
        XCTAssertFalse(name.contains("\\"))
        XCTAssertFalse(name.contains(":"))
        XCTAssertTrue(name.hasSuffix(".mp4"))
    }

    func testFileNameAddsAVideoExtensionWhenTheUrlIsNotAVideo() {
        let name = MediaDownloader.fileName(from: "https://media.example/19.m3u8", fallback: "x")
        XCTAssertEqual(name, "19.m3u8.mp4", "分片清单即使被下载也不该冒充视频文件")
    }

    func testDownloadDirectoryIsInsideTheSandbox() {
        let directory = MediaDownloader.directory()
        XCTAssertNotNil(directory)
        XCTAssertTrue(directory?.path.contains("Downloads") == true)
    }
}
