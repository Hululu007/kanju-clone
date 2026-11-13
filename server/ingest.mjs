#!/usr/bin/env node
// 片库采集：从 Internet Archive 抓取「公有领域 / 开放授权」的影片元数据与可播放直链，
// 写进本地 SQLite 片库（server/data/catalog.db）。
//
//   node server/ingest.mjs            # 默认每个合集抓 90 条
//   LIMIT=200 node server/ingest.mjs
//
// 只收录 archive.org 明确可自由分发的内容（公有领域、CC 授权、Prelinger 等），
// 不涉及任何有版权的院线/平台剧集。

import { openDB } from './db.mjs'

const LIMIT = Number(process.env.LIMIT || 350)
const CONCURRENCY = Number(process.env.CONCURRENCY || 6)

// 合集 -> 站内分类
const COLLECTIONS = [
  { id: 'feature_films', cat: 'movie', label: '经典电影' },
  { id: 'silent_films', cat: 'movie', label: '默片时代' },
  { id: 'SciFi_Horror', cat: 'movie', label: '科幻恐怖' },
  { id: 'short_films', cat: 'movie', label: '短片集' },
  { id: 'classic_tv', cat: 'tv', label: '老电视剧' },
  { id: 'television', cat: 'tv', label: '电视档案' },
  { id: 'animationandcartoons', cat: 'anime', label: '经典动画' },
  { id: 'more_animation', cat: 'anime', label: '动画短片' },
  { id: 'classic_cartoons', cat: 'anime', label: '卡通老片' },
  { id: 'prelinger', cat: 'variety', label: '纪录影像' },
  { id: 'universal_newsreels', cat: 'variety', label: '新闻纪录' },
]

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|avi|mkv)$/i
const PREFER = ['mpeg4', 'h.264', '512kb mpeg4', 'matroska', 'ogg video', 'webm', 'mpeg2']

async function jget(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'kanju-clone/1.0 (personal catalog)' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
}

// 同一部片常带多种转码文件（xxx.mp4 / xxx_512kb.mp4 / xxx_edit.mp4），
// 归一化后同名即视为同一段，只保留画质最好的那个。
const normKey = (name) =>
  String(name)
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[\s._-]+(512kb|64kb|256kb|h\.?264|mpeg4|mpeg2|edit|edited|ia|ia2|derivative|clean|full|small|large|hd|sd|new|fixed)\b/g, '')
    .replace(/[\s._-]+$/g, '')
    .replace(/[\s._-]+/g, ' ')
    .trim()

const clean = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// 某个 item 的 metadata 里挑一个能直接播放的视频文件
function pickVideo(files) {
  const vids = files.filter((f) => VIDEO_EXT.test(f.name || '') || PREFER.includes(String(f.format || '').toLowerCase()))
  if (!vids.length) return null
  const score = (f) => {
    const fmt = String(f.format || '').toLowerCase()
    let s = 0
    if (fmt.includes('mpeg4') || fmt.includes('h.264')) s += 60
    if (/\.mp4$/i.test(f.name)) s += 30
    if (fmt.includes('512kb')) s += 10
    s += Math.min(Number(f.size || 0) / 1e9, 3) * 10 // 大一点通常画质好，但别压倒格式分
    return s
  }
  vids.sort((a, b) => score(b) - score(a))
  const f = vids[0]
  return {
    name: f.name,
    length: f.length ? Number(String(f.length).split(':').reduce((acc, p) => acc * 60 + Number(p), 0)) : null,
    quality: /h\.?264|mpeg4|mp4/i.test(f.format || f.name) ? 'SD/HD' : 'SD',
  }
}

async function ingestCollection(db, { id: coll, cat, label }) {
  const search =
    'https://archive.org/advancedsearch.php?q=' +
    encodeURIComponent(`collection:(${coll}) AND mediatype:movies`) +
    '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=downloads&fl%5B%5D=runtime' +
    `&sort%5B%5D=downloads+desc&rows=${LIMIT}&page=1&output=json`
  const found = await jget(search)
  const docs = found?.response?.docs || []
  console.log(`[${coll}] 搜索命中 ${found?.response?.numFound}，取前 ${docs.length}`)

  const upsertShow = db.prepare(`
    INSERT INTO shows (id,title,year,category,genres,description,poster,downloads,runtime,license,collection,added)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, year=excluded.year, category=excluded.category,
      genres=excluded.genres, description=excluded.description, poster=excluded.poster,
      downloads=excluded.downloads, runtime=excluded.runtime, license=excluded.license,
      collection=excluded.collection
  `)
  const delEps = db.prepare('DELETE FROM episodes WHERE show_id = ?')
  const insEp = db.prepare(
    'INSERT INTO episodes (show_id, idx, label, stream, length, quality) VALUES (?,?,?,?,?,?)'
  )

  let ok = 0
  let skipped = 0

  const queue = [...docs]
  async function worker() {
    for (;;) {
      const doc = queue.shift()
      if (!doc) return
      try {
        const meta = await jget(`https://archive.org/metadata/${doc.identifier}`)
        if (meta?.is_dark) {
          skipped++
          continue
        }
        const m = meta?.metadata || {}
        const files = meta?.files || []
        const vids = files.filter(
          (f) => VIDEO_EXT.test(f.name || '') || PREFER.includes(String(f.format || '').toLowerCase())
        )
        if (!vids.length) {
          skipped++
          continue
        }
        const title = clean(m.title || doc.title)
        if (!title || title.length < 2) {
          skipped++
          continue
        }
        const year = Number(String(m.year || m.date || doc.year || '').slice(0, 4)) || null
        const genres = [].concat(m.subject || [])
          .flatMap((s) => String(s).split(/[;,]/))
          .map((s) => clean(s))
          .filter((s) => s && s.length < 20)
          .slice(0, 4)
        const desc = clean(m.description).slice(0, 400)
        const poster = `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`
        const license = clean(m.licenseurl || m.license || '') || null
        const runtime = Number(m.runtime) || null

        // 一个 item 里有多个不同视频文件 -> 当成剧集/分集；只有一个 -> 正片。
        // 同一集常有多种格式（mp4/ogv），按首段文件名去重，每段只留画质最好的那个。
        const best = new Map()
        for (const f of vids) {
          const v = pickVideo([f])
          if (!v) continue
          const key = normKey(f.name)
          const prev = best.get(key)
          const better =
            !prev ||
            (v.quality === 'SD/HD' && prev.v.quality !== 'SD/HD') ||
            (v.quality === prev.v.quality && Number(f.size || 0) > Number(prev.f.size || 0))
          if (better) best.set(key, { f, v })
        }
        const picked = [...best.values()].slice(0, 30)
        const eps = picked.map((x, i) => ({
          idx: i + 1,
          label: picked.length > 1 ? `第${i + 1}集` : '正片',
          stream: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${String(x.f.name)
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          length: x.v.length,
          quality: x.v.quality,
        }))

        db.exec('BEGIN')
        upsertShow.run(
          doc.identifier,
          title,
          year,
          cat,
          JSON.stringify(genres),
          desc || `${label} · 来自 Internet Archive 开放片库`,
          poster,
          Number(doc.downloads || m.downloads || 0),
          runtime,
          license,
          coll,
          new Date().toISOString()
        )
        delEps.run(doc.identifier)
        for (const e of eps) insEp.run(doc.identifier, e.idx, e.label, e.stream, e.length, e.quality)
        db.exec('COMMIT')
        ok++
        if (ok % 10 === 0) console.log(`[${coll}] 已入库 ${ok}…`)
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        skipped++
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`[${coll}] 完成：入库 ${ok}，跳过 ${skipped}`)
}

const db = openDB()
const t0 = Date.now()
for (const c of COLLECTIONS) {
  try {
    await ingestCollection(db, c)
  } catch (e) {
    console.error(`[${c.id}] 失败：${e.message}`)
  }
}
// 同名同年重复条目只保留热度最高的一个
const dupes = db
  .prepare(
    `SELECT lower(title) t, IFNULL(year,0) y, COUNT(*) c FROM shows GROUP BY t,y HAVING c > 1`
  )
  .all()
let removed = 0
for (const d of dupes) {
  const rows = db
    .prepare(`SELECT id, downloads FROM shows WHERE lower(title)=? AND IFNULL(year,0)=? ORDER BY downloads DESC`)
    .all(d.t, d.y)
  for (const r of rows.slice(1)) {
    db.prepare('DELETE FROM episodes WHERE show_id=?').run(r.id)
    db.prepare('DELETE FROM shows WHERE id=?').run(r.id)
    removed++
  }
}
console.log(`去重：移除 ${removed} 条重复条目`)

const total = db.prepare('SELECT COUNT(*) n FROM shows').get().n
const eps = db.prepare('SELECT COUNT(*) n FROM episodes').get().n
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`片库：${total} 部 / ${eps} 个可播放文件（耗时 ${secs}s）`)
db.close()
