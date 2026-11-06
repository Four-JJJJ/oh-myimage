export interface AppConfig {
  model: string;
  modelOptions?: string[];
  models?: string[];
  promptOptimizerModel: string;
  maxImagesPerRequest: number;
  generationTimeoutSeconds: number;
  ratios: string[];
  qualities: string[];
  formats: string[];
  turnstileSiteKey: string;
  turnstileRequired: boolean;
}

export interface ProviderSettings {
  baseURL: string;
  model: string;
  apiKeyHint: string;
  lastTestOk: boolean;
  lastTestedAt: string | null;
}

export interface ImageProviderProfile extends ProviderSettings {
  id: string;
  name: string;
  models?: string[];
  modelSource?: "discovered" | "preset";
}

export interface SettingsProviders {
  imageProvider: ProviderSettings | null;
  imageProviders?: ImageProviderProfile[];
  activeImageProviderId?: string | null;
  promptProvider: ProviderSettings | null;
}

export interface ImageItem {
  id: string;
  jobId: string;
  url: string;
  width: number;
  height: number;
  format: string;
  byteSize?: number;
  thumbnailUrl?: string | null;
  createdAt: string;
  prompt?: string;
  quality?: string;
  aspectRatio?: string;
}

export function generatedImageDisplayUrl(image: Pick<ImageItem, "url" | "thumbnailUrl" | "format">): string {
  const format = image.format.trim().toLowerCase();
  return format === "gif" || format === "svg" ? image.url : image.thumbnailUrl ?? image.url;
}

export function supportsGeneratedImageEditing(image: Pick<ImageItem, "format">): boolean {
  return ["png", "jpeg", "webp"].includes(image.format.trim().toLowerCase());
}

export interface InspirationItem {
  id: string;
  sourceKey: string;
  sourceName: string;
  originalUrl: string;
  author: string | null;
  title: string | null;
  prompt: string;
  negativePrompt: string | null;
  thumbnailUrl: string | null;
  externalImageUrl: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: string | null;
  tags: string[];
  model: string | null;
  safety: string;
  useCount: number;
  importedAt: string;
  favorite: boolean;
}

export interface GenerationJob {
  id: string;
  conversation_id?: string | null;
  status: "queued" | "running" | "succeeded" | "partial_succeeded" | "failed" | "cancelled";
  stage?: "queued" | "submitting" | "waiting_provider" | "saving" | "completed" | "failed" | "cancelled" | null;
  progress_current?: number;
  progress_total?: number | null;
  prompt: string;
  model?: string;
  aspect_ratio: string;
  width: number;
  height: number;
  quality: string;
  quantity: number;
  output_format: string;
  background: string;
  compression: number | null;
  error_code: string | null;
  error_message: string | null;
  error_reason?: string | null;
  results?: GenerationJobResult[];
  referenceImages?: GenerationReferenceImage[];
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GenerationJobResult {
  index: number;
  status: "queued" | "running" | "succeeded" | "failed";
  imageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GenerationReferenceImage {
  name: string;
  mimeType: string;
  byteSize: number;
  role?: "source" | "reference";
  url: string;
}

export interface GenerationRecord {
  job: GenerationJob;
  images: ImageItem[];
  elapsedSeconds: number | null;
}

export interface GenerationStatusResponse {
  ok: true;
  job: GenerationJob;
  images: ImageItem[];
}

interface ApiResponse<T> {
  ok: boolean;
  error?: {
    code: string;
    message: string;
  };
  [key: string]: unknown;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
  });
  const json = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error?.message ?? `请求失败：${response.status}`);
  }
  return json as T;
}

/**
 * Read fresh generation state with a deadline. A stalled fetch must not hold a
 * polling loop's in-flight lock forever and prevent later status updates.
 */
export async function getGenerationStatus(jobId: string, timeoutMs = 12_000): Promise<GenerationStatusResponse> {
  let lastError: unknown;
  const deadline = Date.now() + Math.max(2, timeoutMs);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const remainingMs = Math.max(1, deadline - Date.now());
    const attemptTimeoutMs = attempt === 0 ? Math.max(1, Math.floor(remainingMs / 2)) : remainingMs;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("获取生成状态超时，系统会自动重试。"));
      }, attemptTimeoutMs);
    });
    try {
      return await Promise.race([
        api<GenerationStatusResponse>(`/api/generations/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      lastError = timedOut ? new Error("获取生成状态超时，系统会自动重试。") : error;
      if (!timedOut || attempt === 1) throw lastError;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  throw lastError;
}

export function generatedImageRetryUrl(rawUrl: string, retryKey: string | number): string {
  const url = new URL(rawUrl, "https://oh-myimage.invalid");
  url.searchParams.set("sw", "0");
  url.searchParams.set("retry", String(retryKey));
  return url.origin === "https://oh-myimage.invalid" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

export function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
