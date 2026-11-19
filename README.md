# 看剧 AI · 站点复刻（kanju32 前端 + 自建片库）

复刻 [kanju32.com](https://kanju32.com/) 的界面与信息架构，并把「后端影视数据库」这一层自己补齐：
片库元数据来自原站公开接口（通过逆向还原的签名算法访问），播放线路在播放时现场解析。

- 站点（GitHub Pages）：https://kenzhao11.github.io/kanju-clone/
- 源码（本仓库）：静态前端 + 采集/解析工具链

> 说明：本站只保存片名、简介、海报地址等元数据，不存放、不转存任何视频文件；
> 播放时由本地片源服务向线上线路换取一次性直链。
> 片库里有一部分是原站的会员片源（匿名取不到地址），这些条目卡片上会标「需会员」，
> 首页另有「打开就能播」一栏只放免登录可取的片子。仅供个人学习与测试使用。

## 两个部分

| 部分 | 作用 | 部署 |
| --- | --- | --- |
| 前端站点 `src/` + `dist/` | 首页、分类、搜索、详情、播放器、历史、片单 | GitHub Pages（纯静态） |
| 片源服务 `server/proxy.mjs` | 现场解析某一集的播放直链、读写播放进度 | 本机 `node server/proxy.mjs` |

静态站点里的直链会过期，所以播放时前端会先问本地片源服务要一条新直链；
片源服务没启动时退回打包进站点的缓存直链。

## 快速开始

```bash
npm install

# 1) 采集片库（写入 server/data/kanju.db）
npm run crawl              # 可加 LIMIT=500 CONCURRENCY=6 控制规模

# 2) 摸一遍哪些片子是公开可播的（有些是原站会员片）
npm run resolve

# 3) 导出成前端数据
npm run export             # 生成 src/catalog.gen.js

# 4) 起片源服务（另开一个终端常驻）
npm run proxy              # http://127.0.0.1:8899

# 5) 本地看效果
npm run dev                # http://localhost:5173
```

想换片源服务地址：在浏览器控制台执行
`localStorage.setItem('kj-proxy', 'http://你的地址:8899')`，或在构建时设 `VITE_PROXY_BASE`。

## 部署到 GitHub Pages

```bash
bash scripts/deploy.sh     # 构建 dist 并推到 gh-pages 分支
```

Pages 已指向 `gh-pages` 分支根目录，推送后一两分钟生效。

## 接口一览

片源服务（本机 8899，CORS 全开）：

| 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 服务状态与库内数量 |
| `GET /api/list?cat=tv&q=&page=1&limit=24` | 分类/搜索列表 |
| `GET /api/show?id=av_xxx` | 详情 + 分集（不含直链） |
| `GET /api/play?show=av_xxx&ep=0` | 现场解析该集直链（90 秒缓存） |
| `GET/POST /api/progress` | 播放进度读写 |

原站契约（`server/kanju-client.mjs` 已封装）：

- 签名：`HMAC-SHA256(secret, METHOD\npath?query\ntimestamp\nnonce)`，写在 `x-ai-movie-*` 头里
- `GET /v1/runtime/bootstrap`、`/v1/announcements/manifest`、`/v1/feed/home`
- `GET /v1/browse/catalog?scope=public&sort=heat_desc&limit=20&kind=series&page=N`
- `GET /v1/catalog/:id`、`GET /v1/catalog/:id/episodes?limit=48&offset=0`
- `GET /v1/playback/resolve/:episode_token?view=compact` → `line_options[].url = resolve://<ticket>`
- `POST /v1/playback/resolve-line {ticket}` → `line.url`（一次性 CDN 直链）

## 目录结构

```
server/
  kanju-client.mjs   签名 + 请求封装（限速、重试）
  kanju-crawl.mjs    采集：目录分页 → 详情 → 分集 → 可选解析直链
  kanju-resolve.mjs  逐片试播，标出「公开可播 / 需会员」
  kanju-export.mjs   SQLite → src/catalog.gen.js
  proxy.mjs          片源服务（现场解析直链）
src/
  data.js            片库数据层（分类、周历、榜单、搜索）
  runtime.js         片源服务探测与现场解析
  pages/             首页 / 播放 / 历史 / 片单 / 下载 / 会话
scripts/deploy.sh    构建并推送 gh-pages
```

## 主题

侧栏顶部有「深色 / 白色 / 自动」三段切换（手机端顶栏右侧的太阳/月亮按钮可循环切换）：

- 白色主题是完整的一套浅色配色（白底、白卡片、深色文字），不是简单反色；播放器视频区保持深色，海报上的白色文字不动
- 默认仍是「深色」；选择会记在 `localStorage.kj-theme-mode`
- 「自动」跟随系统 `prefers-color-scheme`，系统切换时实时生效
- 想临时预览/分享某一主题：在地址后加 `?theme=light`、`?theme=dark` 或 `?theme=auto`

## 集数一致性核验（重要）

「第 N 集」必须对上原站的第 N 集，做法有三道保险：

1. **同一份分集列表**：分集来自原站 `GET /v1/catalog/<id>/episodes?limit=48&offset=N`，按返回顺序写入 `episodes.idx`，
   点击第 N 个按钮 → `/api/play?ep=idx` → 只解析这一行的 `token`；
2. **令牌级比对**：`node tmp_token_audit.js <showId> 2,19`（本仓库外的工作脚本）会打开原站播放页点同名按钮，
   把原站实际用的 token 和本地库里 `number=N` 的 token 做 SHA-256 前缀比对，实测《谷雨》第 2 / 19 集 MATCH；
3. **运行时校验**：`server/proxy.mjs` 的 `playUrl()` 在解析后比对
   `current_episode.episode_number` 与库内 `number`，不一致直接报「集数不一致：请求第N集，原站返回第M集」，绝不串播。

另外：多季综艺/剧集的原站编号会从 1 重新开始，导出时若发现编号不连续 `seqOk=false`，
就改按列表顺序编号（`第1集…`），保证"点的第几集就是列表第几项"。

### 线路串集（实测存在，已从根上封死）

令牌对得上，不代表线路给的视频对得上。实测原站部分 CMS 线路（如 **暴风资源 bfzy**）
会把整部剧的多集都指回同一段视频：`谷雨` 第 1/2/3/4/5/6/7/8/11/12/15 集的第一个分片完全相同。
只看 URL 或 `episode_number` 都发现不了，必须比对**内容**。

现在的做法是内容指纹硬校验：

- 每次播放都会拉真实 `.m3u8`，取**首个分片前 64KB** 做 SHA-1 内容指纹；
- 与库里该剧其它集的指纹比对，撞指纹即判定「该线路串集」→ 立刻拉黑换线，绝不播出；
- `node server/kanju-audit.mjs --show <id> --full` 会把整部剧逐集跑一遍，
  选出一条「全集内容互不相同」的主线路，把每集指纹写进 `sources` 表；
- 之后播放时，实时指纹只要和别的集撞上就直接拒绝，因此不会再出现
  「点第 19 集播第 2 集」。

| 表 | 作用 |
| --- | --- |
| `sources` | 每集 × 每线路：地址、分片数、时长、内容指纹、校验状态 |
| `provider_health` | 每部剧 × 每线路：`ok / dup / empty / dead / member` |
| `provider_baseline` | 第 1 集基准指纹，用于识别「所有集都指向第 1 集」 |

常用命令：

```bash
npm run audit -- --title 谷雨 --eps 1,2,19   # 抽查三条线路的健康度
npm run audit -- --show <id> --full          # 全量校验并选定主线路
npm run audit -- --limit 50                  # 按热度批量体检
```

全量采集（5 个频道，约 5000 部）：

```powershell
$env:FULL='1'; $env:CONCURRENCY='6'; npm run crawl
```

### 官方 1080P 线路（匿名访客会话）

原站默认播放的是「官方 1080P」线路，这类线路是 `resolve://<ticket>`，必须带**匿名访客会话**才能换取真实地址：

- `POST /v1/users/anonymous`，body `{ "anonymous_id": "web_<uuid>" }`
- 返回 `Set-Cookie: ai_movie_session=...`（约 1 年有效）
- 不带 cookie：官方线路返回 401 或只给占位图；带了就是真实 MP4/HLS

客户端已内置该流程（`server/kanju-client.mjs` 的 `ensureGuest()`）：

- 首次播放时自动建会话，cookie 落到 `server/data/guest-session.json`（已 gitignore）
- 会话过期自动重建一次
- 官方线路里的 MP4 常伪装成 `.jpg` / `image/jpeg`，现在按**文件头**（`ftyp`）识别，不再误判为图片

播放排序与原站一致：**官方线路优先**（按原站顺序），官方全部不可用时才回退普通线路。
播放器页新增「线路」选择条，按官方 / 普通分组，可手动切换。

会员限制：原站大量剧集的最新若干集返回 `401 playback_user_session_required`，
匿名拿不到地址，页面会显示「这一集在原站是会员片源」，标着「可播放」的片子可以直接看。

## Cloudflare 后端（Worker + D1）

线上后端：**https://kanju-api.kenzhao123.workers.dev**
D1：`kanju-db`（5,046 部 / 208,412 集 / 12,234 条线路校验）

前端 `src/runtime.js` 默认指向该 Worker，本机 `8899` 只作离线兜底。

账号体系使用账号 + 密码，登录令牌保存在浏览器并通过 `Authorization: Bearer` 访问 Worker。
播放记录和断点进度按用户写入 D1，因此换浏览器或设备登录同一账号即可继续观看；
未登录时仍按当前设备本地保存。密码只保存加盐派生值，不保存明文。

部署 / 同步：

```powershell
cd worker/api
wrangler d1 execute kanju-db --remote --file=schema.sql   # 首次建表
wrangler deploy
'<签名密钥>' | wrangler secret put KJ_SECRET              # 加密 Secret

# 本地库 → D1（INSERT OR REPLACE，可重复执行）
node server/export-d1.mjs
Get-ChildItem worker/api/sql/*.sql | Sort-Object Name | ForEach-Object {
  wrangler d1 execute kanju-db --remote --file=$_.FullName
}
```

接口与原片源服务一致：`/api/health`、`/api/list`、`/api/show`、`/api/lines`、`/api/play`、`/api/audit`、`/api/progress`。

### 上游新内容自动同步

Worker 带 Cron `*/30 * * * *`（每 30 分钟），走 `/v1/browse/catalog?sort=update_desc`：

- 只处理 `updated_at` 变化或新出现的剧（Free 计划单次 10 部、2 页，控制在 50 个子请求内）
- 新剧补详情简介 + 全部分集（最多 8 页 × 48）
- 写 D1 的 `shows` / `episodes`，不动已有的 `description`、`sources`
- 水位线存 `meta.last_sync_at`，回看窗口 3 天；预算用完不推进水位线，下一轮重试

前端首页新增「最新上线」栏（读 `/api/list?sort=updated`），静态片库里没有的新 id
会自动回源 `/api/show`，所以同步进来的新剧可以直接打开播放。

手动触发：

```powershell
# x-sync-key = sha256(KJ_SECRET + ":sync") 的前 16 位
curl -X POST "https://kanju-api.kenzhao123.workers.dev/api/sync?max=20&pages=3" `
  -H "x-sync-key: <key>"
```

> 注意：D1 已是主库。日常增量由 Worker 负责；本地 `kanju.db` 仅用于抓取/审计，
> 不要再把旧本地库整批覆盖回去（会回退 `updated_at`）。

## 手机适配

在 390×844（iPhone 14 尺寸）实测通过：

- 底部悬浮导航不再遮挡正文（`main` 预留 84px + 安全区）
- 播放器固定 16:9，海报 `object-fit: contain`，左上角集数标签不再压住原生控件
- 线路选择按「官方 / 普通」横向滚动，不再撑破版面
- 分集网格手机 4 列、按钮高度 42px；详情信息两列
- 相关推荐、首页卡片在窄屏自动缩小，搜索结果为两列
- 使用 `100dvh` 处理 iOS 地址栏高度变化，`-webkit-text-size-adjust` 防止字号被放大

实测：手机打开《谷雨》第 19 集 → `1080P-官方S`，45 分钟可播；搜索「谷雨」返回 5 条结果。

### 播放倍速

播放器下方新增倍速条：**1x / 1.5x / 2x / 2.5x / 3x**，默认 1x。

- 选择写入 `localStorage`（`kj-speed`），换集、刷新都保持
- MP4 与 HLS 都生效（同一 `<video>` 元素）
- iOS 若把 >2x 钳制为 2x，界面会按真实 `playbackRate` 回显

### 播放增强（对齐原站）

- **画质增强**：一键给 `<video>` 加 `contrast(1.06) saturate(1.08) brightness(1.02)`，
  与原站完全一致；状态存 `localStorage.kj-hq`
- **弹幕**：默认开启，可关闭；播放器叠加层滚动显示，输入框实时发送
  - 数据存 D1 `danmaku` 表（`show_id + ep_idx + t`），接口 `GET/POST /api/danmaku`
  - 状态存 `localStorage.kj-dm`
  - 原站弹幕 = 带播放进度的评论（`/v1/comments` 的 `metadata.playback_context`），
    用 `node server/sync-danmaku.mjs --show <id>` 按剧批量导入
- **跳过片头 / 片尾**：片头片尾时长取自原站 `/v1/catalog/:id` 的
  `playback_skip_settings_preset`，按剧缓存到 D1（`shows.intro_end / outro_from`）
  - 片头期间显示「跳过片头」，接近结尾显示「跳过片尾」

### 影片简介同步

简介来自原站 `GET /v1/catalog/:id` 的 `description` 字段。

- 全量采集时若详情请求失败，旧逻辑会用 `NULL` 覆盖已有简介；已改为
  `description=COALESCE(excluded.description, shows.description)`
- `npm run backfill:desc`：只补 `description` 为空的条目，写出 D1 可导入的 SQL
- 已补回 758 部（谷雨、尚公主、后会友期等），其余 651 部上游本身没有简介或详情 500
- 播放页对空简介**整块隐藏**（不再显示「收录于开放影像片库」之类占位文案）

### 播放页 v2（对齐原站）

- 顶部：标题 / 年份·地区·类型 / 开始播放 / 加入片单 / 分享
- 左侧：播放器 + 工具条（显示设置 / 线路 / 画质增强 / 弹幕 / 下一集 / 发弹幕）
- 显示设置：播放速度（1x–3x）、画面填充（默认/铺满/拉伸）
- 右侧四个 tab：选集 / 投屏 / 讨论 / 反馈
  - 讨论来自 Worker `/api/comments`（原站 `/v1/comments`），实测 30 条
- 下方：简介、主创（导演/主演）、相关推荐
- 桌面端内容区已正确避开固定侧栏，右侧面板不再被裁切
