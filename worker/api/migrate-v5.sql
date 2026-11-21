-- v5：首页栏目缓存 + 各分类热榜名次
-- 首页栏目按原站 /v1/feed/home 的栏目顺序与条目落库，保证前端与会原站一致；
-- hot_rank 保存 电视剧/电影/综艺/动漫 分类热榜名次，列表页据此排序。

CREATE TABLE IF NOT EXISTS feed_rows (
  row_id TEXT PRIMARY KEY,
  section_id TEXT,
  title TEXT,
  subtitle TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL,
  browse TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS hot_rank (
  kind TEXT NOT NULL,
  rank INTEGER NOT NULL,
  show_id TEXT NOT NULL,
  heat_value REAL,
  synced_at TEXT,
  PRIMARY KEY (kind, rank)
);

CREATE INDEX IF NOT EXISTS idx_hot_rank_show ON hot_rank(show_id);
