ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS prompt_base_url TEXT;
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS prompt_encrypted_api_key TEXT;
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS prompt_api_key_hint TEXT;
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS prompt_last_test_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS prompt_last_tested_at TEXT;
