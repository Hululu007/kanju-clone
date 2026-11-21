import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker from '../worker/api/src/index.js'

const schema = readFileSync(new URL('../worker/api/schema.sql', import.meta.url), 'utf8')
const segments = [720, 1080].map((height) => readFileSync(new URL(`./fixtures/avc-${height}.ts`, import.meta.url)))

function fixture(t) {
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
      return Response.json({ current_episode: { episode_number: Number(ep) }, line_options: [
        { provider_id: 'bad', url: `https://media.example/${id}/broken.m3u8` },
        { provider_id: 'good', url: `https://media.example/${id}/${ep}.m3u8` },
      ] })
    }
    if (url.hostname !== 'media.example' || url.pathname.includes('broken')) return new Response(null, { status: 404 })
    const second = /2\.(m3u8|ts)$/.test(url.pathname)
    const response = new Response(url.pathname.endsWith('.m3u8') ? `#EXTM3U\n#EXTINF:4,\n${second ? 2 : 1}.ts` : segments[Number(second)], { headers })
    Object.defineProperty(response, 'url', { value: url.href })
    return response
  })
  const request = (path, options) => worker.fetch(new Request(`https://worker.example${path}`, options), env)
  const seed = (id) => {
    sqlite.prepare('INSERT INTO shows(id,title) VALUES(?,?)').run(id, id)
    for (let i = 0; i < 2; i++) sqlite.prepare('INSERT INTO episodes(show_id,idx,number,token) VALUES(?,?,?,?)').run(id, i, i + 1, `${id}-${i + 1}`)
  }
  return { seed, request, sqlite, fetchLog }
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
  const { seed, request, sqlite } = fixture(t)
  seed('reported')
  sqlite.prepare("INSERT INTO sources(show_id,ep_idx,provider,url,kind,status) VALUES('reported',0,'good','https://media.example/good.m3u8','hls','ok')").run()
  const attemptId = '4cde2b87-f63f-4e81-8902-e1f60941c18a'
  const payload = { showId: 'reported', provider: 'good', ok: true, attemptId }
  const post = (headers = {}) => request('/api/playback-result', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })
  assert.equal((await post()).status, 401)
  const token = 'T'.repeat(43)
  const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const hash = [...new Uint8Array(tokenHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  sqlite.prepare('INSERT INTO users(id,username,normalized_username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('user-1', 'test-user', 'test-user', 'placeholder', Date.now(), Date.now())
  sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)').run(hash, 'user-1', Date.now(), Date.now() + 60_000, Date.now())
  const headers = { authorization: `Bearer ${token}` }
  assert.equal((await post(headers)).status, 200)
  assert.equal((await post(headers)).status, 200)
  assert.equal(sqlite.prepare("SELECT successes, failures FROM provider_playback_stats WHERE show_id='reported' AND provider='good'").get().successes, 1)
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
