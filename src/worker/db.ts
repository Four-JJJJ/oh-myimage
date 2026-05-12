import { randomId, todayStartIso } from "./http";
import {
  CredentialRecord,
  GenerationJobRecord,
  ImageAssetRecord,
  JobStatus,
  SessionRecord,
  SpaceRecord,
} from "./types";
import { GenerationInput } from "./validation";

export async function getSpaceByKey(db: D1Database, spaceKey: string): Promise<SpaceRecord | null> {
  return db.prepare("SELECT * FROM spaces WHERE space_key = ?").bind(spaceKey).first<SpaceRecord>();
}

export async function createSpace(
  db: D1Database,
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

export async function createSession(db: D1Database, spaceId: string, tokenHash: string, expiresAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO space_sessions (id, space_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(randomId("ses"), spaceId, tokenHash, expiresAt)
    .run();
}

export async function getSession(db: D1Database, tokenHash: string): Promise<(SessionRecord & SpaceRecord) | null> {
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

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM space_sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function upsertCredential(
  db: D1Database,
  spaceId: string,
  baseURL: string,
  model: string,
  encryptedApiKey: string,
  apiKeyHint: string,
): Promise<void> {
  const existing = await getCredential(db, spaceId);
  if (existing) {
    await db
      .prepare(
        `UPDATE api_credentials
         SET base_url = ?, model = ?, encrypted_api_key = ?, api_key_hint = ?, updated_at = CURRENT_TIMESTAMP
         WHERE space_id = ?`,
      )
      .bind(baseURL, model, encryptedApiKey, apiKeyHint, spaceId)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO api_credentials (id, space_id, base_url, model, encrypted_api_key, api_key_hint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(randomId("cred"), spaceId, baseURL, model, encryptedApiKey, apiKeyHint)
    .run();
}

export async function getCredential(db: D1Database, spaceId: string): Promise<CredentialRecord | null> {
  return db.prepare("SELECT * FROM api_credentials WHERE space_id = ?").bind(spaceId).first<CredentialRecord>();
}

export async function deleteCredential(db: D1Database, spaceId: string): Promise<void> {
  await db.prepare("DELETE FROM api_credentials WHERE space_id = ?").bind(spaceId).run();
}

export async function markCredentialTested(db: D1Database, spaceId: string, ok: boolean): Promise<void> {
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
  db: D1Database,
  spaceId: string,
  input: GenerationInput,
  model: string,
  baseUrlHash: string,
): Promise<string> {
  const id = randomId("job");
  await db
    .prepare(
      `INSERT INTO generation_jobs (
        id, space_id, status, prompt, aspect_ratio, width, height, quality, quantity,
        output_format, background, compression, moderation, model, base_url_hash
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
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
    )
    .run();
  return id;
}

export async function getGenerationJob(
  db: D1Database,
  spaceId: string,
  jobId: string,
): Promise<GenerationJobRecord | null> {
  return db
    .prepare("SELECT * FROM generation_jobs WHERE id = ? AND space_id = ?")
    .bind(jobId, spaceId)
    .first<GenerationJobRecord>();
}

export async function getGenerationJobForWorker(db: D1Database, jobId: string): Promise<GenerationJobRecord | null> {
  return db.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(jobId).first<GenerationJobRecord>();
}

export async function listImagesForJob(db: D1Database, spaceId: string, jobId: string): Promise<ImageAssetRecord[]> {
  const result = await db
    .prepare("SELECT * FROM image_assets WHERE job_id = ? AND space_id = ? ORDER BY created_at ASC")
    .bind(jobId, spaceId)
    .all<ImageAssetRecord>();
  return result.results ?? [];
}

export async function listImages(db: D1Database, spaceId: string, cursor?: string): Promise<ImageAssetRecord[]> {
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

export async function getImage(db: D1Database, spaceId: string, imageId: string): Promise<ImageAssetRecord | null> {
  return db
    .prepare("SELECT * FROM image_assets WHERE id = ? AND space_id = ?")
    .bind(imageId, spaceId)
    .first<ImageAssetRecord>();
}

export async function countDailyJobs(db: D1Database, spaceId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE space_id = ? AND created_at >= ?")
    .bind(spaceId, todayStartIso())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countActiveJobs(db: D1Database, spaceId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE space_id = ? AND status IN ('queued', 'running')")
    .bind(spaceId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function insertRateLimitEvent(db: D1Database, spaceId: string, eventType: string): Promise<void> {
  await db
    .prepare("INSERT INTO rate_limit_events (id, space_id, event_type) VALUES (?, ?, ?)")
    .bind(randomId("evt"), spaceId, eventType)
    .run();
}

export async function updateJobStatus(
  db: D1Database,
  jobId: string,
  status: JobStatus,
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  const completed = status === "succeeded" || status === "failed" || status === "cancelled";
  await db
    .prepare(
      `UPDATE generation_jobs
       SET status = ?,
           error_code = ?,
           error_message = ?,
           started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
           completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = ?`,
    )
    .bind(status, errorCode ?? null, errorMessage ?? null, status, completed ? 1 : 0, jobId)
    .run();
}

export async function completeJob(
  db: D1Database,
  jobId: string,
  revisedPrompt: string | null,
  usageJson: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_jobs
       SET status = 'succeeded', revised_prompt = ?, usage_json = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(revisedPrompt, usageJson, jobId)
    .run();
}

export async function insertImageAsset(
  db: D1Database,
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
