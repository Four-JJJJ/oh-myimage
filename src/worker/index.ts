import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";
import {
  countActiveJobs,
  countDailyImageUsage,
  createGenerationJob,
  deleteGenerationJob,
  createSession,
  createSpace,
  deleteCredential,
  deleteSession,
  getCredential,
  getGenerationJob,
  getImage,
  getSession,
  getSpaceByKey,
  GENERATION_JOB_PAGE_SIZE,
  insertRateLimitEvent,
  listGenerationResultsForJob,
  listGenerationResultsForJobs,
  listGenerationJobs,
  listImages,
  listImagesForJob,
  listImagesForJobs,
  markCredentialTested,
  StoredReferenceImage,
  updateJobStatus,
  upsertCredential,
} from "./db";
import { apiKeyHint, decryptSecret, encryptSecret, hashPassword, makeSessionToken, sha256Hex, verifyPassword } from "./crypto";
import { daysFromNow, envNumber, jsonError, randomId } from "./http";
import { buildProviderEndpoint, normalizeSpaceName, validateBaseURL, verifyTurnstile } from "./security";
import { optimizePrompt, processGenerationMessage, ProviderError, resolveGenerationTimeoutMs, testProvider } from "./provider";
import {
  getInspirationItem,
  importInspirationUrl,
  isInspirationQueueMessage,
  listEnabledInspirationSources,
  listInspirations,
  parseInspirationTags,
  processInspirationSourceMessage,
  recordInspirationUse,
  toggleInspirationFavorite,
} from "./inspiration";
import { AppBindings, CredentialRecord, Env, GenerationJobRecord, GenerationMessage, SpaceRecord } from "./types";
import { GenerationInput, parseGenerationInput, parsePromptOptimizationInput, RATIO_TO_SIZE } from "./validation";

const SESSION_COOKIE = "image2_session";
const SESSION_DAYS = 30;
const SOURCE_IMAGE_ID_FIELD = "sourceImageId";
const REFERENCE_IMAGE_FIELD = "referenceImage";
const MASK_IMAGE_FIELD = "maskImage";
const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;
const MASK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const REFERENCE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MASK_IMAGE_MIME_TYPES = new Set(["image/png"]);
const IMAGE_MODEL_OPTIONS = ["gpt-image-2"] as const;
const PROMPT_OPTIMIZER_MODEL_OPTIONS = ["gpt-5.5", "gpt-5.4"] as const;
const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 0;
const MAX_PROVIDER_RETRY_ATTEMPTS = 4;
const DEFAULT_PROVIDER_RETRY_DELAY_SECONDS = 120;
const MAX_PROVIDER_RETRY_DELAY_SECONDS = 600;
const IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

export const app = new Hono<AppBindings>();

app.use("/api/*", cors({ origin: [], credentials: true }));

app.onError((error, c) => {
  if ("res" in error && error.res instanceof Response) return error.res;
  console.error(error);
  return c.json({ ok: false, error: { code: "internal_error", message: "服务暂时不可用。" } }, 500);
});

async function parseGenerationRequest(request: Request): Promise<{ body: Record<string, unknown> | null; referenceImages: File[]; maskImage?: File }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const formData = await request.formData().catch(() => null);
    if (!formData) return { body: null, referenceImages: [] };

    const body: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (key === REFERENCE_IMAGE_FIELD || key === MASK_IMAGE_FIELD || value instanceof File) continue;
      body[key] = value;
    }

    const uploadedImages = formData
      .getAll(REFERENCE_IMAGE_FIELD)
      .filter((value): value is File => value instanceof File && value.size > 0);
    const uploadedMask = formData.get(MASK_IMAGE_FIELD);
    return {
      body,
      referenceImages: uploadedImages,
      maskImage: uploadedMask instanceof File && uploadedMask.size > 0 ? uploadedMask : undefined,
    };
  }

  const body = await request.json().catch(() => null);
  return { body: body && typeof body === "object" ? (body as Record<string, unknown>) : null, referenceImages: [] };
}

async function storeReferenceImage(env: Env, spaceId: string, jobId: string, file: File, index = 0): Promise<StoredReferenceImage> {
  const mimeType = normalizeReferenceImageMime(file.type);
  if (!REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) {
    throw jsonError(400, "invalid_reference_image", "参考图仅支持 PNG、JPEG 或 WebP 格式。");
  }
  if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
    throw jsonError(400, "reference_image_too_large", "参考图不能超过 10MB。");
  }

  const bytes = await file.arrayBuffer();
  const extension = extensionForReferenceImage(mimeType);
  const name = safeReferenceImageName(file.name, extension);
  const storageKey = `${spaceId}/${jobId}/reference-${index + 1}.${extension}`;
  await env.IMAGES.put(storageKey, bytes, {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `inline; filename="${name}"`,
    },
    customMetadata: {
      jobId,
      spaceId,
      kind: "reference",
      referenceIndex: String(index + 1),
    },
  });

  return {
    storageKey,
    mimeType,
    name,
    byteSize: bytes.byteLength,
  };
}

async function storeReferenceImages(env: Env, spaceId: string, jobId: string, files: File[]): Promise<StoredReferenceImage[]> {
  if (files.length > MAX_REFERENCE_IMAGES) {
    throw jsonError(400, "too_many_reference_images", `参考图最多 ${MAX_REFERENCE_IMAGES} 张。`);
  }
  return Promise.all(files.map((file, index) => storeReferenceImage(env, spaceId, jobId, file, index)));
}

async function cloneSourceImageAsReference(env: Env, spaceId: string, jobId: string, sourceImageId: string): Promise<StoredReferenceImage> {
  const sourceImage = await getImage(env.DB, spaceId, sourceImageId);
  if (!sourceImage) {
    throw jsonError(404, "source_image_not_found", "源图片不存在。");
  }

  const mimeType = normalizeReferenceImageMime(sourceImage.mime_type);
  if (!REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) {
    throw jsonError(400, "invalid_source_image", "源图片格式不支持编辑。");
  }

  const extension = extensionForReferenceImage(mimeType);
  const name = safeReferenceImageName(`${sourceImage.id}.${extension}`, extension);
  const storageKey = `${spaceId}/${jobId}/reference-1.${extension}`;
  const putOptions = {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `inline; filename="${name}"`,
    },
    customMetadata: {
      jobId,
      spaceId,
      kind: "reference",
      referenceIndex: "1",
    },
  };

  if (env.IMAGES.copy) {
    await env.IMAGES.copy(sourceImage.storage_key, storageKey, putOptions);
  } else {
    const sourceObject = await env.IMAGES.get(sourceImage.storage_key);
    if (!sourceObject) {
      throw jsonError(404, "source_image_file_missing", "源图片文件不存在。");
    }
    await env.IMAGES.put(storageKey, await sourceObject.arrayBuffer(), putOptions);
  }

  return {
    storageKey,
    mimeType,
    name,
    byteSize: sourceImage.byte_size,
  };
}

async function storeMaskImage(env: Env, spaceId: string, jobId: string, file: File): Promise<StoredReferenceImage> {
  const mimeType = normalizeReferenceImageMime(file.type);
  if (!MASK_IMAGE_MIME_TYPES.has(mimeType)) {
    throw jsonError(400, "invalid_mask_image", "选区遮罩仅支持 PNG 格式。");
  }
  if (file.size > MASK_IMAGE_MAX_BYTES) {
    throw jsonError(400, "mask_image_too_large", "选区遮罩不能超过 10MB。");
  }

  const bytes = await file.arrayBuffer();
  const name = safeReferenceImageName(file.name, "png");
  const storageKey = `${spaceId}/${jobId}/mask.png`;
  await env.IMAGES.put(storageKey, bytes, {
    httpMetadata: {
      contentType: "image/png",
      contentDisposition: `inline; filename="${name}"`,
    },
    customMetadata: {
      jobId,
      spaceId,
      kind: "mask",
    },
  });

  return {
    storageKey,
    mimeType: "image/png",
    name,
    byteSize: bytes.byteLength,
  };
}

function normalizeReferenceImageMime(value: string): string {
  const mimeType = value.trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function extensionForReferenceImage(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function safeReferenceImageName(value: string, extension: string): string {
  const fallback = `reference.${extension}`;
  const safe = (value || fallback).replace(/[^\w.-]/g, "_").slice(0, 120);
  return safe || fallback;
}

async function assertGenerationLimitsForRequest(env: Env, spaceId: string, requestedImages: number): Promise<void> {
  const dailyLimit = dailyImageLimit(env);
  const runningLimit = envNumber(env.MAX_RUNNING_JOBS_PER_SPACE, 2);
  const usage = await countDailyImageUsage(env.DB, spaceId);
  if (usage.total + requestedImages > dailyLimit) {
    const remaining = Math.max(0, dailyLimit - usage.total);
    await insertRateLimitEvent(env.DB, spaceId, "daily_generation_limit");
    throw jsonError(429, "daily_limit_reached", `今日剩余张数不足，还剩 ${remaining} 张，本次请求 ${requestedImages} 张。`);
  }
  if ((await countActiveJobs(env.DB, spaceId)) >= runningLimit) {
    await insertRateLimitEvent(env.DB, spaceId, "active_generation_limit");
    throw jsonError(429, "active_limit_reached", `同时运行任务最多 ${runningLimit} 个。`);
  }
}

export function hasUnlimitedDailyImageQuota(credential: Pick<CredentialRecord, "base_url">): boolean {
  void credential;
  return false;
}

function hasImageProviderConfigured(credential: CredentialRecord | null): credential is CredentialRecord {
  return Boolean(credential?.base_url && credential.encrypted_api_key);
}

function hasPromptProviderConfigured(credential: CredentialRecord | null): credential is CredentialRecord {
  return Boolean(credential?.prompt_base_url && credential.prompt_encrypted_api_key);
}

function dailyImageLimit(env: Env): number {
  return Math.max(0, Math.trunc(envNumber(env.MAX_DAILY_IMAGES_PER_SPACE ?? env.MAX_DAILY_JOBS_PER_SPACE, 50)));
}

function generationInputFromJob(job: GenerationJobRecord): GenerationInput {
  return {
    prompt: job.prompt,
    aspectRatio: job.aspect_ratio,
    width: job.width,
    height: job.height,
    quality: job.quality as GenerationInput["quality"],
    quantity: job.quantity,
    outputFormat: job.output_format as GenerationInput["outputFormat"],
    background: job.background as GenerationInput["background"],
    compression: job.compression ?? 100,
    moderation: job.moderation as GenerationInput["moderation"],
  };
}

async function cloneReferenceImage(
  env: Env,
  spaceId: string,
  nextJobId: string,
  sourceJob: GenerationJobRecord,
): Promise<StoredReferenceImage[]> {
  const snapshots = referenceImagesFromJob(sourceJob);
  if (snapshots.length === 0) return [];
  const copied: StoredReferenceImage[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const sourceObject = await env.IMAGES.get(snapshot.storageKey);
    if (!sourceObject) {
      throw jsonError(404, "reference_image_missing", "参考图文件不存在，请重新上传后再试。");
    }

    const mimeType = snapshot.mimeType ?? sourceObject.httpMetadata?.contentType ?? "image/png";
    const extension = extensionForReferenceImage(mimeType);
    const name = safeReferenceImageName(snapshot.name ?? "", extension);
    const bytes = await sourceObject.arrayBuffer();
    const storageKey = `${spaceId}/${nextJobId}/reference-${index + 1}.${extension}`;
    await env.IMAGES.put(storageKey, bytes, {
      httpMetadata: {
        contentType: mimeType,
        contentDisposition: `inline; filename="${name}"`,
      },
      customMetadata: {
        jobId: nextJobId,
        spaceId,
        kind: "reference",
        referenceIndex: String(index + 1),
      },
    });

    copied.push({
      storageKey,
      mimeType,
      name,
      byteSize: bytes.byteLength,
    });
  }
  return copied;
}

function referenceImagesFromJob(
  job: Pick<
    GenerationJobRecord,
    "reference_images_json" | "reference_image_storage_key" | "reference_image_mime_type" | "reference_image_name" | "reference_image_byte_size"
  >,
): StoredReferenceImage[] {
  const parsed = parseReferenceImagesJson(job.reference_images_json);
  if (parsed.length > 0) return parsed;
  if (!job.reference_image_storage_key) return [];
  return [
    {
      storageKey: job.reference_image_storage_key,
      mimeType: job.reference_image_mime_type ?? "image/png",
      name: job.reference_image_name ?? "reference.png",
      byteSize: job.reference_image_byte_size ?? 0,
    },
  ];
}

function parseReferenceImagesJson(value: string | null | undefined): StoredReferenceImage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const storageKey = typeof record.storageKey === "string" ? record.storageKey : "";
        if (!storageKey) return null;
        return {
          storageKey,
          mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png",
          name: typeof record.name === "string" ? record.name : "reference.png",
          byteSize: typeof record.byteSize === "number" ? record.byteSize : 0,
        };
      })
      .filter((item): item is StoredReferenceImage => Boolean(item));
  } catch {
    return [];
  }
}

function conversationIdFromBody(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const value = body.conversationId;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

async function resolveConversationId(db: Env["DB"], spaceId: string, requestedConversationId?: string): Promise<string | undefined> {
  if (!requestedConversationId) return undefined;
  const sourceJob = await getGenerationJob(db, spaceId, requestedConversationId);
  if (!sourceJob) return undefined;
  return sourceJob.conversation_id ?? sourceJob.id;
}

async function cloneMaskImage(
  env: Env,
  spaceId: string,
  nextJobId: string,
  sourceJob: GenerationJobRecord,
): Promise<StoredReferenceImage | undefined> {
  if (!sourceJob.mask_image_storage_key) return undefined;
  const sourceObject = await env.IMAGES.get(sourceJob.mask_image_storage_key);
  if (!sourceObject) {
    throw jsonError(404, "mask_image_missing", "选区遮罩文件不存在，请重新涂抹后再试。");
  }

  const bytes = await sourceObject.arrayBuffer();
  const name = safeReferenceImageName(sourceJob.mask_image_name ?? "", "png");
  const storageKey = `${spaceId}/${nextJobId}/mask.png`;
  await env.IMAGES.put(storageKey, bytes, {
    httpMetadata: {
      contentType: "image/png",
      contentDisposition: `inline; filename="${name}"`,
    },
    customMetadata: {
      jobId: nextJobId,
      spaceId,
      kind: "mask",
    },
  });

  return {
    storageKey,
    mimeType: "image/png",
    name,
    byteSize: bytes.byteLength,
  };
}

app.get("/api/config", (c) => {
  const maxDailyImagesPerSpace = dailyImageLimit(c.env);
  return c.json({
    ok: true,
    config: {
      model: optionOrFallback(c.env.DEFAULT_IMAGE_MODEL, IMAGE_MODEL_OPTIONS),
      promptOptimizerModel: optionOrFallback(c.env.PROMPT_OPTIMIZER_MODEL, PROMPT_OPTIMIZER_MODEL_OPTIONS),
      maxImagesPerRequest: envNumber(c.env.MAX_IMAGES_PER_REQUEST, 4),
      maxDailyImagesPerSpace,
      maxDailyJobsPerSpace: maxDailyImagesPerSpace,
      generationTimeoutSeconds: Math.round(resolveGenerationTimeoutMs(c.env.REQUEST_TIMEOUT_MS) / 1000),
      ratios: [...Object.keys(RATIO_TO_SIZE), "custom"],
      qualities: ["auto", "low", "medium", "high"],
      formats: ["png", "webp", "jpeg"],
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? "",
      turnstileRequired: c.env.TURNSTILE_REQUIRED === "true",
    },
  });
});

app.post("/api/auth/space-login", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") throw jsonError(400, "invalid_request", "请求体格式不正确。");
  const { spaceName, password, turnstileToken } = body as Record<string, unknown>;
  if (typeof spaceName !== "string" || spaceName.trim().length < 2) {
    throw jsonError(400, "invalid_space_name", "空间名至少需要 2 个字符。");
  }
  if (typeof password !== "string" || password.length < 1) throw jsonError(400, "invalid_password", "请输入空间密码。");

  const turnstileOk = await verifyTurnstile(typeof turnstileToken === "string" ? turnstileToken : undefined, c.req.raw, c.env);
  if (!turnstileOk) throw jsonError(403, "turnstile_failed", "人机验证失败。");

  const normalized = normalizeSpaceName(spaceName);
  let space = await getSpaceByKey(c.env.DB, normalized.key);
  if (space) {
    const ok = await verifyPassword(password, space.password_hash);
    if (!ok) throw jsonError(401, "invalid_credentials", "空间名或密码不正确。");
  } else {
    if (password.length < 8) {
      throw jsonError(400, "invalid_password", "新空间密码至少需要 8 个字符。");
    }
    space = await createSpace(c.env.DB, normalized.displayName, normalized.key, await hashPassword(password));
  }

  const token = makeSessionToken();
  await createSession(c.env.DB, space.id, await sha256Hex(token), daysFromNow(SESSION_DAYS));
  const isSecureRequest = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return c.json({ ok: true, spaceId: space.id, spaceName: space.space_name });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(c.env.DB, await sha256Hex(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  const publicPaths = new Set(["/api/config", "/api/auth/space-login"]);
  if (publicPaths.has(new URL(c.req.url).pathname)) return next();
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw jsonError(401, "unauthorized", "请先进入空间。");
  const session = await getSession(c.env.DB, await sha256Hex(token));
  if (!session) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    throw jsonError(401, "session_expired", "登录状态已过期，请重新进入空间。");
  }
  c.set("session", session);
  c.set("space", {
    id: session.space_id,
    space_name: session.space_name,
    space_key: session.space_key,
    password_hash: session.password_hash,
    created_at: session.created_at,
    updated_at: session.updated_at,
  } satisfies SpaceRecord);
  return next();
});

app.get("/api/me", async (c) => {
  const space = c.get("space");
  const dailyLimit = dailyImageLimit(c.env);
  const [credential, usage] = await Promise.all([
    getCredential(c.env.DB, space.id),
    countDailyImageUsage(c.env.DB, space.id),
  ]);
  return c.json({
    ok: true,
    space: { id: space.id, name: space.space_name },
    providerConfigured: hasImageProviderConfigured(credential),
    dailyRemaining: Math.max(0, dailyLimit - usage.total),
    dailyLimit,
    dailyUsed: usage.generated,
    dailyPending: usage.pending,
  });
});

app.get("/api/settings/provider", async (c) => {
  const credential = await getCredential(c.env.DB, c.get("space").id);
  return c.json({
    ok: true,
    imageProvider: hasImageProviderConfigured(credential)
      ? {
          baseURL: credential.base_url,
          model: optionOrFallback(credential.model, IMAGE_MODEL_OPTIONS),
          apiKeyHint: credential.api_key_hint,
          lastTestOk: Boolean(credential.last_test_ok),
          lastTestedAt: credential.last_tested_at,
        }
      : null,
    promptProvider: hasPromptProviderConfigured(credential)
      ? {
          baseURL: credential.prompt_base_url ?? "",
          model: optionOrFallback(credential.prompt_optimizer_model ?? c.env.PROMPT_OPTIMIZER_MODEL, PROMPT_OPTIMIZER_MODEL_OPTIONS),
          apiKeyHint: credential.prompt_api_key_hint ?? "",
          lastTestOk: Boolean(credential.prompt_last_test_ok),
          lastTestedAt: credential.prompt_last_tested_at,
        }
      : null,
  });
});

app.post("/api/settings/provider", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") throw jsonError(400, "invalid_request", "请求体格式不正确。");
  const { imageProvider, promptProvider } = body as Record<string, unknown>;
  if ((!imageProvider || typeof imageProvider !== "object") && (!promptProvider || typeof promptProvider !== "object")) {
    throw jsonError(400, "invalid_request", "请至少填写一个 Provider。");
  }
  const existingCredential = await getCredential(c.env.DB, c.get("space").id);
  const imageInput = imageProvider && typeof imageProvider === "object" ? (imageProvider as Record<string, unknown>) : null;
  const promptInput = promptProvider && typeof promptProvider === "object" ? (promptProvider as Record<string, unknown>) : null;
  if (imageInput && typeof imageInput.baseURL !== "string") throw jsonError(400, "invalid_base_url", "请输入生图 Provider 的 baseURL。");
  if (promptInput && typeof promptInput.baseURL !== "string") throw jsonError(400, "invalid_prompt_base_url", "请输入提示词 Provider 的 baseURL。");
  if (!imageInput && !hasImageProviderConfigured(existingCredential)) throw jsonError(400, "invalid_image_provider", "请填写生图 Provider。");
  if (!promptInput && !hasPromptProviderConfigured(existingCredential)) throw jsonError(400, "invalid_prompt_provider", "请填写提示词 Provider。");
  const resolvedImageBaseURL = imageInput?.baseURL ?? existingCredential?.base_url;
  const resolvedPromptBaseURL = promptInput?.baseURL ?? existingCredential?.prompt_base_url;
  if (typeof resolvedImageBaseURL !== "string") throw jsonError(400, "invalid_base_url", "请输入生图 Provider 的 baseURL。");
  if (typeof resolvedPromptBaseURL !== "string") throw jsonError(400, "invalid_prompt_base_url", "请输入提示词 Provider 的 baseURL。");
  const imageValidation = validateBaseURL(resolvedImageBaseURL);
  const promptValidation = validateBaseURL(resolvedPromptBaseURL);
  if (!imageValidation.ok || !imageValidation.normalized) throw jsonError(400, "invalid_base_url", imageValidation.error ?? "生图 Provider 的 baseURL 不合法。");
  if (!promptValidation.ok || !promptValidation.normalized) throw jsonError(400, "invalid_prompt_base_url", promptValidation.error ?? "提示词 Provider 的 baseURL 不合法。");
  const rawImageApiKey = imageInput && typeof imageInput.apiKey === "string" ? imageInput.apiKey.trim() : "";
  const rawPromptApiKey = promptInput && typeof promptInput.apiKey === "string" ? promptInput.apiKey.trim() : "";
  if (rawImageApiKey && rawImageApiKey.length < 8) throw jsonError(400, "invalid_api_key", "请输入有效的生图 Provider API Key。");
  if (rawPromptApiKey && rawPromptApiKey.length < 8) throw jsonError(400, "invalid_prompt_api_key", "请输入有效的提示词 Provider API Key。");
  if (!rawImageApiKey && !existingCredential?.encrypted_api_key) throw jsonError(400, "invalid_api_key", "请输入有效的生图 Provider API Key。");
  if (!rawPromptApiKey && !existingCredential?.prompt_encrypted_api_key) throw jsonError(400, "invalid_prompt_api_key", "请输入有效的提示词 Provider API Key。");
  const selectedImageModel = optionOrFallback(
    imageInput && typeof imageInput.model === "string" ? imageInput.model : existingCredential?.model ?? c.env.DEFAULT_IMAGE_MODEL,
    IMAGE_MODEL_OPTIONS,
  );
  const selectedPromptOptimizerModel = optionOrFallback(
    promptInput && typeof promptInput.model === "string"
      ? promptInput.model
      : existingCredential?.prompt_optimizer_model ?? c.env.PROMPT_OPTIMIZER_MODEL,
    PROMPT_OPTIMIZER_MODEL_OPTIONS,
  );
  const encryptedImageApiKey = rawImageApiKey
    ? await encryptSecret(rawImageApiKey, c.env.APP_ENCRYPTION_KEY ?? "")
    : existingCredential?.encrypted_api_key;
  const savedImageApiKeyHint = rawImageApiKey ? apiKeyHint(rawImageApiKey) : existingCredential?.api_key_hint;
  const encryptedPromptApiKey = rawPromptApiKey
    ? await encryptSecret(rawPromptApiKey, c.env.APP_ENCRYPTION_KEY ?? "")
    : existingCredential?.prompt_encrypted_api_key;
  const savedPromptApiKeyHint = rawPromptApiKey ? apiKeyHint(rawPromptApiKey) : existingCredential?.prompt_api_key_hint;
  if (!encryptedImageApiKey || !savedImageApiKeyHint) throw jsonError(400, "invalid_api_key", "请输入有效的生图 Provider API Key。");
  if (!encryptedPromptApiKey || !savedPromptApiKeyHint) throw jsonError(400, "invalid_prompt_api_key", "请输入有效的提示词 Provider API Key。");

  await upsertCredential(
    c.env.DB,
    c.get("space").id,
    {
      imageBaseURL: imageValidation.normalized,
      imageModel: selectedImageModel,
      imageEncryptedApiKey: encryptedImageApiKey,
      imageApiKeyHint: savedImageApiKeyHint,
      promptBaseURL: promptValidation.normalized,
      promptModel: selectedPromptOptimizerModel,
      promptEncryptedApiKey: encryptedPromptApiKey,
      promptApiKeyHint: savedPromptApiKeyHint,
    },
  );
  return c.json({
    ok: true,
    imageProvider: {
      baseURL: imageValidation.normalized,
      model: selectedImageModel,
      apiKeyHint: savedImageApiKeyHint,
      lastTestOk: false,
      lastTestedAt: null,
    },
    promptProvider: {
      baseURL: promptValidation.normalized,
      model: selectedPromptOptimizerModel,
      apiKeyHint: savedPromptApiKeyHint,
      lastTestOk: false,
      lastTestedAt: null,
    },
  });
});

app.delete("/api/settings/provider", async (c) => {
  await deleteCredential(c.env.DB, c.get("space").id);
  return c.json({ ok: true });
});

app.post("/api/provider/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const spaceId = c.get("space").id;
  const kind = body && typeof body === "object" && (body as Record<string, unknown>).kind === "prompt" ? "prompt" : "image";
  let baseURL: string | undefined;
  let apiKey: string | undefined;

  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).baseURL === "string") {
    const raw = body as Record<string, unknown>;
    const validation = validateBaseURL(raw.baseURL as string);
    if (!validation.ok || !validation.normalized) throw jsonError(400, "invalid_base_url", validation.error ?? "baseURL 不合法。");
    const rawApiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    baseURL = validation.normalized;
    if (rawApiKey) {
      apiKey = rawApiKey;
    } else {
      const credential = await getCredential(c.env.DB, spaceId);
      if (!credential) throw jsonError(400, "invalid_api_key", "请输入 API Key。");
      const encryptedApiKey = kind === "prompt" ? credential.prompt_encrypted_api_key : credential.encrypted_api_key;
      if (!encryptedApiKey) throw jsonError(400, "invalid_api_key", "请输入 API Key。");
      apiKey = await decryptSecret(encryptedApiKey, c.env.APP_ENCRYPTION_KEY ?? "");
    }
  } else {
    const credential = await getCredential(c.env.DB, spaceId);
    if (!credential) throw jsonError(400, "provider_missing", "请先保存 provider 配置。");
    baseURL = kind === "prompt" ? credential.prompt_base_url ?? undefined : credential.base_url;
    const encryptedApiKey = kind === "prompt" ? credential.prompt_encrypted_api_key : credential.encrypted_api_key;
    if (!baseURL || !encryptedApiKey) {
      throw jsonError(400, "provider_missing", kind === "prompt" ? "请先保存提示词 Provider 配置。" : "请先保存生图 Provider 配置。");
    }
    apiKey = await decryptSecret(encryptedApiKey, c.env.APP_ENCRYPTION_KEY ?? "");
  }

  const result = await testProvider(baseURL, apiKey);
  if (!(body && typeof body === "object" && typeof (body as Record<string, unknown>).baseURL === "string")) {
    await markCredentialTested(c.env.DB, spaceId, kind, result.ok);
  }
  return c.json({ ok: true, result });
});

app.post("/api/prompts/optimize", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parsePromptOptimizationInput(body);
  if (!parsed.input) throw jsonError(400, "invalid_prompt_input", parsed.error ?? "提示词优化参数不正确。");

  const spaceId = c.get("space").id;
  const credential = await getCredential(c.env.DB, spaceId);
  if (!hasPromptProviderConfigured(credential)) throw jsonError(400, "provider_missing", "请先在设置中配置提示词 Provider。");

  try {
    const apiKey = await decryptSecret(credential.prompt_encrypted_api_key ?? "", c.env.APP_ENCRYPTION_KEY ?? "");
    const optimizedPrompt = await optimizePrompt(parsed.input, credential, apiKey, c.env);
    return c.json({ ok: true, optimizedPrompt });
  } catch (error) {
    const providerError =
      error instanceof ProviderError ? error : new ProviderError("prompt_optimization_failed", "提示词优化失败，请稍后重试。");
    throw jsonError(providerHttpStatus(providerError), providerError.code, providerError.message);
  }
});

app.post("/api/generations", async (c) => {
  const requestPayload = await parseGenerationRequest(c.req.raw);
  const parsed = parseGenerationInput(requestPayload.body, c.env.MAX_IMAGES_PER_REQUEST);
  if (!parsed.input) throw jsonError(400, "invalid_generation_input", parsed.error ?? "生图参数不正确。");
  const sourceImageId =
    typeof requestPayload.body?.[SOURCE_IMAGE_ID_FIELD] === "string" ? requestPayload.body[SOURCE_IMAGE_ID_FIELD].trim() : "";
  const requestedConversationId = conversationIdFromBody(requestPayload.body);

  const turnstileOk = await verifyTurnstile(parsed.input.turnstileToken, c.req.raw, c.env);
  if (!turnstileOk) throw jsonError(403, "turnstile_failed", "人机验证失败。");

  const space = c.get("space");
  const credential = await getCredential(c.env.DB, space.id);
  if (!hasImageProviderConfigured(credential)) throw jsonError(400, "provider_missing", "请先在设置中配置生图 Provider。");
  await assertGenerationLimitsForRequest(c.env, space.id, parsed.input.quantity);

  if (requestPayload.referenceImages.length > 0 && sourceImageId) {
    throw jsonError(400, "reference_source_conflict", "参考图上传和源图片编辑不能同时使用。");
  }
  if (requestPayload.maskImage && requestPayload.referenceImages.length === 0 && !sourceImageId) {
    throw jsonError(400, "mask_requires_reference_image", "选区遮罩需要和参考图一起提交。");
  }

  const jobId = randomId("job");
  const referenceImages = requestPayload.referenceImages.length > 0
    ? await storeReferenceImages(c.env, space.id, jobId, requestPayload.referenceImages)
    : sourceImageId
      ? [await cloneSourceImageAsReference(c.env, space.id, jobId, sourceImageId)]
      : [];
  const maskImage = requestPayload.maskImage ? await storeMaskImage(c.env, space.id, jobId, requestPayload.maskImage) : undefined;

  await createGenerationJob(
    c.env.DB,
    space.id,
    parsed.input,
    credential.model,
    await sha256Hex(credential.base_url),
    referenceImages,
    maskImage,
    jobId,
    await resolveConversationId(c.env.DB, space.id, requestedConversationId),
  );
  await enqueueGenerationJob(c.env, jobId, space.id, parsed.input.quantity);
  return c.json({ ok: true, jobId, status: "queued" });
});

app.get("/api/generations", async (c) => {
  const spaceId = c.get("space").id;
  const jobs = await listGenerationJobs(c.env.DB, spaceId, c.req.query("cursor"));
  const visibleJobs = jobs.slice(0, GENERATION_JOB_PAGE_SIZE);
  const jobIds = visibleJobs.map((job) => job.id);
  const images = await listImagesForJobs(c.env.DB, spaceId, jobIds);
  const results = await listGenerationResultsForJobs(c.env.DB, spaceId, jobIds);
  const imagesByJob = new Map<string, typeof images>();
  for (const image of images) {
    const group = imagesByJob.get(image.job_id) ?? [];
    group.push(image);
    imagesByJob.set(image.job_id, group);
  }
  const resultsByJob = new Map<string, typeof results>();
  for (const result of results) {
    const group = resultsByJob.get(result.job_id) ?? [];
    group.push(result);
    resultsByJob.set(result.job_id, group);
  }

  return c.json({
    ok: true,
    records: visibleJobs.map((job) => {
      const jobImages = imagesByJob.get(job.id) ?? [];
      return {
        job: serializeGenerationJob(job, resultsByJob.get(job.id) ?? []),
        elapsedSeconds: generationElapsedSeconds(job),
        images: jobImages.map((image) => serializeImage(image)),
      };
    }),
    nextCursor: jobs.length > GENERATION_JOB_PAGE_SIZE ? visibleJobs.at(-1)?.created_at : null,
  });
});

app.get("/api/generations/:jobId", async (c) => {
  const job = await getGenerationJob(c.env.DB, c.get("space").id, c.req.param("jobId"));
  if (!job) throw jsonError(404, "job_not_found", "任务不存在。");
  const images = await listImagesForJob(c.env.DB, c.get("space").id, job.id);
  const results = await listGenerationResultsForJob(c.env.DB, c.get("space").id, job.id);
  return c.json({
    ok: true,
    job: serializeGenerationJob(job, results),
    images: images.map((image) => serializeImage(image)),
  });
});

app.get("/api/generations/:jobId/references/:index", async (c) => {
  const spaceId = c.get("space").id;
  const job = await getGenerationJob(c.env.DB, spaceId, c.req.param("jobId"));
  if (!job) throw jsonError(404, "job_not_found", "任务不存在。");
  const index = Number(c.req.param("index"));
  const reference = referenceImagesFromJob(job)[index];
  if (!Number.isInteger(index) || index < 0 || !reference) {
    throw jsonError(404, "reference_image_not_found", "参考图不存在。");
  }
  const object = await c.env.IMAGES.get(reference.storageKey);
  if (!object) throw jsonError(404, "reference_image_missing", "参考图文件不存在。");
  return new Response(object.body, {
    headers: {
      "Content-Type": reference.mimeType,
      "Content-Disposition": `inline; filename="${reference.name}"`,
    },
  });
});

app.delete("/api/generations/:jobId", async (c) => {
  const spaceId = c.get("space").id;
  const job = await getGenerationJob(c.env.DB, spaceId, c.req.param("jobId"));
  if (!job) throw jsonError(404, "job_not_found", "任务不存在。");

  const images = await listImagesForJob(c.env.DB, spaceId, job.id);
  const storageKeys = [
    ...images.map((image) => image.storage_key),
    ...referenceImagesFromJob(job).map((reference) => reference.storageKey),
    ...(job.mask_image_storage_key ? [job.mask_image_storage_key] : []),
  ];
  for (const storageKey of storageKeys) {
    await c.env.IMAGES.delete(storageKey);
  }
  await deleteGenerationJob(c.env.DB, spaceId, job.id);
  return c.json({ ok: true });
});

app.post("/api/generations/:jobId/regenerate", async (c) => {
  const space = c.get("space");
  const sourceJob = await getGenerationJob(c.env.DB, space.id, c.req.param("jobId"));
  if (!sourceJob) throw jsonError(404, "job_not_found", "任务不存在。");

  const credential = await getCredential(c.env.DB, space.id);
  if (!hasImageProviderConfigured(credential)) throw jsonError(400, "provider_missing", "请先在设置中配置生图 Provider。");
  await assertGenerationLimitsForRequest(c.env, space.id, sourceJob.quantity);

  const jobId = randomId("job");
  const referenceImages = await cloneReferenceImage(c.env, space.id, jobId, sourceJob);
  const maskImage = await cloneMaskImage(c.env, space.id, jobId, sourceJob);
  await createGenerationJob(
    c.env.DB,
    space.id,
    generationInputFromJob(sourceJob),
    credential.model,
    await sha256Hex(credential.base_url),
    referenceImages,
    maskImage,
    jobId,
    sourceJob.conversation_id ?? sourceJob.id,
  );
  await enqueueGenerationJob(c.env, jobId, space.id, sourceJob.quantity);
  return c.json({ ok: true, jobId, status: "queued" });
});

app.get("/api/images", async (c) => {
  const images = await listImages(c.env.DB, c.get("space").id, c.req.query("cursor"));
  return c.json({
    ok: true,
    images: images.map((image) => serializeImage(image, true)),
    nextCursor: images.length === 30 ? images[images.length - 1]?.created_at : null,
  });
});

app.get("/api/images/:imageId/download", async (c) => {
  const image = await getImage(c.env.DB, c.get("space").id, c.req.param("imageId"));
  if (!image) throw jsonError(404, "image_not_found", "图片不存在。");
  const filename = `${image.id}.${image.format}`;
  const inlineContentDisposition = `inline; filename="${filename}"`;
  const attachmentContentDisposition = `attachment; filename="${filename}"`;
  const rawDownload = c.req.query("raw") === "1";
  const attachmentDownload = c.req.query("download") === "1";
  const etag = imageETag(image.sha256);
  const cachedHeaders = imageResponseHeaders(image.mime_type, attachmentDownload ? attachmentContentDisposition : inlineContentDisposition, etag);
  if (rawDownload) {
    if (matchesIfNoneMatch(c.req.header("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: cachedHeaders });
    }
    const object = await c.env.IMAGES.get(image.storage_key);
    if (!object) throw jsonError(404, "image_file_missing", "图片文件不存在。");
    return new Response(object.body, {
      headers: cachedHeaders,
    });
  }
  if (c.env.IMAGES.createPresignedGetUrl) {
    const url = await c.env.IMAGES.createPresignedGetUrl(image.storage_key, {
      expiresInSeconds: 300,
      contentType: image.mime_type,
      contentDisposition: inlineContentDisposition,
    });
    return c.redirect(url, 302);
  }
  const object = await c.env.IMAGES.get(image.storage_key);
  if (!object) throw jsonError(404, "image_file_missing", "图片文件不存在。");
  return new Response(object.body, {
    headers: imageResponseHeaders(image.mime_type, inlineContentDisposition, etag),
  });
});

app.get("/api/inspirations", async (c) => {
  const result = await listInspirations(c.env.DB, c.get("space").id, {
    q: c.req.query("q"),
    source: c.req.query("source"),
    tag: c.req.query("tag"),
    favorites: c.req.query("favorites") === "1",
    cursor: c.req.query("cursor"),
  });
  return c.json({
    ok: true,
    inspirations: result.items.map((item) => serializeInspiration(item)),
    nextCursor: result.nextCursor,
  });
});

app.post("/api/inspirations/import-url", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") throw jsonError(400, "invalid_request", "请求体格式不正确。");
  const raw = body as Record<string, unknown>;
  if (typeof raw.url !== "string") throw jsonError(400, "invalid_url", "请输入灵感来源链接。");
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === "string") : undefined;
  try {
    const item = await importInspirationUrl(c.env, {
      url: raw.url,
      prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
      author: typeof raw.author === "string" ? raw.author : undefined,
      tags,
    });
    return c.json({ ok: true, inspiration: serializeInspiration({ ...item, favorite: 0 }) });
  } catch (error) {
    throw jsonError(400, "inspiration_import_failed", error instanceof Error ? error.message : "导入失败。");
  }
});

app.post("/api/inspirations/:itemId/favorite", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const favorite = body && typeof body === "object" && typeof (body as Record<string, unknown>).favorite === "boolean"
    ? ((body as Record<string, unknown>).favorite as boolean)
    : undefined;
  try {
    const nextFavorite = await toggleInspirationFavorite(c.env.DB, c.get("space").id, c.req.param("itemId"), favorite);
    return c.json({ ok: true, favorite: nextFavorite });
  } catch (error) {
    throw jsonError(404, "inspiration_not_found", error instanceof Error ? error.message : "灵感素材不存在。");
  }
});

app.post("/api/inspirations/:itemId/use", async (c) => {
  await recordInspirationUse(c.env.DB, c.req.param("itemId"));
  return c.json({ ok: true });
});

app.get("/api/inspirations/:itemId/thumbnail", async (c) => {
  const item = await getInspirationItem(c.env.DB, c.req.param("itemId"));
  if (!item || item.status !== "published" || !item.thumbnail_storage_key) {
    throw jsonError(404, "inspiration_thumbnail_missing", "灵感缩略图不存在。");
  }
  const contentDisposition = `inline; filename="${item.id}"`;
  if (c.env.IMAGES.createPresignedGetUrl) {
    const url = await c.env.IMAGES.createPresignedGetUrl(item.thumbnail_storage_key, {
      expiresInSeconds: 300,
      contentType: item.thumbnail_mime_type ?? "image/jpeg",
      contentDisposition,
    });
    return c.redirect(url, 302);
  }
  const object = await c.env.IMAGES.get(item.thumbnail_storage_key);
  if (!object) throw jsonError(404, "inspiration_thumbnail_missing", "灵感缩略图不存在。");
  return new Response(object.body, {
    headers: {
      "Content-Type": item.thumbnail_mime_type ?? "image/jpeg",
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": contentDisposition,
    },
  });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (env.INSPIRATION_FEATURE_ENABLED !== "true") return;
    const sources = await listEnabledInspirationSources(env.DB);
    const results = await Promise.allSettled(
      sources.map((source) =>
        env.INSPIRATION_QUEUE.send({
          type: "inspiration-source",
          sourceId: source.id,
          trigger: "scheduled",
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") console.error("inspiration scheduled enqueue failed", result.reason);
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isInspirationQueueMessage(message.body)) {
        await processInspirationSourceMessage(message.body, env);
        message.ack();
        continue;
      }

      const canRetryProviderError = message.attempts <= resolveProviderRetryAttempts(env.PROVIDER_RETRY_ATTEMPTS);
      try {
        await processGenerationMessage(message.body as GenerationMessage, env, { throwRetryableErrors: canRetryProviderError });
        message.ack();
      } catch (error) {
        if (canRetryProviderError && error instanceof ProviderError && error.retryable) {
          const delaySeconds = resolveProviderRetryDelaySeconds(env.PROVIDER_RETRY_DELAY_SECONDS);
          console.warn(
            `generation provider retry scheduled after ${delaySeconds}s`,
            JSON.stringify({ messageId: message.id, attempts: message.attempts, code: error.code }),
          );
          message.retry({ delaySeconds });
          continue;
        }
        throw error;
      }
    }
  },
};

// Force buildProviderEndpoint to stay typechecked with worker entry. It is also exported for tests.
void buildProviderEndpoint;

function providerHttpStatus(error: ProviderError): number {
  if (error.code === "provider_rate_limited") return 429;
  if (error.code === "provider_timeout") return 504;
  if (error.code === "provider_auth_failed") return 502;
  return 502;
}

async function enqueueGenerationJob(env: Env, jobId: string, spaceId: string, quantity: number): Promise<void> {
  try {
    await env.GENERATION_QUEUE.send({ jobId, spaceId });
  } catch (error) {
    const message = "生图任务进入队列失败，请稍后重试。";
    try {
      await updateJobStatus(env.DB, jobId, "failed", "queue_enqueue_failed", message, {
        stage: "failed",
        progressCurrent: 0,
        progressTotal: quantity,
      });
    } catch (updateError) {
      console.error("generation queue enqueue compensation failed", updateError);
    }
    throw jsonError(503, "queue_enqueue_failed", message);
  }
}

function serializeGenerationJob(job: GenerationJobRecord, results: Awaited<ReturnType<typeof listGenerationResultsForJob>>) {
  return {
    ...job,
    conversation_id: job.conversation_id ?? job.id,
    stage: job.stage ?? stageFromStatus(job.status),
    progress_current: job.progress_current ?? inferredProgressCurrent(job, results),
    progress_total: job.progress_total ?? job.quantity,
    error_reason: job.error_reason ?? job.error_message,
    results: normalizeGenerationResults(job, results),
    referenceImages: referenceImagesFromJob(job).map((reference, index) => ({
      name: reference.name,
      mimeType: reference.mimeType,
      byteSize: reference.byteSize,
      url: `/api/generations/${job.id}/references/${index}`,
    })),
  };
}

function normalizeGenerationResults(job: GenerationJobRecord, results: Awaited<ReturnType<typeof listGenerationResultsForJob>>) {
  const byIndex = new Map(results.map((result) => [result.result_index, result]));
  return Array.from({ length: job.quantity }, (_, index) => {
    const result = byIndex.get(index);
    if (result) {
      return {
        index,
        status: result.status,
        imageId: result.image_asset_id,
        errorCode: result.error_code,
        errorMessage: result.error_message,
        startedAt: result.started_at,
        completedAt: result.completed_at,
      };
    }
    return {
      index,
      status: job.status === "queued" || job.status === "running" ? job.status : "failed",
      imageId: null,
      errorCode: job.status === "partial_succeeded" || job.status === "failed" ? job.error_code : null,
      errorMessage: job.status === "partial_succeeded" || job.status === "failed" ? job.error_message : null,
      startedAt: null,
      completedAt: null,
    };
  });
}

function inferredProgressCurrent(job: GenerationJobRecord, results: Awaited<ReturnType<typeof listGenerationResultsForJob>>): number {
  if (job.status === "succeeded" || job.status === "partial_succeeded" || job.status === "failed" || job.status === "cancelled") return job.quantity;
  return results.filter((result) => result.status === "succeeded" || result.status === "failed").length;
}

function stageFromStatus(status: GenerationJobRecord["status"]) {
  if (status === "queued") return "queued";
  if (status === "running") return "waiting_provider";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
}

function serializeImage(
  image: {
    id: string;
    job_id: string;
    width: number;
    height: number;
    format: string;
    byte_size?: number;
    created_at: string;
    prompt?: string;
    quality?: string;
    aspect_ratio?: string;
  },
  includeMetadata = false,
) {
  return {
    id: image.id,
    jobId: image.job_id,
    url: `/api/images/${image.id}/download?raw=1`,
    width: image.width,
    height: image.height,
    format: image.format,
    byteSize: image.byte_size,
    createdAt: image.created_at,
    ...(includeMetadata
      ? {
          prompt: image.prompt,
          quality: image.quality,
          aspectRatio: image.aspect_ratio,
        }
      : {}),
  };
}

function imageResponseHeaders(contentType: string, contentDisposition: string, etag: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Cache-Control": IMAGE_CACHE_CONTROL,
    "Content-Disposition": contentDisposition,
    "ETag": etag,
  };
}

function imageETag(sha256: string): string {
  return `"${sha256.replace(/"/g, "")}"`;
}

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === etag || item === "*");
}

function generationElapsedSeconds(job: { created_at: string; started_at: string | null; completed_at: string | null }): number | null {
  const startedAt = parseDbTimestamp(job.started_at ?? job.created_at);
  const finishedAt = job.completed_at ? parseDbTimestamp(job.completed_at) : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return null;
  return Math.round((finishedAt - startedAt) / 1000);
}

function parseDbTimestamp(value: string): number {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return Date.parse(value);
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

function optionOrFallback<T extends readonly string[]>(value: string | undefined, options: T): T[number] {
  const normalized = value?.trim() ?? "";
  return options.some((option) => option === normalized) ? (normalized as T[number]) : options[0];
}

export function resolveProviderRetryAttempts(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(envNumber(value, DEFAULT_PROVIDER_RETRY_ATTEMPTS)), 0), MAX_PROVIDER_RETRY_ATTEMPTS);
}

export function resolveProviderRetryDelaySeconds(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(envNumber(value, DEFAULT_PROVIDER_RETRY_DELAY_SECONDS)), 1), MAX_PROVIDER_RETRY_DELAY_SECONDS);
}

function serializeInspiration(item: Parameters<typeof inspirationItemShape>[0]) {
  return inspirationItemShape(item);
}

function inspirationItemShape(item: {
  id: string;
  source_key?: string;
  source_name?: string;
  original_url: string;
  author: string | null;
  title: string | null;
  prompt: string;
  negative_prompt: string | null;
  thumbnail_storage_key: string | null;
  original_image_url: string | null;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  tags_json: string;
  model: string | null;
  safety: string;
  use_count: number;
  imported_at: string;
  favorite?: number;
}) {
  return {
    id: item.id,
    sourceKey: item.source_key ?? "",
    sourceName: item.source_name ?? "",
    originalUrl: item.original_url,
    author: item.author,
    title: item.title,
    prompt: item.prompt,
    negativePrompt: item.negative_prompt,
    thumbnailUrl: item.thumbnail_storage_key ? `/api/inspirations/${item.id}/thumbnail` : null,
    externalImageUrl: item.original_image_url,
    width: item.width,
    height: item.height,
    aspectRatio: item.aspect_ratio,
    tags: parseInspirationTags(item.tags_json),
    model: item.model,
    safety: item.safety,
    useCount: item.use_count,
    importedAt: item.imported_at,
    favorite: Boolean(item.favorite),
  };
}
