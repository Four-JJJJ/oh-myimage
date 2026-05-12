import { bytesFromBase64, decryptSecret, sha256Hex } from "./crypto";
import { randomId, redactSecrets } from "./http";
import { buildProviderEndpoint } from "./security";
import {
  completeJob,
  getCredential,
  getGenerationJobForWorker,
  insertImageAsset,
  updateJobStatus,
} from "./db";
import { CredentialRecord, Env, GenerationJobRecord, GenerationMessage } from "./types";

interface ProviderImage {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface ProviderGenerationResponse {
  created?: number;
  data?: ProviderImage[];
  output_format?: string;
  quality?: string;
  size?: string;
  usage?: unknown;
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

export async function processGenerationMessage(message: GenerationMessage, env: Env): Promise<void> {
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
    const response = await requestGeneration(job, credential, apiKey, env);
    const images = response.data?.filter((item) => item.b64_json) ?? [];
    if (images.length === 0) {
      throw new ProviderError("empty_response", "模型服务没有返回图片。");
    }

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      if (!image.b64_json) continue;
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
    }

    await completeJob(
      env.DB,
      job.id,
      images.find((item) => item.revised_prompt)?.revised_prompt ?? null,
      response.usage ? JSON.stringify(response.usage) : null,
    );
  } catch (error) {
    const providerError = normalizeProviderError(error);
    await updateJobStatus(env.DB, job.id, "failed", providerError.code, providerError.message);
  }
}

async function requestGeneration(
  job: GenerationJobRecord,
  credential: CredentialRecord,
  apiKey: string,
  env: Env,
): Promise<ProviderGenerationResponse> {
  const endpoint = buildProviderEndpoint(credential.base_url, "/images/generations");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), Number(env.REQUEST_TIMEOUT_MS ?? 120000));
  try {
    const body: Record<string, unknown> = {
      model: job.model,
      prompt: job.prompt,
      n: job.quantity,
      size: `${job.width}x${job.height}`,
      quality: job.quality,
      output_format: job.output_format,
      background: job.background,
      moderation: job.moderation,
      user: job.space_id,
    };
    if (job.output_format !== "png" && job.compression !== null) {
      body.output_compression = job.compression;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await providerMessage(response);
      throw new ProviderError(
        providerErrorCode(response.status),
        text || `模型服务返回 ${response.status}。`,
        response.status === 429 || response.status >= 500,
      );
    }

    return (await response.json()) as ProviderGenerationResponse;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("provider_request_failed", redactSecrets(error instanceof Error ? error.message : "模型请求失败。"));
  } finally {
    clearTimeout(timer);
  }
}

function providerErrorCode(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected";
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
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("generation_failed", redactSecrets(error instanceof Error ? error.message : "生成失败。"));
}

function mimeFromFormat(format: string): string {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
  return "image/png";
}
