import type { AppConfig, GenerationJob, GenerationRecord, ImageItem } from "./api";

const previewStorageKey = "oh-myimage.preview";
const previewDemoImageUrl = "/demo-preview.png";
const previewDemoImageWidth = 936;
const previewDemoImageHeight = 1664;
const previewBaseGenerationDelayMs = 8000;
const previewPerImageDelayMs = 3000;
const previewMaxGenerationDelayMs = 120000;
const previewRatioSizes: Record<string, [number, number]> = {
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1536, 1152],
  "3:4": [1152, 1536],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "1:1": [1024, 1024],
};

const previewConfig: AppConfig = {
  model: "gpt-image-2",
  promptOptimizerModel: "gpt-5.5",
  maxImagesPerRequest: 4,
  maxDailyImagesPerSpace: 50,
  generationTimeoutSeconds: 600,
  ratios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"],
  qualities: ["auto", "low", "medium", "high"],
  formats: ["png", "jpeg", "webp"],
  turnstileSiteKey: "",
  turnstileRequired: false,
};

let previewInstalled = false;
let previewRecords: GenerationRecord[] | null = null;
let previewReadyAtByJobId: Record<string, number> = {};

export function installPreviewApi(): void {
  if (previewInstalled || !isLocalPreviewAllowed()) return;
  const mode = previewMode();
  if (!mode) return;

  previewInstalled = true;
  previewRecords = recordsForMode(mode);
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }

    return previewResponse(await handlePreviewApi(request, url));
  };
}

function isLocalPreviewAllowed(): boolean {
  return ["localhost", "127.0.0.1", "dev-gen.fourj.space"].includes(window.location.hostname);
}

function previewMode(): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("preview");
  if (value === "off") {
    window.localStorage.removeItem(previewStorageKey);
    return null;
  }
  if (value !== null) {
    const mode = value.trim() || "empty";
    window.localStorage.setItem(previewStorageKey, mode);
    return mode;
  }
  return window.localStorage.getItem(previewStorageKey) ?? (window.location.hostname === "dev-gen.fourj.space" ? "history" : null);
}

async function handlePreviewApi(request: Request, url: URL): Promise<unknown> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return { ok: true, config: previewConfig };
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    return {
      ok: true,
      space: { id: "preview_space", name: "Preview acceptance" },
      providerConfigured: true,
      dailyRemaining: 48,
      dailyLimit: 50,
    };
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return { ok: true };
  }

  if (request.method === "POST" && url.pathname === "/api/prompts/optimize") {
    const body = objectBody(await request.json().catch(() => ({})));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    return { ok: true, optimizedPrompt: prompt ? `${prompt}，高质量商业摄影，细节清晰，光影克制` : "" };
  }

  if (request.method === "GET" && url.pathname === "/api/generations") {
    return { ok: true, records: previewRecords ?? [], nextCursor: null };
  }

  const regenerateMatch = url.pathname.match(/^\/api\/generations\/([^/]+)\/regenerate$/);
  if (request.method === "POST" && regenerateMatch) {
    const source = (previewRecords ?? []).find((record) => record.job.id === regenerateMatch[1]);
    const record = createRecord(source?.job.prompt ?? "重新生成的预览任务", "running", undefined, undefined, settingsFromJob(source?.job));
    delayPreviewCompletion(record.job);
    previewRecords = [record, ...(previewRecords ?? [])];
    return { ok: true, jobId: record.job.id, status: "queued" };
  }

  if (request.method === "POST" && url.pathname === "/api/generations") {
    const input = await previewGenerationInputFromRequest(request);
    const record = createRecord(input.prompt || "本地预览生成任务", "running", undefined, undefined, input);
    delayPreviewCompletion(record.job);
    previewRecords = [record, ...(previewRecords ?? [])];
    return { ok: true, jobId: record.job.id, status: "queued" };
  }

  const generationMatch = url.pathname.match(/^\/api\/generations\/([^/]+)$/);
  if (request.method === "GET" && generationMatch) {
    const id = generationMatch[1];
    const records = previewRecords ?? [];
    const current = records.find((record) => record.job.id === id) ?? createRecord("本地预览生成任务", "succeeded", id);
    if (isPreviewWaiting(current)) {
      return { ok: true, job: current.job, images: current.images };
    }
    const completed = completeRecord(current);
    previewRecords = [completed, ...records.filter((record) => record.job.id !== id)];
    return { ok: true, job: completed.job, images: completed.images };
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/images/")) {
    return Response.redirect(previewDemoImageUrl, 302);
  }

  return { ok: false, error: { code: "preview_not_found", message: "预览接口未覆盖该请求。" } };
}

function delayPreviewCompletion(job: Pick<GenerationJob, "id" | "quantity">): void {
  previewReadyAtByJobId[job.id] = Date.now() + previewGenerationDelayMs(job.quantity);
}

function isPreviewWaiting(record: GenerationRecord): boolean {
  if (record.job.status !== "queued" && record.job.status !== "running") return false;
  const readyAt = previewReadyAtByJobId[record.job.id] ?? Date.now() + previewGenerationDelayMs(record.job.quantity);
  previewReadyAtByJobId[record.job.id] = readyAt;
  return Date.now() < readyAt;
}

export function previewGenerationDelayMs(quantity: number, search = typeof window === "undefined" ? "" : window.location.search): number {
  const params = new URLSearchParams(search);
  const override = toPreviewInt(params.get("previewDelayMs"), NaN);
  if (Number.isFinite(override) && override >= 0) {
    return Math.min(previewMaxGenerationDelayMs, override);
  }
  return Math.min(previewMaxGenerationDelayMs, previewBaseGenerationDelayMs + Math.max(1, quantity) * previewPerImageDelayMs);
}

export interface PreviewGenerationInput {
  prompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  quality: string;
  quantity: number;
  outputFormat: string;
}

export async function previewGenerationInputFromRequest(request: Request): Promise<PreviewGenerationInput> {
  const contentType = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown>;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    body = formDataObject(form);
  } else {
    body = objectBody(await request.json().catch(() => ({})));
  }
  return previewGenerationInputFromBody(body);
}

export function previewGenerationInputFromBody(body: Record<string, unknown>): PreviewGenerationInput {
  const aspectRatio = typeof body.aspectRatio === "string" && body.aspectRatio.trim() ? body.aspectRatio.trim() : "9:16";
  const ratioSize = previewRatioSizes[aspectRatio] ?? [previewDemoImageWidth, previewDemoImageHeight];
  const width = toPreviewInt(body.width, ratioSize[0]);
  const height = toPreviewInt(body.height, ratioSize[1]);
  return {
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    aspectRatio,
    width,
    height,
    quality: typeof body.quality === "string" && body.quality.trim() ? body.quality.trim() : "auto",
    quantity: clampPreviewQuantity(toPreviewInt(body.quantity, 1)),
    outputFormat: typeof body.outputFormat === "string" && body.outputFormat.trim() ? body.outputFormat.trim() : "png",
  };
}

function formDataObject(form: FormData | null): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!form) return body;
  for (const [key, value] of form.entries()) {
    if (value instanceof File) continue;
    body[key] = value;
  }
  return body;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toPreviewInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clampPreviewQuantity(value: number): number {
  return Math.min(4, Math.max(1, value));
}

function previewResponse(payload: unknown): Response {
  if (payload instanceof Response) return payload;
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status: typeof payload === "object" && payload && "ok" in payload && payload.ok === false ? 404 : 200,
  });
}

function recordsForMode(mode: string): GenerationRecord[] {
  if (mode === "empty") return [];
  if (mode === "generating") return [createRecord("一只在黑色摄影棚里发光的玻璃猫，产品海报风格", "running")];
  return [
    createRecord("一只在黑色摄影棚里发光的玻璃猫，产品海报风格", "succeeded"),
    createRecord("默认创作默认创作默认创作", "succeeded", "preview_job_older", "2026-06-12T10:20:00.000Z"),
  ];
}

function createRecord(
  prompt: string,
  status: GenerationJob["status"],
  id = `preview_job_${Date.now()}`,
  createdAt = new Date().toISOString(),
  input: Partial<PreviewGenerationInput> = {},
): GenerationRecord {
  const aspectRatio = input.aspectRatio ?? "9:16";
  const [fallbackWidth, fallbackHeight] = previewRatioSizes[aspectRatio] ?? [previewDemoImageWidth, previewDemoImageHeight];
  const width = input.width ?? fallbackWidth;
  const height = input.height ?? fallbackHeight;
  const quantity = clampPreviewQuantity(input.quantity ?? 1);
  const outputFormat = input.outputFormat ?? "png";
  const quality = input.quality ?? "auto";
  const job: GenerationJob = {
    id,
    status,
    stage: status === "running" ? "waiting_provider" : "completed",
    progress_current: status === "running" ? 0 : quantity,
    progress_total: quantity,
    prompt,
    aspect_ratio: aspectRatio,
    width,
    height,
    quality,
    quantity,
    output_format: outputFormat,
    background: "auto",
    compression: 100,
    error_code: null,
    error_message: null,
    created_at: createdAt,
    started_at: createdAt,
    completed_at: status === "running" ? null : createdAt,
  };
  return {
    job,
    images: status === "running" ? [] : previewImages(job, createdAt),
    elapsedSeconds: status === "running" ? null : 18.4,
  };
}

function completeRecord(record: GenerationRecord): GenerationRecord {
  if (record.job.status !== "queued" && record.job.status !== "running") return record;
  const completedAt = new Date().toISOString();
  return {
    job: {
      ...record.job,
      status: "succeeded",
      stage: "completed",
      progress_current: record.job.quantity,
      progress_total: record.job.quantity,
      completed_at: completedAt,
    },
    images: previewImages(record.job, completedAt),
    elapsedSeconds: 2.4,
  };
}

function settingsFromJob(job?: GenerationJob): Partial<PreviewGenerationInput> {
  if (!job) return {};
  return {
    aspectRatio: job.aspect_ratio,
    width: job.width,
    height: job.height,
    quality: job.quality,
    quantity: job.quantity,
    outputFormat: job.output_format,
  };
}

function previewImages(job: GenerationJob, createdAt: string): ImageItem[] {
  return Array.from({ length: Math.max(1, job.quantity) }, (_, index) => previewImage(job, index, createdAt));
}

function previewImage(job: GenerationJob, index: number, createdAt: string): ImageItem {
  return {
    id: `${job.id}_image_${index + 1}`,
    jobId: job.id,
    url: previewDemoImageUrl,
    width: job.width,
    height: job.height,
    format: job.output_format,
    createdAt,
    prompt: job.prompt,
    quality: job.quality,
    aspectRatio: job.aspect_ratio,
  };
}
