CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  space_name TEXT NOT NULL,
  space_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS space_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  api_key_hint TEXT NOT NULL,
  last_test_ok INTEGER NOT NULL DEFAULT 0,
  last_tested_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
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
  revised_prompt TEXT,
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  format TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_sessions_space_expires ON space_sessions(space_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_space_created ON generation_jobs(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created ON generation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_space_created ON image_assets(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_job ON image_assets(job_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_space_type_created ON rate_limit_events(space_id, event_type, created_at);
