#!/usr/bin/env node
// 片库 API：读本地 SQLite，对外提供列表 / 搜索 / 详情 / 播放记录。
//
//   node server/api.mjs                 # 默认 http://localhost:8787
//   PORT=9000 node server/api.mjs
//
// 同一个库还能导出成静态 JSON（node server/export.mjs），供 GitHub Pages 这类纯静态托管使用。

import http from 'node:http'
import { openDB } from './db.mjs'

const PORT = Number(process.env.PORT || 8787)
const db = openDB()

const q = (sql) => db.prepare(sql)
const row2show = (r) => ({
  id: r.id,
  title: r.title,
  year: r.year,
  cat: r.category,
  genres: JSON.parse(r.genres || '[]'),
  desc: r.description,
  poster: r.poster,
  heat: r.downloads,
  runtime: r.runtime,
  license: r.license,
  episodeCount: r.eps ?? 0,
})

const LIST_SQL = `
  SELECT s.*, (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS eps
  FROM shows s`

function list({ cat, q: kw, limit = 60, offset = 0 } = {}) {
  const where = []
  const args = []
  if (cat && cat !== 'all') {
    where.push('s.category = ?')
    args.push(cat)
  }
  if (kw) {
    where.push('(s.title LIKE ? OR s.genres LIKE ? OR s.description LIKE ?)')
    args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
  }
  const sql =
    LIST_SQL +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY s.downloads DESC LIMIT ? OFFSET ?`
  return q(sql)
    .all(...args, Number(limit), Number(offset))
    .map(row2show)
}

const counts = () =>
  Object.fromEntries(
    q('SELECT category, COUNT(*) n FROM shows GROUP BY category')
      .all()
      .map((r) => [r.category, r.n])
  )

function detail(id) {
  const s = q(`SELECT * FROM shows WHERE id = ?`).get(id)
  if (!s) return null
  const eps = q('SELECT idx,label,stream,length,quality FROM episodes WHERE show_id = ? ORDER BY idx').all(id)
  return { ...row2show(s), episodes: eps }
}

const json = (res, code, body) => {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'public, max-age=60',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname

    if (req.method === 'OPTIONS') return json(res, 204, null)

    try {
      if (p === '/api/health') {
        const n = q('SELECT COUNT(*) n FROM shows').get().n
        const e = q('SELECT COUNT(*) n FROM episodes').get().n
        return json(res, 200, { ok: true, shows: n, episodes: e, counts: counts() })
      }

      if (p === '/api/shows') {
        const cat = url.searchParams.get('cat') || 'all'
        const kw = url.searchParams.get('q') || ''
        const limit = Math.min(Number(url.searchParams.get('limit') || 60), 200)
        const offset = Number(url.searchParams.get('offset') || 0)
        return json(res, 200, { items: list({ cat, q: kw, limit, offset }), counts: counts() })
      }

      if (p.startsWith('/api/shows/')) {
        const id = decodeURIComponent(p.slice('/api/shows/'.length))
        const d = detail(id)
        return d ? json(res, 200, d) : json(res, 404, { error: 'not found' })
      }

      if (p === '/api/catalog') {
        // 一次性把全站片库吐出来（静态导出与前端首屏用）
        const items = list({ limit: 5000 })
        const eps = q('SELECT show_id, idx, label, stream, length, quality FROM episodes ORDER BY show_id, idx').all()
        const by = {}
        for (const e of eps) (by[e.show_id] ||= []).push(e)
        return json(res, 200, { count: items.length, counts: counts(), shows: items.map((s) => ({ ...s, episodes: by[s.id] || [] })) })
      }

      if (p === '/api/progress') {
        if (req.method === 'POST') {
          let raw = ''
          req.on('data', (c) => (raw += c))
          req.on('end', () => {
            try {
              const { showId, idx = 1, position = 0, duration = null } = JSON.parse(raw || '{}')
              q(
                `INSERT INTO progress (show_id, idx, position, duration, updated) VALUES (?,?,?,?,?)
                 ON CONFLICT(show_id, idx) DO UPDATE SET position=excluded.position, duration=excluded.duration, updated=excluded.updated`
              ).run(showId, idx, position, duration, new Date().toISOString())
              json(res, 200, { ok: true })
            } catch {
              json(res, 400, { error: 'bad body' })
            }
          })
          return
        }
        return json(res, 200, {
          items: q(
            `SELECT p.*, s.title, s.poster FROM progress p JOIN shows s ON s.id = p.show_id ORDER BY p.updated DESC LIMIT 50`
          ).all(),
        })
      }

      return json(res, 404, { error: 'not found', routes: ['/api/health', '/api/shows', '/api/shows/:id', '/api/catalog', '/api/progress'] })
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) })
    }
  })
  .listen(PORT, () => {
    const n = q('SELECT COUNT(*) n FROM shows').get().n
    console.log(`片库 API: http://localhost:${PORT}/api/shows  （${n} 部）`)
  })
