-- Idempotent v8 attempt de-duplication table for browser-confirmed playback outcomes.
CREATE TABLE IF NOT EXISTS provider_playback_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  show_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_attempts_created ON provider_playback_attempts(created_at);
