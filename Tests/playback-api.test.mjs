import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker from '../worker/api/src/index.js'
import { remainingProbeBudget } from '../worker/api/src/source-selection.js'

const schema = readFileSync(new URL('../worker/api/schema.sql', import.meta.url), 'utf8')
const segments = [720, 1080].map((height) => readFileSync(new URL(`./fixtures/avc-${height}.ts`, import.meta.url)))

function fixture(t, { media = 'hls', sameContent = false, lines = ['bad', 'good'], heights = {}, delays = {} } = {}) {
  const fetchLog = []
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const env = { KJ_SECRET: 'test-only', DB: { prepare(sql) { return { bind(...args) {
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
    if (url.hostname !== 'media.example' || url.pathname.includes('broken')) return new Response(null, { status: 404 })
    // 按线路指定响应延迟，模拟慢线路（例如手选线路 6.25 秒才返回）。
    const slowProvider = Object.keys(delays).find((provider) => url.pathname.includes(`/${provider}.`) || url.pathname.includes(`/${provider}-`))
    if (slowProvider) await new Promise((resolve) => setTimeout(resolve, delays[slowProvider]))
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
  return { seed, request, sqlite, fetchLog, login }
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

test('默认线路探测成功后不再为换源列表等其余候选（长嵌套请求会被平台按 CPU 上限掐断）', async (t) => {
  const { seed, request, sqlite, fetchLog } = fixture(t, { lines: ['good', 'bad', 'spare'] })
  seed('lead-fast')
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('lead-fast','good','')").run()
  const play = await (await request('/api/play?show=lead-fast&ep=0')).json()
  assert.equal(play.provider, 'good')
  assert.ok(!fetchLog.includes('/lead-fast/broken.m3u8'), `已成功就不该再探后面的死线：${fetchLog.join(',')}`)
  assert.ok(!fetchLog.includes('/lead-fast/spare.m3u8'), `已成功就不该再探后面的候选：${fetchLog.join(',')}`)
  const spare = play.options.find(({ provider }) => provider === 'spare')
  assert.ok(spare, '没探过的线路仍要出现在换源列表里')
  assert.equal(spare.status, 'unknown', '没探过不等于死线')
})

test('没有原站默认记录时先探到 720 不能把 quality=1080 降级', async (t) => {
  const { seed, request } = fixture(t, { lines: ['sd', 'hd'], heights: { sd: 720, hd: 1080 } })
  seed('quality-order')
  const play = await (await request('/api/play?show=quality-order&ep=0&quality=1080')).json()
  assert.equal(play.provider, 'hd', '列表第一条只是上游顺序，不能当成默认项抢先返回')
  assert.equal(play.quality, 1080)
})

test('手选线路 6.25 秒才响应仍然可播（首条提前返回不能缩短它的超时）', async (t) => {
  const { seed, request } = fixture(t, { media: 'mp4', lines: ['slowline'], delays: { slowline: 6250 } })
  seed('slow-manual')
  const response = await request('/api/play?show=slow-manual&ep=0&line=slowline&strict=1')
  const play = await response.json()
  assert.equal(response.status, 200, JSON.stringify(play))
  assert.equal(play.provider, 'slowline')
})

test('权威首条失败后备用线路照旧接上，两段探测共享原版 20 秒预算', async (t) => {
  const { seed, request, sqlite } = fixture(t, { lines: ['bad', 'good'] })
  seed('lead-fail')
  // 对照表说原站默认是 bad，首条因此走提前返回的分支；它不可播时必须照旧接备用线。
  sqlite.prepare("INSERT INTO origin_defaults(show_id,provider,label) VALUES('lead-fail','bad','')").run()
  const started = Date.now()
  const play = await (await request('/api/play?show=lead-fail&ep=0')).json()
  const elapsed = Date.now() - started
  assert.equal(play.provider, 'good')
  assert.ok(elapsed < 20000, `不能重新领一份预算：${elapsed}ms`)
  // 其余候选只能拿到 20 秒扣掉首条已用时间，且不能为负。
  assert.equal(remainingProbeBudget(Date.now() - 7000), 13000)
  assert.equal(remainingProbeBudget(Date.now() - 30000), 1000)
})
