export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  GENERATION_QUEUE: Queue<GenerationMessage>;
  APP_ENCRYPTION_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_REQUIRED?: string;
  DEFAULT_IMAGE_MODEL?: string;
  MAX_IMAGES_PER_REQUEST?: string;
  MAX_DAILY_JOBS_PER_SPACE?: string;
  MAX_RUNNING_JOBS_PER_SPACE?: string;
  REQUEST_TIMEOUT_MS?: string;
  IMAGE_RETENTION_DAYS?: string;
}

export interface GenerationMessage {
  jobId: string;
  spaceId: string;
}

export interface SpaceRecord {
  id: string;
  space_name: string;
  space_key: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  space_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface CredentialRecord {
  id: string;
  space_id: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  api_key_hint: string;
  last_test_ok: number;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerationJobRecord {
  id: string;
  space_id: string;
  status: JobStatus;
  prompt: string;
  aspect_ratio: string;
  width: number;
  height: number;
  quality: string;
  quantity: number;
  output_format: string;
  background: string;
  compression: number | null;
  moderation: string;
  model: string;
  base_url_hash: string | null;
  revised_prompt: string | null;
  usage_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ImageAssetRecord {
  id: string;
  space_id: string;
  job_id: string;
  storage_key: string;
  mime_type: string;
  format: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  created_at: string;
  prompt?: string;
  quality?: string;
  aspect_ratio?: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type AppBindings = {
  Bindings: Env;
  Variables: {
    space: SpaceRecord;
    session: SessionRecord;
  };
};
