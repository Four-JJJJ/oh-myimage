import { randomId, todayStartTimestamp } from "./http";
import {
  AppDatabase,
  CredentialRecord,
  GenerationJobResultRecord,
  GenerationJobRecord,
  GenerationReferenceImageSnapshot,
  ImageAssetRecord,
  JobStage,
  JobStatus,
  SessionRecord,
  SpaceRecord,
} from "./types";
import { GenerationInput } from "./validation";

export const IMAGE_GENERATED_EVENT = "image_generated";

export interface StoredReferenceImage {
  storageKey: string;
  mimeType: string;
  name: string;
  byteSize: number;
}

export interface JobStatusUpdate {
  stage?: JobStage | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  errorReason?: string | null;
}

export interface DailyImageUsage {
  generated: number;
  pending: number;
  total: number;
}

export async function getSpaceByKey(db: AppDatabase, spaceKey: string): Promise<SpaceRecord | null> {
  return db.prepare("SELECT * FROM spaces WHERE space_key = ?").bind(spaceKey).first<SpaceRecord>();
}

export async function createSpace(
  db: AppDatabase,
  displayName: string,
  spaceKey: string,
  passwordHash: string,
): Promise<SpaceRecord> {
  const id = randomId("spc");
  await db
    .prepare("INSERT INTO spaces (id, space_name, space_key, password_hash) VALUES (?, ?, ?, ?)")
    .bind(id, displayName, spaceKey, passwordHash)
    .run();
  const space = await getSpaceByKey(db, spaceKey);
  if (!space) throw new Error("空间创建失败。");
  return space;
}

export async function createSession(db: AppDatabase, spaceId: string, tokenHash: string, expiresAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO space_sessions (id, space_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(randomId("ses"), spaceId, tokenHash, expiresAt)
    .run();
}

export async function getSession(db: AppDatabase, tokenHash: string): Promise<(SessionRecord & SpaceRecord) | null> {
  return db
    .prepare(
      `SELECT
        space_sessions.id,
        space_sessions.space_id,
        space_sessions.token_hash,
        space_sessions.expires_at,
        space_sessions.created_at,
        spaces.id AS space_id_record,
        spaces.space_name,
        spaces.space_key,
        spaces.password_hash,
        spaces.updated_at
      FROM space_sessions
      INNER JOIN spaces ON spaces.id = space_sessions.space_id
      WHERE space_sessions.token_hash = ? AND space_sessions.expires_at > ?`,
    )
    .bind(tokenHash, new Date().toISOString())
    .first<SessionRecord & SpaceRecord & { space_id_record: string }>();
}

export async function deleteSession(db: AppDatabase, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM space_sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function upsertCredential(
  db: AppDatabase,
  spaceId: string,
  baseURL: string,
  model: string,
  promptOptimizerModel: string,
  encryptedApiKey: string,
  apiKeyHint: string,
): Promise<void> {
  const existing = await getCredential(db, spaceId);
  if (existing) {
    await db
      .prepare(
        `UPDATE api_credentials
         SET base_url = ?, model = ?, prompt_optimizer_model = ?, encrypted_api_key = ?, api_key_hint = ?,
             last_test_ok = 0, last_tested_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE space_id = ?`,
      )
      .bind(baseURL, model, promptOptimizerModel, encryptedApiKey, apiKeyHint, spaceId)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO api_credentials (id, space_id, base_url, model, prompt_optimizer_model, encrypted_api_key, api_key_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(randomId("cred"), spaceId, baseURL, model, promptOptimizerModel, encryptedApiKey, apiKeyHint)
    .run();
}

export async function getCredential(db: AppDatabase, spaceId: string): Promise<CredentialRecord | null> {
  return db.prepare("SELECT * FROM api_credentials WHERE space_id = ?").bind(spaceId).first<CredentialRecord>();
}

export async function deleteCredential(db: AppDatabase, spaceId: string): Promise<void> {
  await db.prepare("DELETE FROM api_credentials WHERE space_id = ?").bind(spaceId).run();
}

export async function markCredentialTested(db: AppDatabase, spaceId: string, ok: boolean): Promise<void> {
  await db
    .prepare(
      `UPDATE api_credentials
       SET last_test_ok = ?, last_tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE space_id = ?`,
    )
    .bind(ok ? 1 : 0, spaceId)
    .run();
}

export async function createGenerationJob(
  db: AppDatabase,
  spaceId: string,
  input: GenerationInput,
  model: string,
  baseUrlHash: string,
  referenceImages: StoredReferenceImage[] = [],
  maskImage?: StoredReferenceImage,
  jobId = randomId("job"),
): Promise<string> {
  const primaryReference = referenceImages[0];
  const referenceImagesJson = referenceImages.length > 0 ? JSON.stringify(referenceImages.map(referenceImageSnapshot)) : null;
  await db
    .prepare(
      `INSERT INTO generation_jobs (
        id, space_id, status, prompt, aspect_ratio, width, height, quality, quantity,
        output_format, background, compression, moderation, model, base_url_hash,
        reference_image_storage_key, reference_image_mime_type, reference_image_name, reference_image_byte_size,
        mask_image_storage_key, mask_image_mime_type, mask_image_name, mask_image_byte_size,
        stage, progress_current, progress_total, reference_images_json
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .bind(
      jobId,
      spaceId,
      input.prompt,
      input.aspectRatio,
      input.width,
      input.height,
      input.quality,
      input.quantity,
      input.outputFormat,
      input.background,
      input.outputFormat === "png" ? null : input.compression,
      input.moderation,
      model,
      baseUrlHash,
      primaryReference?.storageKey ?? null,
      primaryReference?.mimeType ?? null,
      primaryReference?.name ?? null,
      primaryReference?.byteSize ?? null,
      maskImage?.storageKey ?? null,
      maskImage?.mimeType ?? null,
      maskImage?.name ?? null,
      maskImage?.byteSize ?? null,
      input.quantity,
      referenceImagesJson,
    )
    .run();
  return jobId;
}

export async function getGenerationJob(
  db: AppDatabase,
  spaceId: string,
  jobId: string,
): Promise<GenerationJobRecord | null> {
  return db
    .prepare("SELECT * FROM generation_jobs WHERE id = ? AND space_id = ?")
    .bind(jobId, spaceId)
    .first<GenerationJobRecord>();
}

export async function getGenerationJobForWorker(db: AppDatabase, jobId: string): Promise<GenerationJobRecord | null> {
  return db.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(jobId).first<GenerationJobRecord>();
}

export async function deleteGenerationJob(db: AppDatabase, spaceId: string, jobId: string): Promise<void> {
  await db.prepare("DELETE FROM generation_jobs WHERE id = ? AND space_id = ?").bind(jobId, spaceId).run();
}

export async function listGenerationJobs(db: AppDatabase, spaceId: string, cursor?: string): Promise<GenerationJobRecord[]> {
  const sql = cursor
    ? `SELECT * FROM generation_jobs
       WHERE space_id = ? AND created_at < ?
       ORDER BY created_at DESC
       LIMIT 30`
    : `SELECT * FROM generation_jobs
       WHERE space_id = ?
       ORDER BY created_at DESC
       LIMIT 30`;
  const statement = cursor ? db.prepare(sql).bind(spaceId, cursor) : db.prepare(sql).bind(spaceId);
  const result = await statement.all<GenerationJobRecord>();
  return result.results ?? [];
}

export async function listImagesForJob(db: AppDatabase, spaceId: string, jobId: string): Promise<ImageAssetRecord[]> {
  const result = await db
    .prepare("SELECT * FROM image_assets WHERE job_id = ? AND space_id = ? ORDER BY created_at ASC")
    .bind(jobId, spaceId)
    .all<ImageAssetRecord>();
  return result.results ?? [];
}

export async function listImagesForJobs(db: AppDatabase, spaceId: string, jobIds: string[]): Promise<ImageAssetRecord[]> {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT * FROM image_assets
       WHERE space_id = ? AND job_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(spaceId, ...jobIds)
    .all<ImageAssetRecord>();
  return result.results ?? [];
}

export async function listGenerationResultsForJob(
  db: AppDatabase,
  spaceId: string,
  jobId: string,
): Promise<GenerationJobResultRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM generation_job_results
       WHERE space_id = ? AND job_id = ?
       ORDER BY result_index ASC`,
    )
    .bind(spaceId, jobId)
    .all<GenerationJobResultRecord>();
  return result.results ?? [];
}

export async function listGenerationResultsForJobs(
  db: AppDatabase,
  spaceId: string,
  jobIds: string[],
): Promise<GenerationJobResultRecord[]> {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT * FROM generation_job_results
       WHERE space_id = ? AND job_id IN (${placeholders})
       ORDER BY job_id ASC, result_index ASC`,
    )
    .bind(spaceId, ...jobIds)
    .all<GenerationJobResultRecord>();
  return result.results ?? [];
}

export async function listImages(db: AppDatabase, spaceId: string, cursor?: string): Promise<ImageAssetRecord[]> {
  const sql = cursor
    ? `SELECT image_assets.*, generation_jobs.prompt, generation_jobs.quality, generation_jobs.aspect_ratio
       FROM image_assets
       INNER JOIN generation_jobs ON generation_jobs.id = image_assets.job_id
       WHERE image_assets.space_id = ? AND image_assets.created_at < ?
       ORDER BY image_assets.created_at DESC
       LIMIT 30`
    : `SELECT image_assets.*, generation_jobs.prompt, generation_jobs.quality, generation_jobs.aspect_ratio
       FROM image_assets
       INNER JOIN generation_jobs ON generation_jobs.id = image_assets.job_id
       WHERE image_assets.space_id = ?
       ORDER BY image_assets.created_at DESC
       LIMIT 30`;
  const statement = cursor ? db.prepare(sql).bind(spaceId, cursor) : db.prepare(sql).bind(spaceId);
  const result = await statement.all<ImageAssetRecord>();
  return result.results ?? [];
}

export async function getImage(db: AppDatabase, spaceId: string, imageId: string): Promise<ImageAssetRecord | null> {
  return db
    .prepare("SELECT * FROM image_assets WHERE id = ? AND space_id = ?")
    .bind(imageId, spaceId)
    .first<ImageAssetRecord>();
}

export async function countDailyGeneratedImages(db: AppDatabase, spaceId: string): Promise<number> {
  const todayStart = todayStartTimestamp();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT rate_limit_events.id
         FROM rate_limit_events
         WHERE rate_limit_events.space_id = ?
           AND rate_limit_events.event_type = ?
           AND rate_limit_events.created_at >= ?
         UNION ALL
         SELECT image_assets.id
         FROM image_assets
         WHERE image_assets.space_id = ?
           AND image_assets.created_at >= ?
           AND NOT EXISTS (
             SELECT 1
             FROM rate_limit_events
             WHERE rate_limit_events.id = 'evt_usage_' || image_assets.id
           )
       ) daily_usage`,
    )
    .bind(spaceId, IMAGE_GENERATED_EVENT, todayStart, spaceId, todayStart)
    .first<{ count: number | string }>();
  return dbNumber(row?.count);
}

export async function countPendingGenerationImages(db: AppDatabase, spaceId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE
           WHEN generation_jobs.quantity > COALESCE(image_counts.image_count, 0)
           THEN generation_jobs.quantity - COALESCE(image_counts.image_count, 0)
           ELSE 0
         END
       ), 0) AS count
       FROM generation_jobs
       LEFT JOIN (
         SELECT job_id, COUNT(*) AS image_count
         FROM image_assets
         WHERE space_id = ?
         GROUP BY job_id
       ) image_counts ON image_counts.job_id = generation_jobs.id
       WHERE generation_jobs.space_id = ?
         AND generation_jobs.status IN ('queued', 'running')`,
    )
    .bind(spaceId, spaceId)
    .first<{ count: number | string }>();
  return dbNumber(row?.count);
}

export async function countDailyImageUsage(db: AppDatabase, spaceId: string): Promise<DailyImageUsage> {
  const generated = await countDailyGeneratedImages(db, spaceId);
  const pending = await countPendingGenerationImages(db, spaceId);
  return {
    generated,
    pending,
    total: generated + pending,
  };
}

export async function countActiveJobs(db: AppDatabase, spaceId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE space_id = ? AND status IN ('queued', 'running')")
    .bind(spaceId)
    .first<{ count: number | string }>();
  return dbNumber(row?.count);
}

export async function insertRateLimitEvent(db: AppDatabase, spaceId: string, eventType: string): Promise<void> {
  await db
    .prepare("INSERT INTO rate_limit_events (id, space_id, event_type) VALUES (?, ?, ?)")
    .bind(randomId("evt"), spaceId, eventType)
    .run();
}

export async function insertImageUsageEvent(db: AppDatabase, spaceId: string, imageId: string): Promise<void> {
  await db
    .prepare("INSERT INTO rate_limit_events (id, space_id, event_type) VALUES (?, ?, ?)")
    .bind(imageUsageEventId(imageId), spaceId, IMAGE_GENERATED_EVENT)
    .run();
}

export async function updateJobStatus(
  db: AppDatabase,
  jobId: string,
  status: JobStatus,
  errorCode?: string,
  errorMessage?: string,
  update: JobStatusUpdate = {},
): Promise<void> {
  const completed = status === "succeeded" || status === "partial_succeeded" || status === "failed" || status === "cancelled";
  const nextStage = update.stage ?? stageForStatus(status);
  await db
    .prepare(
      `UPDATE generation_jobs
       SET status = ?,
           error_code = ?,
           error_message = ?,
           error_reason = ?,
           stage = ?,
           progress_current = COALESCE(?, progress_current),
           progress_total = COALESCE(?, progress_total),
           started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
           completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = ?`,
    )
    .bind(
      status,
      errorCode ?? null,
      errorMessage ?? null,
      update.errorReason ?? errorMessage ?? null,
      nextStage,
      update.progressCurrent ?? null,
      update.progressTotal ?? null,
      status,
      completed,
      jobId,
    )
    .run();
}

export async function completeJob(
  db: AppDatabase,
  jobId: string,
  status: Extract<JobStatus, "succeeded" | "partial_succeeded">,
  revisedPrompt: string | null,
  usageJson: string | null,
  errorCode: string | null = null,
  errorMessage: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_jobs
       SET status = ?, stage = 'completed', progress_current = quantity, progress_total = quantity,
           revised_prompt = ?, usage_json = ?, error_code = ?, error_message = ?, error_reason = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, revisedPrompt, usageJson, errorCode, errorMessage, errorMessage, jobId)
    .run();
}

export async function upsertGenerationJobResult(
  db: AppDatabase,
  row: Omit<GenerationJobResultRecord, "created_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO generation_job_results (
        id, space_id, job_id, result_index, status, image_asset_id, error_code, error_message, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id, result_index) DO UPDATE SET
        status = excluded.status,
        image_asset_id = excluded.image_asset_id,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        started_at = COALESCE(generation_job_results.started_at, excluded.started_at),
        completed_at = excluded.completed_at`,
    )
    .bind(
      row.id,
      row.space_id,
      row.job_id,
      row.result_index,
      row.status,
      row.image_asset_id,
      row.error_code,
      row.error_message,
      row.started_at,
      row.completed_at,
    )
    .run();
}

export async function insertImageAsset(
  db: AppDatabase,
  row: Omit<ImageAssetRecord, "created_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO image_assets (
        id, space_id, job_id, storage_key, mime_type, format, width, height, byte_size, sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.space_id,
      row.job_id,
      row.storage_key,
      row.mime_type,
      row.format,
      row.width,
      row.height,
      row.byte_size,
      row.sha256,
    )
    .run();
}

function imageUsageEventId(imageId: string): string {
  return `evt_usage_${imageId}`;
}

function dbNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function referenceImageSnapshot(image: StoredReferenceImage): GenerationReferenceImageSnapshot {
  return {
    storageKey: image.storageKey,
    mimeType: image.mimeType,
    name: image.name,
    byteSize: image.byteSize,
  };
}

function stageForStatus(status: JobStatus): JobStage {
  if (status === "queued") return "queued";
  if (status === "running") return "waiting_provider";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
}
