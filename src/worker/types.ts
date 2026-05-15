export interface AppDatabase {
  prepare(query: string): AppPreparedStatement;
}

export interface AppPreparedStatement {
  bind(...values: unknown[]): AppPreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface AppObject {
  body: ReadableStream | null;
  httpMetadata?: {
    contentType?: string;
    contentDisposition?: string;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AppObjectStorePutOptions {
  httpMetadata?: {
    contentType?: string;
    contentDisposition?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface AppObjectStore {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: AppObjectStorePutOptions,
  ): Promise<unknown>;
  get(key: string): Promise<AppObject | null>;
  copy?(sourceKey: string, destinationKey: string, options?: AppObjectStorePutOptions): Promise<unknown>;
  delete(key: string): Promise<void>;
  createPresignedGetUrl?(
    key: string,
    options?: {
      expiresInSeconds?: number;
      contentType?: string;
      contentDisposition?: string;
    },
  ): Promise<string>;
}

export interface AppQueue<T> {
  send(message: T): Promise<void>;
}

export interface Env {
  DB: AppDatabase;
  IMAGES: AppObjectStore;
  ASSETS?: Fetcher;
  GENERATION_QUEUE: AppQueue<GenerationMessage>;
  INSPIRATION_QUEUE: AppQueue<InspirationQueueMessage>;
  APP_ENCRYPTION_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_REQUIRED?: string;
  DEFAULT_IMAGE_MODEL?: string;
  PROMPT_OPTIMIZER_MODEL?: string;
  MAX_IMAGES_PER_REQUEST?: string;
  MAX_DAILY_IMAGES_PER_SPACE?: string;
  MAX_DAILY_JOBS_PER_SPACE?: string;
  MAX_RUNNING_JOBS_PER_SPACE?: string;
  REQUEST_TIMEOUT_MS?: string;
  PROVIDER_IMAGE_BATCH_SIZE?: string;
  PROVIDER_IMAGE_CONCURRENCY?: string;
  PROVIDER_RETRY_ATTEMPTS?: string;
  PROVIDER_RETRY_DELAY_SECONDS?: string;
  IMAGE_RETENTION_DAYS?: string;
  X_BEARER_TOKEN?: string;
  INSPIRATION_FEATURE_ENABLED?: string;
  INSPIRATION_MAX_ITEMS_PER_RUN?: string;
  INSPIRATION_THUMBNAIL_MAX_BYTES?: string;
  INSPIRATION_AUTO_PUBLISH_SOURCES?: string;
}

export interface GenerationMessage {
  jobId: string;
  spaceId: string;
}

export interface InspirationQueueMessage {
  type: "inspiration-source";
  sourceId: string;
  trigger: "scheduled" | "manual";
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
  prompt_optimizer_model: string;
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
  reference_image_storage_key: string | null;
  reference_image_mime_type: string | null;
  reference_image_name: string | null;
  reference_image_byte_size: number | null;
  mask_image_storage_key: string | null;
  mask_image_mime_type: string | null;
  mask_image_name: string | null;
  mask_image_byte_size: number | null;
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

export interface InspirationSourceRecord {
  id: string;
  source_key: string;
  name: string;
  kind: "x" | "jimeng" | "civitai" | "generic";
  enabled: number;
  config_json: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InspirationItemRecord {
  id: string;
  source_id: string;
  source_item_id: string | null;
  original_url: string;
  author: string | null;
  title: string | null;
  prompt: string;
  negative_prompt: string | null;
  thumbnail_storage_key: string | null;
  thumbnail_mime_type: string | null;
  original_image_url: string | null;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  tags_json: string;
  model: string | null;
  safety: "sfw" | "nsfw" | "unknown";
  status: "draft" | "published" | "hidden";
  dedupe_key: string;
  use_count: number;
  imported_at: string;
  created_at: string;
  updated_at: string;
  source_key?: string;
  source_name?: string;
  favorite?: number;
}

export interface InspirationImportRunRecord {
  id: string;
  source_id: string | null;
  source_key: string | null;
  trigger_type: "scheduled" | "manual";
  status: "running" | "succeeded" | "failed";
  items_seen: number;
  items_imported: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export type JobStatus = "queued" | "running" | "succeeded" | "partial_succeeded" | "failed" | "cancelled";

export type AppBindings = {
  Bindings: Env;
  Variables: {
    space: SpaceRecord;
    session: SessionRecord;
  };
};
