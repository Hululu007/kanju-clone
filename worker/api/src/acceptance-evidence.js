// 100 部验收证据的两个纯判定，供验收脚本与回归测试共用。
// 只做可复核的文本/采样判定，不猜原站默认项，不把 seek 跳转当连续播放。

// 从原站正常播放页的 preview 文本提取「完整集名/版本名」。
// preview 形如：标题 集名 年份 · 分类 · 集名 · 地区 · 语言 关闭 播放详情
// 真正的集名在「分类段」之后；标题段里可能含「第1季/加更」等字样，不能从标题段取。
// 只接受段首即为集名/版本标识的片段，绝不拿地区/语言/UI 文案冒充集名。
const CATEGORY = /^(剧集|电影|综艺|动漫|纪录片|短片|短剧)$/
const EPISODE_AT_START = /^(第\s*\d+\s*[集期]|\d{4}-\d{2}-\d{2}|正片|抢先版|抢先看|尝鲜版|预告片|先导篇|第一期|加更|纯享|特辑|回顾)/
export function extractOriginEpisode(preview) {
  const parts = String(preview || '').split('·').map((s) => s.trim()).filter(Boolean)
  const catAt = parts.findIndex((p) => CATEGORY.test(p))
  const scan = catAt >= 0 ? parts.slice(catAt + 1) : parts.slice(1)
  for (const part of scan) {
    const clean = part.replace(/关闭.*$/, '').replace(/播放详情.*$/, '').trim()
    if (EPISODE_AT_START.test(clean)) return clean
  }
  return ''
}

// 连续推进判定：只有自然解码推进才算真实播放。
// 判据（全部满足才算通过）：
//  - 存在一段 >=5 个有效解码帧，currentTime 单调递增、相邻增量 (0, maxStep]；
//  - 该段跨度 >= minSpan 秒（不是起播瞬间/单帧）；
//  - 全程没有 seek 跳变（正向相邻增量 > maxStep，或负向回退超过采样抖动 -0.05s）；
//  - 全程播放器状态无失败/错误文案，且无媒体错误码（video.err）；
//  - 线路与集保持稳定，且命中目标（给出 target 时）。
const FAIL_TEXT = /失败|错误|没有.*可用线路|NotSupportedError|无法播放|请.*重试|请.*选择其他线路/
export function isContinuousPlayback(samples, opts = {}) {
  const maxStep = opts.maxStep ?? 3.5
  const minFrames = opts.minFrames ?? 5
  const minSpan = opts.minSpan ?? 5
  const target = opts.target || ''
  const targetEp = opts.targetEp || ''
  const list = Array.isArray(samples) ? samples : []
  const valid = list.filter((s) => s && s.video && s.video.w > 0 && (s.video.ready ?? 2) >= 2 && s.video.t != null)
  let best = [], cur = valid.length ? [valid[0]] : []
  for (let i = 1; i < valid.length; i++) {
    const d = valid[i].video.t - valid[i - 1].video.t
    if (d > 0 && d <= maxStep) cur.push(valid[i])
    else { if (cur.length > best.length) best = cur; cur = [valid[i]] }
  }
  if (cur.length > best.length) best = cur
  const span = best.length >= 2 ? +(best[best.length - 1].video.t - best[0].video.t).toFixed(2) : 0
  const anyJump = valid.length >= 2 && valid.slice(1).some((s, i) => {
    const d = s.video.t - valid[i].video.t
    return d > maxStep || d < -0.05
  })
  const hasError = list.some((s) => FAIL_TEXT.test(String(s?.status || '')) || Number(s?.video?.err) > 0)
  const lines = [...new Set(valid.map((s) => s.lineOn || s.line).filter(Boolean))]
  const episodes = [...new Set(valid.map((s) => s.episodeOn || s.episode).filter(Boolean))]
  const ok = !anyJump
    && best.length >= minFrames
    && span >= minSpan
    && !hasError
    && lines.length <= 1
    && episodes.length <= 1
    && (!target || lines.some((l) => l.includes(target)))
    && (!targetEp || episodes.some((e) => e.includes(targetEp)))
  return {
    ok, span, runLength: best.length, validFrames: valid.length, anyJump, hasError,
    lineStable: lines.length <= 1, episodeStable: episodes.length <= 1, lines, episodes,
  }
}
