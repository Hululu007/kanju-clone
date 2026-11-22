import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import worker from '../worker/api/src/index.js'

const schema = readFileSync(new URL('../worker/api/schema.sql', import.meta.url), 'utf8')
const mp4 = () => {
  const bytes = new Uint8Array(2048)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  return bytes
}

let fixtureSeq = 0
function fixture(t, { officialMedia = 'ok', lineAttempts = [], cachedUrl = '', always429 = false, subrequestLimit = false, extraLines = 0 } = {}) {
  const id = `egress-${++fixtureSeq}`
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const env = {
    KJ_SECRET: 'test-secret',
    DB: { prepare(sql) { return { bind(...args) {
      return {
        first: async () => sqlite.prepare(sql).get(...args),
        all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
      }
    } } } },
  }
  t.after(() => sqlite.close())
  let fetchCount = 0
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    fetchCount++
    const url = new URL(input)
    if (url.pathname === '/v1/users/anonymous') {
      return new Response('{}', { status: 201, headers: { 'set-cookie': 'ai_movie_session=test-guest-session-value-1234567890; Path=/' } })
    }
    if (url.pathname === '/v1/playback/resolve-line') {
      const body = JSON.parse(options.body || '{}')
      if (body.ticket === 'official-ticket') {
        lineAttempts.push('official')
        const tries = lineAttempts.filter((x) => x === 'official').length
        if ((tries === 1 && officialMedia === 'line-429') || always429) {
          return new Response(JSON.stringify({ code: 'rate_limited' }), { status: 429 })
        }
        if (subrequestLimit) {
          return new Response('Error 1102: Too many subrequests by single Worker invocation', { status: 500 })
        }
        return new Response(JSON.stringify({ line: { url: 'https://media.example/official.mp4' } }), { status: 201 })
      }
      return new Response(JSON.stringify({ line: { url: 'https://media.example/other.mp4' } }), { status: 201 })
    }
    if (url.pathname.match(/^\/v1\/playback\/resolve\//)) {
      const options = [
        { provider_id: 'official-z', label: '1080P-官方Z', url: 'resolve://official-ticket' },
        { provider_id: 'other', label: '备用资源', url: 'https://media.example/other.mp4' },
      ]
      for (let i = 0; i < extraLines; i++) options.push({ provider_id: `filler-${i}`, label: `备用${i}`, url: `resolve://filler-${i}` })
      return Response.json({ current_episode: { episode_number: 1 }, line_options: options })
    }
    if (url.hostname === 'media.example' && url.pathname === '/cached.mp4') {
      return new Response(mp4(), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2047/100000' } })
    }
    if (url.hostname === 'media.example' && url.pathname === '/official.mp4') {
      if (officialMedia === 'timeout') throw new Error('connect timeout from worker egress')
      if (officialMedia === 'http-403') return new Response('', { status: 403 })
      return new Response(mp4(), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2047/100000' } })
    }
    if (url.hostname === 'media.example' && url.pathname === '/other.mp4') {
      return new Response(mp4(), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2047/100000' } })
    }
    return new Response(null, { status: 404 })
  })
  sqlite.prepare('INSERT INTO shows(id,title) VALUES(?,?)').run(id, id)
  sqlite.prepare('INSERT INTO episodes(show_id,idx,number,token) VALUES(?,?,?,?)').run(id, 0, 1, `${id}-1`)
  sqlite.prepare('INSERT INTO origin_defaults(show_id,provider,label) VALUES(?,?,?)').run(id, 'official-z', '1080P-官方Z')
  if (cachedUrl) sqlite.prepare("INSERT INTO sources(show_id,ep_idx,provider,label,url,kind,status,checked_at) VALUES(?,?,?,?,?,?,?,datetime('now'))").run(id, 0, 'official-z', '1080P-官方Z', cachedUrl, 'mp4', 'ok')
  const request = (path) => worker.fetch(new Request(`https://worker.example${path}`), env)
  return { request, lineAttempts, id, fetchCount: () => fetchCount }
}

test('a 429 from resolve-line is retried instead of losing the official line', async (t) => {
  const { request, lineAttempts, id } = fixture(t, { officialMedia: 'line-429' })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  assert.equal(play.provider, 'official-z', JSON.stringify(play))
  assert.equal(play.verified, true)
  assert.ok(lineAttempts.filter((x) => x === 'official').length >= 2, 'the 429 attempt must be retried')
})

test('a resolved origin-default line survives a worker-side transport timeout as unverified', async (t) => {
  const { request, id } = fixture(t, { officialMedia: 'timeout' })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  assert.equal(play.provider, 'official-z', JSON.stringify(play))
  assert.equal(play.verified, false)
  assert.equal(play.probeDegraded, true)
  assert.equal(play.url, 'https://media.example/official.mp4')
})

test('a rate-limited resolve reuses the last verified media url for the same episode', async (t) => {
  const { request, id } = fixture(t, { always429: true, cachedUrl: 'https://media.example/cached.mp4' })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  assert.equal(play.provider, 'official-z', JSON.stringify(play))
  assert.equal(play.url, 'https://media.example/cached.mp4')
  assert.equal(play.verified, true)
})

test('the subrequest limit reuses the last verified url instead of losing the official line', async (t) => {
  const { request, id } = fixture(t, { subrequestLimit: true, cachedUrl: 'https://media.example/cached.mp4' })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  assert.equal(play.provider, 'official-z', JSON.stringify(play))
  assert.equal(play.url, 'https://media.example/cached.mp4')
})

test('a long line list never spends more than the worker subrequest budget', async (t) => {
  const { request, id, fetchCount } = fixture(t, { extraLines: 18 })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  // 统计所有 fetch（解析、媒体、会话），不能只数官方线的解析请求。
  assert.ok(fetchCount() <= 50, `worker spent ${fetchCount()} subrequests`)
  assert.equal(play.options.length, 20, JSON.stringify(play.options.length))
  assert.ok(play.options.every((option) => option.status !== 'dead'), 'unprobed lines must stay unknown, not dead')
})

test('a hard HTTP failure on the origin-default line still falls back to a verified line', async (t) => {
  const { request, id } = fixture(t, { officialMedia: 'http-403' })
  const play = await (await request(`/api/play?show=${id}&ep=0`)).json()
  assert.equal(play.provider, 'other', JSON.stringify(play))
  assert.equal(play.verified, true)
})
