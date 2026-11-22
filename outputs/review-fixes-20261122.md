# 审核开发二不通过项 → 修复记录（2026-11-22）

针对审核对 `467a913` 的 5 条不通过项逐条修复。**尚未部署、未合并 main、未执行 migrate-v10**，等审核复核通过后再按交付流程上线。

## 1) 对照表未命中时误把上游 selected 当默认（回归）

- 根因：`markOriginDefault` 未命中时原样返回，上游 `selected`（列表第一条）被 `line-order.js` / `source-selection.js` 当成实测默认。
- 修复：
  - 排序与选线只认 `originDefault` 这一个对照表信号（`worker/api/src/origin-default.js`、`line-order.js`、`source-selection.js`）。
  - 上游 `selected` 一律不参与排序、选线、重试。
- 复现测试：`Tests/line-order.test.mjs`（上游 720P 标 `selected:true`，仍选 1080P）、`Tests/origin-default.test.mjs`（未命中时无 originDefault）、`Tests/source-selection.test.mjs`。
- 红→绿：把 3 个源文件回退到 `467a913` 实现跑新测试 → 5 条失败（含上述回归）；恢复修复后 59 条全过。

## 2) 同一 provider 多语言版本无法手选

- 根因：前端两个按钮都发 `provider`，后端按 provider 取排序第一条。
- 修复：线路标识改为 `provider|label`（新模块 `worker/api/src/line-key.js`）；`/api/lines`、`/api/play` 都返回 `key`，前端按 key 选中/上报/恢复高亮，后端按 key 匹配（无分隔符时仍兼容旧 provider 值）。
- 复现测试：`Tests/line-key.test.mjs`。

## 3) 软失败重试条件与失败状态

- 根因：重试按上游 `selected` 触发；重试返回 `member`/`http_403` 时只在成功时替换，响应仍报「超时/未知」。
- 修复：`planOriginRetry` 只对对照表命中且软失败的线路重试；`mergeOriginRetry` 用重试结果（含明确失败）替换原结果。
- 复现测试：`Tests/origin-default.test.mjs`（只对对照表命中重试、会员失败替换超时）。

## 4) 默认集仍取列表第一集

- 修复：`origin_defaults` 增加 `ep_idx`/`ep_label`（`migrate-v10.sql`）；`/api/show` 返回 `defaultEpisode`；播放器无续播记录时先打开原站默认集，其次才是列表第一集；原站默认集不在库内时诚实返回 `matched:false` + 原因，不拿别的集冒充。
- 单测：`Tests/origin-default.test.mjs` 的 `pickOriginDefaultEpisode`。
- 12 部默认集对照：`outputs/origin-defaults-episodes-20261122.csv`
  - 已对齐 8 部：4 部剧集（第1集）、4 部电影（正片）。
  - 未对齐 4 部：综艺原站默认集（2026-11-20 抢鲜版 / 2026-11-21 第7期 上 / 20261121 纯享 / 2026-02-01 名场面特辑）不在 D1 分集里，需 `/api/sync`（需要 `x-sync-key`）或 02:00 定时同步补齐；本轮无该密钥，记为数据阻塞，不拿旧集冒充。

## 5) 测试

- 59 通过 / 0 失败 / 0 跳过（`node --test Tests/*.test.mjs`，memcap 2048）。
- 新增 5 条测试（线路 key 2 条、默认集/重试 3 条），并补上第 1 条回归用例的上游 `selected:true`。
- `vite build` 通过；`node --check worker/api/src/index.js` 通过。

## 仍未解决（不是本轮代码能修）

- 官方线路 `probe_timeout` / `resolve_failed`：Worker 出口到上游媒体的可达性问题，选线逻辑已按原站默认优先 + 软失败重试处理，硬失败仍会回退并在响应里给出真实原因。
- 综艺 4 部默认集：等分集同步。
