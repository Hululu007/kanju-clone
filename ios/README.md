# 追剧 AI iOS 客户端

独立的 Swift 工程，用 WKWebView 加载 `https://zhuiju.dpdns.org/`，复用现有账号、片源和观看进度后端。审查修复版 0.1.1 最低支持 iOS 15，因为站点的模块使用顶层 await。

## 已实现

- 登录 Cookie、`localStorage` 与观看进度持久化。
- 同域 API 重写：把 `kanju-api.kenzhao123.workers.dev` 的接口请求转到站点域名，并补齐 `AbortSignal.timeout`。
- 随包内置 hls.js 1.5.17，支持系统 HLS 时通过 NativeHls 兼容层优先使用系统解码，不依赖 jsdelivr。
- 1／1.5／2／2.5／3 倍速记忆，播放开始和元数据加载时自动应用。
- 横屏、原生全屏播放、画中画（iOS 14.2+）、返回手势。
- `target="_blank"` 站内链接在应用内打开，站外 HTTPS 链接交给 Safari。
- 页面加载失败时显示重试界面；网页弹窗改用原生对话框。
- 片源返回必须与选中的影片、索引、集数一致且 verified=true，只接受无账号密码的 HTTPS 片源地址。
- 新的选集或切线操作取消旧的解析请求；加载完成后再次触发播放，避免首次 play 早于媒体就绪。
- 网站访问门 401 单独跳回网站访问密码页，不交给账号模块清空账号缓存。
- 横屏播放时展开播放器并保留线路和显示设置；网页画中画按钮接入 WebKit presentation mode。

## 回归验证

本地运行 `node ios/Tests/bootstrap.test.mjs`，覆盖请求头与请求体保留、访问门与账号过期区分、错误片源拒绝、异步响应竞争、后台状态和存储异常。

云端生成八秒的测试视频与 HLS 清单，再运行 XCTest/WKWebView 测试。测试必须通过后才生成 IPA。测试媒体仅进入测试 bundle，正式 App 不包含这些样本。

模拟器中的 MP4/HLS 解码不等于实体 iPhone 和家庭网络验收；测试请求夹具也不能证明真实账号服务与所有 CDN 在设备上可用。

## 本地生成工程

需要 macOS 与 Xcode。安装 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 后：

```bash
cd ios
xcodegen generate
open ZhuijuAI.xcodeproj
```

真机调试需要在 Signing & Capabilities 选择自己的 Team，并把 Bundle Identifier 改成未被占用的标识。

## 云端构建未签名 IPA

仓库内的 `.github/workflows/ios-unsigned.yml` 会在 `macos-15` 上安装 XcodeGen、编译 Release 真机包并上传 `ZhuijuAI-unsigned.ipa`。

推送到 GitHub 后，在 Repository → Actions → **Build unsigned iOS IPA** → Run workflow。完成后在运行记录的 Artifacts 下载压缩包。

构建使用 `CODE_SIGNING_ALLOWED=NO`，产物不能直接安装，需要本地签名。

## iPhone 安装

### 方式一：Sideloadly

1. Windows 安装 iTunes（Apple 官网版本）和 [Sideloadly](https://sideloadly.io/)。
2. 数据线连接 iPhone，解锁并信任电脑。
3. 把 `ZhuijuAI-unsigned.ipa` 拖入 Sideloadly，输入自己的 Apple ID。
4. 按提示开启开发者模式（iOS 16+：设置 → 隐私与安全性 → 开发者模式）。
5. 免费账号的描述文件 7 天到期，到期后重新签名安装。

### 方式二：AltStore Classic

1. Windows 安装 Apple 官网 iTunes 与 iCloud，再安装 [AltServer](https://altstore.io/)。
2. 用 AltServer 把 AltStore 安装到 iPhone，并在 iPhone 设置中信任描述文件。
3. 把 IPA 传到 iPhone“文件”App，在 AltStore → My Apps → 左上角 + 选择该 IPA。
4. AltStore 会使用你的 Apple ID 签名；保持 AltServer 可连接时可自动续签。

Apple 账号密码与验证码只在安装工具中输入，不要写进仓库或脚本。

## 验证边界

云端构建只能证明工程可编译。以下项目仍需 iPhone 真机验收：站点访问密码、账号密码登录、搜索、选集与线路切换、HLS 播放、横屏全屏、倍速、画中画、断点续看。Windows 无法运行 iOS 模拟器或真机调试。
