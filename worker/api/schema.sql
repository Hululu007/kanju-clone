-- D1 结构（与本地 SQLite 对齐）
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  export_id INTEGER,
  title TEXT,
  normalized_title TEXT,
  aliases TEXT,
  content_kind TEXT,
  year INTEGER,
  area TEXT,
  language TEXT,
  genres TEXT,
  actors TEXT,
  directors TEXT,
  poster TEXT,
  backdrop TEXT,
  description TEXT,
  remarks TEXT,
  update_status TEXT,
  episode_progress TEXT,
  episode_count INTEGER,
  available_episode_count INTEGER,
  heat_value REAL,
  playback_count INTEGER,
  updated_at TEXT,
  updated_ts TEXT,
  synced_at TEXT,
  intro_end REAL,
  outro_from REAL,
  availability_state TEXT,
  availability_label TEXT,
  detail_url TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  show_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  number INTEGER,
  key TEXT,
  title TEXT,
  token TEXT,
  playback_count INTEGER,
  quality TEXT,
  line_label TEXT,
  provider TEXT,
  stream TEXT,
  stream_kind TEXT,
  resolved_at TEXT,
  PRIMARY KEY (show_id, idx)
);

CREATE TABLE IF NOT EXISTS sources (
  show_id TEXT NOT NULL,
  ep_idx INTEGER NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  url TEXT,
  kind TEXT,
  fingerprint TEXT,
  segments INTEGER,
  duration REAL,
  quality INTEGER,
  status TEXT,
  checked_at TEXT,
  PRIMARY KEY (show_id, ep_idx, provider)
);

CREATE TABLE IF NOT EXISTS provider_health (
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  verdict TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT,
  PRIMARY KEY (show_id, provider)
);

CREATE TABLE IF NOT EXISTS provider_playback_stats (
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (show_id, provider)
);

CREATE TABLE IF NOT EXISTS provider_playback_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_attempts_created ON provider_playback_attempts(created_at);

CREATE TABLE IF NOT EXISTS provider_baseline (
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ep_idx INTEGER,
  fingerprint TEXT,
  segments INTEGER,
  duration REAL,
  checked_at TEXT,
  PRIMARY KEY (show_id, provider)
);

CREATE TABLE IF NOT EXISTS progress (
  device TEXT NOT NULL,
  show_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  updated TEXT NOT NULL,
  PRIMARY KEY (device, show_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_progress (
  user_id TEXT NOT NULL,
  show_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, show_id)
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS danmaku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id TEXT NOT NULL,
  ep_idx INTEGER NOT NULL,
  t REAL NOT NULL,
  text TEXT NOT NULL,
  color TEXT,
  device TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_danmaku_ep ON danmaku(show_id, ep_idx, t);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shows_kind ON shows(content_kind);
CREATE INDEX IF NOT EXISTS idx_shows_heat ON shows(heat_value);
CREATE INDEX IF NOT EXISTS idx_shows_kind_area_heat ON shows(content_kind, area, heat_value DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_area_updated ON shows(content_kind, area, updated_ts DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_heat ON shows(content_kind, heat_value DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_updated ON shows(content_kind, updated_ts DESC);
CREATE INDEX IF NOT EXISTS idx_shows_episode_count ON shows(episode_count);
CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, idx);
CREATE INDEX IF NOT EXISTS idx_sources_show ON sources(show_id, ep_idx);
CREATE INDEX IF NOT EXISTS idx_health_verdict ON provider_health(verdict);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_progress_updated ON user_progress(user_id, updated_at DESC);

-- 原站默认线路对照：逐部实测原站播放页的默认线路，默认播放跟随它（见 src/origin-default.js）
CREATE TABLE IF NOT EXISTS origin_defaults (
  show_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT,
  ep_idx INTEGER,
  ep_label TEXT,
  title TEXT,
  source TEXT,
  observed_at TEXT
);
