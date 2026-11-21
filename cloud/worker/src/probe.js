// kanju-probe：可行性探测 Worker
// 用途：用与 /api/play 相同的上游解析逻辑（resolve → 线路排序 → 播放列表/分片内容校验）
// 在 Cloudflare 出口 IP 上跑一次，确认能否拿到可播 m3u8。
//
// 调用：GET /?token=<播放凭证>&want=<期望集数>
// 不依赖 D1，不返回凭证本身。
import { api } from './kanju-client.js'
import { lineOptions, inspectSource } from './media-source.js'

const json = (obj, code = 200) =>
  new Response(JSON.stringify(obj, null, 1), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}
const pathOf = (u) => {
  try {
    return new URL(u).pathname
  } catch {
    return ''
  }
}

async function probe(token, want, secret) {
  const out = { egress: null, resolve: null, tried: [] }
  try {
    const r = await fetch('https://kanju32.com/v1/runtime/bootstrap', { headers: { accept: 'application/json' } })
    out.egress = { status: r.status, cfRay: r.headers.get('cf-ray') || '' }
  } catch (e) {
    out.egress = { error: String(e.message || e).slice(0, 120) }
  }

  let rv
  try {
    rv = await api.resolve(token, secret)
  } catch (e) {
    out.resolve = { error: String(e.message || e).slice(0, 200) }
    return out
  }
  const got = rv?.current_episode?.episode_number
  out.resolve = {
    ok: true,
    episodeNumber: got ?? null,
    matchesWant: got == null || want == null ? null : Number(got) === Number(want),
    lineCount: (rv?.line_options || []).length,
  }
  if (got != null && want != null && Number(got) !== Number(want)) {
    out.error = `集数不一致：请求第${want}集，原站返回第${got}集`
    return out
  }

  const lines = lineOptions(rv).sort((a, b) => a.priority - b.priority)
  for (const line of lines.slice(0, 8)) {
    let url = line.url
    if (!url && line.ticket) {
      try {
        const rl = await api.resolveLine(line.ticket, secret)
        url = rl?.line?.url || ''
      } catch (e) {
        out.tried.push({ provider: line.provider, reason: 'resolve_line_failed', detail: String(e.message || e).slice(0, 100) })
        continue
      }
    }
    if (!url) {
      out.tried.push({ provider: line.provider, reason: 'no_url' })
      continue
    }
    const info = await inspectSource(url, { contentHash: true })
    if (!info.ok) {
      out.tried.push({ provider: line.provider, reason: info.error || 'not_playable', kind: info.kind, status: info.status ?? null })
      continue
    }
    out.ok = true
    out.play = {
      provider: line.provider,
      label: line.label,
      kind: info.kind,
      segments: info.segments,
      duration: Math.round(info.duration || 0),
      host: hostOf(url),
      path: pathOf(url),
      contentFingerprint: info.contentFingerprint || null,
      finalHost: hostOf(info.first || ''),
    }
    return out
  }
  out.ok = false
  out.error = '所有候选线路都不可播'
  return out
}

export default {
  async fetch(request, env) {
    let u
    try {
      u = new URL(request.url)
    } catch {
      return json({ error: 'bad request url' }, 400)
    }
    if (u.pathname === '/' && !u.search) {
      return json({ service: 'kanju-probe', usage: '/?token=<playback token>&want=<episode number>' })
    }
    const secret = env.KANJU_SECRET
    if (!secret) return json({ error: 'worker 缺少 KANJU_SECRET' }, 500)
    const token = u.searchParams.get('token')
    if (!token) return json({ error: '缺少 token' }, 400)
    const want = u.searchParams.get('want')
    const t0 = Date.now()
    try {
      const out = await probe(token, want, secret)
      out.ms = Date.now() - t0
      return json(out)
    } catch (e) {
      return json({ error: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }, 500)
    }
  },
}
