import { readFileSync, writeFileSync } from 'node:fs'
const cats = { tv: 45, movie: 35, variety: 10, anime: 10 }
const names = { tv: '电视剧', movie: '电影', variety: '综艺', anime: '动漫' }
const load = (c) => JSON.parse(readFileSync(`outputs/acceptance-100/raw/list-${c}.json`, 'utf8')).items || []
const pools = Object.fromEntries(Object.keys(cats).map(c => [c, load(c)]))
const chosen = []
const seenTitle = new Set(), seenId = new Set()
const take = (cat, n) => {
  let got = 0
  for (const it of pools[cat]) {
    if (got >= n) break
    if (seenId.has(it.id) || seenTitle.has(it.title)) continue
    seenId.add(it.id); seenTitle.add(it.title)
    chosen.push({
      no: chosen.length + 1, cat, catName: names[cat],
      rank: pools[cat].indexOf(it) + 1,
      id: it.id, title: it.title, year: it.year, kind: it.kind,
      heat: it.heatValue, remarks: it.remarks, episodeCount: it.episodeCount,
    })
    got++
  }
  return got
}
const actual = {}
for (const c of Object.keys(cats)) actual[c] = take(c, cats[c])
// 不足时按 tv→movie→variety→anime 从其余类别未入选热门补足
const order = ['tv', 'movie', 'variety', 'anime']
while (chosen.length < 100) {
  let added = 0
  for (const c of order) {
    if (chosen.length >= 100) break
    added += take(c, 1)
  }
  if (!added) break
}
const out = {
  lockedAt: '2026-11-22 (Asia/Shanghai)',
  source: 'https://kanju-api.kenzhao123.workers.dev/api/list?cat=<cat>&sort=heat (本站分类热榜 hot_rank)',
  quota: cats, actualByCat: Object.fromEntries(Object.keys(cats).map(c => [c, chosen.filter(x => x.cat === c).length])),
  total: chosen.length, items: chosen,
}
writeFileSync('outputs/acceptance-100/hot-100-fixed-20261122.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify({ total: out.total, actualByCat: out.actualByCat }))
for (const c of Object.keys(cats)) console.log(c, chosen.filter(x => x.cat === c).map(x => `${x.rank}.${x.title}`).join(' | ').slice(0, 500))
