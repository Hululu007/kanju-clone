// 重新挑选片源文件：把 _edit/hires 这类超大转码换成标准 h.264 版本
// 用法：node server/repick.mjs          只修有问题的
//       ALL=1 node server/repick.mjs    全库重挑
import { openDB } from './db.mjs'

const CONCURRENCY = Number(process.env.CONCURRENCY || 8)
const db = openDB()

// 与 ingest.mjs 保持一致的归一化：同一段的不同转码归到一组
const normKey = (name) =>
  String(name)
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[\s._-]+(512kb|64kb|256kb|h\.?264|mpeg4|mpeg2|edit|edited|ia|ia2|derivative|clean|full|small|large|hd|sd|new|fixed)\b/g, '')
    .replace(/[\s._-]+$/g, '')
    .replace(/[\s._-]+/g, ' ')
    .trim()

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mkv|avi)$/i

// 新的打分：优先标准 h.264 / 512kb 衍生版本，pénale 超大 hires 与 _edit
function score(f) {
  const fmt = String(f.format || '').toLowerCase()
  const name = String(f.name || '').toLowerCase()
  const size = Number(f.size || 0) / 1048576 // MB
  let s = 0
  if (fmt === 'h.264' || fmt === 'h.264 ia') s += 90
  else if (fmt.includes('h.264')) s += 80
  else if (fmt.includes('512kb')) s += 75
  else if (fmt.includes('mpeg4')) s += 55
  else if (fmt.includes('matroska') || fmt.includes('webm')) s += 45
  else if (fmt.includes('mpeg2')) s += 20
  if (/\.mp4$/i.test(name)) s += 15
  if (/_edit\b|hires|\.mpg$|\.avi$/i.test(name)) s -= 45
  if (name.includes('_512kb')) s += 12 // 带宽友好
  // 20MB～450MB 是流式播放的舒适区
  if (size > 450) s -= Math.min((size - 450) / 25, 40)
  if (size < 8) s -= 15
  return s
}

const jget = async (url, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'kanju-clone/1.0 (personal catalog)' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
}

const bad = /_edit|hires|\.ogv$|\.mkv$/i
const targets = process.env.ALL
  ? db.prepare('SELECT DISTINCT show_id id FROM episodes').all()
  : db.prepare(`SELECT DISTINCT show_id id FROM episodes WHERE stream LIKE '%_edit%' OR stream LIKE '%hires%' OR length IS NULL`).all()

console.log(`需要重挑：${targets.length} 部`)

let done = 0
let changed = 0

async function handle({ id }) {
  let meta
  try {
    meta = await jget(`https://archive.org/metadata/${encodeURIComponent(id)}`)
  } catch {
    return
  }
  const files = (meta.files || []).filter((f) => VIDEO_EXT.test(f.name || '') || f.format)
  const vids = files.filter((f) => VIDEO_EXT.test(f.name || ''))
  if (!vids.length) return

  const groups = new Map()
  for (const f of vids) {
    const k = normKey(f.name)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(f)
  }

  const eps = db.prepare('SELECT idx, label, stream, length FROM episodes WHERE show_id=? ORDER BY idx').all(id)
  const upd = db.prepare('UPDATE episodes SET stream=?, length=?, quality=? WHERE show_id=? AND idx=?')

  for (const ep of eps) {
    // 找到这条 episode 现在指向的那一组
    const curBase = normKey(decodeURIComponent(String(ep.stream).split('/').pop() || ''))
    const group = groups.get(curBase) || groups.get([...groups.keys()].find((k) => curBase.startsWith(k) || k.startsWith(curBase)))
    if (!group || !group.length) continue
    const best = group.slice().sort((a, b) => score(b) - score(a))[0]
    const url = `https://archive.org/download/${id}/${encodeURIComponent(best.name)}`
    if (url !== ep.stream) {
      upd.run(url, Number(best.length || best.size || ep.length || 0) || null, best.format || null, id, ep.idx)
      changed++
    }
  }
  done++
  if (done % 25 === 0) console.log(`  处理 ${done}/${targets.length}，改动 ${changed}`)
}

const queue = targets.slice()
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await handle(queue.shift())
  })
)

console.log(`完成：处理 ${done} 部，替换 ${changed} 个片源`)
const left = db.prepare(`SELECT COUNT(*) n FROM episodes WHERE stream LIKE '%_edit%'`).get().n
console.log(`残留 _edit 文件：${left}`)
