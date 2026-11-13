// 逐个片子解析第一集，判定「公开可播 / 需要原站登录」，结果写回 shows.play_state
import { DatabaseSync } from 'node:sqlite'
import { api, call } from './kanju-client.mjs'

const db = new DatabaseSync(new URL('./data/kanju.db', import.meta.url))
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;')
const cols = db.prepare('PRAGMA table_info(shows)').all().map((c) => c.name)
if (!cols.includes('play_state')) db.exec('ALTER TABLE shows ADD COLUMN play_state TEXT')

const LIMIT = Number(process.env.LIMIT || 2000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 4)
const ONLY = process.env.STATE || '' // 重跑某一种状态：playable / login_required / error

const rows = db
  .prepare(
    `SELECT s.id, s.title,
            (SELECT token FROM episodes e WHERE e.show_id = s.id AND e.token IS NOT NULL ORDER BY e.idx LIMIT 1) AS token
     FROM shows s
     WHERE ${ONLY ? 's.play_state = ?' : 's.play_state IS NULL'}
       AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = s.id)
     ORDER BY COALESCE(s.heat_value, 0) DESC LIMIT ?`,
  )
  .all(...(ONLY ? [ONLY, LIMIT] : [LIMIT]))

const mark = db.prepare('UPDATE shows SET play_state=? WHERE id=?')
const stat = { playable: 0, login_required: 0, error: 0, done: 0 }
const started = Date.now()
let cursor = 0

async function judge(token) {
  const r = await api.resolve(token)
  const opt = (r.line_options || []).find((o) => o.url_kind === 'resolve_ticket' || o.type === 'player')
  if (!opt) return 'error'
  const ticket = String(opt.url || '').replace(/^resolve:\/\//, '')
  await call('/v1/playback/resolve-line', { method: 'POST', body: { ticket } })
  return 'playable'
}

async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++]
    let state = 'error'
    try {
      state = await judge(row.token)
    } catch (e) {
      const body = String(e.body || e.message || '')
      state = /login_required|playback_user_session_required/.test(body) ? 'login_required' : 'error'
    }
    mark.run(state, row.id)
    stat[state]++
    stat.done++
    if (stat.done % 25 === 0) console.log(JSON.stringify({ ...stat, sec: ((Date.now() - started) / 1000).toFixed(0) }))
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log('完成', JSON.stringify(stat), ((Date.now() - started) / 1000).toFixed(1) + 's')
await new Promise((r) => setTimeout(r, 300))
process.exit(0)
