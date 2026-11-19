var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var COOKIE_NAME = "zj_auth";
var COOKIE_MAX_AGE = 365 * 24 * 3600;
var MAX_FAILS = 10;
var LOCK_MS = 15 * 60 * 1e3;
var NOINDEX = { "x-robots-tag": "noindex, nofollow, noarchive" };
var PUBLIC_ASSETS = /* @__PURE__ */ new Set([
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png"
]);
function isPublicAsset(path) {
  if (PUBLIC_ASSETS.has(path)) return true;
  if (path.startsWith("/favicon")) return true;
  if (path.startsWith("/icons/")) return true;
  return false;
}
__name(isPublicAsset, "isPublicAsset");
var enc = new TextEncoder();
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64url, "b64url");
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}
__name(hmacSign, "hmacSign");
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return new Uint8Array(d);
}
__name(sha256, "sha256");
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function cookieValue(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
__name(cookieValue, "cookieValue");
async function issueToken(env) {
  const exp = Date.now() + COOKIE_MAX_AGE * 1e3;
  return `${exp}.${await hmacSign(env.COOKIE_SECRET, `v1.${exp}`)}`;
}
__name(issueToken, "issueToken");
async function tokenValid(env, token) {
  if (!token || !env.COOKIE_SECRET) return false;
  const i = token.indexOf(".");
  if (i <= 0) return false;
  const exp = Number(token.slice(0, i));
  const sig = token.slice(i + 1);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return safeEqual(sig, await hmacSign(env.COOKIE_SECRET, `v1.${exp}`));
}
__name(tokenValid, "tokenValid");
async function isAuthed(env, request) {
  return tokenValid(env, cookieValue(request, COOKIE_NAME));
}
__name(isAuthed, "isAuthed");
function kvStore(ns) {
  return {
    async get(key) {
      return ns.get(key, "json");
    },
    async put(key, value) {
      await ns.put(key, JSON.stringify(value), { expirationTtl: Math.ceil(LOCK_MS * 2 / 1e3) });
    }
  };
}
__name(kvStore, "kvStore");
function cacheStore() {
  const store = caches.default;
  const url = /* @__PURE__ */ __name((key) => `https://zj-rl.internal/${encodeURIComponent(key)}`, "url");
  return {
    async get(key) {
      const hit = await store.match(url(key));
      if (!hit) return null;
      try {
        return await hit.json();
      } catch {
        return null;
      }
    },
    async put(key, value) {
      await store.put(
        url(key),
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(LOCK_MS * 2 / 1e3)}` }
        })
      );
    }
  };
}
__name(cacheStore, "cacheStore");
function rlStore(env) {
  return env.RL && typeof env.RL.get === "function" ? kvStore(env.RL) : cacheStore();
}
__name(rlStore, "rlStore");
async function readState(env, ip) {
  const st = await rlStore(env).get(`rl:${ip}`);
  const fails = Number(st?.fails) || 0;
  const until = Number(st?.until) || 0;
  if (until && until <= Date.now()) return { fails: 0, until: 0 };
  return { fails, until };
}
__name(readState, "readState");
async function writeState(env, ip, st) {
  await rlStore(env).put(`rl:${ip}`, st);
}
__name(writeState, "writeState");
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
__name(esc, "esc");
function safeNext(raw) {
  const s = String(raw || "");
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return "/";
  return s;
}
__name(safeNext, "safeNext");
function tipHtml({ error = "", lockMinutes = 0, fails = 0 } = {}) {
  if (lockMinutes) return `<p class="err">\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u5DF2\u9501\u5B9A\uFF0C\u8BF7 ${lockMinutes} \u5206\u949F\u540E\u518D\u8BD5\u3002</p>`;
  if (!error) return "";
  const tail = fails ? `\uFF08\u5DF2\u8FDE\u7EED\u9519\u8BEF ${fails}/${MAX_FAILS} \u6B21\uFF09` : "";
  return `<p class="err">${esc(error)}${tail}</p>`;
}
__name(tipHtml, "tipHtml");
function loginPage({ next = "/", error = "", lockMinutes = 0, fails = 0 } = {}) {
  const tip = tipHtml({ error, lockMinutes, fails });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>\u9700\u8981\u5BC6\u7801 \xB7 \u963F\u5657\u5F71\u89C6</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:#0f1115;color:#e8eaed;padding:24px}
.card{width:100%;max-width:340px;background:#181b21;border:1px solid #262b33;border-radius:14px;padding:26px 24px}
h1{margin:0 0 6px;font-size:18px;font-weight:600}
p.sub{margin:0 0 18px;font-size:13px;color:#8b939f}
input[type=password]{width:100%;padding:11px 12px;font-size:15px;color:#e8eaed;background:#10131a;
  border:1px solid #2c323c;border-radius:9px;outline:none}
input[type=password]:focus{border-color:#4c8dff}
button{width:100%;margin-top:12px;padding:11px;font-size:15px;font-weight:600;color:#fff;
  background:#2f6fed;border:0;border-radius:9px;cursor:pointer}
button:active{background:#2860d0}
.err{margin:0 0 14px;font-size:13px;color:#ff6b6b;line-height:1.5}
</style>
</head>
<body>
<form class="card" method="post" action="/__login">
  <h1>\u963F\u5657\u5F71\u89C6</h1>
  <p class="sub">\u672C\u7AD9\u4EC5\u9650\u79C1\u7528\uFF0C\u8BF7\u8F93\u5165\u8BBF\u95EE\u5BC6\u7801</p>
  ${tip}
  <input type="password" name="password" inputmode="text" autocomplete="current-password"
         placeholder="\u8BBF\u95EE\u5BC6\u7801" autofocus required>
  <input type="hidden" name="next" value="${esc(safeNext(next))}">
  <button type="submit">\u8FDB\u5165</button>
</form>
</body>
</html>`;
}
__name(loginPage, "loginPage");
function pageResponse({ status = 200, next, error, lockMinutes, fails } = {}) {
  return new Response(loginPage({ next, error, lockMinutes, fails }), {
    status,
    headers: {
      ...NOINDEX,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY"
    }
  });
}
__name(pageResponse, "pageResponse");
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...NOINDEX, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
__name(jsonResponse, "jsonResponse");
async function handleLogin(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const st = await readState(env, ip);
  if (st.until) {
    const mins = Math.max(1, Math.ceil((st.until - Date.now()) / 6e4));
    return pageResponse({ status: 429, lockMinutes: mins });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return pageResponse({ status: 400, error: "\u8BF7\u6C42\u683C\u5F0F\u6709\u8BEF\uFF0C\u8BF7\u91CD\u8BD5\u3002" });
  }
  const next = safeNext(form.get("next"));
  const given = String(form.get("password") || "");
  const expected = env.SITE_PASSWORD ? await sha256(env.SITE_PASSWORD) : null;
  const actual = await sha256(given);
  const ok = !!expected && safeEqual(b64url(expected), b64url(actual));
  if (!ok) {
    const fails = st.fails + 1;
    const until = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
    await writeState(env, ip, { fails, until });
    if (until) return pageResponse({ status: 429, lockMinutes: Math.ceil(LOCK_MS / 6e4) });
    return pageResponse({ status: 401, next, error: "\u5BC6\u7801\u4E0D\u6B63\u786E\uFF0C\u8BF7\u91CD\u8BD5\u3002", fails });
  }
  if (st.fails) await writeState(env, ip, { fails: 0, until: 0 });
  const token = await issueToken(env);
  return new Response(null, {
    status: 302,
    headers: {
      ...NOINDEX,
      location: next,
      "cache-control": "no-store",
      "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
    }
  });
}
__name(handleLogin, "handleLogin");
async function forwardApi(request, env) {
  const headers = new Headers(request.headers);
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");
  headers.delete("host");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init = { method: request.method, headers, redirect: "manual" };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }
  const upstream = new Request(request.url, init);
  let res;
  try {
    res = await env.API.fetch(upstream);
  } catch (e) {
    return jsonResponse(502, { error: "upstream_unreachable", detail: String(e && e.message ? e.message : e) });
  }
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(NOINDEX)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}
__name(forwardApi, "forwardApi");
var src_default = {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, { error: "bad_request" });
    }
    const path = url.pathname;
    const method = request.method;
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { ...NOINDEX, "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" }
      });
    }
    if (isPublicAsset(path)) {
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { ...NOINDEX, allow: "GET, HEAD" } });
      }
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [k, v] of Object.entries(NOINDEX)) headers.set(k, v);
      headers.set("cache-control", "public, max-age=86400");
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (path === "/__login") {
      if (method === "POST") return handleLogin(request, env);
      if (method === "GET" || method === "HEAD") {
        if (await isAuthed(env, request)) {
          return new Response(null, { status: 302, headers: { ...NOINDEX, location: safeNext(url.searchParams.get("next")), "cache-control": "no-store" } });
        }
        return pageResponse({ next: safeNext(url.searchParams.get("next")) });
      }
      return new Response("Method Not Allowed", { status: 405, headers: { ...NOINDEX, allow: "GET, POST" } });
    }
    if (path === "/__logout") {
      return new Response(null, {
        status: 302,
        headers: {
          ...NOINDEX,
          location: "/__login",
          "cache-control": "no-store",
          "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
        }
      });
    }
    const authed = await isAuthed(env, request);
    if (path === "/api" || path.startsWith("/api/")) {
      if (!authed) return jsonResponse(401, { error: "unauthorized" });
      return forwardApi(request, env);
    }
    if (!authed) return pageResponse({ next: path + url.search });
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { ...NOINDEX, allow: "GET, HEAD" } });
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Headers(res.headers);
    for (const [k, v] of Object.entries(NOINDEX)) out.set(k, v);
    return new Response(res.body, { status: res.status, headers: out });
  }
};

// ../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
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

// ../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
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

// .wrangler/tmp/bundle-EHTp8X/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
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

// .wrangler/tmp/bundle-EHTp8X/middleware-loader.entry.ts
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
