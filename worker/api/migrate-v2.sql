ALTER TABLE shows ADD COLUMN intro_end REAL;
ALTER TABLE shows ADD COLUMN outro_from REAL;
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
