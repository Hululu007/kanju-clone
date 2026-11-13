// kanju-api —— 复刻原站后端契约的 Cloudflare Worker（D1 数据库）
// 对外同时提供两套接口：
//   /v1/*  原站同构接口（runtime.bootstrap / feed.home / catalog.work / suggest / announcements）
//   /api/* 本项目前端早期使用的简化接口（保留兼容）
// 数据全部中文口径（标题、题材、地区、语言、简介）。

const CORS = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400',
  'content-type': 'application/json; charset=utf-8',
})

const json = (data, env, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS(env?.ALLOW_ORIGIN) })

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const parseJSON = (s, fb) => {
  try {
    /**
     * @type {any}
     */
    const v = JSON.parse(s)
    return v ?? fb
  } catch {
    return fb
  }
}

const KIND_LABEL = { movie: '电影', series: '电视剧', anime: '动画', documentary: '纪录影像' }

// ---------------- 卡片组装（与原站卡片字段同构） ----------------
async function cardOf(env, row, episodes) {
  const eps = episodes || (await episodesOf(env, row.id))
  const groups = eps.length
    ? [
        {
          id: 'web',
          label: '网页播放器',
          type: 'player',
          episode_count: eps.length,
          episodes: eps.map((e) => ({
            index: e.idx,
            label: e.label,
            stream: e.stream,
            length: e.length,
            quality: e.quality,
          })),
        },
      ]
    : []
  return {
    id: row.id,
    work_id: 'work:' + row.id,
    seasons: [],
    title: row.title_cn || row.title,
    normalized_title: row.title,
    aliases: row.title_cn && row.title_cn !== row.title ? [row.title] : [],
    content_kind: row.kind || 'movie',
    year: row.year,
    area: row.area_cn || '美国',
    language: row.language_cn || '英语',
    genres: parseJSON(row.tags_cn || '[]', []),
    actors: [],
    directors: [],
    poster_url: row.poster,
    backdrop_url: row.poster,
    remarks: row.remarks_cn || '',
    playback_groups: groups,
    availability: {
      state: eps.length ? 'playable' : 'unavailable',
      label: eps.length ? '可播放' : '暂无片源',
      playable: eps.length > 0,
      disabled: false,
      source: 'catalog',
    },
    heat_value: num(row.heat_value || row.downloads),
    playback_count: num(row.playback_count),
    updated_at: row.updated_at || row.added,
    rank_reason: [],
    rank_position: 0,
    reasons: ['catalog_public'],
    facts: { theme_terms: [], embedding_terms: [], intent_phrases: [] },
    synopsis: row.synopsis_cn || '',
    detail_url: '/v1/catalog/' + row.id,
  }
}

async function episodesOf(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT idx,label,stream,length,quality FROM episodes WHERE show_id=? ORDER BY idx'
  )
    .bind(id)
    .all()
  return results || []
}

// ---------------- 首页 feed ----------------
const SECTIONS = [
  {
    id: 'feed_sec_everyone_watching',
    type: 'trend',
    role: 'primary',
    title: '大家都在看',
    subtitle: '所有分类里热度最高的一批',
    reason: 'center_trending',
    priority: 100,
    where: "1=1",
  },
  {
    id: 'feed_sec_movie',
    type: 'channel',
    role: 'channel',
    title: '电影',
    subtitle: '经典长片与默片，一晚上看一部',
    reason: 'catalog_movie',
    priority: 90,
    where: "category='movie'",
  },
  {
    id: 'feed_sec_series',
    type: 'channel',
    role: 'channel',
    title: '电视剧',
    subtitle: '老剧集，分段慢慢看',
    reason: 'catalog_series',
    priority: 80,
    where: "category='tv'",
  },
  {
    id: 'feed_sec_anime',
    type: 'channel',
    role: 'channel',
    title: '动漫',
    subtitle: '手绘年代的动画短片',
    reason: 'catalog_anime',
    priority: 70,
    where: "category='anime'",
  },
  {
    id: 'feed_sec_doc',
    type: 'channel',
    role: 'channel',
    title: '纪录影像',
    subtitle: '上世纪留下来的纪录与宣传片',
    reason: 'catalog_documentary',
    priority: 60,
    where: "category='variety'",
  },
]

async function homeFeed(env, { sections = 3, cards = 10 } = {}) {
  const want = SECTIONS.slice(0, Math.max(1, Math.min(SECTIONS.length, sections)))
  const out = []
  for (const s of want) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM shows
       WHERE ${s.where} AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)
       ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ?`
    )
      .bind(Math.max(1, Math.min(30, cards)))
      .all()
    out.push({
      id: s.id,
      type: s.type,
      role: s.role,
      title: s.title,
      subtitle: s.subtitle,
      reason: s.reason,
      priority: s.priority,
      cards: await Promise.all((results || []).map((r) => cardOf(env, r))),
    })
  }
  return {
    object: 'home.feed',
    strategy: 'd1_catalog_snapshot',
    period: 'day',
    project_id: 'kanju-clone',
    quota: { section_limit: 11, cards_per_section: 30 },
    sections: out,
  }
}

// ---------------- 运行时引导 ----------------
function bootstrap(env, url) {
  const catalogRows = [
    {
      kind: 'movie',
      genres: ['剧情', '喜剧', '犯罪', '恐怖', '科幻', '悬疑', '爱情', '战争', '西部'],
    },
    { kind: 'series', genres: ['剧情', '喜剧', '悬疑', '家庭'] },
    { kind: 'anime', genres: ['动画', '家庭', '喜剧'] },
    { kind: 'documentary', genres: ['纪实', '新闻', '科普', '历史'] },
  ]
  return {
    object: 'runtime.bootstrap',
    version: 1,
    canonical_host: url.hostname,
    cache_ttl_seconds: 300,
    catalog_ui: {
      version: 1,
      channels: [
        { key: 'recommend', label: 'AI找剧' },
        { key: 'updates', label: '最近更新' },
        { key: 'series', label: '电视剧' },
        { key: 'movie', label: '电影' },
        { key: 'anime', label: '动漫' },
        { key: 'variety', label: '纪录影像' },
      ],
      catalogs: catalogRows.map((c) => ({
        kind: c.kind,
        default_sort: 'heat_desc',
        rows: [
          {
            key: 'genre',
            label: '分类',
            all_label: '全部分类',
            clear_params: ['genre'],
            options: [
              { key: '', label: '全部分类', params: {}, enabled: true },
              ...c.genres.map((g) => ({
                key: g,
                label: g,
                params: { genre: g },
                enabled: true,
              })),
            ],
          },
        ],
      })),
    },
  }
}

// ---------------- 搜索建议 ----------------
async function suggest(env, q, limit) {
  const kw = String(q || '').trim()
  if (!kw) return { object: 'suggest.results', query: '', items: [], total: 0 }
  const like = `%${kw}%`
  const { results } = await env.DB.prepare(
    `SELECT * FROM shows
     WHERE (title LIKE ? OR title_cn LIKE ? OR tags_cn LIKE ?)
       AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)
     ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ?`
  )
    .bind(like, like, like, Math.max(1, Math.min(20, limit)))
    .all()
  const items = await Promise.all(
    (results || []).map(async (r) => {
      const c = await cardOf(env, r)
      return {
        id: c.id,
        title: c.title,
        year: c.year,
        area: c.area,
        content_kind: c.content_kind,
        poster_url: c.poster_url,
        remarks: c.remarks,
        heat_value: c.heat_value,
        detail_url: c.detail_url,
      }
    })
  )
  return { object: 'suggest.results', query: kw, items, total: items.length }
}

// ---------------- 公告 ----------------
function announcements() {
  return {
    object: 'site.announcement_manifest',
    site_id: 'site_kanju_clone',
    revision: 'kanju-clone-1',
    version: 'v1.0.0',
    generated_at: new Date().toISOString(),
    cache_ttl_seconds: 30,
    tabs: [
      { id: 'latest', label: '最新', item_ids: ['welcome'] },
      { id: 'guide', label: '使用方法', item_ids: ['howto'] },
    ],
    items: [
      {
        id: 'welcome',
        tab: 'latest',
        title: '【本站已接入开放影像片库】',
        body: '本站为个人自建的影视站点，片源全部来自 Internet Archive 的开放授权与公有领域影片，可直接在线播放与下载。片库共收录数千部电影、剧集与老动画，简介与标签已全部中文化。',
        summary: '接入开放授权片库，数千部影片可直接播放。',
        priority: 250,
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: null,
        updated_at: new Date().toISOString(),
        content_hash: 'welcome',
        type: 'announcement',
        body_format: 'plain',
        metadata: {},
      },
      {
        id: 'howto',
        tab: 'guide',
        title: '怎么用',
        body: '首页顶部搜索框可以直接搜片名或题材；中间的分区按电影、电视剧、动漫、纪录影像浏览；点卡片进详情页即可播放，多段影片可以在分集里切换。',
        summary: '搜索、分区浏览、详情页播放三步走。',
        priority: 200,
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: null,
        updated_at: new Date().toISOString(),
        content_hash: 'howto',
        type: 'announcement',
        body_format: 'plain',
        metadata: {},
      },
    ],
  }
}

// ---------------- 路由 ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const p = url.pathname
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env.ALLOW_ORIGIN) })

    try {
      // ---- 原站同构 /v1 ----
      if (p === '/v1/runtime/bootstrap') return json(bootstrap(env, url), env)
      if (p === '/v1/announcements/manifest') return json(announcements(), env)
      if (p === '/v1/feed/home') {
        return json(
          await homeFeed(env, {
            sections: num(url.searchParams.get('sections'), 3),
            cards: num(url.searchParams.get('cards'), 10),
          }),
          env
        )
      }
      if (p === '/v1/suggest') {
        return json(await suggest(env, url.searchParams.get('q'), num(url.searchParams.get('limit'), 8)), env)
      }
      if (p.startsWith('/v1/catalog/')) {
        const id = decodeURIComponent(p.slice('/v1/catalog/'.length))
        const row = await env.DB.prepare('SELECT * FROM shows WHERE id=?').bind(id).first()
        if (!row) return json({ error: { message: '没有这部影片', code: 'not_found' } }, env, 404)
        const card = await cardOf(env, row)
        return json({ object: 'catalog.work', ...card, original_title: row.title }, env)
      }

      // ---- 兼容的简化 /api ----
      if (p === '/api/health') return json({ ok: true, db: 'd1', time: new Date().toISOString() }, env)
      if (p === '/api/stats') {
        const a = await env.DB.prepare('SELECT COUNT(*) n FROM shows').first()
        const b = await env.DB.prepare('SELECT COUNT(*) n FROM episodes').first()
        return json({ shows: a?.n || 0, episodes: b?.n || 0 }, env)
      }
      if (p === '/api/shows') {
        const cat = url.searchParams.get('cat')
        const q = url.searchParams.get('q')
        const limit = Math.max(1, Math.min(200, num(url.searchParams.get('limit'), 24)))
        const offset = Math.max(0, num(url.searchParams.get('offset'), 0))
        const where = ["EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)"]
        const args = []
        if (cat) {
          where.push('category=?')
          args.push(cat)
        }
        if (q) {
          where.push('(title LIKE ? OR title_cn LIKE ? OR tags_cn LIKE ? OR synopsis_cn LIKE ?)')
          const like = `%${q}%`
          args.push(like, like, like, like)
        }
        const sql = `SELECT * FROM shows WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ? OFFSET ?`
        const { results } = await env.DB.prepare(sql)
          .bind(...args, limit, offset)
          .all()
        return json({ total: results.length, offset, items: await Promise.all((results || []).map((r) => cardOf(env, r))) }, env)
      }
      if (p.startsWith('/api/shows/')) {
        const id = decodeURIComponent(p.slice('/api/shows/'.length))
        const row = await env.DB.prepare('SELECT * FROM shows WHERE id=?').bind(id).first()
        if (!row) return json({ error: 'not found' }, env, 404)
        return json(await cardOf(env, row), env)
      }
      // 播放进度：GET /api/progress?device=web 列出，POST 写入（服务端按设备保存）
      if (p === '/api/progress') {
        const device = url.searchParams.get('device') || 'web'
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}))
          const dev = String(body.device || device)
          const id = String(body.showId || body.show_id || '')
          if (!id) return json({ error: 'showId 必填' }, env, 400)
          await env.DB.prepare(
            `INSERT INTO progress (device, show_id, idx, position, duration, updated)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(device, show_id) DO UPDATE SET
               idx=excluded.idx, position=excluded.position,
               duration=excluded.duration, updated=excluded.updated`
          )
            .bind(
              dev,
              id,
              num(body.idx, 1),
              num(body.position),
              num(body.duration),
              new Date().toISOString()
            )
            .run()
          return json({ ok: true, device: dev, showId: id }, env)
        }
        const { results } = await env.DB.prepare(
          'SELECT show_id, idx, position, duration, updated FROM progress WHERE device=? ORDER BY updated DESC LIMIT 50'
        )
          .bind(device)
          .all()
        return json({ object: 'progress.list', device, items: results || [] }, env)
      }
      if (p === '/api/catalog') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM shows WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id) ORDER BY COALESCE(heat_value, downloads) DESC'
        ).all()
        const eps = await env.DB.prepare('SELECT * FROM episodes ORDER BY show_id, idx').all()
        const byId = {}
        for (const e of eps.results || []) (byId[e.show_id] ||= []).push(e)
        return json(
          {
            object: 'catalog.dump',
            items: await Promise.all((results || []).map((r) => cardOf(env, r, byId[r.id] || []))),
          },
          env
        )
      }

      return json({ error: { message: 'no route', path: p } }, env, 404)
    } catch (err) {
      return json({ error: { message: String(err && err.message ? err.message : err) } }, env, 500)
    }
  },
}
