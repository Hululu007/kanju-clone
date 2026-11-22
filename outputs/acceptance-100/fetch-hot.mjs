import { writeFileSync } from 'node:fs'
const API='https://kanju-api.kenzhao123.workers.dev'
const cats=['tv','movie','variety','anime']
const out={lockedAt:new Date().toISOString(),source:`${API}/api/list?cat=<cat>&sort=heat&limit=25`,rows:[]}
for(const cat of cats){
  const r=await fetch(`${API}/api/list?cat=${cat}&sort=heat&limit=25`)
  const j=await r.json()
  out.rows.push({cat,status:r.status,items:(j.items||[]).map((i,n)=>({rank:n+1,id:i.id,title:i.title,year:i.year,kind:i.kind,heat:i.heatValue,remarks:i.remarks,episodeCount:i.episodeCount}))})
}
writeFileSync('outputs/acceptance-100/hot-100-raw-20261122.json',JSON.stringify(out,null,2))
for(const r of out.rows) console.log(r.cat, r.status, r.items.length, r.items.slice(0,3).map(i=>i.title).join('/'))
