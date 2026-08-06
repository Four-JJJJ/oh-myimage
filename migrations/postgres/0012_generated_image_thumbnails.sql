ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS thumbnail_storage_key TEXT;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS thumbnail_mime_type TEXT;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS thumbnail_byte_size INTEGER;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS thumbnail_sha256 TEXT;
