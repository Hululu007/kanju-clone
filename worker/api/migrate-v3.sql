CREATE UNIQUE INDEX IF NOT EXISTS uniq_danmaku ON danmaku(show_id, ep_idx, t, text);
