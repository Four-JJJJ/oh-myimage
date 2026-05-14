CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  space_name TEXT NOT NULL,
  space_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS space_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_optimizer_model TEXT NOT NULL DEFAULT 'gpt-5.5',
  encrypted_api_key TEXT NOT NULL,
  api_key_hint TEXT NOT NULL,
  last_test_ok INTEGER NOT NULL DEFAULT 0,
  last_tested_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  quality TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  output_format TEXT NOT NULL,
  background TEXT NOT NULL,
  compression INTEGER,
  moderation TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url_hash TEXT,
  reference_image_storage_key TEXT,
  reference_image_mime_type TEXT,
  reference_image_name TEXT,
  reference_image_byte_size INTEGER,
  mask_image_storage_key TEXT,
  mask_image_mime_type TEXT,
  mask_image_name TEXT,
  mask_image_byte_size INTEGER,
  revised_prompt TEXT,
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  format TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inspiration_sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inspiration_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES inspiration_sources(id) ON DELETE CASCADE,
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
  imported_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS inspiration_favorites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES inspiration_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (space_id, item_id)
);

CREATE TABLE IF NOT EXISTS inspiration_import_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES inspiration_sources(id) ON DELETE SET NULL,
  source_key TEXT,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_imported INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_space_sessions_space_expires ON space_sessions(space_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_space_created ON generation_jobs(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created ON generation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_space_created ON image_assets(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_job ON image_assets(job_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_space_type_created ON rate_limit_events(space_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_sources_enabled ON inspiration_sources(enabled, source_key);
CREATE INDEX IF NOT EXISTS idx_inspiration_items_source_imported ON inspiration_items(source_id, imported_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_items_status_imported ON inspiration_items(status, imported_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_favorites_space_created ON inspiration_favorites(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inspiration_import_runs_source_started ON inspiration_import_runs(source_id, started_at);

INSERT INTO inspiration_sources (id, source_key, name, kind, enabled, config_json)
VALUES
  ('src_civitai', 'civitai', 'Civitai', 'civitai', 1, '{"limit":12,"nsfw":false,"sort":"Most Reactions","period":"Week"}'),
  ('src_x', 'x', 'X', 'x', 0, '{"query":"(AI art OR image prompt) has:images -is:retweet lang:en","limit":10}'),
  ('src_jimeng', 'jimeng', '即梦灵感', 'jimeng', 0, '{"urls":["https://www.jimeng.com/"]}')
ON CONFLICT (id) DO NOTHING;
