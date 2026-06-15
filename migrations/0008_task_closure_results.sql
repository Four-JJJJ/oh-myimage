ALTER TABLE generation_jobs ADD COLUMN stage TEXT;
ALTER TABLE generation_jobs ADD COLUMN progress_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN progress_total INTEGER;
ALTER TABLE generation_jobs ADD COLUMN error_reason TEXT;
ALTER TABLE generation_jobs ADD COLUMN reference_images_json TEXT;

CREATE TABLE IF NOT EXISTS generation_job_results (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  result_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  image_asset_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (image_asset_id) REFERENCES image_assets(id) ON DELETE SET NULL,
  UNIQUE (job_id, result_index)
);

CREATE INDEX IF NOT EXISTS idx_generation_job_results_job_index ON generation_job_results(job_id, result_index);
CREATE INDEX IF NOT EXISTS idx_generation_job_results_space_job ON generation_job_results(space_id, job_id);
