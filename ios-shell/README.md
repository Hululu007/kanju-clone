# ios-shell — 追剧AI H5 外壳

整屏一个 `WKWebView` 加载 <https://zhuiju.dpdns.org>。功能全部在网页里，这个 App 只提供外壳能力，
用来验证「H5 + 少量原生外壳」能不能替代 `ios/` 里的原生实现。

- App 名：追剧AI H5（`CFBundleDisplayName`）
- Bundle id：`org.dpdns.zhuiju.h5`（原生包是 `org.dpdns.zhuiju.ios`，两个可以同时装）
- 版本：0.1.0 (1)

## 外壳能力

| 能力 | 实现位置 |
| --- | --- |
| 内联播放、无需手势即可出声、画中画、AirPlay | `ZhuijuH5/WebViewController.swift` 的 `WKWebViewConfiguration` |
| 后台音频 | `Info.plist` 的 `UIBackgroundModes: audio` + `AppDelegate` 的 `AVAudioSession .playback` |
| 左右边缘滑动返回/前进 | `allowsBackForwardNavigationGestures` |
| 下拉刷新 | `webView.scrollView.refreshControl`（回弹打开） |
| 站外链接走 Safari | `WKNavigationDelegate` / `WKUIDelegate` |
| 深色底，无白闪 | window/WebView 黑底 + 文档开头注入的底色脚本 |
| 尊重安全区 | WebView 约束到 `view.safeAreaLayoutGuide` |
| 离线错误页 + 重试 | `offlineView` + `retryButton` |
| API 同源改写、横屏播放器布局 | `ZhuijuH5/AppBootstrap.js`（文档开头注入） |

`AppBootstrap.js` 直接移植自 `android/app/src/phone/assets/app-bootstrap.js`：把发往
`kanju-api.kenzhao123.workers.dev` 的 `/api` 请求改写成同源请求，并在横屏播放时给
`html[data-app-landscape]` 打补丁。iOS 原生支持 HLS，所以没有 hls.js。

## 本地构建

```bash
brew install xcodegen
cd ios-shell
xcodegen generate
open ZhuijuAIH5.xcodeproj
```

回归测试（不依赖 Xcode，纯 Node）：

```bash
node ios-shell/Tests/bootstrap.test.mjs
```

## CI

`.github/workflows/ios-shell-unsigned.yml`：`macos-15` 上跑上面的 Node 回归 → XcodeGen 生成工程 →
Release 无签名构建 → 打包成 `ZhuijuAI-H5-0.1.0.ipa`（artifact `ZhuijuAI-H5-unsigned-ipa`）。
只在 `ios-shell/**` 变更或手动触发时运行，不碰 `ios-unsigned.yml`。
