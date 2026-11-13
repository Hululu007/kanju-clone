-- kanju-clone 片库（D1）。字段口径对齐原站 /v1 卡片结构，值全部为中文。
DROP TABLE IF EXISTS shows;
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS progress;

CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,            -- 原始标题
  title_cn TEXT,                  -- 中文标题
  year INTEGER,
  category TEXT,                  -- movie / tv / anime / variety
  kind TEXT,                      -- movie / series / anime / documentary
  area_cn TEXT,                   -- 地区（中文）
  language_cn TEXT,               -- 语言（中文）
  tags_cn TEXT,                   -- 中文题材数组（JSON）
  remarks_cn TEXT,                -- 角标，如「全 3 段」
  synopsis_cn TEXT,               -- 中文简介
  poster TEXT,
  runtime REAL,
  license TEXT,
  collection TEXT,
  downloads INTEGER DEFAULT 0,
  heat_value REAL DEFAULT 0,
  playback_count INTEGER DEFAULT 0,
  updated_at TEXT,
  added TEXT
);
CREATE INDEX idx_shows_cat ON shows(category);
CREATE INDEX idx_shows_heat ON shows(heat_value DESC);

CREATE TABLE episodes (
  show_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  label TEXT,
  stream TEXT NOT NULL,
  length REAL,
  quality TEXT,
  PRIMARY KEY (show_id, idx)
);
CREATE INDEX idx_eps_show ON episodes(show_id);

CREATE TABLE progress (
  device TEXT NOT NULL,
  show_id TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 1,
  position REAL DEFAULT 0,
  duration REAL DEFAULT 0,
  updated TEXT,
  PRIMARY KEY (device, show_id)
);
