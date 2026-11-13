var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var CORS = /* @__PURE__ */ __name((origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-max-age": "86400",
  "content-type": "application/json; charset=utf-8"
}), "CORS");
var json = /* @__PURE__ */ __name((data, env, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS(env?.ALLOW_ORIGIN) }), "json");
var num = /* @__PURE__ */ __name((v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d, "num");
var parseJSON = /* @__PURE__ */ __name((s, fb) => {
  try {
    const v = JSON.parse(s);
    return v ?? fb;
  } catch {
    return fb;
  }
}, "parseJSON");
async function cardOf(env, row, episodes) {
  const eps = episodes || await episodesOf(env, row.id);
  const groups = eps.length ? [
    {
      id: "web",
      label: "\u7F51\u9875\u64AD\u653E\u5668",
      type: "player",
      episode_count: eps.length,
      episodes: eps.map((e) => ({
        index: e.idx,
        label: e.label,
        stream: e.stream,
        length: e.length,
        quality: e.quality
      }))
    }
  ] : [];
  return {
    id: row.id,
    work_id: "work:" + row.id,
    seasons: [],
    title: row.title_cn || row.title,
    normalized_title: row.title,
    aliases: row.title_cn && row.title_cn !== row.title ? [row.title] : [],
    content_kind: row.kind || "movie",
    year: row.year,
    area: row.area_cn || "\u7F8E\u56FD",
    language: row.language_cn || "\u82F1\u8BED",
    genres: parseJSON(row.tags_cn || "[]", []),
    actors: [],
    directors: [],
    poster_url: row.poster,
    backdrop_url: row.poster,
    remarks: row.remarks_cn || "",
    playback_groups: groups,
    availability: {
      state: eps.length ? "playable" : "unavailable",
      label: eps.length ? "\u53EF\u64AD\u653E" : "\u6682\u65E0\u7247\u6E90",
      playable: eps.length > 0,
      disabled: false,
      source: "catalog"
    },
    heat_value: num(row.heat_value || row.downloads),
    playback_count: num(row.playback_count),
    updated_at: row.updated_at || row.added,
    rank_reason: [],
    rank_position: 0,
    reasons: ["catalog_public"],
    facts: { theme_terms: [], embedding_terms: [], intent_phrases: [] },
    synopsis: row.synopsis_cn || "",
    detail_url: "/v1/catalog/" + row.id
  };
}
__name(cardOf, "cardOf");
async function episodesOf(env, id) {
  const { results } = await env.DB.prepare(
    "SELECT idx,label,stream,length,quality FROM episodes WHERE show_id=? ORDER BY idx"
  ).bind(id).all();
  return results || [];
}
__name(episodesOf, "episodesOf");
var SECTIONS = [
  {
    id: "feed_sec_everyone_watching",
    type: "trend",
    role: "primary",
    title: "\u5927\u5BB6\u90FD\u5728\u770B",
    subtitle: "\u6240\u6709\u5206\u7C7B\u91CC\u70ED\u5EA6\u6700\u9AD8\u7684\u4E00\u6279",
    reason: "center_trending",
    priority: 100,
    where: "1=1"
  },
  {
    id: "feed_sec_movie",
    type: "channel",
    role: "channel",
    title: "\u7535\u5F71",
    subtitle: "\u7ECF\u5178\u957F\u7247\u4E0E\u9ED8\u7247\uFF0C\u4E00\u665A\u4E0A\u770B\u4E00\u90E8",
    reason: "catalog_movie",
    priority: 90,
    where: "category='movie'"
  },
  {
    id: "feed_sec_series",
    type: "channel",
    role: "channel",
    title: "\u7535\u89C6\u5267",
    subtitle: "\u8001\u5267\u96C6\uFF0C\u5206\u6BB5\u6162\u6162\u770B",
    reason: "catalog_series",
    priority: 80,
    where: "category='tv'"
  },
  {
    id: "feed_sec_anime",
    type: "channel",
    role: "channel",
    title: "\u52A8\u6F2B",
    subtitle: "\u624B\u7ED8\u5E74\u4EE3\u7684\u52A8\u753B\u77ED\u7247",
    reason: "catalog_anime",
    priority: 70,
    where: "category='anime'"
  },
  {
    id: "feed_sec_doc",
    type: "channel",
    role: "channel",
    title: "\u7EAA\u5F55\u5F71\u50CF",
    subtitle: "\u4E0A\u4E16\u7EAA\u7559\u4E0B\u6765\u7684\u7EAA\u5F55\u4E0E\u5BA3\u4F20\u7247",
    reason: "catalog_documentary",
    priority: 60,
    where: "category='variety'"
  }
];
async function homeFeed(env, { sections = 3, cards = 10 } = {}) {
  const want = SECTIONS.slice(0, Math.max(1, Math.min(SECTIONS.length, sections)));
  const out = [];
  for (const s of want) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM shows
       WHERE ${s.where} AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)
       ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ?`
    ).bind(Math.max(1, Math.min(30, cards))).all();
    out.push({
      id: s.id,
      type: s.type,
      role: s.role,
      title: s.title,
      subtitle: s.subtitle,
      reason: s.reason,
      priority: s.priority,
      cards: await Promise.all((results || []).map((r) => cardOf(env, r)))
    });
  }
  return {
    object: "home.feed",
    strategy: "d1_catalog_snapshot",
    period: "day",
    project_id: "kanju-clone",
    quota: { section_limit: 11, cards_per_section: 30 },
    sections: out
  };
}
__name(homeFeed, "homeFeed");
function bootstrap(env, url) {
  const catalogRows = [
    {
      kind: "movie",
      genres: ["\u5267\u60C5", "\u559C\u5267", "\u72AF\u7F6A", "\u6050\u6016", "\u79D1\u5E7B", "\u60AC\u7591", "\u7231\u60C5", "\u6218\u4E89", "\u897F\u90E8"]
    },
    { kind: "series", genres: ["\u5267\u60C5", "\u559C\u5267", "\u60AC\u7591", "\u5BB6\u5EAD"] },
    { kind: "anime", genres: ["\u52A8\u753B", "\u5BB6\u5EAD", "\u559C\u5267"] },
    { kind: "documentary", genres: ["\u7EAA\u5B9E", "\u65B0\u95FB", "\u79D1\u666E", "\u5386\u53F2"] }
  ];
  return {
    object: "runtime.bootstrap",
    version: 1,
    canonical_host: url.hostname,
    cache_ttl_seconds: 300,
    catalog_ui: {
      version: 1,
      channels: [
        { key: "recommend", label: "AI\u627E\u5267" },
        { key: "updates", label: "\u6700\u8FD1\u66F4\u65B0" },
        { key: "series", label: "\u7535\u89C6\u5267" },
        { key: "movie", label: "\u7535\u5F71" },
        { key: "anime", label: "\u52A8\u6F2B" },
        { key: "variety", label: "\u7EAA\u5F55\u5F71\u50CF" }
      ],
      catalogs: catalogRows.map((c) => ({
        kind: c.kind,
        default_sort: "heat_desc",
        rows: [
          {
            key: "genre",
            label: "\u5206\u7C7B",
            all_label: "\u5168\u90E8\u5206\u7C7B",
            clear_params: ["genre"],
            options: [
              { key: "", label: "\u5168\u90E8\u5206\u7C7B", params: {}, enabled: true },
              ...c.genres.map((g) => ({
                key: g,
                label: g,
                params: { genre: g },
                enabled: true
              }))
            ]
          }
        ]
      }))
    }
  };
}
__name(bootstrap, "bootstrap");
async function suggest(env, q, limit) {
  const kw = String(q || "").trim();
  if (!kw) return { object: "suggest.results", query: "", items: [], total: 0 };
  const like = `%${kw}%`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM shows
     WHERE (title LIKE ? OR title_cn LIKE ? OR tags_cn LIKE ?)
       AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)
     ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ?`
  ).bind(like, like, like, Math.max(1, Math.min(20, limit))).all();
  const items = await Promise.all(
    (results || []).map(async (r) => {
      const c = await cardOf(env, r);
      return {
        id: c.id,
        title: c.title,
        year: c.year,
        area: c.area,
        content_kind: c.content_kind,
        poster_url: c.poster_url,
        remarks: c.remarks,
        heat_value: c.heat_value,
        detail_url: c.detail_url
      };
    })
  );
  return { object: "suggest.results", query: kw, items, total: items.length };
}
__name(suggest, "suggest");
function announcements() {
  return {
    object: "site.announcement_manifest",
    site_id: "site_kanju_clone",
    revision: "kanju-clone-1",
    version: "v1.0.0",
    generated_at: (/* @__PURE__ */ new Date()).toISOString(),
    cache_ttl_seconds: 30,
    tabs: [
      { id: "latest", label: "\u6700\u65B0", item_ids: ["welcome"] },
      { id: "guide", label: "\u4F7F\u7528\u65B9\u6CD5", item_ids: ["howto"] }
    ],
    items: [
      {
        id: "welcome",
        tab: "latest",
        title: "\u3010\u672C\u7AD9\u5DF2\u63A5\u5165\u5F00\u653E\u5F71\u50CF\u7247\u5E93\u3011",
        body: "\u672C\u7AD9\u4E3A\u4E2A\u4EBA\u81EA\u5EFA\u7684\u5F71\u89C6\u7AD9\u70B9\uFF0C\u7247\u6E90\u5168\u90E8\u6765\u81EA Internet Archive \u7684\u5F00\u653E\u6388\u6743\u4E0E\u516C\u6709\u9886\u57DF\u5F71\u7247\uFF0C\u53EF\u76F4\u63A5\u5728\u7EBF\u64AD\u653E\u4E0E\u4E0B\u8F7D\u3002\u7247\u5E93\u5171\u6536\u5F55\u6570\u5343\u90E8\u7535\u5F71\u3001\u5267\u96C6\u4E0E\u8001\u52A8\u753B\uFF0C\u7B80\u4ECB\u4E0E\u6807\u7B7E\u5DF2\u5168\u90E8\u4E2D\u6587\u5316\u3002",
        summary: "\u63A5\u5165\u5F00\u653E\u6388\u6743\u7247\u5E93\uFF0C\u6570\u5343\u90E8\u5F71\u7247\u53EF\u76F4\u63A5\u64AD\u653E\u3002",
        priority: 250,
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: null,
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        content_hash: "welcome",
        type: "announcement",
        body_format: "plain",
        metadata: {}
      },
      {
        id: "howto",
        tab: "guide",
        title: "\u600E\u4E48\u7528",
        body: "\u9996\u9875\u9876\u90E8\u641C\u7D22\u6846\u53EF\u4EE5\u76F4\u63A5\u641C\u7247\u540D\u6216\u9898\u6750\uFF1B\u4E2D\u95F4\u7684\u5206\u533A\u6309\u7535\u5F71\u3001\u7535\u89C6\u5267\u3001\u52A8\u6F2B\u3001\u7EAA\u5F55\u5F71\u50CF\u6D4F\u89C8\uFF1B\u70B9\u5361\u7247\u8FDB\u8BE6\u60C5\u9875\u5373\u53EF\u64AD\u653E\uFF0C\u591A\u6BB5\u5F71\u7247\u53EF\u4EE5\u5728\u5206\u96C6\u91CC\u5207\u6362\u3002",
        summary: "\u641C\u7D22\u3001\u5206\u533A\u6D4F\u89C8\u3001\u8BE6\u60C5\u9875\u64AD\u653E\u4E09\u6B65\u8D70\u3002",
        priority: 200,
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: null,
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        content_hash: "howto",
        type: "announcement",
        body_format: "plain",
        metadata: {}
      }
    ]
  };
}
__name(announcements, "announcements");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS(env.ALLOW_ORIGIN) });
    try {
      if (p === "/v1/runtime/bootstrap") return json(bootstrap(env, url), env);
      if (p === "/v1/announcements/manifest") return json(announcements(), env);
      if (p === "/v1/feed/home") {
        return json(
          await homeFeed(env, {
            sections: num(url.searchParams.get("sections"), 3),
            cards: num(url.searchParams.get("cards"), 10)
          }),
          env
        );
      }
      if (p === "/v1/suggest") {
        return json(await suggest(env, url.searchParams.get("q"), num(url.searchParams.get("limit"), 8)), env);
      }
      if (p.startsWith("/v1/catalog/")) {
        const id = decodeURIComponent(p.slice("/v1/catalog/".length));
        const row = await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(id).first();
        if (!row) return json({ error: { message: "\u6CA1\u6709\u8FD9\u90E8\u5F71\u7247", code: "not_found" } }, env, 404);
        const card = await cardOf(env, row);
        return json({ object: "catalog.work", ...card, original_title: row.title }, env);
      }
      if (p === "/api/health") return json({ ok: true, db: "d1", time: (/* @__PURE__ */ new Date()).toISOString() }, env);
      if (p === "/api/stats") {
        const a = await env.DB.prepare("SELECT COUNT(*) n FROM shows").first();
        const b = await env.DB.prepare("SELECT COUNT(*) n FROM episodes").first();
        return json({ shows: a?.n || 0, episodes: b?.n || 0 }, env);
      }
      if (p === "/api/shows") {
        const cat = url.searchParams.get("cat");
        const q = url.searchParams.get("q");
        const limit = Math.max(1, Math.min(200, num(url.searchParams.get("limit"), 24)));
        const offset = Math.max(0, num(url.searchParams.get("offset"), 0));
        const where = ["EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id)"];
        const args = [];
        if (cat) {
          where.push("category=?");
          args.push(cat);
        }
        if (q) {
          where.push("(title LIKE ? OR title_cn LIKE ? OR tags_cn LIKE ? OR synopsis_cn LIKE ?)");
          const like = `%${q}%`;
          args.push(like, like, like, like);
        }
        const sql = `SELECT * FROM shows WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(heat_value, downloads) DESC LIMIT ? OFFSET ?`;
        const { results } = await env.DB.prepare(sql).bind(...args, limit, offset).all();
        return json({ total: results.length, offset, items: await Promise.all((results || []).map((r) => cardOf(env, r))) }, env);
      }
      if (p.startsWith("/api/shows/")) {
        const id = decodeURIComponent(p.slice("/api/shows/".length));
        const row = await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(id).first();
        if (!row) return json({ error: "not found" }, env, 404);
        return json(await cardOf(env, row), env);
      }
      if (p === "/api/progress") {
        const device = url.searchParams.get("device") || "web";
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const dev = String(body.device || device);
          const id = String(body.showId || body.show_id || "");
          if (!id) return json({ error: "showId \u5FC5\u586B" }, env, 400);
          await env.DB.prepare(
            `INSERT INTO progress (device, show_id, idx, position, duration, updated)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(device, show_id) DO UPDATE SET
               idx=excluded.idx, position=excluded.position,
               duration=excluded.duration, updated=excluded.updated`
          ).bind(
            dev,
            id,
            num(body.idx, 1),
            num(body.position),
            num(body.duration),
            (/* @__PURE__ */ new Date()).toISOString()
          ).run();
          return json({ ok: true, device: dev, showId: id }, env);
        }
        const { results } = await env.DB.prepare(
          "SELECT show_id, idx, position, duration, updated FROM progress WHERE device=? ORDER BY updated DESC LIMIT 50"
        ).bind(device).all();
        return json({ object: "progress.list", device, items: results || [] }, env);
      }
      if (p === "/api/catalog") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM shows WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = shows.id) ORDER BY COALESCE(heat_value, downloads) DESC"
        ).all();
        const eps = await env.DB.prepare("SELECT * FROM episodes ORDER BY show_id, idx").all();
        const byId = {};
        for (const e of eps.results || []) (byId[e.show_id] ||= []).push(e);
        return json(
          {
            object: "catalog.dump",
            items: await Promise.all((results || []).map((r) => cardOf(env, r, byId[r.id] || [])))
          },
          env
        );
      }
      return json({ error: { message: "no route", path: p } }, env, 404);
    } catch (err) {
      return json({ error: { message: String(err && err.message ? err.message : err) } }, env, 500);
    }
  }
};

// ../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-zwiAz5/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-zwiAz5/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
