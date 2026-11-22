# 审核第三轮返修（2026-11-22）

审核 commit：50512c6 → 本轮 2 条 P1。

## 1) [P1] 手选粤语仍可能播成普通话
- 现象：手选线路未启用严格选线，粤语探测失败后 /api/play 回退到同 provider 的普通话。
- 修法：`src/player-policy.js` 新增 `lineRequestOptions(requestedLine)`（手选即 `strict:true`），
  `src/pages/player.js` 的 `resolvePlay` 调用展开它；严格模式下失败如实提示
  「所选线路「<标签>」暂不可用，请换一条线路。」，不再自动换到别的线路。
- 验证：`Tests/player-policy.test.mjs` 新增手选/自动两条用例；`Tests/playback-lifecycle.test.mjs`
  断言播放器把 `lineRequestOptions(requestedLine)` 和手选提示接到请求与提示上（旧代码下红）。

## 2) [P1] 无标签且同源多语言版本时，默认标记与重试判定不一致
- 现象：`markOriginDefault` 不认定默认，`planOriginRetry` 却按首条命中并单独重试。
- 修法：抽出 `findOriginDefaultIndex`（按标签精确匹配；无标签时只有该 provider 唯一一条，
  或重复行标签全同才算命中），`markOriginDefault` 与 `planOriginRetry` 共用同一判定。
- 验证：`Tests/origin-default.test.mjs` 新增「同源普通话+粤语、无标签、首条超时」用例，
  旧实现返回 `{index:0, retry:true}`，修后 `{index:-1, retry:false}`（先红后绿）。

## 结果
- 全部测试：70 通过 / 0 失败 / 0 跳过（`node --test "Tests/*.test.mjs"`）。
- `npx vite build` 通过；`node --check` 通过（origin-default.js / index.js / player-policy.js / player.js）。

## 仍未解决（不属选线逻辑）
- 4 部综艺的原站默认集不在 D1 分集里：需要 `/api/sync` 的 `x-sync-key` 或等 02:00 定时同步。
- 官方线 `probe_timeout` / `resolve_failed`：Worker 出口可达性问题，需换解析出口。
