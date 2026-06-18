ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS conversation_id TEXT;
UPDATE generation_jobs
SET conversation_id = id
WHERE conversation_id IS NULL OR BTRIM(conversation_id) = '';
