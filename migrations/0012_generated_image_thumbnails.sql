ALTER TABLE image_assets ADD COLUMN thumbnail_storage_key TEXT;
ALTER TABLE image_assets ADD COLUMN thumbnail_mime_type TEXT;
ALTER TABLE image_assets ADD COLUMN thumbnail_byte_size INTEGER;
ALTER TABLE image_assets ADD COLUMN thumbnail_sha256 TEXT;
