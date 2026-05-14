ALTER TABLE generation_jobs ADD COLUMN reference_image_storage_key TEXT;
ALTER TABLE generation_jobs ADD COLUMN reference_image_mime_type TEXT;
ALTER TABLE generation_jobs ADD COLUMN reference_image_name TEXT;
ALTER TABLE generation_jobs ADD COLUMN reference_image_byte_size INTEGER;
