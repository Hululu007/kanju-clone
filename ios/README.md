# 追剧 AI iOS 客户端

独立的 Swift 工程，用 WKWebView 加载 `https://zhuiju.dpdns.org/`，复用现有账号、片源和观看进度后端。修复版 0.1.8（build 9，包含 0.1.7 单集直链修复和本轮冷启动绘制优化）最低支持 iOS 15，因为站点的模块使用顶层 await。

## 已实现

- 登录 Cookie、`localStorage` 与观看进度持久化。
- 同域 API 重写：把 `kanju-api.kenzhao123.workers.dev` 的接口请求转到站点域名，并补齐 `AbortSignal.timeout`。
- 随包内置 hls.js 1.5.17，支持系统 HLS 时通过 NativeHls 兼容层优先使用系统解码，不依赖 jsdelivr。
- 1／1.5／2／2.5／3 倍速记忆，播放开始和元数据加载时自动应用。
- 全屏与横屏：底部控制栏右端是「全屏」，进入后播放器铺满整屏（竖屏也铺满，横屏去掉安全区黑边），并由原生层锁横屏、隐藏状态栏与底部小白条；退出时恢复竖屏。播放中转到横屏也会自动进入沉浸模式。全屏时上方那排「显示设置/线路/弹幕/画中画/下一集」整条收起，只留底部控制栏（播放 · 进度 · 外放 · 倍速 · 退出全屏）。
- 滚动稳定性：弹幕动画改用 transform（不再逐帧布局）、固定顶栏/底栏在 App 内不再每帧重算模糊、提示行固定两行高度（提示只走悬浮 toast，不再推动下方内容）、横滑条取消平滑滚动。
- 浅色主题：底栏图标与文字、全屏工具条都按主题切换深色文字，不再白底白字。
- 分类卡片横排时按卡片实际宽度排布，「更新至第 N 集」不再被列宽挤压、重叠。
- 搜索：请求携带输入框关键词（站点 `proxyList` 漏传 `q` 时由客户端补齐，不替换接口）。
- `target="_blank"` 站内链接在应用内打开，站外 HTTPS 链接交给 Safari。
- 页面加载失败时显示重试界面；网页弹窗改用原生对话框。
- 片源返回必须与选中的影片、索引、集数一致且 verified=true，只接受无账号密码的 HTTPS 片源地址。
- 新的选集或切线操作取消旧的解析请求；加载完成后再次触发播放，避免首次 play 早于媒体就绪。
- 网站访问门 401 单独跳回网站访问密码页，不交给账号模块清空账号缓存。
- 网页画中画按钮接入 WebKit presentation mode。
- 外放：底部「外放」弹出三项——分享播放地址（原生分享面板，标准 `public.url` + 链接元数据）、复制播放地址、下载本集。只接受 https 直链；`blob:`/MSE 加密流、HLS 分片一律如实拒绝并说明原因。不引入第三方 SDK，也不需要额外登录。
- 选集区标签（选集/投屏/讨论/反馈）支持横滑切页（横向位移明显压过纵向才算），注入层与站点层不会重复响应同一次滑动。
- 账号状态：侧栏用户名与成长卡片来自同一来源，登录后不会再一半用户名一半「游客账号」。
- 下载：仅登录后可点。未登录点下载只弹登录提示，不发任何请求。登录后用当前可用的 https 直链、一次一集、原生 URLSession 落盘到 `Documents/Downloads`，控制栏显示百分比、可取消、失败给原因；下载完成后可「用其他播放器打开」，把本地文件交给系统应用列表（播放器 App 能出现的方式）。
- 媒体地址只有一个来源：`currentSrc` / `src` / `<source>` 原始属性，只认 http(s) 且排除页面地址；同一集内记住最后一次真实见过的片源（换集即失效），元素被重建也不会把已播过的一集判成「没解析出直链」。菜单说明与点击提示来自同一个函数：先判登录，再判地址，再判分片。
- User-Agent 里的版本号取自 `CFBundleShortVersionString`，不再手写（`VersionTests` 钉住）。
- 0.1.7：iOS 取得并校验播放直链时同步记入当前集媒体状态，HLS 在 WebKit 内转为 `blob:` 后下载/分享仍识别为已解析；换集或换线路时清除旧直链。选集标签明确允许纵向滚动并由注入层识别横向手势，取消手势时清空状态；旧版及 WebKit 原生全屏按钮均强制隐藏。
- 0.1.8：减少冷启动滚动期间 WKWebView GPU 合成压力：深色与浅色静态背景放在根视图，移除两个全屏 fixed 背景伪元素；海报卡片取消无触屏 hover 的合成隔离与过渡。单集电影索引 `0` 的直链状态保留修复。SenPlayer 继续通过标准 iOS URL 分享/本地视频文件分享交付；没有加入未经证实的私有 URL scheme。

## 回归验证

本地运行 `node --test ios/Tests/*.test.mjs Tests/*.test.mjs`（60 项），覆盖请求头与请求体保留、访问门与账号过期区分、错误片源拒绝、异步响应竞争、后台状态、存储异常，以及 0.1.2~0.1.8 新增的控制栏（全屏在进度条右端、倍速到 3×）、全屏隐藏与恢复所有浮层控件、外放菜单（分享/复制/下载）、未登录不下载、下载进度与取消、直链状态（含无选集按钮的单集电影）、元素重建后仍认得出已播过的一集、两处品牌图、浅色主题与分类卡片兜底样式、选集卡片不压字、播放失败不再静默、搜索关键词、首页日期条（幂等停靠、后台刷新后回到用户位置）、标签横滑与取消手势恢复、账号文案一致（不再同时出现游客与用户名）、弹幕 transform 动画与滚动面去模糊。XCTest 侧另有 `ShareTests`（https 白名单）、`DownloadTests`（文件名清洗、沙盒目录）与 `VersionTests`（UA 版本等于包版本）。

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

## 图标

`scripts/appicon-source.png` 是设计稿，跑 `powershell -File scripts/make-icon.ps1` 会去掉外圈白边并生成 1024×1024、无透明通道的 `AppIcon-1024.png`（iOS 会自己裁圆角，图标本身不能带白边或 alpha）。

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
