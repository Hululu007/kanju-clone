# 下载失败 / 永远排队 —— 根因、证据与验证边界（0.1.19 build 27）

本文件是本任务的续接点：目标、真因、改动、验证到哪一步、还差什么，都写在这里。
Ken 的规则：禁止云端测试/模拟器/XCTest/UI smoke/截图门禁；本地只跑有意义的快速检查 + 最终 packaging-only 编译打包。

## 1. 范围

- 我负责：**部分影视下载直接失败 / 一直排队 / 立即失败**，以及最终整合与唯一一次打包。
- 删除（左滑删除、旧路径迁移、离线播放先停播、文件清理）由开发二负责；`MediaDownloader` / `HLSDownloader`
  这两个共享文件只有我一个写入者，开发二以 commit/patch 交付，由我集成。

## 2. 真因（附证据，不把假说当结论）

### 2.1 整文件下载与 HLS 分片发的都不是浏览器的请求

- 代码位置：`MediaDownloader.launch`（整文件 MP4）原来直接 `session.downloadTask(with: url)`，
  没有 Referer、没有 UA，后台会话默认 UA 是 `App名/版本 CFNetwork/...`。
- `HLSDownloader.begin` 原来把 `WebViewController.userAgent`（只有 `ZhuijuAI/<版本> iOS` 这一个令牌）
  当媒体 UA 发给片源 CDN。
- 网页播放器用的是系统 Safari UA + 站点 Referer。片源 CDN 按 UA/防盗链放行，于是**网页能播、App 下载 403**。
- 实测（`ios/scripts/probe_matrix.py`，取站点数据库里判定 `ok` 的真实线路，只打印域名和状态码）：

  | 线路（脱敏） | 无 UA | App 令牌 UA | Safari UA + Referer |
  | --- | --- | --- | --- |
  | svip.xgplay12.com | 403 | 200 | 200 |
  | cdn5.ryplay5.com | 连接被拒 | 200 | 200 |
  | ukzy.ukubf3.com | 000 / 403 | 403 | 403 |
  | sign.site.zshtys888.com（DB 判 ok） | 402 | 402 | 402 |

  结论：UA 是最直接的差异来源；`sign.site…` 这类「当时 ok、现在 402」是令牌过期 —— 失败后必须重新解析地址再试。

### 2.2 取消/删除过的任务会被启动对账「复活」，永久占住并发名额

- `MediaDownloader.reconcile` 原来对上系统里还在的任务时，**无条件**把记录改回 `running`，不看记录是否已经
  `cancelled` / 已删除 / `failed`。
- `URLSessionTask.cancel()` 是异步的：取消后的下一次对账（页面加载、回到前台、切页各调一次 `downloadSync`）
  会把这条记录写回 `running`，而那条任务再也不会发终态回调 → 记录永久 `running`。
- `maxConcurrent = 2`，两个名额被僵尸占住 → 后面的集全部停在「排队中」，杀 App 重开也一样（重启后对账再复活一次）。
- 顺带：系统里对不上任何记录的孤儿任务以前从不 `cancel()`。

### 2.3 没有集号的入队请求被静默丢掉

- `enqueue` 里 `if epKey.isEmpty { continue }`：网页已经先画了一行「排队中」（乐观行），
  原生既没落记录也没发失败事件 → 界面永远排队，实际什么都没下。

### 2.4 取消用的是 `HLSDownloader.pause`

- 分片任务和分片缓存都留着，重启后与本地队列对不上，成为僵尸任务（占名额、占磁盘）。

## 3. 3 部真实样本（来自站点数据库 `sources` 表，脱敏）

> 这是「站点源站侧」的证据（数据库判定 + 源站 HTTP 探测），不是真机下载成功的证据。

| 剧 | 集数 | 站点判定 ok 的线路 | 明确失败的线路（错误域/码） |
| --- | --- | --- | --- |
| 谷雨 | 多线路 | hongniu 20 集、hhzy/ikun/iqiyi/jinying/jszy/mdzy/subo/wsyzy/wujin/xigua/xinlang/zy360 各 3 集 | ffzy 403、niuniu 403、suoni 403、uku 403、dytt 403+fetch_failed、maotai fetch_failed、zuida fetch_failed、yzzy 403 |
| 倾世锦鳞谷雨来 | 24 集（hongniu） | hongniu 24、hhzy/ikun/jinying/jszy/mdzy/subo/wsyzy/wujin/xinlang/zuida 各 3 | bfzy 404、liangzi 404、dytt 403、ffzy 403、niuniu 403、suoni 403、xigua 403、maotai fetch_failed、yzzy 403 |
| 谷雨街后巷 | 多线路 | hongniu 5 集、hhzy/ikun/iqiyi/jszy/maoyan/mdzy/ruyi/subo/wsyzy/wujin/xigua/xinlang/zuida/zy360 各 2 集 | bfzy 404、liangzi 404、dytt 403、ffzy 403、niuniu 403、suoni 403、yzzy 403、dbzy/jinying/maotai fetch_failed |

- 全库统计：`sources` 共 12252 行，`ok` 12183、`http_403` 45、`http_404` 10、`fetch_failed` 14；`kind` 以 HLS 为主（12205）。
- 探针脚本：`ios/scripts/inspect_fail_sources.py`、`ios/scripts/export_samples.py`、`ios/scripts/probe_matrix.py`、
  `ios/scripts/probe_ua.py`（都只读数据库副本，输出脱敏）。

## 4. 改动文件

- `ios/ZhuijuAI/MediaDownloader.swift`
  - 新增 `browserUserAgent` / `appUserAgentToken` / `mediaUserAgent` / `mediaRequestHeaders(from:)`；
  - `launch`：整文件下载改成带 Referer + 浏览器 UA 的 `URLRequest`（续传分支保留 `withResumeData`）；
  - `enqueue`：缺集号 → 落一条 `failed` 记录并给出原因，不再静默丢；
  - `reconcile`：防重入；只接管 `queued/running` 且未删除的记录，终态记录的任务与孤儿任务一律 `cancel()`；
    清掉遗留的 HLS 僵尸 job（`HLSDownloader.discardZombies`）；
  - 取消/全部取消：`HLSDownloader.discard`（连分片缓存），暂停仍用 `pause`；
  - `fail`：失败/取消时丢弃该集的 HLS 分片缓存与进度节流状态。
- `ios/ZhuijuAI/HLSDownloader.swift`
  - 媒体 UA 走 `MediaDownloader.mediaUserAgent`（只有网页给的是真浏览器 UA 才照用）；
  - 同一 id 换清单地址时先丢旧分片缓存；重启对账时把「记录还在下但没拿到后台回调」的 job 重新 `pump`。
- `ios/ZhuijuAI/WebViewController.swift`
  - 网页 `didFinish` 后把真实 `navigator.userAgent` 交给下载器；
  - 单集/批量入队的 `meta` 补 `userAgent` 与兜底 `Referer`（页面 origin）。
- `ios/ZhuijuAI/AppBootstrap.js`
  - 失败格显示「失败 · 点一下重试」（点格子重新解析 `/api/play` 再入队）。
- `ios/Tests/downloadFailure.test.mjs`（新增 10 条源码守卫：UA/Referer、对账、暂停续传、代次作废等）。
- `ios/REGRESSIONS.md`：REG-029（本问题）、REG-030（删除线，开发二）、REG-031（夹具 40GB）。

**审核第一轮两项（已修）**：暂停中的 HLS job 被 `discardZombies` 当僵尸清分片缓存；同一 id 换清单后旧的清单/密钥/分片回调
会写进新任务。现在暂停 job 只停调度、缓存留存，重启后按记录恢复暂停态；每次开始/丢弃/失败/合成完成换代次，
所有异步回调都带代次校验。

**集成**：开发二删除线 `fix/ios-del-record`（4712d53、241fc6f）已合入本分支；共享文件以本分支为唯一写入者，
REG-029/030/031 三段都保留。

## 5. 本地验证（真实输出）

- `python C:\Users\kenzh\hark_tasks\memcap.py 2048 bash -c 'node --test Tests/*.test.mjs'` → 本分支初版 **112/112 通过**；
  整合删除线与审核修复后 `cd ios && python C:/Users/kenzh/hark_tasks/memcap.py 2048 node --test Tests/*.test.mjs` → **126/126 通过**，
  全程 2GB 硬上限内，没有 `[memcap]` 触发。
- 单跑 `Tests/downloadFailure.test.mjs` → **10/10 通过**（含暂停对账与回调代次两条新守卫）。
- 关于 Hark 报告的 40GB：已定位到**未提交草稿版 + 一条必然失败的断言**，Node 断言展开夹具 DOM 的双向引用导致指数膨胀；
  夹具已改成单行 inspect 摘要并加回归，草稿版上复测 52ms 内普通失败、512MB 也不 OOM。证据见 `ios/DOWNLOAD_TEST_MEMORY_20261120.md`。
  所有测试/脚本继续一律套 memcap 2048。

## 6. 待真机验收矩阵（新包安装后）

| 项 | 步骤 | 期望 |
| --- | --- | --- |
| UA/Referer 修复 | 谷雨 / 倾世锦鳞谷雨来 各下一集（HLS） | 不再是 403，进度条前进 |
| 失败可读可重试 | 找一部已知失败线路的剧，点下载 | 明确失败原因；格子显示「失败 · 点一下重试」，点一下重新解析再下 |
| 取消不卡队列 | 下一部 3 集，取消第 1 集 | 第 2/3 集继续动，不卡「排队中」 |
| 杀 App 重开 | 下到一半杀掉 App 再打开 | 队列接着下，不从头、不僵尸 |
| 删除后队列 | 删掉正在下的一集 | 队列继续，无复活记录 |
| 离线播放 | 已下载完成的一集 | App 内直接播 |

## 7. 合并与打包记录（2026-11-21）

- 合并：`4f1b14f`（main，build 26）→ `ce927cc`（main，build 27），快进合并，无中间版本进 main。
  打包的 commit 就是 `ce927cc041872ef68fc7a17f31ae05fb2a0ad4c0`。
- build 号只加一次：`ios/project.yml` 的 `CURRENT_PROJECT_VERSION` 26 → 27；
  打包工作流 `ios-ipa-only.yml` 里的版本断言同步改为 27。
- 打包 run：[44773625470](https://github.com/kenzhao11/kanju-clone/actions/runs/44773625470) —— **只编译打包**，没有云端测试/模拟器/UI 冒烟。
  失败的 44773256147 是把 commit SHA 填进 `code_ref` 导致的 checkout 失败，与代码无关。
- 产物：`ZhuijuAI-0.1.19-build27-unsigned.ipa`，4 514 877 字节，
  sha256 `8a73b7ca9171e1866a95fb1998729cdfd1910eafdb118cdada41ac63614c8320`，
  已放 `C:\Users\kenzh\Desktop\`。
- 审核：下载队列线「审核开发」通过（`4f1b14f..dfd97ee`）；删除线「审核开发二」通过（`4f1b14f..241fc6f`）；
  整合版「审核开发」通过（含暂停分片保留、回调代次、删除线整合）。
- 真机项仍未验收（见第 6 节），需 Ken 安装 build 27 后测。
