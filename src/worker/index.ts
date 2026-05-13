import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";
import {
  countActiveJobs,
  countDailyJobs,
  createGenerationJob,
  createSession,
  createSpace,
  deleteCredential,
  deleteSession,
  getCredential,
  getGenerationJob,
  getImage,
  getSession,
  getSpaceByKey,
  insertRateLimitEvent,
  listImages,
  listImagesForJob,
  markCredentialTested,
  upsertCredential,
} from "./db";
import { apiKeyHint, decryptSecret, encryptSecret, hashPassword, makeSessionToken, sha256Hex, verifyPassword } from "./crypto";
import { daysFromNow, envNumber, jsonError, randomId } from "./http";
import { buildProviderEndpoint, normalizeSpaceName, validateBaseURL, verifyTurnstile } from "./security";
import { processGenerationMessage, resolveGenerationTimeoutMs, testProvider } from "./provider";
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
import { AppBindings, Env, GenerationMessage, SpaceRecord } from "./types";
import { parseGenerationInput, RATIO_TO_SIZE } from "./validation";

const SESSION_COOKIE = "image2_session";
const SESSION_DAYS = 30;

const app = new Hono<AppBindings>();

app.use("/api/*", cors({ origin: [], credentials: true }));

app.onError((error, c) => {
  console.error(error);
  if ("res" in error && error.res instanceof Response) return error.res;
  return c.json({ ok: false, error: { code: "internal_error", message: "服务暂时不可用。" } }, 500);
});

app.get("/api/config", (c) => {
  return c.json({
    ok: true,
    config: {
      model: c.env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2",
      maxImagesPerRequest: envNumber(c.env.MAX_IMAGES_PER_REQUEST, 4),
      maxDailyJobsPerSpace: envNumber(c.env.MAX_DAILY_JOBS_PER_SPACE, 50),
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
  if (typeof password !== "string" || password.length < 8) {
    throw jsonError(400, "invalid_password", "密码至少需要 8 个字符。");
  }

  const turnstileOk = await verifyTurnstile(typeof turnstileToken === "string" ? turnstileToken : undefined, c.req.raw, c.env);
  if (!turnstileOk) throw jsonError(403, "turnstile_failed", "人机验证失败。");

  const normalized = normalizeSpaceName(spaceName);
  let space = await getSpaceByKey(c.env.DB, normalized.key);
  if (space) {
    const ok = await verifyPassword(password, space.password_hash);
    if (!ok) throw jsonError(401, "invalid_credentials", "空间名或密码不正确。");
  } else {
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
  const credential = await getCredential(c.env.DB, space.id);
  return c.json({
    ok: true,
    space: { id: space.id, name: space.space_name },
    providerConfigured: Boolean(credential),
  });
});

app.get("/api/settings/provider", async (c) => {
  const credential = await getCredential(c.env.DB, c.get("space").id);
  return c.json({
    ok: true,
    provider: credential
      ? {
          baseURL: credential.base_url,
          model: credential.model,
          apiKeyHint: credential.api_key_hint,
          lastTestOk: Boolean(credential.last_test_ok),
          lastTestedAt: credential.last_tested_at,
        }
      : null,
  });
});

app.post("/api/settings/provider", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") throw jsonError(400, "invalid_request", "请求体格式不正确。");
  const { baseURL, apiKey, model } = body as Record<string, unknown>;
  if (typeof baseURL !== "string") throw jsonError(400, "invalid_base_url", "请输入 baseURL。");
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) throw jsonError(400, "invalid_api_key", "请输入有效 API Key。");
  const validation = validateBaseURL(baseURL);
  if (!validation.ok || !validation.normalized) throw jsonError(400, "invalid_base_url", validation.error ?? "baseURL 不合法。");
  const selectedModel = typeof model === "string" && model.trim() ? model.trim() : c.env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2";

  await upsertCredential(
    c.env.DB,
    c.get("space").id,
    validation.normalized,
    selectedModel,
    await encryptSecret(apiKey.trim(), c.env.APP_ENCRYPTION_KEY ?? ""),
    apiKeyHint(apiKey.trim()),
  );
  return c.json({ ok: true, provider: { baseURL: validation.normalized, model: selectedModel, apiKeyHint: apiKeyHint(apiKey.trim()) } });
});

app.delete("/api/settings/provider", async (c) => {
  await deleteCredential(c.env.DB, c.get("space").id);
  return c.json({ ok: true });
});

app.post("/api/provider/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const spaceId = c.get("space").id;
  let baseURL: string | undefined;
  let apiKey: string | undefined;

  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).baseURL === "string") {
    const raw = body as Record<string, unknown>;
    const validation = validateBaseURL(raw.baseURL as string);
    if (!validation.ok || !validation.normalized) throw jsonError(400, "invalid_base_url", validation.error ?? "baseURL 不合法。");
    if (typeof raw.apiKey !== "string") throw jsonError(400, "invalid_api_key", "请输入 API Key。");
    baseURL = validation.normalized;
    apiKey = raw.apiKey;
  } else {
    const credential = await getCredential(c.env.DB, spaceId);
    if (!credential) throw jsonError(400, "provider_missing", "请先保存 provider 配置。");
    baseURL = credential.base_url;
    apiKey = await decryptSecret(credential.encrypted_api_key, c.env.APP_ENCRYPTION_KEY ?? "");
  }

  const result = await testProvider(baseURL, apiKey);
  await markCredentialTested(c.env.DB, spaceId, result.ok);
  return c.json({ ok: true, result });
});

app.post("/api/generations", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseGenerationInput(body, c.env.MAX_IMAGES_PER_REQUEST);
  if (!parsed.input) throw jsonError(400, "invalid_generation_input", parsed.error ?? "生图参数不正确。");

  const turnstileOk = await verifyTurnstile(parsed.input.turnstileToken, c.req.raw, c.env);
  if (!turnstileOk) throw jsonError(403, "turnstile_failed", "人机验证失败。");

  const space = c.get("space");
  const credential = await getCredential(c.env.DB, space.id);
  if (!credential) throw jsonError(400, "provider_missing", "请先在设置中配置 baseURL 和 API Key。");
  const dailyLimit = envNumber(c.env.MAX_DAILY_JOBS_PER_SPACE, 50);
  const runningLimit = envNumber(c.env.MAX_RUNNING_JOBS_PER_SPACE, 2);
  if ((await countDailyJobs(c.env.DB, space.id)) >= dailyLimit) {
    await insertRateLimitEvent(c.env.DB, space.id, "daily_generation_limit");
    throw jsonError(429, "daily_limit_reached", `今日任务数已达到 ${dailyLimit}。`);
  }
  if ((await countActiveJobs(c.env.DB, space.id)) >= runningLimit) {
    await insertRateLimitEvent(c.env.DB, space.id, "active_generation_limit");
    throw jsonError(429, "active_limit_reached", `同时运行任务最多 ${runningLimit} 个。`);
  }

  const jobId = await createGenerationJob(
    c.env.DB,
    space.id,
    parsed.input,
    credential.model,
    await sha256Hex(credential.base_url),
  );
  await c.env.GENERATION_QUEUE.send({ jobId, spaceId: space.id });
  return c.json({ ok: true, jobId, status: "queued" });
});

app.get("/api/generations/:jobId", async (c) => {
  const job = await getGenerationJob(c.env.DB, c.get("space").id, c.req.param("jobId"));
  if (!job) throw jsonError(404, "job_not_found", "任务不存在。");
  const images = await listImagesForJob(c.env.DB, c.get("space").id, job.id);
  return c.json({
    ok: true,
    job,
    images: images.map((image) => ({
      id: image.id,
      url: `/api/images/${image.id}/download`,
      width: image.width,
      height: image.height,
      format: image.format,
      createdAt: image.created_at,
    })),
  });
});

app.get("/api/images", async (c) => {
  const images = await listImages(c.env.DB, c.get("space").id, c.req.query("cursor"));
  return c.json({
    ok: true,
    images: images.map((image) => ({
      id: image.id,
      jobId: image.job_id,
      url: `/api/images/${image.id}/download`,
      width: image.width,
      height: image.height,
      format: image.format,
      byteSize: image.byte_size,
      createdAt: image.created_at,
      prompt: image.prompt,
      quality: image.quality,
      aspectRatio: image.aspect_ratio,
    })),
    nextCursor: images.length === 30 ? images[images.length - 1]?.created_at : null,
  });
});

app.get("/api/images/:imageId/download", async (c) => {
  const image = await getImage(c.env.DB, c.get("space").id, c.req.param("imageId"));
  if (!image) throw jsonError(404, "image_not_found", "图片不存在。");
  const object = await c.env.IMAGES.get(image.storage_key);
  if (!object) throw jsonError(404, "image_file_missing", "图片文件不存在。");
  return new Response(object.body, {
    headers: {
      "Content-Type": image.mime_type,
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${image.id}.${image.format}"`,
    },
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
  const object = await c.env.IMAGES.get(item.thumbnail_storage_key);
  if (!object) throw jsonError(404, "inspiration_thumbnail_missing", "灵感缩略图不存在。");
  return new Response(object.body, {
    headers: {
      "Content-Type": item.thumbnail_mime_type ?? "image/jpeg",
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${item.id}"`,
    },
  });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
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
      } else {
        await processGenerationMessage(message.body as GenerationMessage, env);
      }
      message.ack();
    }
  },
};

// Force buildProviderEndpoint to stay typechecked with worker entry. It is also exported for tests.
void buildProviderEndpoint;

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
