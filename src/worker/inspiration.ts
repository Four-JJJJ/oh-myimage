import { sha256Hex } from "./crypto";
import { envNumber, randomId, redactSecrets } from "./http";
import { AppDatabase, Env, InspirationItemRecord, InspirationQueueMessage, InspirationSourceRecord } from "./types";

const DEFAULT_MAX_ITEMS_PER_RUN = 12;
const DEFAULT_THUMBNAIL_MAX_BYTES = 1_048_576;
const IMPORT_USER_AGENT = "oh-myimage-inspiration/1.0 (+https://workers.cloudflare.com)";

interface InspirationCandidate {
  sourceItemId?: string;
  originalUrl: string;
  author?: string;
  title?: string;
  prompt?: string;
  negativePrompt?: string;
  originalImageUrl?: string;
  width?: number;
  height?: number;
  tags?: string[];
  model?: string;
  safety?: "sfw" | "nsfw" | "unknown";
  status?: "draft" | "published" | "hidden";
}

interface ImportResult {
  itemsSeen: number;
  itemsImported: number;
}

export interface InspirationFilters {
  q?: string;
  source?: string;
  tag?: string;
  favorites?: boolean;
  cursor?: string;
}

export interface InspirationListResult {
  items: InspirationItemRecord[];
  nextCursor: string | null;
}

export interface ManualImportInput {
  url: string;
  prompt?: string;
  title?: string;
  author?: string;
  tags?: string[];
}

export interface NormalizedInspirationUrl {
  normalizedUrl: string;
  sourceKey: "x" | "jimeng" | "generic";
  tweetId?: string;
}

export function normalizeInspirationUrl(rawUrl: string): NormalizedInspirationUrl {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("请输入有效的 URL。");
  }

  if (url.protocol !== "https:") throw new Error("灵感来源链接必须使用 HTTPS。");
  if (isBlockedHostname(url.hostname)) throw new Error("不支持导入内网、本机或 IP 地址链接。");
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com")) {
    const tweetId = extractTweetId(url);
    if (!tweetId) throw new Error("X 链接需要指向具体推文。");
    return { normalizedUrl: canonicalTweetUrl(tweetId, url.pathname), sourceKey: "x", tweetId };
  }

  if (hostname.includes("jimeng") || hostname.includes("jianying")) {
    return { normalizedUrl: url.toString(), sourceKey: "jimeng" };
  }

  return { normalizedUrl: url.toString(), sourceKey: "generic" };
}

export async function listInspirations(db: AppDatabase, spaceId: string, filters: InspirationFilters): Promise<InspirationListResult> {
  const conditions = ["items.status = 'published'"];
  const values: unknown[] = [spaceId];

  if (filters.q?.trim()) {
    const term = `%${escapeLike(filters.q.trim())}%`;
    conditions.push("(items.prompt LIKE ? ESCAPE '\\' OR items.title LIKE ? ESCAPE '\\' OR items.author LIKE ? ESCAPE '\\' OR items.tags_json LIKE ? ESCAPE '\\')");
    values.push(term, term, term, term);
  }

  if (filters.source?.trim()) {
    conditions.push("sources.source_key = ?");
    values.push(filters.source.trim());
  }

  if (filters.tag?.trim()) {
    conditions.push("items.tags_json LIKE ? ESCAPE '\\'");
    values.push(`%${escapeLike(filters.tag.trim())}%`);
  }

  if (filters.favorites) {
    conditions.push("favorites.item_id IS NOT NULL");
  }

  if (filters.cursor?.trim()) {
    conditions.push("items.imported_at < ?");
    values.push(filters.cursor.trim());
  }

  const result = await db
    .prepare(
      `SELECT
        items.*,
        sources.source_key,
        sources.name AS source_name,
        CASE WHEN favorites.item_id IS NULL THEN 0 ELSE 1 END AS favorite
       FROM inspiration_items items
       INNER JOIN inspiration_sources sources ON sources.id = items.source_id
       LEFT JOIN inspiration_favorites favorites ON favorites.item_id = items.id AND favorites.space_id = ?
       WHERE ${conditions.join(" AND ")}
       ORDER BY items.imported_at DESC, items.id DESC
       LIMIT 31`,
    )
    .bind(...values)
    .all<InspirationItemRecord>();

  const rows = result.results ?? [];
  const items = rows.slice(0, 30);
  return {
    items,
    nextCursor: rows.length > 30 ? items[items.length - 1]?.imported_at ?? null : null,
  };
}

export async function getInspirationItem(db: AppDatabase, itemId: string): Promise<InspirationItemRecord | null> {
  return db
    .prepare(
      `SELECT items.*, sources.source_key, sources.name AS source_name
       FROM inspiration_items items
       INNER JOIN inspiration_sources sources ON sources.id = items.source_id
       WHERE items.id = ?`,
    )
    .bind(itemId)
    .first<InspirationItemRecord>();
}

export async function toggleInspirationFavorite(
  db: AppDatabase,
  spaceId: string,
  itemId: string,
  favorite?: boolean,
): Promise<boolean> {
  const item = await db.prepare("SELECT id FROM inspiration_items WHERE id = ? AND status = 'published'").bind(itemId).first<{ id: string }>();
  if (!item) throw new Error("灵感素材不存在。");

  const existing = await db
    .prepare("SELECT id FROM inspiration_favorites WHERE space_id = ? AND item_id = ?")
    .bind(spaceId, itemId)
    .first<{ id: string }>();
  const next = favorite ?? !existing;

  if (next && !existing) {
    await db
      .prepare("INSERT INTO inspiration_favorites (id, space_id, item_id) VALUES (?, ?, ?)")
      .bind(randomId("fav"), spaceId, itemId)
      .run();
  } else if (!next && existing) {
    await db.prepare("DELETE FROM inspiration_favorites WHERE space_id = ? AND item_id = ?").bind(spaceId, itemId).run();
  }
  return next;
}

export async function recordInspirationUse(db: AppDatabase, itemId: string): Promise<void> {
  await db.prepare("UPDATE inspiration_items SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(itemId).run();
}

export async function importInspirationUrl(env: Env, input: ManualImportInput): Promise<InspirationItemRecord> {
  const normalized = normalizeInspirationUrl(input.url);
  const source = await getOrCreateSource(env.DB, normalized.sourceKey);
  const runId = await startImportRun(env.DB, source, "manual");

  try {
    const candidate =
      normalized.sourceKey === "x"
        ? await importXUrl(env, normalized, input)
        : await importGenericUrl(normalized, input, normalized.sourceKey === "jimeng");
    const result = await upsertInspirationCandidate(env, source, {
      ...candidate,
      prompt: candidate.prompt ?? input.prompt,
      title: input.title ?? candidate.title,
      author: input.author ?? candidate.author,
      tags: mergeTags(candidate.tags, input.tags),
      status: "published",
    });
    await finishImportRun(env.DB, runId, "succeeded", 1, result.inserted ? 1 : 0);
    const item = await getInspirationItem(env.DB, result.itemId);
    if (!item) throw new Error("导入后未找到灵感素材。");
    return item;
  } catch (error) {
    await finishImportRun(env.DB, runId, "failed", 0, 0, redactSecrets(error instanceof Error ? error.message : "导入失败。"));
    throw error;
  }
}

export async function listEnabledInspirationSources(db: AppDatabase): Promise<InspirationSourceRecord[]> {
  const result = await db
    .prepare("SELECT * FROM inspiration_sources WHERE enabled = 1 ORDER BY source_key ASC")
    .all<InspirationSourceRecord>();
  return result.results ?? [];
}

export async function processInspirationSourceMessage(message: InspirationQueueMessage, env: Env): Promise<void> {
  const source = await env.DB.prepare("SELECT * FROM inspiration_sources WHERE id = ?").bind(message.sourceId).first<InspirationSourceRecord>();
  if (!source || !source.enabled) return;

  const runId = await startImportRun(env.DB, source, message.trigger);
  try {
    const result = await importSource(env, source);
    await env.DB.prepare("UPDATE inspiration_sources SET last_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(source.id).run();
    await finishImportRun(env.DB, runId, "succeeded", result.itemsSeen, result.itemsImported);
  } catch (error) {
    await finishImportRun(
      env.DB,
      runId,
      "failed",
      0,
      0,
      redactSecrets(error instanceof Error ? error.message : "采集失败。"),
    );
  }
}

export function parseInspirationTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12);
  } catch {
    return [];
  }
}

export function isInspirationQueueMessage(body: unknown): body is InspirationQueueMessage {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).type === "inspiration-source" &&
      typeof (body as Record<string, unknown>).sourceId === "string",
  );
}

async function importSource(env: Env, source: InspirationSourceRecord): Promise<ImportResult> {
  if (source.kind === "civitai") return importCivitaiSource(env, source);
  if (source.kind === "x") return importXSource(env, source);
  if (source.kind === "jimeng" || source.kind === "generic") return importConfiguredPages(env, source);
  return { itemsSeen: 0, itemsImported: 0 };
}

async function importCivitaiSource(env: Env, source: InspirationSourceRecord): Promise<ImportResult> {
  const config = parseConfig(source.config_json);
  const maxItems = sourceLimit(env, config.limit);
  const params = new URLSearchParams({
    limit: String(maxItems),
    nsfw: String(config.nsfw === true ? true : false),
    sort: typeof config.sort === "string" ? config.sort : "Most Reactions",
    period: typeof config.period === "string" ? config.period : "Week",
  });
  const response = await fetch(`https://civitai.com/api/v1/images?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": IMPORT_USER_AGENT },
  });
  if (!response.ok) throw new Error(`Civitai 返回 ${response.status}。`);
  const json = (await response.json()) as { items?: CivitaiImage[] };
  const candidates = (json.items ?? []).map(civitaiCandidate).filter((item): item is InspirationCandidate => Boolean(item));
  return importCandidates(env, source, candidates);
}

async function importXSource(env: Env, source: InspirationSourceRecord): Promise<ImportResult> {
  if (!env.X_BEARER_TOKEN) throw new Error("X_BEARER_TOKEN 未配置，X 来源只能手动导入。");
  const config = parseConfig(source.config_json);
  const query = typeof config.query === "string" && config.query.trim() ? config.query.trim() : "has:images -is:retweet";
  const maxItems = Math.min(sourceLimit(env, config.limit), 100);
  const params = new URLSearchParams({
    query,
    max_results: String(Math.max(10, maxItems)),
    expansions: "attachments.media_keys,author_id",
    "media.fields": "alt_text,height,media_key,preview_image_url,type,url,width",
    "tweet.fields": "attachments,author_id,created_at,text",
    "user.fields": "name,username",
  });
  const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  });
  if (!response.ok) throw new Error(`X API 返回 ${response.status}。`);
  const json = (await response.json()) as XSearchResponse;
  const candidates = xCandidates(json).slice(0, maxItems);
  return importCandidates(env, source, candidates);
}

async function importConfiguredPages(env: Env, source: InspirationSourceRecord): Promise<ImportResult> {
  const config = parseConfig(source.config_json);
  const urls = Array.isArray(config.urls) ? config.urls.filter((item): item is string => typeof item === "string") : [];
  const candidates: InspirationCandidate[] = [];
  for (const rawUrl of urls.slice(0, sourceLimit(env, config.limit))) {
    const normalized = normalizeInspirationUrl(rawUrl);
    candidates.push(await importGenericUrl(normalized, {}, source.kind === "jimeng"));
  }
  return importCandidates(env, source, candidates);
}

async function importCandidates(env: Env, source: InspirationSourceRecord, candidates: InspirationCandidate[]): Promise<ImportResult> {
  let imported = 0;
  for (const candidate of candidates) {
    const result = await upsertInspirationCandidate(env, source, candidate);
    if (result.inserted) imported += 1;
  }
  return { itemsSeen: candidates.length, itemsImported: imported };
}

async function importXUrl(env: Env, normalized: NormalizedInspirationUrl, input: ManualImportInput): Promise<InspirationCandidate> {
  if (env.X_BEARER_TOKEN && normalized.tweetId) {
    try {
      const candidate = await fetchXTweet(env.X_BEARER_TOKEN, normalized.tweetId);
      if (candidate) return { ...candidate, prompt: input.prompt ?? candidate.prompt };
    } catch {
      // Fall back to manual import below.
    }
  }

  if (!input.prompt?.trim()) {
    throw new Error("X 链接不做网页抓取；未配置可用 X API 时，请同时粘贴提示词。");
  }
  return {
    sourceItemId: normalized.tweetId,
    originalUrl: normalized.normalizedUrl,
    title: input.title ?? "X 手动导入",
    author: input.author,
    prompt: input.prompt,
    tags: input.tags,
    safety: "unknown",
  };
}

async function fetchXTweet(token: string, tweetId: string): Promise<InspirationCandidate | null> {
  const params = new URLSearchParams({
    expansions: "attachments.media_keys,author_id",
    "media.fields": "alt_text,height,media_key,preview_image_url,type,url,width",
    "tweet.fields": "attachments,author_id,created_at,text",
    "user.fields": "name,username",
  });
  const response = await fetch(`https://api.x.com/2/tweets/${tweetId}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`X API 返回 ${response.status}。`);
  const json = (await response.json()) as XTweetResponse;
  return xCandidates({ data: json.data ? [json.data] : [], includes: json.includes }).at(0) ?? null;
}

async function importGenericUrl(
  normalized: NormalizedInspirationUrl,
  input: Pick<ManualImportInput, "prompt" | "title" | "author" | "tags">,
  isJimeng: boolean,
): Promise<InspirationCandidate> {
  const response = await fetch(normalized.normalizedUrl, {
    redirect: "manual",
    headers: { Accept: "text/html,image/*", "User-Agent": IMPORT_USER_AGENT },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("来源页面发生重定向，已停止导入。");
  }
  if (!response.ok) throw new Error(`来源页面返回 ${response.status}。`);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    return {
      sourceItemId: normalized.normalizedUrl,
      originalUrl: normalized.normalizedUrl,
      title: input.title ?? (isJimeng ? "即梦灵感" : "图片导入"),
      author: input.author,
      prompt: input.prompt ?? "",
      originalImageUrl: normalized.normalizedUrl,
      tags: mergeTags(input.tags, [isJimeng ? "即梦" : "网页导入"]),
      safety: "unknown",
    };
  }

  const html = await response.text();
  const title = input.title ?? extractMeta(html, "og:title") ?? extractTitle(html);
  const description = extractMeta(html, "og:description") ?? extractMeta(html, "description") ?? extractMeta(html, "twitter:description");
  const imageUrl = absoluteUrl(
    extractMeta(html, "og:image") ?? extractMeta(html, "twitter:image") ?? extractFirstImage(html),
    normalized.normalizedUrl,
  );
  const author = input.author ?? extractMeta(html, "author") ?? extractMeta(html, "article:author");

  return {
    sourceItemId: normalized.normalizedUrl,
    originalUrl: normalized.normalizedUrl,
    title: title ?? (isJimeng ? "即梦灵感" : "网页导入"),
    author,
    prompt: input.prompt ?? description ?? "",
    originalImageUrl: imageUrl,
    tags: mergeTags(input.tags, [isJimeng ? "即梦" : "网页导入"]),
    safety: "unknown",
  };
}

async function upsertInspirationCandidate(
  env: Env,
  source: InspirationSourceRecord,
  candidate: InspirationCandidate,
): Promise<{ itemId: string; inserted: boolean }> {
  const sourceItemId = candidate.sourceItemId ?? candidate.originalUrl;
  const dedupeKey = await sha256Hex(`${source.source_key}:${sourceItemId}:${candidate.originalImageUrl ?? ""}`.toLowerCase());
  const existing = await env.DB.prepare("SELECT id FROM inspiration_items WHERE dedupe_key = ?").bind(dedupeKey).first<{ id: string }>();
  if (existing) {
    await env.DB
      .prepare(
        `UPDATE inspiration_items
         SET title = COALESCE(NULLIF(?, ''), title),
             prompt = CASE WHEN prompt = '' THEN ? ELSE prompt END,
             original_image_url = COALESCE(original_image_url, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(candidate.title ?? "", candidate.prompt ?? "", candidate.originalImageUrl ?? null, existing.id)
      .run();
    return { itemId: existing.id, inserted: false };
  }

  const thumbnail = candidate.originalImageUrl ? await cacheThumbnail(env, source.source_key, dedupeKey, candidate.originalImageUrl) : null;
  const id = randomId("ins");
  const status = candidate.status ?? (autoPublishSources(env).has(source.source_key) ? "published" : "draft");

  await env.DB
    .prepare(
      `INSERT INTO inspiration_items (
        id, source_id, source_item_id, original_url, author, title, prompt, negative_prompt,
        thumbnail_storage_key, thumbnail_mime_type, original_image_url, width, height, aspect_ratio,
        tags_json, model, safety, status, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      source.id,
      sourceItemId,
      candidate.originalUrl,
      candidate.author ?? null,
      candidate.title ?? null,
      candidate.prompt?.trim() ?? "",
      candidate.negativePrompt ?? null,
      thumbnail?.key ?? null,
      thumbnail?.mimeType ?? null,
      candidate.originalImageUrl ?? null,
      candidate.width ?? null,
      candidate.height ?? null,
      aspectRatio(candidate.width, candidate.height),
      JSON.stringify(normalizeTags(candidate.tags)),
      candidate.model ?? null,
      candidate.safety ?? "unknown",
      status,
      dedupeKey,
    )
    .run();

  return { itemId: id, inserted: true };
}

async function cacheThumbnail(
  env: Env,
  sourceKey: string,
  dedupeKey: string,
  imageUrl: string,
): Promise<{ key: string; mimeType: string } | null> {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || isBlockedHostname(url.hostname)) return null;

  const maxBytes = Math.max(64_000, envNumber(env.INSPIRATION_THUMBNAIL_MAX_BYTES, DEFAULT_THUMBNAIL_MAX_BYTES));
  const contentLength = Number(await headContentLength(imageUrl));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(imageUrl, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif", Range: `bytes=0-${maxBytes}` },
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) return null;
    const mimeType = normalizeImageMime(response.headers.get("content-type"));
    if (!mimeType) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return null;
    const key = `inspirations/${sourceKey}/${dedupeKey}.${extensionFromMime(mimeType)}`;
    await env.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: mimeType, contentDisposition: `inline; filename="${dedupeKey}.${extensionFromMime(mimeType)}"` },
    });
    return { key, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function headContentLength(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual" });
    if (!response.ok) return null;
    return response.headers.get("content-length");
  } catch {
    return null;
  }
}

async function getOrCreateSource(db: AppDatabase, sourceKey: NormalizedInspirationUrl["sourceKey"]): Promise<InspirationSourceRecord> {
  const existing = await db.prepare("SELECT * FROM inspiration_sources WHERE source_key = ?").bind(sourceKey).first<InspirationSourceRecord>();
  if (existing) return existing;

  const id = `src_${sourceKey}`;
  const name = sourceKey === "x" ? "X" : sourceKey === "jimeng" ? "即梦灵感" : "网页导入";
  const kind = sourceKey === "generic" ? "generic" : sourceKey;
  await db
    .prepare("INSERT INTO inspiration_sources (id, source_key, name, kind, enabled, config_json) VALUES (?, ?, ?, ?, 0, '{}')")
    .bind(id, sourceKey, name, kind)
    .run();
  const created = await db.prepare("SELECT * FROM inspiration_sources WHERE id = ?").bind(id).first<InspirationSourceRecord>();
  if (!created) throw new Error("灵感来源创建失败。");
  return created;
}

async function startImportRun(db: AppDatabase, source: InspirationSourceRecord, trigger: "scheduled" | "manual"): Promise<string> {
  const id = randomId("run");
  await db
    .prepare("INSERT INTO inspiration_import_runs (id, source_id, source_key, trigger_type, status) VALUES (?, ?, ?, ?, 'running')")
    .bind(id, source.id, source.source_key, trigger)
    .run();
  return id;
}

async function finishImportRun(
  db: AppDatabase,
  runId: string,
  status: "succeeded" | "failed",
  itemsSeen: number,
  itemsImported: number,
  errorMessage?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE inspiration_import_runs
       SET status = ?, items_seen = ?, items_imported = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, itemsSeen, itemsImported, errorMessage ?? null, runId)
    .run();
}

interface CivitaiImage {
  id?: number;
  url?: string;
  width?: number;
  height?: number;
  nsfw?: boolean | string;
  username?: string;
  user?: { username?: string };
  meta?: {
    prompt?: string;
    negativePrompt?: string;
    Model?: string;
    model?: string;
    resources?: Array<{ name?: string; type?: string }>;
  };
}

function civitaiCandidate(item: CivitaiImage): InspirationCandidate | null {
  const prompt = typeof item.meta?.prompt === "string" ? item.meta.prompt.trim() : "";
  if (!item.id || !item.url || !prompt) return null;
  const tags = item.meta?.resources?.map((resource) => resource.name).filter((name): name is string => Boolean(name)) ?? [];
  const nsfw = item.nsfw === true || item.nsfw === "true";
  return {
    sourceItemId: String(item.id),
    originalUrl: `https://civitai.com/images/${item.id}`,
    author: item.username ?? item.user?.username,
    title: prompt.slice(0, 96),
    prompt,
    negativePrompt: item.meta?.negativePrompt,
    originalImageUrl: item.url,
    width: item.width,
    height: item.height,
    tags: ["Civitai", ...tags],
    model: item.meta?.Model ?? item.meta?.model,
    safety: nsfw ? "nsfw" : "sfw",
  };
}

interface XTweet {
  id: string;
  text?: string;
  author_id?: string;
  attachments?: { media_keys?: string[] };
}

interface XMedia {
  media_key: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
}

interface XUser {
  id: string;
  username?: string;
  name?: string;
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: {
    media?: XMedia[];
    users?: XUser[];
  };
}

interface XTweetResponse {
  data?: XTweet;
  includes?: XSearchResponse["includes"];
}

function xCandidates(json: XSearchResponse): InspirationCandidate[] {
  const mediaByKey = new Map((json.includes?.media ?? []).map((item) => [item.media_key, item]));
  const usersById = new Map((json.includes?.users ?? []).map((item) => [item.id, item]));
  return (json.data ?? []).flatMap((tweet) => {
    const user = tweet.author_id ? usersById.get(tweet.author_id) : undefined;
    const medias = tweet.attachments?.media_keys?.map((key) => mediaByKey.get(key)).filter((item): item is XMedia => Boolean(item)) ?? [];
    return medias
      .filter((media) => media.type === "photo" && (media.preview_image_url || media.url))
      .map((media) => ({
        sourceItemId: `${tweet.id}:${media.media_key}`,
        originalUrl: `https://x.com/${user?.username ?? "i"}/status/${tweet.id}`,
        author: user?.username ? `@${user.username}` : user?.name,
        title: trimText(tweet.text ?? media.alt_text ?? "X 灵感", 120),
        prompt: trimText(media.alt_text || tweet.text || "", 4000),
        originalImageUrl: media.preview_image_url ?? media.url,
        width: media.width,
        height: media.height,
        tags: ["X"],
        safety: "unknown" as const,
      }));
  });
}

function extractTweetId(url: URL): string | undefined {
  const match = url.pathname.match(/\/status\/(\d+)/);
  return match?.[1];
}

function canonicalTweetUrl(tweetId: string, pathname: string): string {
  const username = pathname.split("/").filter(Boolean).at(0) ?? "i";
  return `https://x.com/${username}/status/${tweetId}`;
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sourceLimit(env: Env, configured: unknown): number {
  const fallback = envNumber(env.INSPIRATION_MAX_ITEMS_PER_RUN, DEFAULT_MAX_ITEMS_PER_RUN);
  const value = typeof configured === "number" ? configured : Number(configured);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : fallback, fallback, 100));
}

function autoPublishSources(env: Env): Set<string> {
  const raw = env.INSPIRATION_AUTO_PUBLISH_SOURCES ?? "civitai";
  return new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
}

function aspectRatio(width?: number, height?: number): string | null {
  if (!width || !height) return null;
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function mergeTags(...groups: Array<string[] | undefined>): string[] {
  return normalizeTags(groups.flatMap((group) => group ?? []));
}

function trimText(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

function normalizeImageMime(value: string | null): string | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif" || mime === "image/avif") return mime;
  return null;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  return "png";
}

function extractMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return undefined;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1] ? decodeHtml(match[1]) : undefined;
}

function extractFirstImage(html: string): string | undefined {
  const match = html.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i);
  return match?.[1] ? decodeHtml(match[1]) : undefined;
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();
}
