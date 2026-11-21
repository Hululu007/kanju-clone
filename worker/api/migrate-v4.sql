CREATE INDEX IF NOT EXISTS idx_shows_kind_area_heat ON shows(content_kind, area, heat_value DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_area_updated ON shows(content_kind, area, updated_ts DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_heat ON shows(content_kind, heat_value DESC);
CREATE INDEX IF NOT EXISTS idx_shows_kind_updated ON shows(content_kind, updated_ts DESC);
CREATE INDEX IF NOT EXISTS idx_shows_episode_count ON shows(episode_count);
