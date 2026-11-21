// 从本地 kanju.db 导出一致副本 → D1 可导入的分批 SQL
// 用法： node cloud/export-d1.mjs [输出目录]
//   默认输出到 cloud/.d1-export/（已 gitignore，含播放凭证，不要提交）
//
// 只导前端与只读接口真正需要的表/列，尽量缩体积：
//   shows(有分集的)  episodes(token 等)  sources(指纹核对)  provider_health  provider_baseline
// 不导：progress（进度仍走 localStorage）、stream 直链（会过期）、以及采集期的冗余字段
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../', import.meta.url)
const DB = fileURLToPath(new URL('server/data/kanju.db', ROOT))
const OUT = process.argv[2] || fileURLToPath(new URL('.d1-export/', new URL('./', import.meta.url)))
const MAX_STATEMENT_BYTES = 48 * 1024
const MAX_FILE_BYTES = 800 * 1024

const TABLES = [
  {
    name: 'shows',
    columns: [
      'id',
      'title',
      'year',
      'content_kind',
      'area',
      'language',
      'genres',
      'actors',
      'directors',
      'poster',
      'backdrop',
      'description',
      'remarks',
      'episode_count',
      'available_episode_count',
      'heat_value',
      'updated_at',
    ],
    sql: `SELECT id,title,year,content_kind,area,language,genres,actors,directors,poster,backdrop,description,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE EXISTS(SELECT 1 FROM episodes e WHERE e.show_id = shows.id) ORDER BY id`,
  },
  {
    name: 'episodes',
    columns: ['show_id', 'idx', 'number', 'key', 'title', 'token', 'quality', 'line_label', 'provider', 'stream_kind'],
    sql: null,
  },
  {
    name: 'sources',
    columns: ['show_id', 'ep_idx', 'provider', 'label', 'url', 'kind', 'fingerprint', 'segments', 'duration', 'status'],
    sql: null,
  },
  { name: 'provider_health', columns: ['show_id', 'provider', 'verdict', 'detail'], sql: null },
  { name: 'provider_baseline', columns: ['show_id', 'provider', 'ep_idx', 'fingerprint', 'segments', 'duration'], sql: null },
]

const q = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return `'${String(v).replace(/'/g, "''")}'`
}

fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.sql')) fs.unlinkSync(path.join(OUT, f))

const db = new DatabaseSync(DB, { readOnly: true })
const summary = []

for (const t of TABLES) {
  const cols = t.columns.join(',')
  const sql = t.sql ?? `SELECT ${cols} FROM ${t.name}`
  const stmt = db.prepare(sql)
  let fileIdx = 0
  let fileBytes = 0
  let fileFd = null
  let fileCount = 0
  let rows = 0
  let stmtRows = []
  let stmtBytes = 0

  const openFile = () => {
    const name = `${t.name}-${String(fileIdx).padStart(3, '0')}.sql`
    fileIdx++
    fileFd = fs.openSync(path.join(OUT, name), 'w')
    fileBytes = 0
    fileCount++
  }
  const write = (s) => {
    const b = Buffer.byteLength(s)
    fs.writeSync(fileFd, s)
    fileBytes += b
  }
  const flushStmt = () => {
    if (!stmtRows.length) return
    const head = `INSERT INTO ${t.name}(${cols}) VALUES\n`
    const body = stmtRows.join(',\n')
    const tail = ';\n'
    const total = Buffer.byteLength(head) + Buffer.byteLength(body) + Buffer.byteLength(tail)
    const chunkBytes = Buffer.byteLength(body) + 4096
    if (fileFd === null || fileBytes + chunkBytes > MAX_FILE_BYTES) {
      if (fileFd !== null) fs.closeSync(fileFd)
      openFile()
    }
    write(head + body + tail)
    stmtRows = []
    stmtBytes = 0
    void total
  }

  openFile()
  for (const row of stmt.all()) {
    const values = t.columns.map((c) => q(row[c])).join(',')
    stmtRows.push(`(${values})`)
    stmtBytes += Buffer.byteLength(values) + 4
    rows++
    if (stmtBytes >= MAX_STATEMENT_BYTES) flushStmt()
  }
  flushStmt()
  if (fileFd !== null) fs.closeSync(fileFd)
  summary.push({ table: t.name, rows, files: fileCount })
  console.log(`${t.name}: ${rows} 行 → ${fileCount} 个文件`)
}

db.close()

// 体积合计
let total = 0
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.sql')) total += fs.statSync(path.join(OUT, f)).size
console.log(`合计 ${(total / 1048576).toFixed(1)} MB → ${OUT}`)
fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify({ summary, totalBytes: total }, null, 1))
