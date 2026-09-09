ALTER TABLE api_credentials ADD COLUMN active_image_provider_id TEXT;

CREATE TABLE IF NOT EXISTS image_provider_profiles (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  api_key_hint TEXT NOT NULL,
  last_test_ok INTEGER NOT NULL DEFAULT 0,
  last_tested_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (space_id, name)
);

INSERT INTO image_provider_profiles (
  id, space_id, name, base_url, model, encrypted_api_key, api_key_hint, last_test_ok, last_tested_at
)
SELECT 'profile_' || id, space_id, '默认配置', base_url, model, encrypted_api_key, api_key_hint, last_test_ok, last_tested_at
FROM api_credentials
WHERE NOT EXISTS (
  SELECT 1 FROM image_provider_profiles WHERE image_provider_profiles.space_id = api_credentials.space_id
);

UPDATE api_credentials
SET active_image_provider_id = 'profile_' || id
WHERE active_image_provider_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_image_provider_profiles_space_created
  ON image_provider_profiles(space_id, created_at);
