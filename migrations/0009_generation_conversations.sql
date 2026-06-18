ALTER TABLE generation_jobs ADD COLUMN conversation_id TEXT;
UPDATE generation_jobs SET conversation_id = id WHERE conversation_id IS NULL OR TRIM(conversation_id) = '';
