CREATE INDEX IF NOT EXISTS idx_image_assets_space_job_created ON image_assets(space_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_results_space_job_index ON generation_job_results(space_id, job_id, result_index);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_space_status ON generation_jobs(space_id, status);
