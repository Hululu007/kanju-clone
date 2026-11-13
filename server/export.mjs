#!/usr/bin/env node
// 把 SQLite 片库导出成前端可直接 import 的静态模块（字段完全中文化），
// 让 GitHub Pages 这类纯静态托管也能带上整套片库（含真实可播放地址）。
//
//   node server/localize.mjs   # 先把标题/题材/简介中文化
//   node server/export.mjs     # 再写 src/catalog.gen.js
//
// 字段口径参考原站 /v1/feed/home 的卡片结构（title / content_kind / area / genres /
// remarks / playback_groups / availability / heat_value …），这里做了中文简化版。

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDB } from './db.mjs'

const db = openDB()

const KIND = { movie: 'movie', tv: 'series', anime: 'anime', variety: 'documentary' }
const KIND_CN = { movie: '电影', tv: '电视剧', anime: '动画', variety: '纪录影像' }

const shows = db.prepare('SELECT * FROM shows ORDER BY downloads DESC').all().map((s) => {
  const tags = (() => {
    try {
      return JSON.parse(s.tags_cn || '[]')
    } catch {
      return []
    }
  })()
  return {
    id: s.id,
    title: s.title_cn || s.title,
    originalTitle: s.title_cn && s.title_cn !== s.title ? s.title : '',
    year: s.year,
    cat: s.category,
    kind: KIND[s.category] || 'movie',
    kindLabel: KIND_CN[s.category] || '影视',
    area: s.area_cn || '美国',
    language: s.language_cn || '英语',
    genres: tags.length ? tags : ['剧情'],
    remarks: s.remarks_cn || '',
    headline: `${s.area_cn || '美国'} · ${s.year || '二十世纪'} · ${(tags[0] || KIND_CN[s.category] || '影视')}`,
    synopsis: s.synopsis_cn || '',
    poster: s.poster,
    backdrop: s.poster,
    heatValue: Math.round(Number(s.heat_value || 0)),
    playbackCount: Number(s.playback_count || 0),
    updatedAt: s.updated_at,
    collection: s.collection,
    license: s.license,
    runtime: s.runtime,
  }
})

const eps = {}
for (const e of db
  .prepare('SELECT show_id,idx,label,stream,length,quality FROM episodes ORDER BY show_id, idx')
  .all()) {
  ;(eps[e.show_id] ||= []).push({
    idx: e.idx,
    label: e.label,
    url: e.stream,
    length: e.length,
    quality: e.quality,
  })
}

for (const s of shows) {
  const list = eps[s.id] || []
  s.episodeCount = list.length
  s.groups = list.length
    ? [
        {
          id: 'web',
          label: '网页播放器',
          type: 'player',
          episodeCount: list.length,
          episodes: list,
        },
      ]
    : []
  s.availability = {
    state: list.length ? 'playable' : 'unavailable',
    label: list.length ? '可播放' : '暂无片源',
    playable: list.length > 0,
  }
  s.episodes = list
}

const out = fileURLToPath(new URL('../src/catalog.gen.js', import.meta.url))
const banner = `// 由 server/export.mjs 从 SQLite 片库自动生成，请勿手改。
// 片源：Internet Archive 开放授权 / 公有领域影片。生成时间 ${new Date().toISOString()}
`
writeFileSync(out, `${banner}export default ${JSON.stringify(shows, null, 1)}\n`, 'utf8')

const playable = shows.filter((s) => s.episodes.length).length
const cnTitle = shows.filter((s) => s.title !== s.originalTitle || !s.originalTitle).length
console.log(
  `已导出 ${shows.length} 部（可播放 ${playable} 部，中文标题 ${cnTitle} 部）-> src/catalog.gen.js`
)
db.close()
