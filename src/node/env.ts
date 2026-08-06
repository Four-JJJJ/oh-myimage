import "dotenv/config";
import { createPostgresDatabase, PostgresD1Database } from "./postgres-d1";
import { createBullQueues, BullQueues } from "./queue";
import { createR2Store } from "./r2-store";
import { envNumber } from "../worker/http";
import type { Env } from "../worker/types";

export interface NodeRuntime {
  env: Env;
  close(): Promise<void>;
}

export interface CreateNodeRuntimeOptions {
  queues?: boolean;
}

export function createNodeRuntime(options: CreateNodeRuntimeOptions = {}): NodeRuntime {
  const db = createPostgresDatabase(requiredEnv("DATABASE_URL"));
  const queues = options.queues === false ? null : createBullQueues({
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    generationAttempts: resolveGenerationAttempts(),
    generationBackoffMs: envNumber(process.env.POST_PROCESSING_RETRY_DELAY_SECONDS, 5) * 1000,
  });

  const env: Env = {
    DB: db,
    IMAGES: createR2Store({
      accountId: process.env.R2_ACCOUNT_ID,
      endpoint: process.env.R2_ENDPOINT,
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      bucket: requiredEnv("R2_BUCKET"),
    }),
    GENERATION_QUEUE: queues?.generationQueue ?? disabledQueue("generation"),
    INSPIRATION_QUEUE: queues?.inspirationQueue ?? disabledQueue("inspiration"),
    APP_ENCRYPTION_KEY: requiredEnv("APP_ENCRYPTION_KEY"),
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY ?? "",
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY ?? "",
    TURNSTILE_REQUIRED: process.env.TURNSTILE_REQUIRED ?? "false",
    DEFAULT_IMAGE_MODEL: process.env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2",
    PROMPT_OPTIMIZER_MODEL: process.env.PROMPT_OPTIMIZER_MODEL ?? "gpt-5.5",
    MAX_IMAGES_PER_REQUEST: process.env.MAX_IMAGES_PER_REQUEST ?? "4",
    MAX_DAILY_IMAGES_PER_SPACE: process.env.MAX_DAILY_IMAGES_PER_SPACE ?? process.env.MAX_DAILY_JOBS_PER_SPACE ?? "50",
    MAX_DAILY_JOBS_PER_SPACE: process.env.MAX_DAILY_JOBS_PER_SPACE,
    MAX_RUNNING_JOBS_PER_SPACE: process.env.MAX_RUNNING_JOBS_PER_SPACE ?? "12",
    REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS ?? "600000",
    GENERATION_JOB_MAX_RUNTIME_MS: process.env.GENERATION_JOB_MAX_RUNTIME_MS ?? "840000",
    PROVIDER_IMAGE_CONCURRENCY: process.env.PROVIDER_IMAGE_CONCURRENCY ?? "2",
    PROVIDER_TIMEOUT_RETRY_ATTEMPTS: process.env.PROVIDER_TIMEOUT_RETRY_ATTEMPTS ?? "0",
    PROVIDER_RETRY_ATTEMPTS: process.env.PROVIDER_RETRY_ATTEMPTS ?? "0",
    PROVIDER_RETRY_DELAY_SECONDS: process.env.PROVIDER_RETRY_DELAY_SECONDS ?? "120",
    POST_PROCESSING_RETRY_ATTEMPTS: process.env.POST_PROCESSING_RETRY_ATTEMPTS ?? "2",
    POST_PROCESSING_RETRY_DELAY_SECONDS: process.env.POST_PROCESSING_RETRY_DELAY_SECONDS ?? "5",
    IMAGE_RETENTION_DAYS: process.env.IMAGE_RETENTION_DAYS ?? "90",
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN ?? "",
    INSPIRATION_FEATURE_ENABLED: process.env.INSPIRATION_FEATURE_ENABLED ?? "false",
    INSPIRATION_MAX_ITEMS_PER_RUN: process.env.INSPIRATION_MAX_ITEMS_PER_RUN ?? "12",
    INSPIRATION_THUMBNAIL_MAX_BYTES: process.env.INSPIRATION_THUMBNAIL_MAX_BYTES ?? "1048576",
    INSPIRATION_AUTO_PUBLISH_SOURCES: process.env.INSPIRATION_AUTO_PUBLISH_SOURCES ?? "civitai",
  };

  return {
    env,
    async close() {
      await Promise.all([closeDatabase(db), closeQueues(queues)]);
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function resolveGenerationAttempts(): number {
  return resolveGenerationQueueAttempts(process.env.PROVIDER_RETRY_ATTEMPTS, process.env.POST_PROCESSING_RETRY_ATTEMPTS);
}

export function resolveGenerationQueueAttempts(providerValue: string | undefined, postProcessingValue?: string): number {
  return Math.max(1, Math.trunc(Math.max(envNumber(providerValue, 0), envNumber(postProcessingValue, 2))) + 1);
}

function disabledQueue<T>(name: string) {
  return {
    async send(): Promise<void> {
      throw new Error(`${name} queue is disabled in this process.`);
    },
  };
}

async function closeDatabase(db: PostgresD1Database): Promise<void> {
  await db.close();
}

async function closeQueues(queues: BullQueues | null): Promise<void> {
  if (queues) await queues.close();
}
