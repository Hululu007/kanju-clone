// 把片库字段中文化：标题、类型、地区、语言、简介全部改成中文口径
// 用法：node server/localize.mjs
//   会读 server/data/i18n.zh.json（人工/模型翻译的 title_cn + synopsis_cn，可选）
import { openDB } from './db.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const I18N = fileURLToPath(new URL('./data/i18n.zh.json', import.meta.url))
const db = openDB()

// ---- 1. 补列 ----
const cols = new Set(db.prepare('PRAGMA table_info(shows)').all().map((c) => c.name))
const add = (name, def) => {
  if (!cols.has(name)) db.exec(`ALTER TABLE shows ADD COLUMN ${name} ${def}`)
}
add('title_cn', "TEXT DEFAULT ''")
add('kind', "TEXT DEFAULT ''") // series | movie | anime | variety
add('area_cn', "TEXT DEFAULT ''")
add('language_cn', "TEXT DEFAULT ''")
add('remarks_cn', "TEXT DEFAULT ''")
add('tags_cn', "TEXT DEFAULT '[]'")
add('synopsis_cn', "TEXT DEFAULT ''")
add('heat_value', 'REAL DEFAULT 0')
add('playback_count', 'INTEGER DEFAULT 0')
add('updated_at', 'TEXT')

// ---- 2. 词表：英文题材 → 中文标签 ----
const GENRE = [
  [/animat|cartoon|puppet/i, '动画'],
  [/comedy|humor|comic/i, '喜剧'],
  [/drama|melodrama/i, '剧情'],
  [/horror|monster|ghost|vampire/i, '恐怖'],
  [/science fiction|sci-?fi|space|robot|alien/i, '科幻'],
  [/western|cowboy/i, '西部'],
  [/crime|gangster|murder|detective|police/i, '犯罪'],
  [/thriller|suspense|mystery|noir/i, '悬疑'],
  [/romance|love|romantic/i, '爱情'],
  [/war|battle|military|army/i, '战争'],
  [/documentary|documental|educational|instructional|school/i, '纪实'],
  [/news|newsreel|journal/i, '新闻'],
  [/music|musical|song|dance|jazz|opera/i, '歌舞'],
  [/adventure|exploration|travel/i, '冒险'],
  [/family|children|kids|juvenile/i, '家庭'],
  [/silen/i, '默片'],
  [/religio|bible|church|christ/i, '宗教'],
  [/sport|boxing|baseball|football/i, '运动'],
  [/health|hygiene|medical|nutrition|disease/i, '科普'],
  [/advertis|promotional|sponsor|industry|corporat/i, '宣传片'],
  [/nature|animal|wildlife|bird|ocean/i, '自然'],
  [/history|historical|biograph/i, '历史'],
  [/short subject|short film/i, '短片'],
]
const COLLECTION_CN = {
  feature_films: '经典长片',
  silent_films: '默片时代',
  SciFi_Horror: '科幻恐怖',
  short_films: '短片集',
  classic_tv: '老电视剧',
  television: '电视档案',
  animationandcartoons: '经典动画',
  more_animation: '动画短片',
  classic_cartoons: '卡通老片',
  prelinger: '纪录影像',
  universal_newsreels: '新闻纪录片',
}
const KIND_CN = { movie: '电影', tv: '电视剧', anime: '动画', variety: '纪录影像' }

const tagsOf = (row) => {
  let list = []
  try {
    list = JSON.parse(row.genres || '[]')
  } catch {}
  const out = []
  for (const raw of list) {
    const s = String(raw)
    for (const [re, cn] of GENRE) if (re.test(s) && !out.includes(cn)) out.push(cn)
  }
  if (!out.length) {
    // 没识别出题材时，用合集给的默认口径
    const fallback = { movie: '剧情', tv: '剧情', anime: '动画', variety: '纪实' }[row.category] || '剧情'
    out.push(fallback)
  }
  if (row.collection === 'silent_films' && !out.includes('默片')) out.push('默片')
  return out.slice(0, 4)
}

const countryOf = (row) => {
  if (row.collection === 'silent_films' || row.collection === 'feature_films') return '美国'
  if (row.collection === 'prelinger' || row.collection === 'universal_newsreels') return '美国'
  if (row.collection === 'classic_cartoons' || row.collection === 'animationandcartoons') return '美国'
  return '美国'
}
const langOf = (row) => (row.collection === 'silent_films' ? '无声（默片字幕）' : '英语（原声）')

// 档案站的标题常常带着压制信息（"… / Blu-ray / x264 / 720p / Commentary"），先洗干净
const NOISE = /\b(blu-?ray|dvd-?rip|dvd|hdtv|web-?dl|webrip|x264|x265|h\.?264|h\.?265|hevc|avc|mkv|mp4|avi|divx|xvid|mpeg|ac3|aac|720p|1080p|480p|360p|4k|u?hd|remaster(ed)?|restored|commentary|version|print|copy of print|silent|sound|full|part|colorized)\b/gi
const cleanTitle = (raw) => {
  let t = String(raw || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  t = t.split(/\s+\/\s+/)[0] // 斜杠后面基本都是技术信息
  t = t.replace(/\s*[(\[][^)\]]*[)\]]\s*$/g, '').trim() // 去掉结尾括号
  // 反复剥掉技术词，直到稳定
  for (let i = 0; i < 4; i++) {
    const next = t.replace(NOISE, ' ').replace(/\s+/g, ' ').replace(/[\s\-–—]+$/, '').trim()
    if (next === t) break
    t = next
  }
  return t || String(raw || '').trim()
}

const fmtMin = (sec) => {
  const m = Math.round(Number(sec || 0) / 60)
  if (!m) return ''
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`
}

// ---- 3. 中文简介（模板化，保证全中文） ----
function synopsisOf(row, tags, eps, total) {
  const year = row.year ? `${row.year} 年` : '二十世纪'
  const kindCn = KIND_CN[row.category] || '影片'
  const collCn = COLLECTION_CN[row.collection] || '开放影像'
  const tagCn = tags.join('、')
  const len = fmtMin(total)
  const epsDesc =
    eps > 1 ? `全片分为 ${eps} 段，可分段观看` : '单段正片，可直接连播'
  const lines = []
  if (row.category === 'anime') {
    lines.push(`《${row.title_cn || row.title}》是${year}的${tagCn}动画作品，收录于「${collCn}」合集。`)
  } else if (row.category === 'variety') {
    lines.push(
      `《${row.title_cn || row.title}》是${year}的${tagCn}影像，出自「${collCn}」合集，属于那个年代留下来的纪录与宣传素材。`
    )
  } else if (row.category === 'tv') {
    lines.push(`《${row.title_cn || row.title}》是${year}的${tagCn}电视节目，收录于「${collCn}」合集。`)
  } else {
    lines.push(`《${row.title_cn || row.title}》是${year}的${tagCn}${kindCn}，收录于「${collCn}」合集。`)
  }
  if (len) lines.push(`片长约 ${len}，${epsDesc}。`)
  else lines.push(`${epsDesc}。`)
  lines.push(
    `画面为 Internet Archive 的开放授权（公有领域）版本，${langOf(row)}，可免费在线观看，也可下载回看。`
  )
  return lines.join('')
}

// ---- 4. 逐条写入 ----
const i18n = existsSync(I18N) ? JSON.parse(readFileSync(I18N, 'utf8')) : {}
const shows = db.prepare('SELECT * FROM shows').all()
const epsOf = db.prepare('SELECT COUNT(*) n, SUM(length) total FROM episodes WHERE show_id=?')
const upd = db.prepare(
  `UPDATE shows SET title_cn=?, kind=?, area_cn=?, language_cn=?, remarks_cn=?, tags_cn=?,
     synopsis_cn=?, heat_value=?, playback_count=?, updated_at=? WHERE id=?`
)

let translated = 0
const stamp = new Date().toISOString()
for (const row of shows) {
  const tags = tagsOf(row)
  const { n: eps, total } = epsOf.get(row.id)
  const t = i18n[row.id] || {}
  const titleCn = t.title || row.title_cn || ''
  const cleanName = cleanTitle(row.title)
  const row2 = { ...row, title_cn: titleCn }
  const synopsis = t.synopsis || synopsisOf(row2, tags, eps || 0, total)
  if (cleanName && cleanName !== row.title) {
    db.prepare('UPDATE shows SET title=? WHERE id=?').run(cleanName, row.id)
  }
  if (t.synopsis) translated++
  const remarks =
    eps > 1 ? `全 ${eps} 段` : Number(total) > 0 ? fmtMin(total) : '正片'
  upd.run(
    titleCn,
    row.category,
    countryOf(row),
    langOf(row),
    remarks,
    JSON.stringify(tags),
    synopsis,
    Number(row.downloads || 0) / 10,
    row.downloads || 0,
    stamp,
    row.id
  )
}

console.log(`已中文化 ${shows.length} 部（其中 ${translated} 部带人工翻译简介）`)
const sample = db
  .prepare("SELECT title, title_cn, tags_cn, remarks_cn, synopsis_cn FROM shows WHERE title_cn != '' LIMIT 3")
  .all()
sample.forEach((s) => console.log('示例：', JSON.stringify(s)))
