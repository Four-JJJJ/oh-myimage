CREATE TABLE IF NOT EXISTS inspiration_sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inspiration_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_item_id TEXT,
  original_url TEXT NOT NULL,
  author TEXT,
  title TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT,
  thumbnail_storage_key TEXT,
  thumbnail_mime_type TEXT,
  original_image_url TEXT,
  width INTEGER,
  height INTEGER,
  aspect_ratio TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  safety TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'published',
  dedupe_key TEXT NOT NULL UNIQUE,
  use_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_id) REFERENCES inspiration_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspiration_favorites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES inspiration_items(id) ON DELETE CASCADE,
  UNIQUE (space_id, item_id)
);

CREATE TABLE IF NOT EXISTS inspiration_import_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  source_key TEXT,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_imported INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (source_id) REFERENCES inspiration_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inspiration_sources_enabled ON inspiration_sources(enabled, source_key);
CREATE INDEX IF NOT EXISTS idx_inspiration_items_source_imported ON inspiration_items(source_id, imported_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_items_status_imported ON inspiration_items(status, imported_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_favorites_space_created ON inspiration_favorites(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_import_runs_source_started ON inspiration_import_runs(source_id, started_at);

INSERT OR IGNORE INTO inspiration_sources (id, source_key, name, kind, enabled, config_json)
VALUES
  ('src_civitai', 'civitai', 'Civitai', 'civitai', 1, '{"limit":12,"nsfw":false,"sort":"Most Reactions","period":"Week"}'),
  ('src_x', 'x', 'X', 'x', 0, '{"query":"(AI art OR image prompt) has:images -is:retweet lang:en","limit":10}'),
  ('src_jimeng', 'jimeng', '即梦灵感', 'jimeng', 0, '{"urls":["https://www.jimeng.com/"]}');
