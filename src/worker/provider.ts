import { bytesFromBase64, decryptSecret, sha256Hex } from "./crypto";
import { envNumber, redactSecrets } from "./http";
import { buildProviderEndpoint } from "./security";
import {
  completeJob,
  getCredential,
  getGenerationJobForWorker,
  insertImageAsset,
  insertImageUsageEvent,
  listGenerationResultsForJob,
  listImagesForJob,
  updateJobStatus,
  upsertGenerationJobResult,
} from "./db";
import { CredentialRecord, Env, GenerationJobRecord, GenerationMessage, GenerationReferenceImageSnapshot } from "./types";
import { PromptOptimizationInput } from "./validation";

export interface ProviderImage {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface ProviderImageBinary {
  bytes: Uint8Array;
  format: string;
  mimeType: string;
}

export interface ProviderImageDownloadOptions {
  providerBaseURL: string;
  apiKey: string;
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

export interface ImageGenerationPayload {
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
const MIN_GENERATION_JOB_MAX_RUNTIME_MS = 60_000;
const DEFAULT_GENERATION_JOB_MAX_RUNTIME_MS = MAX_QUEUE_CONSUMER_TIMEOUT_MS;
const DEFAULT_PROVIDER_IMAGE_CONCURRENCY = 2;
const MAX_PROVIDER_IMAGE_CONCURRENCY = 4;
const DEFAULT_RESPONSES_MODEL = "gpt-5.5";
const DEFAULT_PROMPT_OPTIMIZER_MODEL = DEFAULT_RESPONSES_MODEL;
const DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS = 45_000;
const PROVIDER_TIMEOUT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000, 60_000] as const;
const DEFAULT_PROVIDER_TIMEOUT_RETRY_ATTEMPTS = 0;
const MAX_PROVIDER_TIMEOUT_RETRY_ATTEMPTS = 4;
const IMMEDIATE_PROVIDER_TIMEOUT_RETRY_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_REDIRECTS = 3;
const PROVIDER_IMAGE_DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const PROVIDER_IMAGE_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 60_000;
const IMAGE_STORAGE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const GENERATED_THUMBNAIL_MAX_EDGE_PX = 512;
const GENERATED_THUMBNAIL_WEBP_QUALITY = 78;
const PROMPT_OPTIMIZER_MODELS = new Set(["gpt-5.5", "gpt-5.4"]);
const PROVIDER_RESULT_CHECKPOINT_VERSION = 1;
const REFERENCE_IMAGE_PROMPT_SUFFIX = [
  "Use the attached reference image(s) as active visual input, not as optional background context.",
  "If the user asks for a change, make that change visibly clear; do not reproduce the reference unchanged unless the user explicitly asks to preserve it.",
].join(" ");
const SOURCE_IMAGE_PROMPT_SUFFIX = [
  "The first attached image is the primary source image to edit.",
  "Any later attached images are supplemental references for the style, material, color, or content the user names.",
  "Preserve only the traits the user explicitly asks to keep, and make requested changes visibly clear.",
].join(" ");
const MASKED_IMAGE_EDIT_PROMPT_SUFFIX = [
  "Treat the user's prompt as the replacement content for that selected area, not as an instruction to add a new object elsewhere in the image.",
  "Replace the masked content so the selected area matches the user's prompt exactly, including short words, labels, or characters when text is requested.",
  "Only edit the area selected by the alpha mask's transparent pixels.",
  "Preserve every unmasked area of the input image, including composition, objects, lighting, texture, and background, as unchanged as possible.",
].join(" ");

interface StoredGenerationImage {
  imageId: string;
  resultIndex: number;
  revisedPrompt: string | null;
  usage: unknown;
}

interface GenerationRunResult {
  requestedCount: number;
  existingCount: number;
  storedImages: StoredGenerationImage[];
  errors: ProviderError[];
}

type ProviderRetryScope = "provider" | "post_processing";

interface ProviderResultCheckpoint {
  version: typeof PROVIDER_RESULT_CHECKPOINT_VERSION;
  acceptedAt: string;
  image: ProviderImage;
  revisedPrompt: string | null;
  usage?: unknown;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryScope: ProviderRetryScope = "provider",
  ) {
    super(message);
  }
}

export interface ProcessGenerationOptions {
  retryProviderErrors?: boolean;
  retryPostProcessingErrors?: boolean;
  /** @deprecated Use retryProviderErrors. Kept for callers built against the previous option. */
  throwRetryableErrors?: boolean;
}

export function providerIdempotencyKey(job: Pick<GenerationJobRecord, "id" | "space_id">, resultIndex: number): string {
  return `oh-myimage:${job.space_id}:${job.id}:${resultIndex}`;
}

export function shouldImmediatelyRetryImageGeneration(error: ProviderError): boolean {
  return error.code === "provider_timeout";
}

export function shouldPersistFailedResult(error: ProviderError): boolean {
  return !error.retryable;
}

export function resolveProviderTimeoutRetryAttempts(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(envNumber(value, DEFAULT_PROVIDER_TIMEOUT_RETRY_ATTEMPTS)), 0), MAX_PROVIDER_TIMEOUT_RETRY_ATTEMPTS);
}

export function resolveProviderTimeoutRetryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.trunc(attempt));
  return PROVIDER_TIMEOUT_RETRY_DELAYS_MS[index] ?? PROVIDER_TIMEOUT_RETRY_DELAYS_MS[PROVIDER_TIMEOUT_RETRY_DELAYS_MS.length - 1];
}

export function generationJobDeadlineMs(
  job: Pick<GenerationJobRecord, "started_at">,
  maxRuntimeMs: number,
  nowMs = Date.now(),
): number {
  const persistedStart = providerTimestampMs(job.started_at);
  const startMs = Number.isFinite(persistedStart) && persistedStart <= nowMs ? persistedStart : nowMs;
  return startMs + maxRuntimeMs;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  provider: Pick<CredentialRecord, "prompt_base_url" | "prompt_optimizer_model">,
  apiKey: string,
  env: Env,
): Promise<string> {
  if (!provider.prompt_base_url) {
    throw new ProviderError("provider_missing", "请先在设置中配置提示词 Provider 的 baseURL 和 API Key。");
  }
  const endpoint = buildProviderEndpoint(provider.prompt_base_url, "/responses");
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
        model: resolveResponsesModel(resolvePromptOptimizerModel(provider.prompt_optimizer_model ?? env.PROMPT_OPTIMIZER_MODEL)),
        instructions: PROMPT_OPTIMIZER_INSTRUCTIONS,
        input: promptOptimizationInput(input),
      }),
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await providerMessage(response);
      const code = providerErrorCode(response.status, text);
      throw new ProviderError(
        code,
        providerStatusMessage(response.status, text, DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS),
        providerErrorRetryable(code, response.status),
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

  await updateJobStatus(env.DB, job.id, "running", undefined, undefined, {
    stage: "waiting_provider",
    progressCurrent: await completedSlotCount(env, job),
    progressTotal: job.quantity,
  });

  try {
    const apiKey = await decryptSecret(credential.encrypted_api_key, env.APP_ENCRYPTION_KEY ?? "");
    const result = await requestGeneration(job, credential, apiKey, env);
    const completedCount = result.existingCount + result.storedImages.length;
    const retryError = [...result.errors].reverse().find((error) => shouldRetryProcessingError(error, options));
    if (retryError) throw retryError;
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
    if (shouldRetryProcessingError(providerError, options)) {
      throw providerError;
    }
    await updateJobStatus(env.DB, job.id, "failed", providerError.code, providerError.message);
  }
}

function shouldRetryProcessingError(error: ProviderError, options: ProcessGenerationOptions): boolean {
  if (!error.retryable) return false;
  if (error.retryScope === "post_processing") return options.retryPostProcessingErrors === true;
  return options.retryProviderErrors ?? options.throwRetryableErrors ?? false;
}

async function requestGeneration(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  env: Env,
): Promise<GenerationRunResult> {
  const timeoutMs = resolveGenerationTimeoutMs(env.REQUEST_TIMEOUT_MS);
  const jobDeadline = generationJobDeadlineMs(job, resolveGenerationJobMaxRuntimeMs(env.GENERATION_JOB_MAX_RUNTIME_MS));
  const concurrency = resolveProviderImageConcurrency(env.PROVIDER_IMAGE_CONCURRENCY);
  const existingImages = await listImagesForJob(env.DB, job.space_id, job.id);
  const existingResults = await listGenerationResultsForJob(env.DB, job.space_id, job.id);
  const remainingCount = Math.max(0, job.quantity - existingImages.length);
  const storedImages: StoredGenerationImage[] = [];
  const errors: ProviderError[] = [];
  const availableIndexes = availableResultIndexes(job.quantity, existingResults, existingImages.length);
  const tasks = Array.from({ length: remainingCount }, (_, index) => async () => {
    const resultIndex = availableIndexes[index] ?? existingImages.length + index;
    const startedAt = new Date().toISOString();
    const remainingJobRuntimeMs = jobDeadline - Date.now();
    if (remainingJobRuntimeMs < 1000) {
      throw new ProviderError(
        "generation_runtime_exceeded",
        "生成任务已达到本次处理的最长运行时间，未完成的图片已停止等待。请稍后重试或减少单次生成数量。",
      );
    }
    await upsertGenerationJobResult(env.DB, {
      id: generationResultId(job.id, resultIndex),
      space_id: job.space_id,
      job_id: job.id,
      result_index: resultIndex,
      status: "running",
      image_asset_id: null,
      error_code: null,
      error_message: null,
      started_at: startedAt,
      completed_at: null,
    });
    await updateJobStatus(env.DB, job.id, "running", undefined, undefined, {
      stage: "waiting_provider",
      progressCurrent: existingImages.length + storedImages.length + errors.length,
      progressTotal: job.quantity,
    });
    try {
      const stored = await generateAndStoreOneImage(
        job,
        credential,
        apiKey,
        Math.min(timeoutMs, remainingJobRuntimeMs),
        env,
        resultIndex,
        jobDeadline,
      );
      await upsertGenerationJobResult(env.DB, {
        id: generationResultId(job.id, resultIndex),
        space_id: job.space_id,
        job_id: job.id,
        result_index: resultIndex,
        status: "succeeded",
        image_asset_id: stored.imageId,
        error_code: null,
        error_message: null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return stored;
    } catch (error) {
      const providerError = normalizeProviderError(error);
      await upsertGenerationJobResult(env.DB, {
        id: generationResultId(job.id, resultIndex),
        space_id: job.space_id,
        job_id: job.id,
        result_index: resultIndex,
        status: "failed",
        image_asset_id: null,
        error_code: providerError.code,
        error_message: providerError.message,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      throw providerError;
    }
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
    await updateJobStatus(env.DB, job.id, "running", undefined, undefined, {
      stage: "waiting_provider",
      progressCurrent: existingImages.length + storedImages.length + errors.length,
      progressTotal: job.quantity,
    });
  }

  return { requestedCount: job.quantity, existingCount: existingImages.length, storedImages, errors };
}

async function generateAndStoreOneImage(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
  resultIndex: number,
  jobDeadlineMs: number,
): Promise<StoredGenerationImage> {
  const recovered = await recoverStoredImageForResult(job, resultIndex, env);
  if (recovered) {
    const checkpoint = await loadProviderResultCheckpoint(job, resultIndex, env);
    await deleteProviderResultCheckpointBestEffort(job, resultIndex, env);
    return checkpoint
      ? { ...recovered, revisedPrompt: checkpoint.revisedPrompt, usage: checkpoint.usage }
      : recovered;
  }

  let checkpoint = await loadProviderResultCheckpoint(job, resultIndex, env);
  if (!checkpoint) {
    const idempotencyKey = providerIdempotencyKey(job, resultIndex);
    const response = await requestGenerationBatchWithRecovery(job, credential, apiKey, timeoutMs, env, idempotencyKey, jobDeadlineMs);
    const image = response.data?.find((item) => item.b64_json || item.url);
    if (!image) {
      throw new ProviderError("empty_response", "模型服务没有返回图片。");
    }
    checkpoint = {
      version: PROVIDER_RESULT_CHECKPOINT_VERSION,
      acceptedAt: new Date().toISOString(),
      image: checkpointImage(image),
      revisedPrompt: image.revised_prompt ?? null,
      usage: response.usage,
    };
    await persistProviderResultCheckpoint(job, resultIndex, checkpoint, env);
  }

  const remainingRuntimeMs = jobDeadlineMs - Date.now();
  if (remainingRuntimeMs < 1_000) {
    throw new ProviderError(
      "generation_runtime_exceeded",
      "模型已返回结果，但任务已达到最长运行时间，未继续下载。为避免重复扣费，系统不会自动重新提交生图。",
    );
  }
  const binary = await resolveProviderImageBinary(
    checkpoint.image,
    job.output_format,
    Math.min(timeoutMs, remainingRuntimeMs),
    { providerBaseURL: credential.base_url, apiKey },
  );
  const id = imageIdForResult(job.id, resultIndex);
  await persistGeneratedImage(job, env, id, resultIndex, binary.bytes, binary.mimeType, binary.format, jobDeadlineMs);
  await deleteProviderResultCheckpointBestEffort(job, resultIndex, env);

  return {
    imageId: id,
    resultIndex,
    revisedPrompt: checkpoint.revisedPrompt,
    usage: checkpoint.usage,
  };
}

export async function requestGenerationBatchWithRecovery(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
  idempotencyKey: string,
  deadlineMs = Date.now() + timeoutMs,
): Promise<ProviderGenerationResponse> {
  try {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs < 1_000) {
      throw new ProviderError("generation_runtime_exceeded", "生成任务已达到最长运行时间，未再次提交模型请求。");
    }
    return await requestGenerationBatch(job, credential, apiKey, Math.min(timeoutMs, remainingMs), env, idempotencyKey);
  } catch (error) {
    const providerError = normalizeProviderError(error);
    if (!shouldImmediatelyRetryImageGeneration(providerError)) throw providerError;

    const retryAttempts = resolveProviderTimeoutRetryAttempts(env.PROVIDER_TIMEOUT_RETRY_ATTEMPTS);
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      const retryDelayMs = resolveProviderTimeoutRetryDelayMs(attempt);
      if (Date.now() + retryDelayMs >= deadlineMs) break;
      await wait(retryDelayMs);
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs < 1_000) break;
      const retryTimeoutMs = Math.min(timeoutMs, IMMEDIATE_PROVIDER_TIMEOUT_RETRY_REQUEST_TIMEOUT_MS, remainingMs);
      try {
        return await requestGenerationBatch(job, credential, apiKey, retryTimeoutMs, env, idempotencyKey);
      } catch (retryError) {
        const retryProviderError = normalizeProviderError(retryError);
        if (!shouldImmediatelyRetryImageGeneration(retryProviderError)) throw retryProviderError;
      }
    }

    throw providerError;
  }
}

export async function resolveProviderImageBinary(
  image: Pick<ProviderImage, "b64_json" | "url">,
  fallbackFormat: string,
  timeoutMs: number,
  options?: ProviderImageDownloadOptions,
): Promise<ProviderImageBinary> {
  if (image.b64_json) {
    return providerImageBinaryFromBytes(bytesFromBase64(image.b64_json), fallbackFormat);
  }

  if (!image.url) {
    throw new ProviderError("empty_response", "模型服务没有返回图片。");
  }

  const initialUrl = validateProviderImageUrl(image.url);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt <= PROVIDER_IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const retryDelayMs = PROVIDER_IMAGE_DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 0;
      if (Date.now() + retryDelayMs >= deadline) break;
      await wait(retryDelayMs);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) break;
    try {
      return await downloadProviderImageOnce(
        initialUrl,
        fallbackFormat,
        Math.min(remainingMs, PROVIDER_IMAGE_DOWNLOAD_ATTEMPT_TIMEOUT_MS),
        options,
      );
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              "provider_image_download_failed",
              `模型已返回图片链接，但下载失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
              true,
            );
      lastError = providerError;
      if (!shouldRetryProviderImageDownload(providerError) || attempt === PROVIDER_IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length) {
        throw asPostProcessingError(providerError);
      }
    }
  }

  throw asPostProcessingError(
    lastError ?? new ProviderError("provider_image_download_timeout", "模型已返回图片链接，但下载图片超时。", true),
  );
}

async function downloadProviderImageOnce(
  initialUrl: URL,
  fallbackFormat: string,
  attemptTimeoutMs: number,
  options?: ProviderImageDownloadOptions,
): Promise<ProviderImageBinary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), Math.max(1_000, attemptTimeoutMs));
  try {
    const { response, finalUrl } = await fetchProviderImageUrl(initialUrl, controller.signal, options);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(
        "provider_image_download_failed",
        `模型已返回图片链接，但下载失败：${response.status}。`,
        isRetryableProviderImageStatus(response.status),
      );
    }

    const contentType = normalizeProviderContentType(response.headers.get("content-type"));
    if (contentType && !formatFromMimeType(contentType)) {
      throw new ProviderError("provider_image_download_invalid_content_type", "模型已返回图片链接，但响应不是支持的图片格式。");
    }
    const declaredLength = contentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > MAX_PROVIDER_IMAGE_DOWNLOAD_BYTES) {
      throw new ProviderError("provider_image_download_too_large", "模型已返回图片链接，但图片文件超过 25MB。");
    }

    const bytes = await responseBytesWithLimit(response, MAX_PROVIDER_IMAGE_DOWNLOAD_BYTES);
    return providerImageBinaryFromBytes(bytes, providerImageFormatFromResponse(contentType, finalUrl.toString(), fallbackFormat));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderError("provider_image_download_timeout", "模型已返回图片链接，但下载图片超时。", true);
    }
    throw new ProviderError(
      "provider_image_download_failed",
      `模型已返回图片链接，但下载失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetryProviderImageDownload(error: ProviderError): boolean {
  return (
    error.retryable &&
    (error.code === "provider_image_download_failed" || error.code === "provider_image_download_timeout")
  );
}

function asPostProcessingError(error: ProviderError): ProviderError {
  const message = error.retryable
    ? `${error.message} 系统只会恢复这份已接收结果，不会重新提交生图。`
    : error.message;
  return new ProviderError(error.code, message, error.retryable, "post_processing");
}

function validateProviderImageUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError("provider_image_download_blocked", "模型返回的图片链接不是有效 URL。");
  }
  // 模型可能返回 http:// 图片链接（如部分中转服务），允许下载；
  // 但内网/本机地址校验始终生效，防止 SSRF。
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("provider_image_download_blocked", "模型返回的图片链接只支持 HTTP/HTTPS 协议。");
  }
  if (url.username || url.password || isBlockedProviderImageHost(url.hostname)) {
    throw new ProviderError("provider_image_download_blocked", "模型返回的图片链接不允许指向本机或内网地址。");
  }
  return url;
}

async function fetchProviderImageUrl(
  initialUrl: URL,
  signal: AbortSignal,
  options?: ProviderImageDownloadOptions,
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_PROVIDER_IMAGE_REDIRECTS; redirectCount += 1) {
    const authorization = providerImageAuthorization(currentUrl, options);
    const response = await fetch(currentUrl.toString(), {
      redirect: "manual",
      signal,
      headers: {
        Accept: "image/*",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });
    if (!isRedirectStatus(response.status)) return { response, finalUrl: currentUrl };

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl };
    currentUrl = validateProviderImageUrl(new URL(location, currentUrl).toString());
  }
  throw new ProviderError("provider_image_download_blocked", "模型返回的图片链接重定向次数过多。");
}

function providerImageAuthorization(url: URL, options?: ProviderImageDownloadOptions): string | null {
  if (!options?.apiKey) return null;
  try {
    return new URL(options.providerBaseURL).origin === url.origin ? `Bearer ${options.apiKey}` : null;
  } catch {
    return null;
  }
}

function isRetryableProviderImageStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBlockedProviderImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return isBlockedIpv6Host(host);
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d+$/.test(octet))) return false;
  const values = octets.map(Number);
  if (!values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return false;
  const [a, b] = values;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isBlockedIpv6Host(host: string): boolean {
  return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function contentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function responseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ProviderError("provider_image_download_too_large", "模型已返回图片链接，但图片文件超过 25MB。");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ProviderError("provider_image_download_too_large", "模型已返回图片链接，但图片文件超过 25MB。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function checkpointImage(image: ProviderImage): ProviderImage {
  if (image.b64_json) return { b64_json: image.b64_json };
  if (image.url) return { url: image.url };
  return {};
}

export function providerResultCheckpointStorageKey(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  resultIndex: number,
): string {
  return `${job.space_id}/${job.id}/provider-result-${resultIndex}.json`;
}

async function persistProviderResultCheckpoint(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  resultIndex: number,
  checkpoint: ProviderResultCheckpoint,
  env: Env,
): Promise<void> {
  const storageKey = providerResultCheckpointStorageKey(job, resultIndex);
  const serialized = JSON.stringify(checkpoint);
  let lastError: unknown;
  for (let attempt = 0; attempt <= IMAGE_STORAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(IMAGE_STORAGE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    try {
      await env.IMAGES.put(storageKey, serialized, {
        httpMetadata: {
          contentType: "application/json",
          contentDisposition: `inline; filename="provider-result-${resultIndex}.json"`,
        },
        customMetadata: {
          jobId: job.id,
          spaceId: job.space_id,
          resultIndex: String(resultIndex),
          kind: "provider-result-checkpoint",
        },
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProviderError(
    "provider_result_checkpoint_failed",
    `模型已返回结果，但保存安全恢复记录失败：${redactSecrets(lastError instanceof Error ? lastError.message : "未知错误")}。为避免重复扣费，系统不会自动重新提交生图。`,
  );
}

async function loadProviderResultCheckpoint(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  resultIndex: number,
  env: Env,
): Promise<ProviderResultCheckpoint | null> {
  const storageKey = providerResultCheckpointStorageKey(job, resultIndex);
  let object: Awaited<ReturnType<Env["IMAGES"]["get"]>>;
  try {
    object = await env.IMAGES.get(storageKey);
  } catch (error) {
    throw new ProviderError(
      "provider_result_checkpoint_read_failed",
      `读取生图恢复记录失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
      "post_processing",
    );
  }
  if (!object) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as Partial<ProviderResultCheckpoint>;
    const image = parsed.image;
    if (
      parsed.version !== PROVIDER_RESULT_CHECKPOINT_VERSION ||
      !image ||
      (typeof image.b64_json !== "string" && typeof image.url !== "string")
    ) {
      throw new Error("checkpoint shape is invalid");
    }
    return {
      version: PROVIDER_RESULT_CHECKPOINT_VERSION,
      acceptedAt: typeof parsed.acceptedAt === "string" ? parsed.acceptedAt : "",
      image: checkpointImage(image),
      revisedPrompt: typeof parsed.revisedPrompt === "string" ? parsed.revisedPrompt : null,
      usage: parsed.usage,
    };
  } catch (error) {
    throw new ProviderError(
      "provider_result_checkpoint_invalid",
      `生图恢复记录损坏：${redactSecrets(error instanceof Error ? error.message : "未知错误")}。为避免重复扣费，系统不会重新提交生图。`,
    );
  }
}

async function deleteProviderResultCheckpointBestEffort(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  resultIndex: number,
  env: Env,
): Promise<void> {
  const storageKey = providerResultCheckpointStorageKey(job, resultIndex);
  try {
    await env.IMAGES.delete(storageKey);
  } catch (error) {
    console.warn("provider result checkpoint cleanup skipped", redactSecrets(error instanceof Error ? error.message : "unknown error"));
  }
}

export async function recoverStoredImageForResult(job: GenerationJobRecord, resultIndex: number, env: Env): Promise<StoredGenerationImage | null> {
  const id = imageIdForResult(job.id, resultIndex);
  const candidates = [...new Set([normalizeProviderImageFormat(job.output_format), "png", "webp", "jpeg"])] as string[];
  let stored: {
    format: string;
    storageKey: string;
    object: NonNullable<Awaited<ReturnType<Env["IMAGES"]["get"]>>>;
  } | null = null;
  for (const candidate of candidates) {
    const storageKey = storageKeyForResult(job, id, candidate);
    let object: Awaited<ReturnType<Env["IMAGES"]["get"]>>;
    try {
      object = await env.IMAGES.get(storageKey);
    } catch (error) {
      throw new ProviderError(
        "image_recovery_read_failed",
        `检查已保存图片失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
        true,
        "post_processing",
      );
    }
    if (object) {
      stored = { format: candidate, storageKey, object };
      break;
    }
  }
  if (!stored) return null;
  const { storageKey, object } = stored;
  try {
    const bytes = new Uint8Array(await object.arrayBuffer());
    const binary = providerImageBinaryFromBytes(bytes, stored.format);
    await insertImageAsset(env.DB, {
      id,
      space_id: job.space_id,
      job_id: job.id,
      storage_key: storageKey,
      mime_type: object.httpMetadata?.contentType ?? binary.mimeType,
      format: binary.format,
      width: job.width,
      height: job.height,
      byte_size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      thumbnail_storage_key: null,
      thumbnail_mime_type: null,
      thumbnail_byte_size: null,
      thumbnail_sha256: null,
    });
    await insertImageUsageEvent(env.DB, job.space_id, id);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "image_asset_recovery_failed",
      `图片已保存，但补写图片记录失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
      "post_processing",
    );
  }
  return {
    imageId: id,
    resultIndex,
    revisedPrompt: null,
    usage: undefined,
  };
}

async function persistGeneratedImage(
  job: GenerationJobRecord,
  env: Env,
  id: string,
  resultIndex: number,
  bytes: Uint8Array,
  mimeType: string,
  format: string,
  deadlineMs: number,
): Promise<void> {
  const storageKey = storageKeyForResult(job, id, format);
  let thumbnail: Awaited<ReturnType<typeof thumbnailMetadataForResult>> | null = null;
  await storeGeneratedImageWithRecovery(job, env, id, resultIndex, storageKey, bytes, mimeType, format, deadlineMs);
  thumbnail = await persistGeneratedThumbnailBestEffort(job, env, id, resultIndex, bytes);

  try {
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
      thumbnail_storage_key: thumbnail?.storageKey ?? null,
      thumbnail_mime_type: thumbnail?.mimeType ?? null,
      thumbnail_byte_size: thumbnail?.bytes.byteLength ?? null,
      thumbnail_sha256: thumbnail ? await sha256Hex(thumbnail.bytes) : null,
    });
    await insertImageUsageEvent(env.DB, job.space_id, id);
  } catch (error) {
    throw new ProviderError(
      "image_asset_persist_failed",
      `模型已返回图片并保存到对象存储，但写入图片记录失败；下次重试会优先补保存记录：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
      "post_processing",
    );
  }
}

async function storeGeneratedImageWithRecovery(
  job: GenerationJobRecord,
  env: Env,
  id: string,
  resultIndex: number,
  storageKey: string,
  bytes: Uint8Array,
  mimeType: string,
  format: string,
  deadlineMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= IMAGE_STORAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delayMs = IMAGE_STORAGE_RETRY_DELAYS_MS[attempt - 1] ?? 0;
      if (Date.now() + delayMs >= deadlineMs) break;
      await wait(delayMs);
    }
    if (deadlineMs - Date.now() < 1_000) break;
    try {
      await env.IMAGES.put(storageKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          contentDisposition: `inline; filename="${id}.${format}"`,
        },
        customMetadata: {
          jobId: job.id,
          spaceId: job.space_id,
          resultIndex: String(resultIndex),
        },
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProviderError(
    "image_storage_failed",
    `模型已返回图片，但保存到对象存储失败：${redactSecrets(lastError instanceof Error ? lastError.message : "已达到任务最长运行时间")}。系统只会恢复这份已接收结果，不会重新提交生图。`,
    true,
    "post_processing",
  );
}

async function requestGenerationBatch(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
  idempotencyKey: string,
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
      headers: providerRequestHeaders(apiKey, body, idempotencyKey),
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await providerMessage(response);
      const code = providerErrorCode(response.status, text);
      throw new ProviderError(
        code,
        providerStatusMessage(response.status, text, timeoutMs),
        providerErrorRetryable(code, response.status),
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
  if (!hasReferenceImages(job)) {
    return JSON.stringify(payload);
  }

  const referenceImages = await loadReferenceImageBlobs(job, env);
  let maskImage: ProviderImageFilePart | undefined;
  if (job.mask_image_storage_key) {
    maskImage = await loadMaskImageBlob(job, env);
  }
  return buildImageGenerationFormData(payload, referenceImages, maskImage);
}

function providerRequestHeaders(apiKey: string, body: BodyInit, idempotencyKey: string): HeadersInit {
  const headers: HeadersInit = {
    Authorization: `Bearer ${apiKey}`,
    "Idempotency-Key": idempotencyKey,
  };
  if (!(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

export function providerErrorCode(status: number, message = ""): string {
  if (isProviderBalanceMessage(message) || status === 402) return "provider_balance_insufficient";
  if (isProviderContentRejectedMessage(message)) return "provider_content_rejected";
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 408 || status === 504 || status === 522 || status === 524) return "provider_timeout";
  if (status >= 500) return "provider_upstream_error";
  return "provider_rejected";
}

export function providerStatusMessage(status: number, message: string, timeoutMs: number): string {
  const code = providerErrorCode(status, message);
  if (code === "provider_auth_failed") return "模型服务鉴权失败，请检查 baseURL 和 API Key。";
  if (code === "provider_balance_insufficient") return "模型服务余额或额度不足，请检查上游账号余额、套餐或额度限制。";
  if (code === "provider_content_rejected") return message || "模型服务拒绝了这次请求，通常是内容安全或审核策略导致。请调整提示词或参考图后重试。";
  if (status === 522 || status === 524) {
    return `模型服务返回 ${status}，上游网关等待模型服务超时。当前 Worker 已允许最长等待 ${formatDuration(timeoutMs)}；如果单次生图经常超过 120 秒，请将 baseURL 指向 DNS-only/直连源站域名，或把上游接口改成异步任务/轮询模式。`;
  }
  if (code === "provider_timeout") {
    return `模型服务返回 ${status}，请求等待超时。当前 Worker 已允许最长等待 ${formatDuration(timeoutMs)}；如果频繁超时，请检查上游网关和模型服务超时配置。`;
  }
  if (code === "provider_upstream_error") {
    return `模型服务返回 ${status}，上游服务暂时不可用或内部错误。请检查 baseURL 网关、模型服务健康状态和上游错误日志。`;
  }
  return message || `模型服务返回 ${status}。`;
}

export function providerErrorRetryable(code: string, status: number): boolean {
  if (code === "provider_timeout" || code === "provider_upstream_error" || code === "provider_rate_limited") return true;
  return status >= 500 && code !== "provider_auth_failed" && code !== "provider_balance_insufficient" && code !== "provider_content_rejected";
}

async function providerMessage(response: Response): Promise<string> {
  const text = redactSecrets(await response.text());
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
    if (parsed.error) {
      const parts = [parsed.error.code, parsed.error.type, parsed.error.message].filter((part): part is string => Boolean(part));
      if (parts.length > 0) return redactSecrets(parts.join(" "));
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

function isProviderBalanceMessage(message: string): boolean {
  return /insufficient[_\s-]*(quota|balance|credit|funds)|billing|payment required|余额不足|额度不足|余额|欠费|quota exceeded/i.test(message);
}

function isProviderContentRejectedMessage(message: string): boolean {
  return /content[_\s-]*policy|policy[_\s-]*violation|safety|moderation|unsafe|blocked by policy|内容审核|安全策略|审核|违规/i.test(message);
}

export function resolveGenerationTimeoutMs(value: string | undefined): number {
  return Math.min(Math.max(envNumber(value, DEFAULT_GENERATION_TIMEOUT_MS), 1000), MAX_QUEUE_CONSUMER_TIMEOUT_MS);
}

export function resolveGenerationJobMaxRuntimeMs(value: string | undefined): number {
  return Math.min(Math.max(envNumber(value, DEFAULT_GENERATION_JOB_MAX_RUNTIME_MS), MIN_GENERATION_JOB_MAX_RUNTIME_MS), MAX_QUEUE_CONSUMER_TIMEOUT_MS);
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
    prompt: buildProviderImagePrompt(job),
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

export function buildProviderImagePrompt(
  job: Pick<GenerationJobRecord, "prompt" | "mask_image_storage_key" | "reference_images_json" | "reference_image_storage_key">,
): string {
  const prompt = job.prompt.trim();
  const referenceContext = referencePromptContext(job);
  return [prompt, referenceContext, job.mask_image_storage_key ? MASKED_IMAGE_EDIT_PROMPT_SUFFIX : ""].filter(Boolean).join("\n\n");
}

function referencePromptContext(
  job: Pick<GenerationJobRecord, "reference_images_json" | "reference_image_storage_key" | "mask_image_storage_key">,
): string {
  const snapshots = parseReferenceImagesJson(job.reference_images_json);
  if (!job.reference_image_storage_key && snapshots.length === 0) return "";
  const hasSource = Boolean(job.mask_image_storage_key) || snapshots.some((snapshot) => snapshot.role === "source");
  return hasSource ? SOURCE_IMAGE_PROMPT_SUFFIX : REFERENCE_IMAGE_PROMPT_SUFFIX;
}

export function imageGenerationEndpointPath(job: Pick<GenerationJobRecord, "reference_image_storage_key" | "reference_images_json">): "/images/edits" | "/images/generations" {
  return hasReferenceImages(job) ? "/images/edits" : "/images/generations";
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

export interface ProviderImageFilePart {
  blob: Blob;
  filename: string;
}

export function buildImageGenerationFormData(
  payload: ImageGenerationPayload,
  referenceImages: ProviderImageFilePart | ProviderImageFilePart[],
  maskImage?: ProviderImageFilePart,
): FormData {
  const formData = new FormData();
  appendImageGenerationFormFields(formData, payload);
  const images = Array.isArray(referenceImages) ? referenceImages : [referenceImages];
  for (const referenceImage of images) {
    formData.append("image[]", referenceImage.blob, referenceImage.filename);
  }
  if (maskImage) {
    formData.append("mask", maskImage.blob, maskImage.filename);
  }
  return formData;
}

function appendImageGenerationFormFields(formData: FormData, payload: ImageGenerationPayload): void {
  for (const [key, value] of Object.entries(payload)) {
    formData.set(key, String(value));
  }
}

async function loadReferenceImageBlobs(job: GenerationJobRecord, env: Env): Promise<ProviderImageFilePart[]> {
  const snapshots = referenceImageSnapshots(job);
  if (snapshots.length === 0) {
    throw new ProviderError("reference_image_missing", "参考图文件不存在，请重新上传后再试。");
  }
  return Promise.all(snapshots.map((snapshot) => loadReferenceSnapshotBlob(snapshot, env)));
}

async function loadReferenceSnapshotBlob(snapshot: GenerationReferenceImageSnapshot, env: Env): Promise<ProviderImageFilePart> {
  const referenceObject = await env.IMAGES.get(snapshot.storageKey);
  if (!referenceObject) {
    throw new ProviderError("reference_image_missing", "参考图文件不存在，请重新上传后再试。");
  }

  const referenceBytes = await referenceObject.arrayBuffer();
  const referenceMimeType = snapshot.mimeType || referenceObject.httpMetadata?.contentType || "image/png";
  const extension = referenceMimeType === "image/jpeg" ? "jpg" : referenceMimeType === "image/webp" ? "webp" : "png";
  return {
    blob: new Blob([referenceBytes], { type: referenceMimeType }),
    filename: snapshot.name || `reference.${extension}`,
  };
}

function referenceImageSnapshots(
  job: Pick<
    GenerationJobRecord,
    "reference_images_json" | "reference_image_storage_key" | "reference_image_mime_type" | "reference_image_name" | "reference_image_byte_size"
  >,
): GenerationReferenceImageSnapshot[] {
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

function parseReferenceImagesJson(value: string | null | undefined): GenerationReferenceImageSnapshot[] {
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
          ...(record.role === "source" || record.role === "reference" ? { role: record.role } : {}),
        };
      })
      .filter((item): item is GenerationReferenceImageSnapshot => Boolean(item));
  } catch {
    return [];
  }
}

function hasReferenceImages(job: Pick<GenerationJobRecord, "reference_image_storage_key" | "reference_images_json">): boolean {
  return Boolean(job.reference_image_storage_key || parseReferenceImagesJson(job.reference_images_json).length > 0);
}

function availableResultIndexes(quantity: number, existingResults: Array<{ result_index: number; status: string }>, existingImageCount: number): number[] {
  const succeeded = new Set(existingResults.filter((result) => result.status === "succeeded").map((result) => result.result_index));
  const indexes: number[] = [];
  for (let index = 0; index < quantity; index += 1) {
    if (!succeeded.has(index)) indexes.push(index);
  }
  if (indexes.length > 0) return indexes;
  return Array.from({ length: Math.max(0, quantity - existingImageCount) }, (_, index) => existingImageCount + index);
}

async function completedSlotCount(env: Env, job: GenerationJobRecord): Promise<number> {
  const images = await listImagesForJob(env.DB, job.space_id, job.id);
  return images.length;
}

function generationResultId(jobId: string, resultIndex: number): string {
  return `res_${jobId}_${resultIndex}`;
}

function imageIdForResult(jobId: string, resultIndex: number): string {
  return `img_${jobId}_${resultIndex}`;
}

function storageKeyForResult(job: Pick<GenerationJobRecord, "space_id" | "id">, imageId: string, format: string): string {
  return `${job.space_id}/${job.id}/${imageId}.${format}`;
}

async function loadSharp(): Promise<typeof import("sharp") | null> {
  try {
    const sharpModule = await import("sharp");
    return sharpModule.default ?? sharpModule;
  } catch {
    return null;
  }
}

async function thumbnailMetadataForResult(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  imageId: string,
  bytes: Uint8Array,
): Promise<{ storageKey: string; mimeType: string; format: string; bytes: Uint8Array } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;

  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: GENERATED_THUMBNAIL_MAX_EDGE_PX,
      height: GENERATED_THUMBNAIL_MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: GENERATED_THUMBNAIL_WEBP_QUALITY })
    .toBuffer()
    .then((thumbnailBytes) => ({
      storageKey: `${job.space_id}/${job.id}/thumb_${imageId}.webp`,
      mimeType: "image/webp",
      format: "webp",
      bytes: thumbnailBytes,
    }))
    .catch(() => null);
}

async function persistGeneratedThumbnailBestEffort(
  job: Pick<GenerationJobRecord, "space_id" | "id">,
  env: Env,
  imageId: string,
  resultIndex: number,
  bytes: Uint8Array,
): Promise<{ storageKey: string; mimeType: string; format: string; bytes: Uint8Array } | null> {
  const thumbnail = await thumbnailMetadataForResult(job, imageId, bytes);
  if (!thumbnail) return null;
  try {
    await env.IMAGES.put(thumbnail.storageKey, thumbnail.bytes, {
      httpMetadata: {
        contentType: thumbnail.mimeType,
        contentDisposition: `inline; filename="${imageId}-thumbnail.${thumbnail.format}"`,
      },
      customMetadata: {
        jobId: job.id,
        spaceId: job.space_id,
        resultIndex: String(resultIndex),
        sourceImageId: imageId,
        kind: "thumbnail",
      },
    });
    return thumbnail;
  } catch (error) {
    console.warn("generated thumbnail persistence skipped", redactSecrets(error instanceof Error ? error.message : "unknown error"));
    return null;
  }
}

export function generatedThumbnailConfig(): { maxEdgePx: number; mimeType: "image/webp"; quality: number } {
  return {
    maxEdgePx: GENERATED_THUMBNAIL_MAX_EDGE_PX,
    mimeType: "image/webp",
    quality: GENERATED_THUMBNAIL_WEBP_QUALITY,
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

function providerTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

function mimeFromFormat(format: string): string {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
  return "image/png";
}

function normalizeProviderContentType(value: string | null): string | null {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized;
}

function providerImageFormatFromResponse(contentType: string | null, rawUrl: string, fallbackFormat: string): string {
  const fromMime = formatFromMimeType(contentType);
  if (fromMime) return fromMime;
  const fromUrl = formatFromImageUrl(rawUrl);
  if (fromUrl) return fromUrl;
  return normalizeProviderImageFormat(fallbackFormat);
}

function formatFromMimeType(contentType: string | null): string | null {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpeg";
  return null;
}

function formatFromImageUrl(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpeg";
  } catch {
    return null;
  }
  return null;
}

function normalizeProviderImageFormat(format: string): string {
  return format === "jpeg" || format === "webp" ? format : "png";
}

function providerImageBinaryFromBytes(bytes: Uint8Array, fallbackFormat: string): ProviderImageBinary {
  const format = formatFromImageBytes(bytes);
  if (!format) {
    throw new ProviderError("provider_image_invalid_data", "模型服务返回的内容不是有效的 PNG、JPEG 或 WebP 图片。");
  }
  void fallbackFormat;
  return { bytes, format, mimeType: mimeFromFormat(format) };
}

function formatFromImageBytes(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

const PROMPT_OPTIMIZER_INSTRUCTIONS = [
  "你是图片生成提示词优化器。",
  "基于用户原始意图优化提示词，让它更适合高质量图片生成。",
  "补强主体、构图、材质、风格、镜头、光线、色彩和细节，但不要改变用户想生成的核心内容。",
  "如果存在参考图，严格保留用户对第1张、第2张等图片角色和顺序的描述，不要重新分配角色。",
  "明确区分必须保持的内容与必须改变的内容；不要把‘保持基本形状’扩大成颜色、材质、光线和细节都完全不变。",
  "用户要求修正、变化或风格迁移时，让目标变化清晰可见，并避免同时加入互相冲突的保持与改变约束。",
  "保留用户使用的主要语言；如果用户混合中英文，可以混合输出。",
  "只输出优化后的提示词本身，不输出解释、标题、编号、Markdown 或引号。",
].join("\n");

export function promptOptimizationInput(input: PromptOptimizationInput): string {
  return [
    `原始提示词：${input.prompt}`,
    "",
    "当前生成参数：",
    `- 比例：${input.aspectRatio}`,
    `- 尺寸：${input.width}x${input.height}`,
    `- 质量：${input.quality}`,
    `- 输出格式：${input.outputFormat}`,
    `- 参考图数量：${input.referenceImageCount}`,
    `- 是否基于已有生成图继续创作：${input.hasSourceImage ? "是；第1张图是当前编辑目标" : "否"}`,
    `- 是否为局部重绘：${input.hasMaskImage ? "是；只改遮罩选区，未选区域保持不变" : "否"}`,
    "- 背景：根据原始提示词判断；如果原始提示词明确要求透明背景，请在优化结果中保留该要求，否则不要额外添加透明背景要求。",
  ].join("\n");
}
