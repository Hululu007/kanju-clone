import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker from '../worker/api/src/index.js'

const schema = readFileSync(new URL('../worker/api/schema.sql', import.meta.url), 'utf8')
const mp4Bytes = () => {
  const bytes = new Uint8Array(2048)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  return bytes
}
class FixtureResponse extends Response {
  constructor(body, init, responseUrl) {
    super(body, init)
    this.fixtureUrl = responseUrl
  }

  get url() { return this.fixtureUrl || super.url }
}

const mp4Response = () => new Response(mp4Bytes(), {
  status: 206,
  headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2047/100000', 'access-control-allow-origin': '*' },
})

let seq = 0
function fixture(t, options = {}) {
  const {
    resolvePolicy = null,
    mediaPolicy = null,
    cached = null,
    extraLines = 8,
  } = options
  const id = `egress-review-${++seq}`
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const env = {
    KJ_SECRET: 'test-secret',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              first: async () => sqlite.prepare(sql).get(...args),
              all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
              run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
            }
          },
        }
      },
    },
  }
  t.after(() => sqlite.close())
  let resolveCalls = 0
  let fetchCount = 0
  t.mock.method(globalThis, 'fetch', async (input, fetchOptions = {}) => {
    fetchCount++
    const url = new URL(input)
    if (url.pathname === '/v1/users/anonymous') {
      return new Response('{}', { status: 201, headers: { 'set-cookie': 'ai_movie_session=test-guest-session-value-1234567890; Path/' } })
    }
    if (url.pathname === '/v1/playback/resolve-line') {
      resolveCalls++
      const body = JSON.parse(fetchOptions.body || '{}')
      const override = resolvePolicy?.(body.ticket, resolveCalls)
      if (override) {
        if (override.url) return Response.json({ line: { url: override.url } }, { status: override.status })
        return new Response(override.text || '', { status: override.status })
      }
      if (body.ticket === 'official-ticket') {
        return Response.json({ line: { url: 'https://media.example/official.mp4' } }, { status: 201 })
      }
      if (body.ticket === 'official-hls') {
        return Response.json({ line: { url: 'https://media.example/official.m3u8' } }, { status: 201 })
      }
      if (body.ticket === 'official-new') {
        return Response.json({ line: { url: 'https://media.example/official-new.mp4' } }, { status: 201 })
      }
      return Response.json({ line: { url: 'https://media.example/other.mp4' } }, { status: 201 })
    }
    if (url.pathname.match(/^\/v1\/playback\/resolve\//)) {
      const options = [
        { provider_id: 'official-z', label: '1080P-官方Z', url: 'resolve://official-ticket' },
        { provider_id: 'other', label: '备用资源', url: 'https://media.example/other.mp4' },
      ]
      for (let i = 0; i < extraLines; i++) options.push({ provider_id: `filler-${i}`, label: `备用${i}`, url: `resolve://filler-${i}` })
      return Response.json({ current_episode: { episode_number: 1 }, line_options: options })
    }
    if (url.hostname === 'media.example') {
      const custom = mediaPolicy?.(url.pathname)
      if (custom === 'throw') throw new Error('connect timeout from worker egress')
      if (custom) return custom
      if (url.pathname === '/cached.mp4' || url.pathname === '/official.mp4'
        || url.pathname === '/official-new.mp4' || url.pathname === '/other.mp4' || url.pathname === '/late.mp4') return mp4Response()
    }
    return new Response(null, { status: 404 })
  })
  sqlite.prepare('INSERT INTO shows(id,title) VALUES(?,?)').run(id, id)
  sqlite.prepare('INSERT INTO episodes(show_id,idx,number,token) VALUES(?,?,?,?)').run(id, 0, 1, `${id}-1`)
  sqlite.prepare('INSERT INTO origin_defaults(show_id,provider,label) VALUES(?,?,?)').run(id, 'official-z', '1080P-官方Z')
  if (cached) {
    sqlite.prepare(`INSERT INTO sources(show_id,ep_idx,provider,label,url,kind,fingerprint,status,checked_at)
      VALUES(?,?,?,?,?,?,?,?,datetime('now'))`).run(id, 0, 'official-z', cached.label, cached.url, 'mp4', cached.fingerprint || null, cached.status || 'ok')
  }
  return {
    id,
    sqlite,
    resolveCalls: () => resolveCalls,
    fetchCount: () => fetchCount,
    request: (path) => worker.fetch(new Request(`https://worker.example${path}`), env),
  }
}

const play = async (f) => (await (await f.request(`/api/play?show=${f.id}&ep=0`)).json())

test('a rate-limited origin default is unknown, not dead, and the fallback is flagged', async (t) => {
  const f = fixture(t, { resolvePolicy: (ticket) => ticket === 'official-ticket' ? { status: 429, text: 'rate_limited' } : null })
  const out = await play(f)
  assert.equal(out.provider, 'other', JSON.stringify(out))
  const def = out.options.find((o) => o.label === '1080P-官方Z')
  assert.equal(def.status, 'unknown', `origin default must not be marked dead: ${JSON.stringify(out.options)}`)
  assert.equal(out.originDefaultStatus, 'rate_limited', JSON.stringify(out))
  assert.equal(out.probeDegraded, true, JSON.stringify(out))
})

test('an HLS default with an unreachable first segment stays an unverified candidate', async (t) => {
  const f = fixture(t, {
    resolvePolicy: (ticket) => ticket === 'official-ticket' ? { status: 201, text: JSON.stringify({ line: { url: 'https://media.example/official.m3u8' } }) } : null,
    mediaPolicy: (path) => {
      if (path === '/official.m3u8') return new FixtureResponse('#EXTM3U\n#EXTINF:2,\nseg1.ts\n', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' } }, 'https://media.example/official.m3u8')
      if (path === '/seg1.ts') return 'throw'
      return null
    },
  })
  const out = await play(f)
  assert.equal(out.provider, 'official-z', JSON.stringify(out))
  assert.equal(out.verified, false)
  assert.equal(out.probeDegraded, true)
  assert.equal(out.url, 'https://media.example/official.m3u8')
})

test('an unlabelled cached source cannot stand in for a labelled origin default', async (t) => {
  const f = fixture(t, {
    resolvePolicy: (ticket) => ticket === 'official-ticket' ? { status: 429, text: 'rate_limited' } : null,
    cached: { label: '', url: 'https://media.example/cached.mp4' },
  })
  const out = await play(f)
  assert.notEqual(out.url, 'https://media.example/cached.mp4', JSON.stringify(out))
})

test('a soft probe failure never overwrites a previously verified source', async (t) => {
  const f = fixture(t, {
    resolvePolicy: (ticket) => ticket === 'official-ticket' ? { status: 201, text: JSON.stringify({ line: { url: 'https://media.example/official-new.mp4' } }) } : null,
    mediaPolicy: (path) => path === '/official-new.mp4' ? 'throw' : null,
    cached: { label: '1080P-官方Z', url: 'https://media.example/cached.mp4', fingerprint: 'mp4-url:previous' },
  })
  await play(f)
  const row = f.sqlite.prepare("SELECT status,fingerprint,url FROM sources WHERE show_id=? AND provider='official-z'").get(f.id)
  assert.equal(row.status, 'ok', JSON.stringify(row))
  assert.equal(row.fingerprint, 'mp4-url:previous', JSON.stringify(row))
  assert.equal(row.url, 'https://media.example/cached.mp4', JSON.stringify(row))
})

test('probing continues past eight failed lines when a later line is playable', async (t) => {
  const f = fixture(t, {
    extraLines: 12,
    resolvePolicy: (ticket, count) => count <= 8
      ? { status: 404, text: 'not found' }
      : { status: 201, url: 'https://media.example/late.mp4' },
    mediaPolicy: (path) => path === '/other.mp4' ? 'throw' : null,
  })
  const out = await play(f)
  assert.equal(out.verified, true, JSON.stringify(out))
  assert.notEqual(out.provider, 'other', 'the ninth line should be probed instead of returning 500')
})

test('the worker never spends more than the Cloudflare subrequest budget', async (t) => {
  const f = fixture(t, { extraLines: 18 })
  const out = await play(f)
  assert.ok(f.fetchCount() <= 50, `worker spent ${f.fetchCount()} subrequests`)
  assert.ok(out.options.length > 0)
})
