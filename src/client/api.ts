export interface AppConfig {
  model: string;
  promptOptimizerModel: string;
  maxImagesPerRequest: number;
  maxDailyImagesPerSpace: number;
  maxDailyJobsPerSpace?: number;
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
  promptOptimizerModel: string;
  apiKeyHint: string;
  lastTestOk: boolean;
  lastTestedAt: string | null;
}

export interface ImageItem {
  id: string;
  jobId: string;
  url: string;
  width: number;
  height: number;
  format: string;
  byteSize?: number;
  createdAt: string;
  prompt?: string;
  quality?: string;
  aspectRatio?: string;
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
  status: "queued" | "running" | "succeeded" | "partial_succeeded" | "failed" | "cancelled";
  prompt: string;
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
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GenerationRecord {
  job: GenerationJob;
  images: ImageItem[];
  elapsedSeconds: number | null;
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

export function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
