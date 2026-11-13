#!/usr/bin/env node
// 把本地 SQLite 片库导出成 D1 可执行的 SQL 分片（worker/seed/*.sql）。
//   node worker/seed.mjs
// 之后：
//   wrangler d1 execute kanju-catalog --remote --file=worker/schema.sql
//   for f in worker/seed/*.sql; do wrangler d1 execute kanju-catalog --remote --file="$f"; done
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDB } from '../server/db.mjs'

const OUT = fileURLToPath(new URL('./seed', import.meta.url))
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const q = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

const db = openDB()
const shows = db
  .prepare(
    "SELECT * FROM shows WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id) ORDER BY downloads DESC"
  )
  .all()
const epsBy = {}
for (const e of db.prepare('SELECT * FROM episodes ORDER BY show_id, idx').all()) {
  ;(epsBy[e.show_id] ||= []).push(e)
}
db.close()

const COLS = [
  'id',
  'title',
  'title_cn',
  'year',
  'category',
  'kind',
  'area_cn',
  'language_cn',
  'tags_cn',
  'remarks_cn',
  'synopsis_cn',
  'poster',
  'runtime',
  'license',
  'collection',
  'downloads',
  'heat_value',
  'playback_count',
  'updated_at',
  'added',
]

const CHUNK_BYTES = 2_800_000 // 每片控制在 2.8MB 以内
let fileIdx = 0
let buf = []
let bytes = 0
let written = 0
let showsInFile = 0
const files = []

const flush = () => {
  if (!buf.length) return
  const name = `seed-${String(fileIdx).padStart(3, '0')}.sql`
  writeFileSync(`${OUT}/${name}`, buf.join('\n') + '\n', 'utf8')
  files.push(name)
  fileIdx++
  buf = []
  bytes = 0
  showsInFile = 0
}

for (const s of shows) {
  const vals = COLS.map((c) => q(s[c]))
  const stmt = `INSERT OR REPLACE INTO shows (${COLS.join(',')}) VALUES (${vals.join(',')});`
  buf.push(stmt)
  bytes += Buffer.byteLength(stmt)
  showsInFile++
  written++

  for (const e of epsBy[s.id] || []) {
    const st = `INSERT OR REPLACE INTO episodes (show_id,idx,label,stream,length,quality) VALUES (${q(
      e.show_id
    )},${q(e.idx)},${q(e.label)},${q(e.stream)},${q(e.length)},${q(e.quality)});`
    buf.push(st)
    bytes += Buffer.byteLength(st)
  }

  if (bytes >= CHUNK_BYTES) flush()
}
flush()

const total = files.reduce((n, f) => n + 1, 0)
console.log(`已生成 ${files.length} 个分片（${written} 部）到 worker/seed/`)
files.slice(0, 3).forEach((f) => console.log('  ', f))
if (total > 3) console.log('   …')
