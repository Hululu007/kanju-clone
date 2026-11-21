CREATE TABLE IF NOT EXISTS provider_playback_stats (
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (show_id, provider)
);
