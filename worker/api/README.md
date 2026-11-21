# kanju-api · Cloudflare Worker + D1

线上地址：https://kanju-api.kenzhao123.workers.dev
D1：`kanju-db`（`41dca879-dd13-416f-acf0-3ca6e8feb9a1`）

## 部署

新建空 D1 数据库时执行 `schema.sql`。已有数据库先检查并只执行尚未应用的增量迁移，再执行 schema 和部署；不要对已有数据库重放 `migrate-v7.sql`，因为 SQLite 不支持 `ADD COLUMN IF NOT EXISTS`。

```powershell
cd worker/api
# 新数据库：
wrangler d1 execute kanju-db --remote --file=schema.sql
# 旧数据库：先检查 sources.quality；缺列时执行一次 v7，然后都执行幂等的 v8 与 schema。
wrangler d1 execute kanju-db --remote --command="PRAGMA table_info(sources)"
wrangler d1 execute kanju-db --remote --file=migrate-v7.sql  # 仅当 quality 列不存在
wrangler d1 execute kanju-db --remote --file=migrate-v8.sql
wrangler d1 execute kanju-db --remote --file=schema.sql
wrangler deploy
'<上游签名密钥>' | wrangler secret put KJ_SECRET   # 加密 Secret，不是明文 var
```

v7 migration 仅新增 `sources.quality` 列，不改写或删除现有来源记录。v8 用 `CREATE TABLE/INDEX IF NOT EXISTS` 安全重复执行；记录仅来自已登录会话；每次 `/api/play` 为已登录用户签发绑定用户、作品、集数、线路且 30 分钟过期的 HMAC 凭证，`attemptId` 不可自造，并按凭证唯一键去重。凭证只在响应中生成，不复用共享播放缓存。浏览器反馈只更新播放历史统计，不能改写 Worker 确认的串集健康状态。部署前应先备份/核对远端 D1，并确认 v7 列状态；本任务未对远端 D1 执行迁移。

## 数据同步（从本地 SQLite）

```powershell
node server/export-d1.mjs           # 生成 worker/api/sql/*.sql（INSERT OR REPLACE）
$files = Get-ChildItem worker/api/sql/*.sql | Sort-Object Name
foreach ($f in $files) { wrangler d1 execute kanju-db --remote --file=$f.FullName }
```

## 首页栏目 / 分类热榜同步（v5）

原来首页各栏是按库内 `heat_value` 现拼的，和各分类热榜只同步了「电视剧」，
所以电影、综艺、动漫、以及栏目顺序都和原站对不上。现在：

- `src/feed-sync.js` 把原站 `/v1/feed/home` 的 **11 个栏目原顺序、原标题、原条目**
  写进 D1 `feed_rows`，`/api/home-feed` 直接按这个顺序输出；
- `hot_rank` 保存 电视剧(series)/电影(movie)/综艺(variety)/动漫(anime) 的 `heat_desc` 名次，
  `/api/list?cat=…&sort=heat` 按名次排序，第一屏与原站一致；
- 原站首页没有综艺栏目，接口层按综艺热榜补一栏「综艺热播」；
- 分集改成 `src/episodes.js` 共用：上游标称集数 > 库内实际分集数时补尾部，
  只有枚举完整且达到标称集数才裁剪，避免「显示 20 集只能播 17 集」和超长剧丢集。

手动同步（每段控制在 30 秒内，避免 Worker 请求超时）：

```powershell
node sync-all.mjs feed 6      # 首页 11 栏目 + 缺集补全
node sync-all.mjs hot 3       # 四个分类热榜（100 名/类）
node sync-all.mjs update 4    # 最近更新的新剧/新集
```

`wrangler.toml` 的 Cron（UTC 18:00 = 北京 02:00）会依次跑 feed → hot → update。

## 接口

| 路径 | 说明 |
| --- | --- |
| `/api/health` | 服务状态与行数 |
| `/api/list?cat=tv&q=&page=1` | 列表/搜索 |
| `/api/home-feed` | 首页各分区与本周日历（统一缓存） |
| `/api/show?id=` | 详情 + 分集 + 线路健康度 |
| `/api/lines?show=&ep=` | 该集可选线路（官方/普通） |
| `/api/play?show=&ep=&line=` | 解析并校验后返回直链 |
| `/api/playback-result` | 登录后 POST `{showId,provider,ok,attemptId}`；按播放尝试去重，探测结果不计入实播历史 |
| `/api/audit?show=` | 线路体检结果 |
| `/api/progress` | 播放进度读写 |
| `POST /api/auth/register` | 账号注册，返回 30 天会话令牌 |
| `POST /api/auth/login` | 账号密码登录 |
| `GET /api/auth/me` | 校验当前会话 |
| `POST /api/auth/logout` | 注销当前会话 |
| `GET/PUT/DELETE /api/user/progress` | 登录用户的观看记录与断点进度 |
| `POST /api/sync` | 手动触发增量同步（需 `x-sync-key`） |

账号接口使用 `Authorization: Bearer <token>`。密码以 PBKDF2-SHA256 加盐保存，
数据库保存的是会话令牌哈希；观看进度按用户存储，可跨浏览器和设备续看。

## 增量同步

`wrangler.toml` 里配置了 Cron：`0 18 * * *`（每天 UTC 18:00，即北京时间 02:00）。

- 数据源：`/v1/browse/catalog?scope=public&sort=update_desc&limit=20&page=N`
- 每天依次同步最近更新和热门电视剧（每类最多 10 部 / 3 页）
- 新剧会补详情简介与全部分集（最多 8 页 × 48）
- 水位线：`meta.last_sync_at`，回看 3 天
- 手动触发：`x-sync-key = sha256(KJ_SECRET + ":sync")` 前 16 位

## 说明

- 匿名访客 cookie 存在 D1 的 `meta` 表，冷启动自动复用
- 官方 1080P 需要该 cookie；`resolve-line` 是 `POST`
- 播放前按媒体类型做内容指纹比对（HLS 首片字节、MP4 源地址和长度）；串集线路自动拉黑
- `KJ_SECRET` 已用 `wrangler secret put` 存为加密 Secret（`secret_text`），不再有明文变量
