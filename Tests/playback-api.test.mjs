import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker from '../worker/api/src/index.js'

const schema = readFileSync(new URL('../worker/api/schema.sql', import.meta.url), 'utf8')
const segments = [720, 1080].map((height) => readFileSync(new URL(`./fixtures/avc-${height}.ts`, import.meta.url)))

function fixture(t, { media = 'hls', sameContent = false, lines = ['bad', 'good'], heights = {}, delays = {} } = {}) {
  const fetchLog = []
  const fetchStarts = new Map()
  // 记录这次请求实际打了多少次 D1，用来守住「快取命中只做有界读」。
  const dbLog = []
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const env = { KJ_SECRET: 'test-only', DB: { prepare(sql) { dbLog.push(sql); return { bind(...args) {
    return {
      first: async () => sqlite.prepare(sql).get(...args),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
    }
  } } } } }
  t.after(() => sqlite.close())
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input)
    fetchLog.push(url.pathname)
    if (!fetchStarts.has(url.pathname)) fetchStarts.set(url.pathname, Date.now())
    const headers = { 'access-control-allow-origin': '*' }
    const show = url.pathname.match(/resolve\/(.+)-([12])$/)
    if (show) {
      const [, id, ep] = show
      const lineUrl = (provider) => {
        const heightTag = heights[provider] ? `-${heights[provider]}` : ''
        if (provider === 'bad') return `https://media.example/${id}/broken.m3u8`
        if (provider === 'good') return `https://media.example/${id}/${sameContent ? 1 : ep}${heightTag}.${media === 'mp4' ? 'mp4' : 'm3u8'}`
        return `https://media.example/${id}/${provider}${heightTag}.${media === 'mp4' ? 'mp4' : 'm3u8'}`
      }
      return Response.json({ current_episode: { episode_number: Number(ep) }, line_options: lines.map((provider) => ({ provider_id: provider, url: lineUrl(provider) })) })
    }
    if (url.hostname !== 'media.example') return new Response(null, { status: 404 })
    // 按线路指定响应延迟，模拟慢线路（例如手选线路 6.25 秒才返回）；
    // 延迟要放在 404 之前，才能模拟「首条很慢才失败」。
    const slowProvider = Object.keys(delays).find((provider) => url.pathname.includes(`/${provider}.`) || url.pathname.includes(`/${provider}-`))
    if (slowProvider) await new Promise((resolve) => setTimeout(resolve, delays[slowProvider]))
    if (url.pathname.includes('broken')) return new Response(null, { status: 404 })
    const second = /2\.(m3u8|ts)$/.test(url.pathname)
    // 线路名带清晰度后缀（如 sd-720.m3u8）时用它决定分片内容，655 与 1080 各自一段。
    const name = url.pathname.split('/').pop()
    const heightHit = name.match(/-(720|1080)\.(?:m3u8|ts)$/)
    const mp4 = new Uint8Array(2048)
    mp4.set(new TextEncoder().encode('ftyp'), 4)
    const body = url.pathname.endsWith('.mp4') ? mp4
      : url.pathname.endsWith('.m3u8') ? `#EXTM3U\n#EXTINF:4,\n${heightHit ? name.replace(/\.m3u8$/, '.ts') : `${second ? 2 : 1}.ts`}`
        : segments[heightHit ? (heightHit[1] === '1080' ? 1 : 0) : Number(second)]
    const response = new Response(body, { headers })
    Object.defineProperty(response, 'url', { value: url.href })
    return response
  })
  const request = (path, options) => worker.fetch(new Request(`https://worker.example${path}`, options), env)
  const seed = (id) => {
    sqlite.prepare('INSERT INTO shows(id,title) VALUES(?,?)').run(id, id)
    for (let i = 0; i < 2; i++) sqlite.prepare('INSERT INTO episodes(show_id,idx,number,token) VALUES(?,?,?,?)').run(id, i, i + 1, `${id}-${i + 1}`)
  }
  const login = async (id = 'user-1') => {
    const token = `test-session-${id}`.padEnd(43, 'T')
    const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    const hash = [...new Uint8Array(tokenHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    sqlite.prepare('INSERT INTO users(id,username,normalized_username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, id, id, 'placeholder', Date.now(), Date.now())
    sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)').run(hash, id, Date.now(), Date.now() + 3_600_000, Date.now())
    return { authorization: `Bearer ${token}` }
  }
  return { seed, request, sqlite, fetchLog, fetchStarts, dbLog, login }
}

test('distinct HLS first segments do not disable a provider for the whole show', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t)
  seed('fingerprint')
  sqlite.prepare("INSERT INTO provider_health(show_id,provider,verdict,detail) VALUES('fingerprint','good','dup','第1集与第2集同内容')").run()
  const first = await (await request('/api/play?show=fingerprint&ep=0')).json()
  const second = await (await request('/api/play?show=fingerprint&ep=1')).json()
  assert.equal(first.provider, 'good', JSON.stringify({ first, second }))
  assert.equal(second.provider, 'good', JSON.stringify({ first, second, sources: sqlite.prepare('SELECT ep_idx, fingerprint FROM sources').all(), fetchLog }))
  assert.notEqual(first.fingerprint, second.fingerprint)
})

test('strict recovery never falls back to a different provider', async (t) => {
  const { seed, request } = fixture(t)
  seed('strict')
  const strict = await (await request('/api/play?show=strict&line=bad&strict=1')).json()
  assert.equal(strict.url, undefined)
  const manual = await (await request('/api/play?show=strict&line=good')).json()
  assert.deepEqual(manual.options.map(({ provider }) => provider).sort(), ['bad', 'good'])
})

test('playback results require a session and count once per attempt', async (t) => {
  const { seed, request, sqlite, login } = fixture(t)
  seed('reported')
  const headers = await login()
  const { attemptId } = await (await request('/api/play?show=reported', { headers })).json()
  const payload = { showId: 'reported', provider: 'good', ok: true, attemptId }
  const post = (headers = {}) => request('/api/playback-result', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })
  assert.equal((await post()).status, 401)
  assert.equal((await post(headers)).status, 200)
  assert.equal((await post(headers)).status, 200)
  assert.equal(sqlite.prepare("SELECT successes, failures FROM provider_playback_stats WHERE show_id='reported' AND provider='good'").get().successes, 1)
})

for (const media of ['hls', 'mp4']) {
  test(`${media} cross-episode collisions stay disabled when revisiting the original episode`, async (t) => {
    const { seed, request, sqlite } = fixture(t, { media, sameContent: true })
    const id = `collision-${media}`
    seed(id)
    const first = await (await request(`/api/play?show=${id}&ep=0&line=good&strict=1`)).json()
    assert.equal(first.provider, 'good')
    assert.equal(sqlite.prepare('SELECT count(*) n FROM provider_baseline').get().n, 0)
    const second = await (await request(`/api/play?show=${id}&ep=1&line=good&strict=1`)).json()
    assert.equal(second.url, undefined, 'the second episode must not return the first episode media')
    const again = await (await request(`/api/play?show=${id}&ep=0&line=good&strict=1`)).json()
    assert.equal(again.url, undefined, 'a confirmed duplicate must remain disabled')
    assert.equal(sqlite.prepare('SELECT verdict FROM provider_health WHERE show_id=? AND provider=?').get(id, 'good').verdict, 'dup')
  })
}

test('confirmed collisions invalidate a previously cached default playback', async (t) => {
  const { seed, request } = fixture(t, { sameContent: true })
  seed('collision-cache')
  assert.equal((await (await request('/api/play?show=collision-cache&ep=0')).json()).provider, 'good')
  assert.equal((await (await request('/api/play?show=collision-cache&ep=1&line=good&strict=1')).json()).url, undefined)
  assert.equal((await (await request('/api/play?show=collision-cache&ep=0')).json()).url, undefined)
})

test('results reject invented attempts, other users, mismatched routes, expired and altered tokens', async (t) => {
  const { seed, request, sqlite, login } = fixture(t)
  seed('issued')
  const owner = await login()
  const other = await login('user-2')
  const play = await (await request('/api/play?show=issued', { headers: owner })).json()
  const post = (attemptId, headers = owner, changes = {}) => request('/api/playback-result', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ showId: 'issued', provider: 'good', ok: true, attemptId, ...changes }),
  })
  for (let i = 0; i < 3; i++) assert.equal((await post(crypto.randomUUID())).status, 403, 'a new UUID is not a server-issued attempt')
  assert.equal((await post(play.attemptId, other)).status, 403)
  assert.equal((await post(play.attemptId, owner, { provider: 'bad' })).status, 403)
  assert.equal((await post(play.attemptId, owner, { showId: 'another-show' })).status, 403)
  const altered = play.attemptId.slice(0, -1) + (play.attemptId.endsWith('a') ? 'b' : 'a')
  assert.equal((await post(altered)).status, 403)
  const now = Date.now()
  const realNow = Date.now
  t.mock.method(Date, 'now', () => now + 31 * 60_000)
  assert.equal((await post(play.attemptId)).status, 403)
  Date.now = realNow
  assert.equal(sqlite.prepare('SELECT count(*) n FROM provider_playback_stats').get().n, 0)
  const responses = await Promise.all([post(play.attemptId), post(play.attemptId), post(play.attemptId, owner, { ok: false })])
  assert.ok(responses.every((response) => response.status === 200))
  const stats = sqlite.prepare('SELECT successes, failures FROM provider_playback_stats').get()
  assert.equal(stats.successes + stats.failures, 1)
})

test('cached playback issues distinct user-bound attempts and anonymous playback cannot report', async (t) => {
  const { seed, request, login } = fixture(t)
  seed('issued-cache')
  const owner = await login()
  const other = await login('user-2')
  const first = await (await request('/api/play?show=issued-cache', { headers: owner })).json()
  const second = await (await request('/api/play?show=issued-cache', { headers: other })).json()
  assert.equal(second.cached, true)
  assert.notEqual(first.attemptId, second.attemptId)
  const post = (attemptId, headers) => request('/api/playback-result', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ showId: 'issued-cache', provider: 'good', ok: true, attemptId }) })
  assert.equal((await post(second.attemptId, owner)).status, 403)
  assert.equal((await post(first.attemptId, owner)).status, 200)
  assert.equal((await post(second.attemptId, other)).status, 200)
  const anonymous = await (await request('/api/play?show=issued-cache')).json()
  assert.equal(anonymous.provider, 'good')
  assert.ok(!anonymous.attemptId, 'anonymous media responses do not issue feedback credentials')
})

test('probe failures do not contribute to browser playback history', async (t) => {
  const { seed, request } = fixture(t)
  seed('stats')
  const play = await (await request('/api/play?show=stats')).json()
  const bad = play.options.find(({ provider }) => provider === 'bad')
  assert.equal(bad.status, 'dead')
  const lines = await (await request('/api/lines?show=stats')).json()
  assert.equal(lines.options.find(({ provider }) => provider === 'bad').successRate, null)
})

// checkedAt 一律按「当前时间之前」算：写死日期会让用例随系统时钟失效（2026-11-22 审核 P2）。
const sqlTimestamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

const insertSource = (sqlite, showId, epIdx, provider, { label = provider, quality = 0, status = 'ok', checkedAt = sqlTimestamp(Date.now()) } = {}) => {
  sqlite.prepare(`INSERT INTO sources(show_id,ep_idx,provider,label,url,kind,segments,duration,quality,status,checked_at)
    VALUES(?,?,?,?,?,'hls',1,4,?,?,?)`).run(showId, epIdx, provider, label, `https://media.example/${showId}/${epIdx}-${provider}.m3u8`, quality, status, checkedAt)
}

test('命中已验证直链时不再解析上游、也不再探测候选（长嵌套请求会被平台按 CPU 上限掐断）', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t, { lines: ['good', 'bad', 'spare'] })
  seed('verified-fast')
  insertSource(sqlite, 'verified-fast', 0, 'good', { quality: 1080 })
  const started = Date.now()
  const play = await (await request('/api/play?show=verified-fast&ep=0&quality=1080')).json()
  const elapsed = Date.now() - started
  assert.equal(play.provider, 'good')
  assert.equal(play.verifiedSourceCache, true, JSON.stringify(play))
  assert.equal(play.url, 'https://media.example/verified-fast/0-good.m3u8')
  assert.equal(play.quality, 1080)
  assert.ok(!fetchLog.some((path) => path.includes('/v1/playback/resolve/')), `不该解析上游：${fetchLog.join(',')}`)
  assert.ok(!fetchLog.some((path) => path.startsWith('/verified-fast/')), `不该探测候选：${fetchLog.join(',')}`)
  assert.ok(elapsed < 2000, `快取应当很快：${elapsed}ms`)
})

test('已验证直链快取也按清晰度选线，不会因为上次成功的 720 线路而降级', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t)
  seed('verified-quality')
  insertSource(sqlite, 'verified-quality', 0, 'sd', { quality: 720 })
  insertSource(sqlite, 'verified-quality', 0, 'hd', { quality: 1080 })
  const play = await (await request('/api/play?show=verified-quality&ep=0&preferred=sd&quality=1080')).json()
  assert.equal(play.provider, 'hd', JSON.stringify(play.options))
  assert.equal(play.quality, 1080)
  assert.ok(!fetchLog.some((path) => path.startsWith('/verified-quality/')), `不该探测候选：${fetchLog.join(',')}`)
})

test('库里高清晰度记录都是 dead 时，不能把 1080 请求降成 720（审核 P1-1）', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 720, hd: 1080 } })
  seed('verified-dead-hd')
  insertSource(sqlite, 'verified-dead-hd', 0, 'sd', { quality: 720 })
  // 这条 1080 已经判定失效：不能拿它当「库里已有 1080」的理由把请求降级成 720。
  insertSource(sqlite, 'verified-dead-hd', 0, 'hd', { quality: 1080, status: 'dead' })
  const play = await (await request('/api/play?show=verified-dead-hd&ep=0&preferred=sd&quality=1080')).json()
  assert.equal(play.verifiedSourceCache, undefined, `dead 记录不能让快取降级返回：${JSON.stringify(play.options)}`)
  assert.equal(play.provider, 'hd')
  assert.equal(play.quality, 1080)
})

test('过期直链不复用，回到完整解析', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t)
  seed('verified-stale')
  insertSource(sqlite, 'verified-stale', 0, 'good', { quality: 1080, checkedAt: '2020-01-01 00:00:00' })
  const play = await (await request('/api/play?show=verified-stale&ep=0')).json()
  assert.ok(fetchLog.some((path) => path.includes('/v1/playback/resolve/')), `过期直链必须重新解析：${fetchLog.join(',')}`)
  assert.equal(play.verifiedSourceCache, undefined)
})

test('被判为串集或需会员的线路不会从已验证直链快取里返回', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t)
  seed('verified-dup')
  insertSource(sqlite, 'verified-dup', 0, 'sd', { quality: 720 })
  insertSource(sqlite, 'verified-dup', 0, 'hd', { quality: 1080 })
  sqlite.prepare("INSERT INTO provider_health(show_id,provider,verdict,detail) VALUES('verified-dup','hd','dup','fingerprint-v2:第1集与第2集同内容')").run()
  // 没有更高的清晰度要求：快取按库里剩下的可用线路返回 sd，绝不返回被判串集的 hd。
  const cached = await (await request('/api/play?show=verified-dup&ep=0&quality=720')).json()
  assert.equal(cached.provider, 'sd', JSON.stringify(cached.options))
  assert.ok(!cached.options.some((option) => option.provider === 'hd'), '串集线路不能出现在换源列表')
  assert.ok(!fetchLog.some((path) => path.startsWith('/verified-dup/')), `不该探测候选：${fetchLog.join(',')}`)
  // 请求 1080 时不能拿那条已废的 1080 记录当「库里已有 1080」的理由降级成 720，要回完整路径重新验证。
  const full = await (await request('/api/play?show=verified-dup&ep=0&quality=1080')).json()
  assert.notEqual(full.verifiedSourceCache, true, '高清晰度记录全废时必须回完整路径')
  assert.notEqual(full.provider, 'hd', '串集线路不能被当成可用线路返回')
})

test('手选线路不吃已验证直链快取，仍走完整解析', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t)
  seed('verified-manual')
  insertSource(sqlite, 'verified-manual', 0, 'good', { quality: 1080 })
  const play = await (await request('/api/play?show=verified-manual&ep=0&line=good&strict=1')).json()
  assert.equal(play.provider, 'good')
  assert.ok(fetchLog.some((path) => path.includes('/v1/playback/resolve/')), `手选线路必须重新解析：${fetchLog.join(',')}`)
  assert.equal(play.verifiedSourceCache, undefined)
})

test('没有原站默认记录时先探到 720 不能把 quality=1080 降级', async (t) => {
  const { seed, request } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 720, hd: 1080 } })
  seed('quality-order')
  const play = await (await request('/api/play?show=quality-order&ep=0&quality=1080')).json()
  assert.equal(play.provider, 'hd', '列表第一条只是上游顺序，不能当成默认项抢先返回')
  assert.equal(play.quality, 1080)
})

test('播放器带上次成功线路时，原站默认的 720 也不能把 quality=1080 降级', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 720, hd: 1080 } })
  seed('preferred-quality')
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('preferred-quality','sd','')").run()
  const play = await (await request('/api/play?show=preferred-quality&ep=0&preferred=sd&quality=1080')).json()
  assert.equal(play.provider, 'hd', JSON.stringify(play.options))
  assert.equal(play.quality, 1080)
})

test('快取只有 720P、请求 1080P 时不能降级：上游可能还有更高的一条', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 720, hd: 1080 } })
  seed('verified-lower-quality')
  insertSource(sqlite, 'verified-lower-quality', 0, 'sd', { quality: 720 })
  const play = await (await request('/api/play?show=verified-lower-quality&ep=0&preferred=sd&quality=1080')).json()
  assert.equal(play.provider, 'hd', JSON.stringify(play.options))
  assert.equal(play.quality, 1080)
  assert.ok(fetchLog.some((path) => path.includes('/v1/playback/resolve/')), `库里没有 1080 时必须回完整解析：${fetchLog.join(',')}`)
})

test('原站默认线路不在快取里时回完整解析，不改默认线路', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 1080, hd: 1080 } })
  seed('verified-default-missing')
  insertSource(sqlite, 'verified-default-missing', 0, 'sd', { quality: 1080 })
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('verified-default-missing','hd','')").run()
  const play = await (await request('/api/play?show=verified-default-missing&ep=0&quality=1080')).json()
  assert.equal(play.provider, 'hd', `默认线路必须跟原站一致：${JSON.stringify(play.options)}`)
})

test('只带 strict=1 也不能吃已验证直链快取', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t, { lines: ['good'], heights: { good: 1080 } })
  seed('verified-strict')
  insertSource(sqlite, 'verified-strict', 0, 'good', { quality: 1080 })
  const play = await (await request('/api/play?show=verified-strict&ep=0&strict=1&quality=1080')).json()
  assert.equal(play.provider, 'good')
  assert.ok(fetchLog.some((path) => path.includes('/v1/playback/resolve/')), `strict=1 必须重新解析：${fetchLog.join(',')}`)
  assert.equal(play.verifiedSourceCache, undefined)
})

test('快取命中后线路被判为需要会员，90 秒内存快取也不能再返回它', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['good', 'spare'], heights: { good: 1080, spare: 1080 } })
  seed('verified-member')
  insertSource(sqlite, 'verified-member', 0, 'good', { quality: 1080, checkedAt: sqlTimestamp(Date.now() - 60_000) })
  insertSource(sqlite, 'verified-member', 0, 'spare', { quality: 1080, checkedAt: sqlTimestamp(Date.now() - 3_600_000) })
  const first = await (await request('/api/play?show=verified-member&ep=0&quality=1080')).json()
  assert.equal(first.provider, 'good', JSON.stringify(first.options))
  sqlite.prepare("INSERT INTO provider_health(show_id,provider,verdict,detail) VALUES('verified-member','good','member','需要登录/会员')").run()
  const second = await (await request('/api/play?show=verified-member&ep=0&quality=1080')).json()
  assert.equal(second.provider, 'spare', `会员线路不能再从内存快取返回：${JSON.stringify(second.options)}`)
})

test('命中已验证直链时不等待 /v1/catalog，也不发任何上游请求', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t, { lines: ['good'], heights: { good: 1080 } })
  seed('verified-nocatalog')
  insertSource(sqlite, 'verified-nocatalog', 0, 'good', { quality: 1080 })
  const play = await (await request('/api/play?show=verified-nocatalog&ep=0&quality=1080')).json()
  assert.equal(play.verifiedSourceCache, true)
  assert.equal(play.skip, null, `缺片头设置时不能现拉 catalog：${JSON.stringify(play.skip)}`)
  assert.ok(!fetchLog.some((path) => path.startsWith('/v1/catalog/')), `不能等 catalog：${fetchLog.join(',')}`)
})

test('已验证直链快取只做有界读取：命中路径 D1 查询不超过 4 次', async (t) => {
  const { seed, request, sqlite, dbLog } = fixture(t, { lines: ['good'], heights: { good: 1080 } })
  seed('verified-bounded')
  insertSource(sqlite, 'verified-bounded', 0, 'good', { quality: 1080 })
  dbLog.length = 0
  const play = await (await request('/api/play?show=verified-bounded&ep=0&quality=1080')).json()
  assert.equal(play.verifiedSourceCache, true)
  assert.ok(dbLog.length <= 4, `命中路径 D1 查询 ${dbLog.length} 次：${dbLog.join(' | ')}`)
})

test('命中快取要标明线路列表只是库内已验证的部分，播放器必须补拉完整列表', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['good', 'spare'], heights: { good: 1080 } })
  seed('verified-partial')
  insertSource(sqlite, 'verified-partial', 0, 'good', { quality: 1080 })
  const play = await (await request('/api/play?show=verified-partial&ep=0&quality=1080')).json()
  assert.equal(play.verifiedSourceCache, true)
  assert.equal(play.optionsPartial, true, '快取列表不是整集线路清单，必须让播放器补拉')
})

test('原站默认线路低于请求清晰度时，快取与原版一样返回默认线路（不算降级）', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['official', 'other'], heights: { official: 720, other: 1080 } })
  seed('verified-default-quality')
  insertSource(sqlite, 'verified-default-quality', 0, 'official', { quality: 720 })
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('verified-default-quality','official','')").run()
  const fast = await (await request('/api/play?show=verified-default-quality&ep=0&quality=1080')).json()
  // 带 strict=1 的那次强制走完整解析，就是原版的答案（也不能吃 90 秒内存快取）。
  const full = await (await request('/api/play?show=verified-default-quality&ep=0&strict=1&quality=1080')).json()
  assert.equal(fast.verifiedSourceCache, true)
  assert.equal(full.verifiedSourceCache, undefined)
  assert.equal(fast.provider, full.provider)
  assert.equal(fast.quality, full.quality)
  // 带上次成功线路（preferred）时原版按清晰度选，快取不能拿 720 顶替：两边都必须给 1080 那条。
  const fullPreferred = await (await request('/api/play?show=verified-default-quality&ep=0&strict=1&preferred=official&quality=1080')).json()
  const fastPreferred = await (await request('/api/play?show=verified-default-quality&ep=0&preferred=official&quality=1080')).json()
  assert.equal(fastPreferred.provider, fullPreferred.provider)
  assert.equal(fastPreferred.quality, 1080)
})

test('手选线路 6.25 秒才响应仍然可播（首条提前返回不能缩短它的超时）', async (t) => {
  const { seed, request } = fixture(t, { media: 'mp4', lines: ['slowline'], delays: { slowline: 6250 } })
  seed('slow-manual')
  const response = await request('/api/play?show=slow-manual&ep=0&line=slowline&strict=1')
  const play = await response.json()
  assert.equal(response.status, 200, JSON.stringify(play))
  assert.equal(play.provider, 'slowline')
})

test('慢首条失败时备用线路仍与它并行探测（不能等首条失败后才开始）', async (t) => {
  const lines = ['broken-lead', ...Array.from({ length: 8 }, (_, i) => `broken${i}`), 'good']
  const delays = { 'broken-lead': 3000, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`broken${i}`, 300])) }
  const { seed, request, sqlite, fetchStarts } = fixture(t, { lines, delays })
  seed('slow-lead-fail')
  // 原站默认就是这条慢首条：旧版会先单独等它，等失败后才开始探其余候选。
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('slow-lead-fail','broken-lead','')").run()
  const started = Date.now()
  const play = await (await request('/api/play?show=slow-lead-fail&ep=0')).json()
  assert.equal(play.provider, 'good', JSON.stringify(play.tried))
  // 关键不是总耗时，而是可播的备用线在慢首条还没失败时就已经开始探测了：
  // 并行时它在 1 秒内就被请求；先等首条 3 秒、再顺序探 8 条，最早也要 3.3 秒后。
  const goodAt = fetchStarts.get('/slow-lead-fail/1.m3u8')
  assert.ok(goodAt, `备用线根本没被探测：${[...fetchStarts.keys()].join(',')}`)
  assert.ok(goodAt - started < 2500, `备用线必须与慢首条并行探测：${goodAt - started}ms`)
})
