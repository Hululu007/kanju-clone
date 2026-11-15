# 追剧 AI iOS 客户端

独立的 Swift 工程，用 WKWebView 加载 `https://zhuiju.dpdns.org/`，复用现有账号、片源和观看进度后端。最低支持 iOS 14。

## 已实现

- 登录 Cookie、`localStorage` 与观看进度持久化。
- 同域 API 重写：把 `kanju-api.kenzhao123.workers.dev` 的接口请求转到站点域名，并补齐 `AbortSignal.timeout`。
- 随包内置 hls.js 1.5.17，播放页不再依赖 jsdelivr；iPhone 走原生 HLS，支持 MSE 的设备使用内置播放器。
- 1／1.5／2／2.5／3 倍速记忆，播放开始和元数据加载时自动应用。
- 横屏、原生全屏播放、画中画（iOS 14.2+）、返回手势。
- `target="_blank"` 站内链接在应用内打开，站外 HTTPS 链接交给 Safari。
- 页面加载失败时显示重试界面；网页弹窗改用原生对话框。

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
