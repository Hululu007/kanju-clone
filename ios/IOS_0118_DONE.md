# 追剧AI iOS build25：真实 HLS 整集下载（待审核、未出包）

分支：`fix/ios-0.1.19-build25-hls`
版本：`0.1.19` / build `25`（`ios/project.yml` 与 `.github/workflows/ios-ipa-only.yml` 的断言都已改成 25）

这份只写 build25 的改动。build24 的「下载唯一数据源、删除墓碑、立即入队、全屏修复、首页无齿轮、外部播放器入口」都保持原样。

## 一、根因（大白话）

站上真实线路给的是 **HLS**：一个 `.m3u8` 清单，里面是几十上百个几秒钟的小分片，而不是一整个 MP4 文件。
但下载链路两头都把 HLS 当成「不能下」：

1. **网页先拒**：`resolveEpisodeUrl` 看到 `kind === 'hls'` 或地址以 `.m3u8` 结尾，直接返回
   「HLS 分片线路，不能整集下载」，连入队消息都不发。
2. **原生再拒**：就算消息发过去，`MediaDownloader.rejection` 也会把 `.m3u8` 打回，只认 https 的 MP4 直链。
3. **以前的验证测错了对象**：之前「下载通过」用的都是 DEBUG 受控源（127.0.0.1 回环 MP4），
   跟站上真实 HLS 线路不是一回事，所以这条缺口一直没暴露。

所以用户点下载等于什么都没发生 —— 不是队列不跑，是**根本进不了队列**。

## 二、这次怎么改

- **网页**：`kind=hls` 或以 `.m3u8` 结尾的线路照常入队，并把 `kind: 'hls'` 和页面 `referer` 一起交给原生；
  MP4 直链还是原来的整文件下载。
- **清单解析**（新文件 `ios/ZhuijuAI/HLSManifest.swift`，纯解析、不联网）：
  - 主清单按 `BANDWIDTH` 挑最高一路，带宽相同再看 `RESOLUTION`；
  - 媒体清单读 `#EXTINF` 时长、`#EXT-X-MEDIA-SEQUENCE`、`#EXT-X-KEY`、`#EXT-X-MAP`、`#EXT-X-BYTERANGE`、`#EXT-X-ENDLIST`；
  - 相对地址按清单地址解析；分片 URI 没带 query 时继承清单自己的 query（CDN 的 token 常挂在清单上，不继承就 403）。
- **分片下载与合成**（新文件 `ios/ZhuijuAI/HLSDownloader.swift`）：
  - 分片走单独一条后台会话（`org.dpdns.zhuiju.ios.hls`），并发最多 4 条，每片失败最多重试 3 次；
  - 每片请求都带 Referer / User-Agent（和网页播放同一个来源），`EXT-X-BYTERANGE` 用 Range 头取；
  - AES-128 用 CommonCrypto 解密（PKCS7），IV 没写时按媒体序号补；
  - fMP4 合成 `.mp4`（初始化段排最前），纯 TS 合成 `.ts`，写进 `Documents/Downloads` 后走原来的「完成」路径；
  - 遇到 SAMPLE-AES / DRM 线路直接失败并说明原因，不假装能下。
- **进度**：已下好的分片按字节汇总，再按「已完成时长 / 总时长」折算总量上报，
  网页算出来的百分比就是「已完成的分片 / 总片数」，长剧集不会因为一两个大分片提前跳到 100%。
- **中断恢复**：任务状态、分片清单、已经下好的分片都持久化在缓存目录；
  暂停只停任务、删除才清缓存；App 被系统回收后重新拉起会接着下，不从 0 重来；
  用户暂停/删除造成的取消不算分片失败，也不消耗重试次数。

## 三、改了哪些文件

- `ios/ZhuijuAI/HLSManifest.swift`（新增）：主清单/媒体清单解析、变体选择、相对地址与 query 继承、AES key/IV、EXT-X-MAP、BYTERANGE。
- `ios/ZhuijuAI/HLSDownloader.swift`（新增）：分片后台会话、并发/重试、Referer/UA/Range、AES 解密、fMP4/TS 合成、进度、恢复、暂停/删除。
- `ios/ZhuijuAI/MediaDownloader.swift`：放行 HLS 清单；`launch` 分流到分片下载器；新增 `hlsProgress` / `hlsComplete` / `hlsFail`；暂停/取消/删除/重启对账接上 HLS。
- `ios/ZhuijuAI/AppBootstrap.js`：`resolveEpisodeUrl` 接受 HLS 并返回 `kind`；入队项带 `kind` 和 `referer`。
- `ios/ZhuijuAI/WebViewController.swift`：把 `kind` / `referer` 放进原生 meta；`.ts` 文件 App 内播不了时收起播放器并提示改用「用其他播放器打开」。
- `ios/ZhuijuAI/AppDelegate.swift`：接住 HLS 那条后台会话的回调。
- `ios/project.yml`、`.github/workflows/ios-ipa-only.yml`：版本号/build 断言改成 25（只打包，不跑云端测试）。
- `ios/Tests/hlsDownload.test.mjs` + `ios/Tests/Fixtures/hls/*.m3u8`（新增）、`ios/Tests/bootstrap.test.mjs`（把「拒绝 HLS」那条旧用例改成「HLS 交给原生」）、`ios/REGRESSIONS.md`（新增 REG-027）。

## 四、本地验证（本轮实际跑过的）

- `node --check ios/ZhuijuAI/AppBootstrap.js`：通过（日志 `C:\Users\kenzh\AppData\Local\Temp\build25-logs\node-check.log`）
- `node --test ios/Tests/*.test.mjs`：100/100 通过（日志 `C:\Users\kenzh\AppData\Local\Temp\build25-logs\node-test.log`）
- **Windows 本机没有 Xcode/Mac，也没有 Swift 工具链**：新增的两个 Swift 文件**没有本地编译**，
  只能靠 packaging-only 的 GitHub Actions 编译兜底；Node 用例只钉源码守卫和夹具结构，不等于 Swift 跑过。

## 五、真实线路验证：没做（不编造）

站点 `/` 与 `/api/play` 都需要访问口令，手上没有凭据，因此下面这条**没有完成**：

| 要求 | 状态 |
| --- | --- |
| 两部不同来源的剧，各下完一集 | **未验证**（站点被口令挡住，拿不到真实 m3u8 与密钥） |
| ffprobe 核对时长/音视频流，记录剧名/集/大小/时长 | **未做**（同上） |

本机装了 ffmpeg/ffprobe 8.0.1，一旦拿到可访问的线路就能直接核。
**没有用回环源或自造样本冒充真实验收。**

## 六、已知限制（如实写）

1. **纯 TS 分片**：合成出来是 `.ts`，iOS 系统播放器（AVFoundation）不支持 MPEG-TS，App 内点开会被收起并提示
   改用「用其他播放器打开」。fMP4 线路合成 `.mp4`，App 内可以正常离线播放。
2. **锁屏/后台**：分片传输本身能由系统后台会话继续；但**解密与合成必须在 App 进程里做**，
   进程被挂起时这一步会停下，回到前台继续（已下好的分片不重下）。没有做静音音频保活，也不声称锁屏期间能完成合成。
3. **DRM**：SAMPLE-AES 等加密线路明确拒绝，不做破解。
4. **真机未测**：真实 HLS 线路的解析、AES 解密、fMP4/TS 合成、切后台续下、完成后播放，全部待 Ken 安装 build25 后验证。

## 七、出包前清单（源码证据，真机未测）

- A 下载（本轮改动面）：网页只拦 blob:/网页地址；HLS 入队带 kind/referer；原生放行清单并分流到分片下载器；
  进度按分片折算；删除清缓存；暂停/重启接着下。Node 100/100 通过。真机未测。
- B 全屏：本轮没改全屏状态机；只在本地播放里加了「打不开就收起并提示」。
- C 首页无齿轮 / 仅网站播放器：本轮没改相关代码，原有 Node 断言仍全过。
- D 账号组与菜单：本轮没改账号/设置菜单，也没有加回讨论、反馈、等级、P2P、内容偏好、我的用量、全部下载。

**真机待办**：build25 出包并放到桌面后，等 Ken 安装确认，再由 Lead 派手机测试；测试前先核对 build 25。
