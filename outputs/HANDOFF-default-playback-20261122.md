# 阿噗影视 · 默认播放对齐原站（2026-11-22）

## 结论

以阿噗影视线上当前热门栏目为准（电视剧 4、综艺 4、电影 4），逐部实看原站播放页的默认集与默认线路，并把默认线路落到阿噗影视：

- **完全一致 5 部**：尚公主、嫁金钗（浏览器实播 1920×1080、2890.1s、进度推进）、走马上任（默认线路一致，浏览器该次探测抖动）、折月亮、八仙（原站播放器里就是同一条 official-v 线路，只是标签带语言后缀）。
- **不一致 7 部**，两类原因，均带证据：
  1. **上游媒体在本机 Cloudflare 侧不可达**：尚公主/走马上任最后一次探测里原站默认线 `1080P-官方Z` 是 `probe_timeout`（同一条线在浏览器实播正常），电影 4 部与综艺 1 部的官方线是 `resolve_failed`。阿噗影视按既有规则回退到其他可用线路。
  2. **综艺分集比原站旧**：原站默认集分别是 `2026-11-20 抢鲜版`、`2026-11-21 第7期 上`、`20261121 纯享`、`2026-02-01 名场面特辑`；库内 后会友期 最新只到 `2026-11-13 抢鲜版`、现在就出发 第4季 最新到 `第5期 下 纯享`、音乐缘计划 最新到 `20261107 第1期 纯享`，因此原站默认集里的官方线路在库里根本不存在，默认集无法对齐。

## 改动

- `worker/api/src/origin-default.js`（新）：`origin_defaults` 对照表读取 + 纯函数 `markOriginDefault`（同 provider 多语言变体按标签精确匹配）。
- `worker/api/src/line-order.js`：排在最前的是「原站默认线路」，其余仍按 1080P、可信播放历史、官方、优先级兜底。
- `worker/api/src/source-selection.js`：用户没手动选过线路时，通过首片探测的原站默认线路优先。
- `worker/api/src/index.js`：`/api/lines` 与 `/api/play` 都套用对照表；原站默认线路若只是 `probe_timeout`／预算不足这类软失败，单独用 12s 重试一次，避免并发探测把它挤掉。
- `worker/api/migrate-v9.sql`（新）+ `worker/api/schema.sql`：`origin_defaults` 表与 12 行实看结果。
- `Tests/line-order.test.mjs`、`Tests/source-selection.test.mjs`、`Tests/origin-default.test.mjs`：新增/更新断言。

## 验证

- 测试：`node --test Tests/*.test.mjs` → **54 通过 / 0 失败**（改前先跑红线：新断言在旧逻辑下失败）。
- 数据：`wrangler d1 execute kanju-db --remote --file=migrate-v9.sql`（12 行），`wrangler deploy`（kanju-api）。
- 线上默认线路（`/api/lines`）：4 部剧集 + 八仙 的首选线路已等于原站默认线路。
- 线上起播（`/api/play`）：嫁金钗、折月亮 两次连续一致；尚公主/走马上任 因 `probe_timeout` 回退（同一线路在浏览器能播）。
- 浏览器实播（隔离、静音、无登录）：嫁金钗 1920×1080、总长 2890.1s、98.7→104.7s 推进；尚公主 1920×1080、总长 2753s（与原站 2753.33s 同片源）。

## 证据文件（同目录）

- `origin-defaults-20261122.json`：原站 12 部默认集/线路 + 原站播放器实测
- `origin-vs-apu-defaults-20261122.csv`：12 部逐部对照（含不一致原因、证据文件）
- `line-default-comparison-20261122.txt`：`/api/lines` 首选线路对照
- `play-default-verification-20261122.txt`、`post-retry-verification-20261122.txt`：`/api/play` 实播线路
- `why-zdropped-20261122.txt`：原站默认线路被判 `probe_timeout` 的明细
- `variety-episodes-20261122.txt`：综艺库内分集落后于原站的清单
- `origin-selected-flags-20261122.txt`：证明上游 `selected` 只是「列表第一条」，不等于原站实际播放线路

## 还没做的

- 综艺 4 部的默认集对齐：需要先把原站新分集同步进 D1（`/api/sync` 需要 `x-sync-key`，或等 02:00 定时同步覆盖到这几部），否则默认集无从对齐。
- 电影/综艺官方线在本机 Cloudflare 侧 `resolve_failed`/`probe_timeout`：属上游可达性问题，需要代理或换解析出口，不是排序逻辑。
