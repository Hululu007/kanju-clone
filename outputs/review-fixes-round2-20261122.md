# 审核第二轮返修（2026-11-22）

审核对象：`3c3dc58`。三条 P1 全部按审核给出的复现路径修复。

## 1. 多语言线路去重（player.js 合并 + 自动换线）

- 原因：`mergeLineOptions` 以 `option.provider` 作 Map 键，同 provider 的普通话/粤语互相覆盖；自动换线用 `option.provider !== currentProvider` 排除，也不会尝试同源另一语言。
- 修复：新增 `mergeLineOptionsList` / `lineKeyOfOption`（`src/player-policy.js`），按 `provider|label` 合并；自动换线改为排除「当前这一条线」，失败集合 `failedLines` 也按线路标识记录；`rankPlayableLines` 同时按 provider 与线路标识过滤。
- 测试：`同一 provider 的普通话与粤语线路合并后都保留`、`自动换线按 provider|label 排除，同源另一语言仍可尝试`。

## 2. 无续播时被第 0 集当续播（player.js:23/94）

- 原因：`Number(resumeParams.get('ep'))` 在无 `ep` 参数时是 `Number(null) === 0`，第 0 集被当续播，原站默认集（如 idx=1）被跳过。
- 修复：无 `ep` 参数时 `resumeIdx = null`；起播集改用纯函数 `pickStartEpisode`（续播 → 原站默认集 → 列表第一集）；`resumeTime` 的两处比较加 `resumeIdx != null` 保护。
- 测试：`没有续播记录时打开原站默认集，不会被第 0 集当成续播`、`有续播记录时优先续播集`。

## 3. 对照表把未匹配当成匹配（origin-default.js:32/72）

- 原因一：指定标签缺失时 `markOriginDefault` 退到同 provider 第一条，选线把它当默认、重试却判定未命中。
- 原因二：指定集名缺失时 `pickOriginDefaultEpisode` 仍按序号返回 `matched:true`，「预告片」被当成「正片」。
- 修复：标签指定则必须精确命中，否则不标默认；没给标签时只有该 provider 在本集唯一（或重复行标签全同）才认定。集名指定则只认集名，缺失就诚实返回 `matched:false / episode_not_in_library`，不再按序号顶替。
- 测试：`指定语言版本缺失时不退到同 provider 的第一条`、`没给标签且同 provider 有多条时不猜哪条是默认`、`集名缺失时即使序号能对上也不冒充原站默认集`。

## 红/绿

- 旧实现（`git stash` 掉三个源文件改动）：4 条红 —— 3 条断言失败 + `player-policy` 模块缺新导出。
- 修复后：`node --test Tests/*.test.mjs` → 67 通过 / 0 失败 / 0 跳过；`vite build`、`node --check` 通过。

## 仍未解决（非选线逻辑）

- 4 部综艺的原站默认集不在 D1 分集里（需 `/api/sync` 的 `x-sync-key`），对照表已存 `ep_label`，接口如实报 `episode_not_in_library`。
- 官方线 `probe_timeout` / `resolve_failed` 是 Worker 出口可达性问题，不属排序/选线缺陷。
