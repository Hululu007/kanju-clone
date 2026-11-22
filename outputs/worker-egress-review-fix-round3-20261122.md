# Worker 官方线出口第三轮返修证据（2026-11-22）

对应审核：`c26112a` 四条未通过 P1（MP4/HLS 多层软失败、CORS 硬失败误判、缓存覆盖、预算与重定向计数）。
用户范围：只做第 2 项（官方线 Worker 出口），第 1 项（4 部综艺原站默认集缺库）按要求不碰。

## 红（在 `c26112a` 上运行新增测试）

命令：`python C:/Users/kenzh/hark_tasks/memcap.py 2048 node --test Tests/worker-egress-review.test.mjs`

- `a rate-limited MP4 default stays unknown and the fallback is flagged`：默认线 `http_429` 被标 `dead`。
- `an HLS master-to-segment transport failure stays an unverified default`：主清单→子清单→首片断网被改写成 `no_playable_variant`，默认线 `dead`。
- `a first segment without browser CORS is a dead line, not an unverified candidate`：首片 CORS 缺失被当作未验证候选抢在可播备用线前。
- `an HLS transport failure never clears a verified cached source`：多层 HLS 软失败把已验证记录改成 `no_playable_variant` 并清空指纹。
- `an HLS variant stopped by the probe budget reports probe_budget_exceeded`：预算在变体处耗尽被报 `no_playable_variant`。
- `an HLS init segment stopped by the probe budget reports probe_budget_exceeded`：预算在初始化片段处耗尽被报 `playlist_dependencies_unavailable`。
- `every redirect hop is charged to the probe budget`：重定向只算一次，预算 1 时仍拿到 `http_302`。

说明：缓存保护那条最初写成单层 HLS 时在旧实现上也绿；按审核原场景改成主清单→子清单→首片后单独确认在 `c26112a` 上红。

## 绿（修复后）

- `python C:/Users/kenzh/hark_tasks/memcap.py 2048 node --test Tests/*.test.mjs` → **95 通过 / 0 失败 / 0 跳过**。
- `node --check`：`index.js`、`playback-probe.js`、`source-selection.js`、`probe-budget.js`、`origin-default.js`、两份 egress 测试，全过。
- `npm run build`（套 memcap 2048）：vite 5.4.21 构建成功，29 modules transformed。

## 根因与修法

1. 软失败分类过宽/过窄：`first_segment_cors_blocked` 被误当软失败；`http_429`、多层 HLS 的 `no_playable_variant`/`playlist_dependencies_unavailable` 没算软失败。
   - `source-selection.js`：CORS 与「内容不是媒体」明确为硬失败；429/5xx、首片传输失败、依赖不可达按软失败处理。
   - `playback-probe.js`：主清单聚合子清单结果时保留首个软失败原因，不再统一改写成 `no_playable_variant`。
2. 预算耗尽在 HLS 内部被 catch 改写：初始化片段/加密 key 的 `probe_budget_exceeded` 被吞成 `playlist_dependencies_unavailable`。
   - 依赖请求 catch 保留预算错误；CORS 错误单独报 `playlist_dependencies_cors_blocked`（硬失败）；429/5xx 报 `playlist_dependencies_http_*`（软失败）。
3. 重定向只计一次：
   - `playback-probe.js` 新增 `createCountedFetch`，`redirect:'manual'` 手动跟随，每一跳都扣预算；记录最终 URL 供 CORS 判断和媒体地址使用。
   - `index.js` 的 MP4 探测也改用同一个计数 fetch，catch 保留 `probe_budget_exceeded`。

## 口径核对

- Cloudflare 官方文档（Context7，2026-10-07 更新）：免费版每次 Worker 调用 50 个子请求；重定向链中的每一跳都计入子请求数。
- 未做生产部署或浏览器实播；4 部综艺缺集未处理。
