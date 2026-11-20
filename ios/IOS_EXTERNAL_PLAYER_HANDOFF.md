# 下载完成的视频交给外部播放器：可行性核实（build 23 前置，未实现）

结论先说：在“不许出现系统分享/打开方式面板”这条约束不变的前提下，**没有任何公开、可靠的办法**
能把 App 沙盒里的本地视频**自动**交给 VLC / Infuse / nPlayer / SenPlayer 这类外部播放器离线播放整集。
这不是 SenPlayer 一家的问题，iOS 的文件沙盒对所有 App 一视同仁。
唯一稳定可行的是**系统文档交接**（“打开方式 / 分享”面板）：由系统把文件复制进目标 App，需要用户点一下，
也就是当前被禁止的那个面板。要往前走，只需要改这一条约束。

## 一、四种候选办法，逐个核实

| 办法 | 能否离线播整集 | 能否不经过系统面板 | 结论 |
| --- | --- | --- | --- |
| URL scheme 传 file:// 给我们沙盒里的文件 | 理论可以 | 可以跳转 | **不行**：目标 App 读不到我们容器的路径 |
| URL scheme 传原始 https 片源 | 不行（要联网） | 可以跳转 | 能用，但不是“下载完成离线播放” |
| 系统文档交接（Open-in / 分享面板） | 可以 | 不行，必须用户点一下 | **唯一可靠**，但被当前约束禁止 |
| 127.0.0.1 本地 HTTP 服务供片 | 可以 | 可以 | **不行**：切到别的 App 后我们被挂起，供不了整集 |

## 二、为什么 file:// 一定读不到（与具体播放器无关）

- Apple 的平台安全文档写明：每个 App 运行在自己的沙盒里，有独立的 home 目录，读别的 App 的数据只能通过
  iOS 明确提供的系统服务：https://support.apple.com/guide/security/ （App security / sandbox 章节）
- 所以 senplayer://…?url=file:///var/mobile/Containers/Data/Application/<我们的UUID>/… 这类地址，
  即使 scheme 被接收，目标 App 打开时也会因为无权访问而失败。VLC、Infuse、nPlayer 同理。
- 也不能把文件写进别人的容器，也没有 App Group（那要同一个开发者团队）。

## 三、URL scheme 本身是公开的，但只解决“跳转”，不解决“给文件”

- VLC 官方 wiki（已抓取核实）有“Integration with third party apps”一节，写着
  vlc-x-callback://x-callback-url/ACTION?url=...&PARAMETER=...，ACTION 支持 stream / download：
  https://wiki.videolan.org/Documentation:IOS/
  同一页的 Share 按钮说明也明确：交给他方 App 依赖对方支持，本质是系统分享。
- Infuse 官方支持页有 Universal URL Scheme 条目（infuse://x-callback-url/play?url=），
  页面正文由脚本渲染，本次没抓到可引用的正文；只能算“有 scheme、传的是 URL”，同样绕不开沙盒。
- nPlayer 的 nplayer-<url> 形式只在第三方源码里见到，没有找到一手文档，不作为依据。
- 结论：scheme 能让我们“跳过去”，但传过去的 file:// 对方读不到；传 https 就退回在线播放。

## 四、系统文档交接为什么是唯一可靠的路

- Apple 的 Document Interaction 文档（已抓取核实）：文档交互控制器会弹出系统菜单，
  其中就有“在另一个 App 中打开”这类选项：
  https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/DocumentInteraction_TopicsForIOS/Introduction/Introduction.html
- OWASP MASTG 的 iOS 文件交换一节也说明：App 之间的文件交换由系统居中，
  文档选择器的导入/导出会把文件**复制进/复制出**沙盒，属于用户主导的操作：
  https://mas.owasp.org/MASTG/0x05d-Testing-Data-Storage/
- 这条路径下，系统把本地文件复制到目标 App 的收件箱，VLC/Infuse 等声明了视频类型的播放器会出现在面板里，
  之后完全离线播放。代价：用户必须在系统面板里点一下目标 App。

## 五、另外两条“不改约束”的退路（都不是 App 内一键跳转）

1. UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace：把下载目录暴露到系统“文件”App，
   用户在“文件”里长按选择 VLC/Infuse 打开。仍然是用户操作，而且入口不在我们 App 里。
2. 在 App 内用 AVPlayer 播放（现在已经有的本地播放），完全不跨 App。

## 六、最小可行方案（等批准后实现）

- 在“我的下载”里，只对**已完成**的集显示一个入口（例如“用其他播放器打开”）。
- 点击后把该集的本地文件 URL 交给 UIActivityViewController / UIDocumentInteractionController，
  由系统弹出“打开方式”面板；用户在面板里选已安装的播放器。无后台服务、无跨沙盒读文件、离线可播。
- 需要改变的约束只有一条：**允许这个系统面板出现**（用户已明确说过要能“用其他播放器播放”，
  这一步就是 iOS 唯一合规的做法）。

## 七、与下载链路的衔接（本仓库现状）

- MediaDownloader.swift 只接受 https 直链的 MP4/M4V/MOV/MKV/TS，.m3u8 直接拒绝，
  下载完成落盘就是一个可播放的单文件（见 MediaDownloader.swift 第 13、146、157 行）。
  所以不存在“HLS 分片要不要合并”的问题，交出去就是一个完整文件。
- 本文只做核实，没有改任何代码，也没有引入分享/打开方式入口。
