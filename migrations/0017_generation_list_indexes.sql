CREATE INDEX IF NOT EXISTS idx_generation_jobs_space_created ON generation_jobs(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_assets_space_created ON image_assets(space_id, created_at DESC);
