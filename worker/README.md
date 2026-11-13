# 看剧AI 后端：Cloudflare Worker + D1

片库存在 D1（SQLite），Worker 提供 `/api/*` 接口。前端静态站可以直连这个 API，也可以继续用构建时导出的快照（`src/catalog.gen.js`）。

## 一次性部署

```bash
cd kanju-clone/worker
npx wrangler login                     # 浏览器里点 Allow
npx wrangler d1 create kanju-catalog   # 记下返回的 database_id
# 把 database_id 填进 wrangler.toml
npx wrangler d1 execute kanju-catalog --remote --file=schema.sql
node seed.mjs                          # 由本地 catalog.db 生成 seed.sql
npx wrangler d1 execute kanju-catalog --remote --file=seed.sql
npx wrangler deploy
```

部署完会拿到形如 `https://kanju-api.<你的子域>.workers.dev` 的地址。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 片库规模自检 |
| GET | `/api/stats` | 各分类数量 |
| GET | `/api/shows?cat=movie&q=关键词&limit=24&offset=0` | 分页列表（含分集） |
| GET | `/api/shows/:id` | 单部详情 |
| GET | `/api/episodes/:id` | 该片所有可播放段 |
| GET | `/api/catalog?cat=` | 全量（前端首次加载用） |
| GET | `/api/progress?device=x` | 播放记录 |
| POST | `/api/progress` | 写播放记录 `{device,showId,idx,position,duration}` |

## 让前端使用 Worker

构建时指定 API 地址，前端会优先走云端片库，失败自动回落到静态快照：

```bash
VITE_API_BASE="https://kanju-api.xxx.workers.dev" BASE_PATH="/kanju-clone/" npx vite build
```

## 重新灌库

```bash
node ../server/ingest.mjs        # 采集 Internet Archive 开放授权影片
node ../server/export.mjs        # 导出前端静态快照
node seed.mjs                    # 导出 D1 种子 SQL
npx wrangler d1 execute kanju-catalog --remote --file=seed.sql
```

所有片源均来自 Internet Archive 的开放授权 / 公有领域内容，直链为 archive.org 官方下载地址。
