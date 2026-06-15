ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress_total INTEGER;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS error_reason TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS reference_images_json TEXT;

CREATE TABLE IF NOT EXISTS generation_job_results (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  result_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  image_asset_id TEXT REFERENCES image_assets(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (job_id, result_index)
);

CREATE INDEX IF NOT EXISTS idx_generation_job_results_job_index ON generation_job_results(job_id, result_index);
CREATE INDEX IF NOT EXISTS idx_generation_job_results_space_job ON generation_job_results(space_id, job_id);
