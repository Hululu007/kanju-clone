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

会员限制：原站大量剧集的最新若干集返回 `401 playback_user_session_required`，
匿名拿不到地址，页面会显示「这一集在原站是会员片源」，标着「可播放」的片子可以直接看。
