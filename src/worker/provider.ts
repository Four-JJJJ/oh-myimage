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
const DEFAULT_PROVIDER_IMAGE_BATCH_SIZE = 1;
const MAX_PROVIDER_IMAGE_BATCH_SIZE = 4;
const DEFAULT_PROVIDER_IMAGE_CONCURRENCY = 2;
const MAX_PROVIDER_IMAGE_CONCURRENCY = 4;
const DEFAULT_RESPONSES_MODEL = "gpt-5.5";
const DEFAULT_PROMPT_OPTIMIZER_MODEL = DEFAULT_RESPONSES_MODEL;
const DEFAULT_PROMPT_OPTIMIZER_TIMEOUT_MS = 45_000;
const IMMEDIATE_PROVIDER_TIMEOUT_RETRY_DELAY_MS = 3_000;
const DEFAULT_PROVIDER_TIMEOUT_RETRY_ATTEMPTS = 0;
const MAX_PROVIDER_TIMEOUT_RETRY_ATTEMPTS = 3;
const IMMEDIATE_PROVIDER_TIMEOUT_RETRY_REQUEST_TIMEOUT_MS = 15_000;
const PROMPT_OPTIMIZER_MODELS = new Set(["gpt-5.5", "gpt-5.4"]);
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
  const existingResults = await listGenerationResultsForJob(env.DB, job.space_id, job.id);
  const remainingCount = Math.max(0, job.quantity - existingImages.length);
  const storedImages: StoredGenerationImage[] = [];
  const errors: ProviderError[] = [];
  const availableIndexes = availableResultIndexes(job.quantity, existingResults, existingImages.length);
  const tasks = Array.from({ length: remainingCount }, (_, index) => async () => {
    const resultIndex = availableIndexes[index] ?? existingImages.length + index;
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs < 1000) {
      throw new ProviderError(
        "provider_timeout",
        `模型服务超过 ${formatDuration(timeoutMs)} 仍未返回，已停止等待。请确认 baseURL 的网关、负载均衡和模型服务超时都不低于这个时间。`,
        true,
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
      started_at: new Date().toISOString(),
      completed_at: null,
    });
    await updateJobStatus(env.DB, job.id, "running", undefined, undefined, {
      stage: "waiting_provider",
      progressCurrent: existingImages.length + storedImages.length + errors.length,
      progressTotal: job.quantity,
    });
    try {
      const stored = await generateAndStoreOneImage(job, credential, apiKey, remainingTimeoutMs, env, resultIndex);
      await upsertGenerationJobResult(env.DB, {
        id: generationResultId(job.id, resultIndex),
        space_id: job.space_id,
        job_id: job.id,
        result_index: resultIndex,
        status: "succeeded",
        image_asset_id: stored.imageId,
        error_code: null,
        error_message: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      return stored;
    } catch (error) {
      const providerError = normalizeProviderError(error);
      if (shouldPersistFailedResult(providerError)) {
        await upsertGenerationJobResult(env.DB, {
          id: generationResultId(job.id, resultIndex),
          space_id: job.space_id,
          job_id: job.id,
          result_index: resultIndex,
          status: "failed",
          image_asset_id: null,
          error_code: providerError.code,
          error_message: providerError.message,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
      }
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
): Promise<StoredGenerationImage> {
  const recovered = await recoverStoredImageForResult(job, resultIndex, env);
  if (recovered) return recovered;

  const idempotencyKey = providerIdempotencyKey(job, resultIndex);
  const response = await requestGenerationBatchWithRecovery(job, credential, apiKey, timeoutMs, env, idempotencyKey);
  const image = response.data?.find((item) => item.b64_json || item.url);
  if (!image) {
    throw new ProviderError("empty_response", "模型服务没有返回图片。");
  }

  const binary = await resolveProviderImageBinary(image, job.output_format, timeoutMs);
  const id = imageIdForResult(job.id, resultIndex);
  await persistGeneratedImage(job, env, id, resultIndex, binary.bytes, binary.mimeType, binary.format);

  return {
    imageId: id,
    resultIndex,
    revisedPrompt: image.revised_prompt ?? null,
    usage: response.usage,
  };
}

export async function requestGenerationBatchWithRecovery(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  timeoutMs: number,
  env: Env,
  idempotencyKey: string,
): Promise<ProviderGenerationResponse> {
  try {
    return await requestGenerationBatch(job, credential, apiKey, timeoutMs, env, idempotencyKey);
  } catch (error) {
    const providerError = normalizeProviderError(error);
    if (!shouldImmediatelyRetryImageGeneration(providerError)) throw providerError;

    const retryAttempts = resolveProviderTimeoutRetryAttempts(env.PROVIDER_TIMEOUT_RETRY_ATTEMPTS);
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      await wait(IMMEDIATE_PROVIDER_TIMEOUT_RETRY_DELAY_MS);
      const retryTimeoutMs = Math.min(timeoutMs, IMMEDIATE_PROVIDER_TIMEOUT_RETRY_REQUEST_TIMEOUT_MS);
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
): Promise<ProviderImageBinary> {
  if (image.b64_json) {
    const format = normalizeProviderImageFormat(fallbackFormat);
    return {
      bytes: bytesFromBase64(image.b64_json),
      format,
      mimeType: mimeFromFormat(format),
    };
  }

  if (!image.url) {
    throw new ProviderError("empty_response", "模型服务没有返回图片。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), Math.max(1_000, timeoutMs));
  try {
    const response = await fetch(image.url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderError(
        "provider_image_download_failed",
        `模型已返回图片链接，但下载失败：${response.status}。`,
        response.status >= 500 || response.status === 429,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = normalizeProviderContentType(response.headers.get("content-type"));
    const format = providerImageFormatFromResponse(contentType, image.url, fallbackFormat);
    return {
      bytes,
      format,
      mimeType: contentType ?? mimeFromFormat(format),
    };
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

export async function recoverStoredImageForResult(job: GenerationJobRecord, resultIndex: number, env: Env): Promise<StoredGenerationImage | null> {
  const id = imageIdForResult(job.id, resultIndex);
  const format = job.output_format;
  const mimeType = mimeFromFormat(format);
  const storageKey = storageKeyForResult(job, id, format);
  const object = await env.IMAGES.get(storageKey);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  await insertImageAsset(env.DB, {
    id,
    space_id: job.space_id,
    job_id: job.id,
    storage_key: storageKey,
    mime_type: object.httpMetadata?.contentType ?? mimeType,
    format,
    width: job.width,
    height: job.height,
    byte_size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
  await insertImageUsageEvent(env.DB, job.space_id, id);
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
): Promise<void> {
  const storageKey = storageKeyForResult(job, id, format);
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
  } catch (error) {
    throw new ProviderError(
      "image_storage_failed",
      `模型已返回图片，但保存到对象存储失败：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
    );
  }

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
    });
    await insertImageUsageEvent(env.DB, job.space_id, id);
  } catch (error) {
    throw new ProviderError(
      "image_asset_persist_failed",
      `模型已返回图片并保存到对象存储，但写入图片记录失败；下次重试会优先补保存记录：${redactSecrets(error instanceof Error ? error.message : "未知错误")}`,
      true,
    );
  }
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

export function buildProviderImagePrompt(job: Pick<GenerationJobRecord, "prompt" | "mask_image_storage_key">): string {
  const prompt = job.prompt.trim();
  if (!job.mask_image_storage_key) return prompt;
  return [prompt, MASKED_IMAGE_EDIT_PROMPT_SUFFIX].filter(Boolean).join("\n\n");
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
