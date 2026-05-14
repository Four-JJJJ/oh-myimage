import { bytesFromBase64, decryptSecret, sha256Hex } from "./crypto";
import { envNumber, randomId, redactSecrets } from "./http";
import { buildProviderEndpoint } from "./security";
import {
  completeJob,
  getCredential,
  getGenerationJobForWorker,
  insertImageAsset,
  insertImageUsageEvent,
  listImagesForJob,
  updateJobStatus,
} from "./db";
import { CredentialRecord, Env, GenerationJobRecord, GenerationMessage } from "./types";
import { PromptOptimizationInput } from "./validation";

export interface ProviderImage {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface ProviderGenerationResponse {
  created?: number;
  data?: ProviderImage[];
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
}

interface ProviderTextResponse {
  output_text?: unknown;
  output?: unknown;
}

interface ImageGenerationPayload {
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  output_format: string;
  background: string;
  moderation: string;
  user: string;
  output_compression?: number;
}

const DEFAULT_GENERATION_TIMEOUT_MS = 600_000;
const MAX_QUEUE_CONSUMER_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_PROVIDER_IMAGE_BATCH_SIZE = 1;
const MAX_PROVIDER_IMAGE_BATCH_SIZE = 4;
const DEFAULT_PROVIDER_IMAGE_CONCURRENCY = 2;
const MAX_PROVIDER_IMAGE_CONCURRENCY = 4;
const DEFAULT_RESPONSES_MODEL = "gpt-5.5";
const DEFAULT_PROMPT_OPTIMIZER_MODEL = DEFAULT_RESPONSES_MODEL;
const DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS = 45_000;
const PROMPT_OPTIMIZER_MODELS = new Set(["gpt-5.5", "gpt-5.4"]);

interface StoredGenerationImage {
  revisedPrompt: string | null;
  usage: unknown;
}

interface GenerationRunResult {
  requestedCount: number;
  existingCount: number;
  storedImages: StoredGenerationImage[];
  errors: ProviderError[];
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export interface ProcessGenerationOptions {
  throwRetryableErrors?: boolean;
}

export async function testProvider(baseURL: string, apiKey: string, timeoutMs = 15000): Promise<{ ok: boolean; status: number; message: string }> {
  const endpoint = buildProviderEndpoint(baseURL, "/models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, status: response.status, message: "连接成功。" };
    return { ok: false, status: response.status, message: `模型服务返回 ${response.status}。` };
  } catch (error) {
    return { ok: false, status: 0, message: redactSecrets(error instanceof Error ? error.message : "连接失败。") };
  } finally {
    clearTimeout(timer);
  }
}

export async function optimizePrompt(
  input: PromptOptimizationInput,
  credential: CredentialRecord,
  apiKey: string,
  env: Env,
): Promise<string> {
  const endpoint = buildProviderEndpoint(credential.base_url, "/responses");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolveResponsesModel(resolvePromptOptimizerModel(credential.prompt_optimizer_model ?? env.PROMPT_OPTIMIZER_MODEL)),
        instructions: PROMPT_OPTIMIZER_INSTRUCTIONS,
        input: promptOptimizationInput(input),
      }),
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await providerMessage(response);
      throw new ProviderError(
        providerErrorCode(response.status),
        providerStatusMessage(response.status, text, DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS),
        response.status === 429 || response.status >= 500,
      );
    }

    const optimizedPrompt = extractResponsesOutputText((await response.json()) as ProviderTextResponse).trim();
    if (!optimizedPrompt) {
      throw new ProviderError("empty_response", "模型服务没有返回优化后的提示词。");
    }
    return optimizedPrompt;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (timedOut) {
      throw new ProviderError(
        "provider_timeout",
        `提示词优化超过 ${formatDuration(DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS)} 仍未返回，请稍后重试。`,
        true,
      );
    }
    throw new ProviderError("provider_request_failed", redactSecrets(error instanceof Error ? error.message : "提示词优化失败。"));
  } finally {
    clearTimeout(timer);
  }
}

export async function processGenerationMessage(message: GenerationMessage, env: Env, options: ProcessGenerationOptions = {}): Promise<void> {
  const job = await getGenerationJobForWorker(env.DB, message.jobId);
  if (!job || job.space_id !== message.spaceId) return;
  if (job.status !== "queued" && job.status !== "running") return;

  const credential = await getCredential(env.DB, job.space_id);
  if (!credential) {
    await updateJobStatus(env.DB, job.id, "failed", "provider_missing", "请先在设置中配置 baseURL 和 API Key。");
    return;
  }

  await updateJobStatus(env.DB, job.id, "running");

  try {
    const apiKey = await decryptSecret(credential.encrypted_api_key, env.APP_ENCRYPTION_KEY ?? "");
    const result = await requestGeneration(job, credential, apiKey, env);
    const completedCount = result.existingCount + result.storedImages.length;
    if (completedCount === 0) {
      throw result.errors.at(-1) ?? new ProviderError("empty_response", "模型服务没有返回图片。");
    }

    const usage = result.storedImages.map((image) => image.usage).filter((item) => item !== undefined);
    const revisedPrompt = result.storedImages.find((image) => image.revisedPrompt)?.revisedPrompt ?? null;
    const usageJson = usage.length === 0 ? null : JSON.stringify(usage.length === 1 ? usage[0] : usage);
    const status = completedCount >= result.requestedCount ? "succeeded" : "partial_succeeded";
    const lastError = result.errors.at(-1);
    const partialMessage =
      status === "partial_succeeded"
        ? `部分图片生成失败，已保留 ${completedCount}/${result.requestedCount} 张成功结果。${lastError?.message ?? "请稍后重试。"}`
        : null;

    await completeJob(
      env.DB,
      job.id,
      status,
      revisedPrompt,
      usageJson,
      status === "partial_succeeded" ? lastError?.code ?? "partial_generation_failed" : null,
      partialMessage,
    );
  } catch (error) {
    const providerError = normalizeProviderError(error);
    if (options.throwRetryableErrors && providerError.retryable) {
      throw providerError;
    }
    await updateJobStatus(env.DB, job.id, "failed", providerError.code, providerError.message);
  }
}

async function requestGeneration(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  env: Env,
): Promise<GenerationRunResult> {
  const timeoutMs = resolveGenerationTimeoutMs(env.REQUEST_TIMEOUT_MS);
  const concurrency = resolveProviderImageConcurrency(env.PROVIDER_IMAGE_CONCURRENCY);
  const deadline = Date.now() + timeoutMs;
  const existingImages = await listImagesForJob(env.DB, job.space_id, job.id);
  const remainingCount = Math.max(0, job.quantity - existingImages.length);
  const storedImages: StoredGenerationImage[] = [];
  const errors: ProviderError[] = [];
  const tasks = Array.from({ length: remainingCount }, () => async () => {
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs < 1000) {
      throw new ProviderError(
        "provider_timeout",
        `模型服务超过 ${formatDuration(timeoutMs)} 仍未返回，已停止等待。请确认 baseURL 的网关、负载均衡和模型服务超时都不低于这个时间。`,
        true,
      );
    }
    return generateAndStoreOneImage(job, credential, apiKey, remainingTimeoutMs, env);
  });

  for (let start = 0; start < tasks.length; start += concurrency) {
    const settled = await Promise.allSettled(tasks.slice(start, start + concurrency).map((task) => task()));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        storedImages.push(result.value);
      } else {
        errors.push(normalizeProviderError(result.reason));
      }
    }
  }

  return { requestedCount: job.quantity, existingCount: existingImages.length, storedImages, errors };
}

async function generateAndStoreOneImage(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
): Promise<StoredGenerationImage> {
  const response = await requestGenerationBatch(job, credential, apiKey, timeoutMs, env);
  const image = response.data?.find((item) => item.b64_json);
  if (!image?.b64_json) {
    throw new ProviderError("empty_response", "模型服务没有返回图片。");
  }

  const bytes = bytesFromBase64(image.b64_json);
  const id = randomId("img");
  const format = job.output_format;
  const mimeType = mimeFromFormat(format);
  const storageKey = `${job.space_id}/${job.id}/${id}.${format}`;
  await env.IMAGES.put(storageKey, bytes, {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `inline; filename="${id}.${format}"`,
    },
    customMetadata: {
      jobId: job.id,
      spaceId: job.space_id,
    },
  });
  await insertImageAsset(env.DB, {
    id,
    space_id: job.space_id,
    job_id: job.id,
    storage_key: storageKey,
    mime_type: mimeType,
    format,
    width: job.width,
    height: job.height,
    byte_size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
  await insertImageUsageEvent(env.DB, job.space_id, id);

  return {
    revisedPrompt: image.revised_prompt ?? null,
    usage: response.usage,
  };
}

async function requestGenerationBatch(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
): Promise<ProviderGenerationResponse> {
  const endpoint = buildProviderEndpoint(credential.base_url, imageGenerationEndpointPath(job));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const body = await providerRequestBody(job, env);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: providerRequestHeaders(apiKey, body),
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await providerMessage(response);
      throw new ProviderError(
        providerErrorCode(response.status),
        providerStatusMessage(response.status, text, timeoutMs),
        response.status === 429 || response.status >= 500,
      );
    }

    return (await response.json()) as ProviderGenerationResponse;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (timedOut) {
      throw new ProviderError(
        "provider_timeout",
        `模型服务超过 ${formatDuration(timeoutMs)} 仍未返回，已停止等待。请确认 baseURL 的网关、负载均衡和模型服务超时都不低于这个时间。`,
        true,
      );
    }
    throw new ProviderError("provider_request_failed", redactSecrets(error instanceof Error ? error.message : "模型请求失败。"));
  } finally {
    clearTimeout(timer);
  }
}

async function providerRequestBody(job: GenerationJobRecord, env: Env): Promise<BodyInit> {
  const payload = buildImageGenerationPayload(job, 1);
  if (!job.reference_image_storage_key) {
    return JSON.stringify(payload);
  }

  const referenceImage = await loadReferenceImageBlob(job, env);
  const formData = new FormData();
  appendImageGenerationFormFields(formData, payload);
  formData.append("image", referenceImage.blob, referenceImage.filename);
  if (job.mask_image_storage_key) {
    const maskImage = await loadMaskImageBlob(job, env);
    formData.append("mask", maskImage.blob, maskImage.filename);
  }
  return formData;
}

function providerRequestHeaders(apiKey: string, body: BodyInit): HeadersInit {
  const headers: HeadersInit = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (!(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

export function providerErrorCode(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 522 || status === 524) return "provider_timeout";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected";
}

export function providerStatusMessage(status: number, message: string, timeoutMs: number): string {
  if (status === 522 || status === 524) {
    return `模型服务返回 ${status}，上游网关等待模型服务超时。当前 Worker 已允许最长等待 ${formatDuration(timeoutMs)}；如果单次生图经常超过 120 秒，请将 baseURL 指向 DNS-only/直连源站域名，或把上游接口改成异步任务/轮询模式。`;
  }
  if (status === 502 || status === 503 || status === 504) {
    return `模型服务返回 ${status}。当前 Worker 已允许最长等待 ${formatDuration(timeoutMs)}；如果仍然出现这个状态，通常是 baseURL 上游网关或模型服务在更早的位置超时。`;
  }
  return message || `模型服务返回 ${status}。`;
}

async function providerMessage(response: Response): Promise<string> {
  const text = redactSecrets(await response.text());
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
    if (parsed.error?.message) {
      return redactSecrets(parsed.error.message);
    }
  } catch {
    // Fall back to trimmed text below.
  }
  if (text.trimStart().startsWith("<")) return "";
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("generation_failed", redactSecrets(error instanceof Error ? error.message : "生成失败。"));
}

export function resolveGenerationTimeoutMs(value: string | undefined): number {
  return Math.min(Math.max(envNumber(value, DEFAULT_GENERATION_TIMEOUT_MS), 1000), MAX_QUEUE_CONSUMER_TIMEOUT_MS);
}

export function resolveProviderImageBatchSize(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(envNumber(value, DEFAULT_PROVIDER_IMAGE_BATCH_SIZE)), 1), MAX_PROVIDER_IMAGE_BATCH_SIZE);
}

export function resolveProviderImageConcurrency(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(envNumber(value, DEFAULT_PROVIDER_IMAGE_CONCURRENCY)), 1), MAX_PROVIDER_IMAGE_CONCURRENCY);
}

export function resolvePromptOptimizerModel(value: string | undefined): string {
  const model = value?.trim();
  return model && PROMPT_OPTIMIZER_MODELS.has(model) ? model : DEFAULT_PROMPT_OPTIMIZER_MODEL;
}

export function resolveResponsesModel(value: string | undefined, fallbackValue?: string): string {
  const model = value?.trim();
  if (model && !isImageOnlyModel(model)) return model;
  const fallbackModel = fallbackValue?.trim();
  if (fallbackModel && !isImageOnlyModel(fallbackModel)) return fallbackModel;
  return DEFAULT_RESPONSES_MODEL;
}

export function extractResponsesOutputText(response: ProviderTextResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) return "";
  const chunks: string[] = [];
  for (const outputItem of response.output) {
    if (!outputItem || typeof outputItem !== "object") continue;
    const content = (outputItem as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const item = contentItem as { type?: unknown; text?: unknown };
      if (item.type === "output_text" && typeof item.text === "string") {
        chunks.push(item.text);
      }
    }
  }
  return chunks.join("\n");
}

export function buildImageGenerationPayload(job: GenerationJobRecord, count: number): ImageGenerationPayload {
  const payload: ImageGenerationPayload = {
    model: job.model,
    prompt: job.prompt,
    n: count,
    size: `${job.width}x${job.height}`,
    quality: job.quality,
    output_format: job.output_format,
    background: resolveImageBackground(job.prompt, job.output_format, job.background),
    moderation: job.moderation,
    user: job.space_id,
  };
  if (job.output_format !== "png" && job.compression !== null) {
    payload.output_compression = job.compression;
  }
  return payload;
}

export function imageGenerationEndpointPath(job: Pick<GenerationJobRecord, "reference_image_storage_key">): "/images/edits" | "/images/generations" {
  return job.reference_image_storage_key ? "/images/edits" : "/images/generations";
}

export function resolveImageBackground(prompt: string, outputFormat: string, configuredBackground = "auto"): "auto" | "opaque" | "transparent" {
  if (outputFormat === "jpeg") {
    return configuredBackground === "opaque" ? "opaque" : "auto";
  }
  if (configuredBackground === "opaque" || configuredBackground === "transparent") {
    return configuredBackground;
  }
  return promptRequestsTransparentBackground(prompt) ? "transparent" : "auto";
}

function promptRequestsTransparentBackground(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  const negativePatterns = [
    /不(?:要|需要)?透明背景/,
    /不要背景透明/,
    /无需透明背景/,
    /非透明背景/,
    /不透明背景/,
    /\bno transparent background\b/,
    /\bnot transparent background\b/,
    /\bwithout transparent background\b/,
    /\bopaque background\b/,
    /\bsolid background\b/,
  ];
  if (negativePatterns.some((pattern) => pattern.test(normalized))) return false;

  const positivePatterns = [
    /透明(?:背景|底|底色)/,
    /背景透明/,
    /透明通道/,
    /alpha\s*通道/,
    /无背景/,
    /去(?:除)?背景/,
    /去背/,
    /抠图/,
    /\btransparent background\b/,
    /\bbackground transparent\b/,
    /\bwith transparency\b/,
    /\balpha channel\b/,
    /\bno background\b/,
    /\bremove(?:d)? background\b/,
    /\bbackground removed\b/,
    /\bcutout\b/,
  ];
  return positivePatterns.some((pattern) => pattern.test(normalized));
}

function appendImageGenerationFormFields(formData: FormData, payload: ImageGenerationPayload): void {
  for (const [key, value] of Object.entries(payload)) {
    formData.set(key, String(value));
  }
}

async function loadReferenceImageBlob(job: GenerationJobRecord, env: Env): Promise<{ blob: Blob; filename: string }> {
  if (!job.reference_image_storage_key) {
    throw new ProviderError("reference_image_missing", "参考图文件不存在，请重新上传后再试。");
  }
  const referenceObject = await env.IMAGES.get(job.reference_image_storage_key);
  if (!referenceObject) {
    throw new ProviderError("reference_image_missing", "参考图文件不存在，请重新上传后再试。");
  }

  const referenceBytes = await referenceObject.arrayBuffer();
  const referenceMimeType = job.reference_image_mime_type ?? referenceObject.httpMetadata?.contentType ?? "image/png";
  const extension = referenceMimeType === "image/jpeg" ? "jpg" : referenceMimeType === "image/webp" ? "webp" : "png";
  return {
    blob: new Blob([referenceBytes], { type: referenceMimeType }),
    filename: job.reference_image_name ?? `reference.${extension}`,
  };
}

async function loadMaskImageBlob(job: GenerationJobRecord, env: Env): Promise<{ blob: Blob; filename: string }> {
  if (!job.mask_image_storage_key) {
    throw new ProviderError("mask_image_missing", "选区遮罩文件不存在，请重新涂抹后再试。");
  }
  const maskObject = await env.IMAGES.get(job.mask_image_storage_key);
  if (!maskObject) {
    throw new ProviderError("mask_image_missing", "选区遮罩文件不存在，请重新涂抹后再试。");
  }

  const maskBytes = await maskObject.arrayBuffer();
  return {
    blob: new Blob([maskBytes], { type: "image/png" }),
    filename: job.mask_image_name ?? "mask.png",
  };
}

function isImageOnlyModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized === "image-2" || normalized.startsWith("gpt-image") || normalized.startsWith("dall-e");
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
}

function mimeFromFormat(format: string): string {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
  return "image/png";
}

const PROMPT_OPTIMIZER_INSTRUCTIONS = [
  "你是图片生成提示词优化器。",
  "基于用户原始意图优化提示词，让它更适合高质量图片生成。",
  "补强主体、构图、材质、风格、镜头、光线、色彩和细节，但不要改变用户想生成的核心内容。",
  "保留用户使用的主要语言；如果用户混合中英文，可以混合输出。",
  "只输出优化后的提示词本身，不输出解释、标题、编号、Markdown 或引号。",
].join("\n");

function promptOptimizationInput(input: PromptOptimizationInput): string {
  return [
    `原始提示词：${input.prompt}`,
    "",
    "当前生成参数：",
    `- 比例：${input.aspectRatio}`,
    `- 尺寸：${input.width}x${input.height}`,
    `- 质量：${input.quality}`,
    `- 输出格式：${input.outputFormat}`,
    "- 背景：根据原始提示词判断；如果原始提示词明确要求透明背景，请在优化结果中保留该要求，否则不要额外添加透明背景要求。",
  ].join("\n");
}
