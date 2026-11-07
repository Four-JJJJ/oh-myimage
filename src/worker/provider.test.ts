import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { encryptSecret } from "./crypto";
import {
  buildImageGenerationFormData,
  buildImageGenerationPayload,
  describeProviderFetchFailure,
  extractResponsesOutputText,
  generatedThumbnailConfig,
  generationJobDeadlineMs,
  imageGenerationEndpointPath,
  promptOptimizationInput,
  providerResultCheckpointStorageKey,
  requestGenerationBatchWithRecovery,
  providerErrorCode,
  resolveProviderImageBinary,
  providerStatusMessage,
  providerErrorRetryable,
  resolveGenerationJobMaxRuntimeMs,
  resolvePromptOptimizerModel,
  resolveProviderImageConcurrency,
  normalizeProviderImageSize,
  resolveProviderTimeoutRetryDelayMs,
  resolveProviderTimeoutRetryAttempts,
  resolvePostCheckpointImageTimeoutMs,
  resolveImageBackground,
  resolveResponsesModel,
  recoverStoredImageForResult,
  processGenerationMessage,
  readProviderModelIds,
  testProvider,
  imageProviderModelCatalog,
  serializeProviderModelCatalog,
  selectImageProviderForModel,
  shouldPersistFailedResult,
  ProviderError,
} from "./provider";
import type { ImageProviderProfileRecord } from "./types";
import { OFFICIAL_IMAGE_MODEL_PRESETS } from "../image-models";

describe("official image model presets", () => {
  it.each(["https://api.xyaigc.xyz", "https://api.xyaigc.xyz/", "https://api.xyaigc.xyz/v1"])("tests the API path, not the HTML homepage, for %s", async (baseURL) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await testProvider(baseURL, "test-key")).toMatchObject({ ok: true, modelSource: "preset", models: [...OFFICIAL_IMAGE_MODEL_PRESETS] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.xyaigc.xyz/v1/models");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([200, 404, 405, 501])("offers unverified presets for an empty or unsupported list (%s)", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await testProvider("https://provider.example/v1", "test-key");
      expect(result).toMatchObject({ ok: true, status, models: [...OFFICIAL_IMAGE_MODEL_PRESETS], modelSource: "preset" });
      expect(result.message).toContain("尚未验证");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/models");
      const profile = providerProfile({ discovered_models_json: serializeProviderModelCatalog(result) });
      expect(imageProviderModelCatalog(profile)).toEqual({ models: [...OFFICIAL_IMAGE_MODEL_PRESETS], modelSource: "preset" });
      expect(selectImageProviderForModel([profile], "gemini-3.1-flash-image", "other")?.id).toBe(profile.id);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([401, 403, 429, 500])("does not mask provider errors with presets (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    try {
      expect(await testProvider("https://provider.example/v1", "test-key")).toMatchObject({ ok: false, status, models: [] });
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not mask invalid JSON or network failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("<html>not an API</html>"))
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (let i = 0; i < 2; i++) expect(await testProvider("https://provider.example/v1", "test-key")).toMatchObject({ ok: false, models: [] });
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports the underlying network cause when a connection test fails", async () => {
    const error = new TypeError("fetch failed");
    Object.assign(error, { cause: Object.assign(new Error("getaddrinfo ENOTFOUND provider.example"), { code: "ENOTFOUND" }) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    try {
      const result = await testProvider("https://provider.example/v1", "test-key");
      expect(result).toMatchObject({ ok: false, status: 0, models: [] });
      expect(result.message).toBe("连接模型服务失败：域名解析失败（ENOTFOUND），请检查 baseURL 和网络。");
    } finally { vi.unstubAllGlobals(); }
  });

  it("preserves discovered IDs and never supplies image presets to prompt tests", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "vendor-custom-image" }] })))
      .mockResolvedValueOnce(new Response("{}", { status: 404 })));
    try {
      expect(await testProvider("https://provider.example/v1", "test-key")).toMatchObject({ models: ["vendor-custom-image"], modelSource: "discovered" });
      expect(await testProvider("https://provider.example/v1", "test-key", 15000, false)).toMatchObject({ ok: false, models: [] });
      expect(imageProviderModelCatalog(providerProfile({ discovered_models_json: null })).models).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
});
import { AppDatabase, AppObjectStore, AppPreparedStatement, GenerationJobRecord } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image provider model routing", () => {
  it("reads OpenAI-style model catalogs and ignores unsupported ids", async () => {
    const response = new Response(JSON.stringify({
      data: [{ id: "gpt-4o" }, { id: "grok-imagine-image-2" }, { id: "gemini-3.1-flash-image" }],
    }));

    await expect(readProviderModelIds(response)).resolves.toEqual([
      "gpt-4o",
      "grok-imagine-image-2",
      "gemini-3.1-flash-image",
    ]);
  });

  it("routes a selected model to the provider that discovered it", () => {
    const openai = providerProfile({ id: "openai", discovered_models_json: JSON.stringify(["gpt-image-2"]) });
    const grok = providerProfile({ id: "grok", discovered_models_json: JSON.stringify(["grok-imagine-image-2.0"]) });

    expect(selectImageProviderForModel([openai, grok], "grok-imagine-image-2.0", "openai")?.id).toBe("grok");
    expect(selectImageProviderForModel([openai, grok], "gpt-image-2", "grok")?.id).toBe("openai");
  });

  it("keeps the active provider when nobody has discovered the model yet", () => {
    const active = providerProfile({ id: "active" });
    const other = providerProfile({ id: "other" });

    expect(selectImageProviderForModel([other, active], "gpt-image-2.5-flare", "active")?.id).toBe("active");
  });
});

function providerProfile(overrides: Partial<ImageProviderProfileRecord>): ImageProviderProfileRecord {
  return {
    id: "profile",
    space_id: "space_1",
    name: "Provider",
    base_url: "https://provider.example/v1",
    model: "gpt-image-2",
    encrypted_api_key: "encrypted",
    api_key_hint: "sk-t...key",
    last_test_ok: 1,
    last_tested_at: null,
    discovered_models_json: null,
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider generation batching", () => {
  it("defaults to two concurrent single-image provider requests", () => {
    expect(resolveProviderImageConcurrency(undefined)).toBe(2);
  });

  it("clamps provider image concurrency", () => {
    expect(resolveProviderImageConcurrency("0")).toBe(1);
    expect(resolveProviderImageConcurrency("2")).toBe(2);
    expect(resolveProviderImageConcurrency("2.8")).toBe(2);
    expect(resolveProviderImageConcurrency("10")).toBe(4);
  });

  it("does not retry chargeable provider timeouts unless explicitly enabled", () => {
    expect(resolveProviderTimeoutRetryAttempts(undefined)).toBe(0);
    expect(resolveProviderTimeoutRetryAttempts("1")).toBe(1);
    expect(resolveProviderTimeoutRetryAttempts("99")).toBe(4);
  });

  it("uses dense then sparse timeout recovery delays", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => resolveProviderTimeoutRetryDelayMs(attempt))).toEqual([
      5_000,
      10_000,
      20_000,
      30_000,
      60_000,
      60_000,
      60_000,
      60_000,
    ]);
  });

  it("uses a bounded job-level runtime budget for multi-image generation", () => {
    expect(resolveGenerationJobMaxRuntimeMs(undefined)).toBe(14 * 60 * 1000);
    expect(resolveGenerationJobMaxRuntimeMs("300000")).toBe(300_000);
    expect(resolveGenerationJobMaxRuntimeMs("1000")).toBe(60_000);
    expect(resolveGenerationJobMaxRuntimeMs("99999999")).toBe(14 * 60 * 1000);
  });

  it("reuses the persisted first start time across queue deliveries", () => {
    const firstStart = Date.parse("2026-08-02T11:09:31.000Z");
    const laterDelivery = Date.parse("2026-08-02T11:18:35.000Z");

    expect(generationJobDeadlineMs({ started_at: "2026-08-02 11:09:31" }, 14 * 60 * 1000, laterDelivery)).toBe(
      firstStart + 14 * 60 * 1000,
    );
    expect(generationJobDeadlineMs({ started_at: null }, 14 * 60 * 1000, laterDelivery)).toBe(
      laterDelivery + 14 * 60 * 1000,
    );
  });

  it("keeps a download budget after the job runtime is exhausted", () => {
    expect(resolvePostCheckpointImageTimeoutMs(240_000, 600_000)).toBe(240_000);
    expect(resolvePostCheckpointImageTimeoutMs(500, 600_000)).toBe(60_000);
    expect(resolvePostCheckpointImageTimeoutMs(-120_000, 600_000)).toBe(60_000);
    expect(resolvePostCheckpointImageTimeoutMs(-120_000, 10_000)).toBe(10_000);
  });
});

describe("provider error normalization", () => {
  it("maps Cloudflare timeout statuses to provider timeouts", () => {
    expect(providerErrorCode(522)).toBe("provider_timeout");
    expect(providerErrorCode(524)).toBe("provider_timeout");
  });

  it("does not surface raw Cloudflare 524 body text to users", () => {
    expect(providerStatusMessage(524, "error code: 524", 600_000)).toBe(
      "模型服务返回 524，上游网关等待模型服务超时。当前 Worker 已允许最长等待 10 分钟；如果单次生图经常超过 120 秒，请将 baseURL 指向 DNS-only/直连源站域名，或把上游接口改成异步任务/轮询模式。",
    );
  });

  it("classifies auth, balance, content, timeout, and upstream errors separately", () => {
    expect(providerErrorCode(401, "invalid api key")).toBe("provider_auth_failed");
    expect(providerErrorCode(402, "insufficient balance")).toBe("provider_balance_insufficient");
    expect(providerErrorCode(400, "content_policy_violation")).toBe("provider_content_rejected");
    expect(providerErrorCode(504, "gateway timeout")).toBe("provider_timeout");
    expect(providerErrorCode(503, "upstream overloaded")).toBe("provider_upstream_error");

    expect(providerErrorRetryable("provider_auth_failed", 401)).toBe(false);
    expect(providerErrorRetryable("provider_balance_insufficient", 402)).toBe(false);
    expect(providerErrorRetryable("provider_content_rejected", 400)).toBe(false);
    expect(providerErrorRetryable("provider_timeout", 504)).toBe(true);
    expect(providerErrorRetryable("provider_upstream_error", 503)).toBe(true);
  });

  it("extracts the undici network cause behind fetch failed", () => {
    const error = new TypeError("fetch failed");
    Object.assign(error, { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

    expect(describeProviderFetchFailure(error)).toEqual({
      code: "ECONNRESET",
      reason: "连接被重置（ECONNRESET）",
      retryable: true,
    });
  });

  it("does not retry certificate failures that need configuration changes", () => {
    const error = new TypeError("fetch failed");
    Object.assign(error, { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) });

    expect(describeProviderFetchFailure(error)).toMatchObject({ code: "CERT_HAS_EXPIRED", retryable: false });
  });

  it("ignores non-network request errors", () => {
    expect(describeProviderFetchFailure(new SyntaxError("Unexpected token < in JSON"))).toBeNull();
  });
});

describe("provider image size normalization", () => {
  it("keeps matching images byte-for-byte without re-encoding", async () => {
    const bytes = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).png().toBuffer();
    const binary = { bytes: new Uint8Array(bytes), format: "png", mimeType: "image/png" };

    const normalized = await normalizeProviderImageSize({ width: 64, height: 48, compression: null }, binary);

    expect(normalized.bytes).toBe(binary.bytes);
  });

  it.each([
    { format: "gif", mimeType: "image/gif", body: "GIF89a" },
    { format: "svg", mimeType: "image/svg+xml", body: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" },
  ])("preserves $format bytes instead of rasterizing them during size normalization", async ({ format, mimeType, body }) => {
    const binary = { bytes: new TextEncoder().encode(body), format, mimeType };

    const normalized = await normalizeProviderImageSize({ width: 1280, height: 768, compression: null }, binary);

    expect(normalized).toBe(binary);
    expect(new TextDecoder().decode(normalized.bytes)).toBe(body);
  });

  it("crops and resizes a mismatched upstream canvas to the exact requested pixels", async () => {
    const bytes = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 60, g: 40, b: 20 } },
    }).png().toBuffer();

    const normalized = await normalizeProviderImageSize(
      { width: 1280, height: 768, compression: null },
      { bytes: new Uint8Array(bytes), format: "png", mimeType: "image/png" },
    );

    const metadata = await sharp(normalized.bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual([1280, 768]);
    expect(normalized.format).toBe("png");
    expect(normalized.mimeType).toBe("image/png");
  });
});

describe("provider save recovery", () => {
  it.each(["base64", "url"])("rejects PNG returned for a GIF request via %s without retrying generation", async (transport) => {
    const encryptionKey = "test-encryption-key-123";
    const job = makeJob({ model: "gpt-image-2.6", output_format: "gif" });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(init.body as string);
        expect(payload.output_format).toBe("gif");
        expect(payload.prompt).toContain("animated GIF with multiple frames");
        return Response.json({ data: [transport === "base64"
          ? { b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }
          : { url: "https://img.example.com/result.gif" }] });
      }
      return new Response(PNG_SIGNATURE, { headers: { "Content-Type": "image/gif" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGenerationMessage({ jobId: job.id, spaceId: job.space_id }, {
      APP_ENCRYPTION_KEY: encryptionKey, DB: db, IMAGES: images, REQUEST_TIMEOUT_MS: "600000",
    } as never, { retryProviderErrors: true, retryPostProcessingErrors: true });

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(db.completedJob).toBeNull();
    expect(db.jobStatusUpdates.at(-1)).toMatchObject({ status: "failed", errorCode: "provider_image_format_mismatch" });
    expect(db.jobStatusUpdates.at(-1)?.errorMessage).toContain("实际返回了 PNG");
    expect(db.imageAssets).toHaveLength(0);
    expect([...images.objects.keys()].filter((key) => !key.endsWith(".json"))).toEqual([]);
  });

  it("does not recover a mismatched PNG as a successful GIF result", async () => {
    const db = new RecordingDatabase();
    const images = new MemoryObjectStore({ "space_1/job_1/img_job_1_0.png": PNG_SIGNATURE.buffer });

    await expect(recoverStoredImageForResult(makeJob({ output_format: "gif" }), 0, { DB: db, IMAGES: images } as never))
      .rejects.toMatchObject({ code: "provider_image_format_mismatch", retryable: false });
    expect(db.queries.join("\n")).not.toContain("INSERT INTO image_assets");
  });

  it("recovers an already stored image object without requesting the provider again", async () => {
    const db = new RecordingDatabase();
    const images = new MemoryObjectStore({
      "space_1/job_1/img_job_1_0.png": PNG_SIGNATURE.buffer as ArrayBuffer,
    });

    const recovered = await recoverStoredImageForResult(makeJob(), 0, { DB: db, IMAGES: images } as never);

    expect(recovered?.imageId).toBe("img_job_1_0");
    expect(db.queries.join("\n")).toContain("INSERT INTO image_assets");
    expect(images.getCalls).toEqual(["space_1/job_1/img_job_1_0.png"]);
  });

  it("recovers a stored image whose actual format differs from the requested format", async () => {
    const db = new RecordingDatabase();
    const images = new MemoryObjectStore({
      "space_1/job_1/img_job_1_0.png": PNG_SIGNATURE.buffer,
    });

    const recovered = await recoverStoredImageForResult(makeJob({ output_format: "jpeg" }), 0, { DB: db, IMAGES: images } as never);

    expect(recovered?.imageId).toBe("img_job_1_0");
    expect(images.getCalls).toEqual([
      "space_1/job_1/img_job_1_0.jpeg",
      "space_1/job_1/img_job_1_0.png",
    ]);
  });

  it.each(["gif", "svg"])("stores %s originals without a static thumbnail or re-encoding", async (format) => {
    const encryptionKey = "test-encryption-key-123";
    const job = makeJob({ output_format: format });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const providerImageBytes = format === "gif"
      ? await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 40, b: 60 } } }).gif().toBuffer()
      : Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"48\"><rect width=\"64\" height=\"48\" fill=\"#123456\"/></svg>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: providerImageBytes.toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    await processGenerationMessage({ jobId: job.id, spaceId: job.space_id }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    const storageKey = `space_1/${job.id}/img_${job.id}_0.${format}`;
    expect(Array.from(images.objects.keys())).toEqual([storageKey]);
    expect(new Uint8Array(images.objects.get(storageKey)!)).toEqual(new Uint8Array(providerImageBytes));
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
    expect(db.imageAssets[0]).toMatchObject({ thumbnail_storage_key: null, thumbnail_mime_type: null });
  });

  it("stores a generated thumbnail alongside the original image asset", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const providerImageBytes = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 245, g: 120, b: 40 },
      },
    })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: providerImageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await processGenerationMessage({ jobId: "job_1", spaceId: "space_1" }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    expect(Array.from(images.objects.keys())).toEqual(["space_1/job_1/img_job_1_0.png", "space_1/job_1/thumb_img_job_1_0.webp"]);
    const originalBytes = images.objects.get("space_1/job_1/img_job_1_0.png");
    const thumbnailBytes = images.objects.get("space_1/job_1/thumb_img_job_1_0.webp");
    expect(thumbnailBytes?.byteLength).toBeGreaterThan(0);
    expect(thumbnailBytes!.byteLength).toBeLessThan(originalBytes!.byteLength);
    expect(db.imageAssets[0]).toMatchObject({
      id: "img_job_1_0",
      thumbnail_storage_key: "space_1/job_1/thumb_img_job_1_0.webp",
      thumbnail_mime_type: "image/webp",
      thumbnail_byte_size: expect.any(Number),
      thumbnail_sha256: expect.any(String),
    });
    expect(db.imageAssets[0]?.thumbnail_byte_size).toBe(thumbnailBytes?.byteLength);
    expect(generatedThumbnailConfig()).toMatchObject({ maxEdgePx: 512, mimeType: "image/webp" });
  });

  it("stores the exact custom dimensions when the provider returns a different canvas", async () => {
    const encryptionKey = "test-encryption-key-123";
    const job = makeJob({ aspect_ratio: "custom", width: 1280, height: 768 });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const providerImageBytes = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 120, g: 80, b: 40 } },
    }).png().toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: providerImageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await processGenerationMessage({ jobId: job.id, spaceId: job.space_id }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    const stored = images.objects.get(`space_1/${job.id}/img_${job.id}_0.png`);
    expect(stored).toBeDefined();
    const metadata = await sharp(stored).metadata();
    expect([metadata.width, metadata.height]).toEqual([1280, 768]);
    expect(db.imageAssets[0]).toMatchObject({ width: 1280, height: 768 });
  });

  it("keeps the original image when optional thumbnail upload fails", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore({ failKeys: new Set(["space_1/job_1/thumb_img_job_1_0.webp"]) });
    const providerImageBytes = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 40, g: 120, b: 245 },
      },
    })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: providerImageBytes.toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await processGenerationMessage({ jobId: "job_1", spaceId: "space_1" }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    expect(Array.from(images.objects.keys())).toEqual(["space_1/job_1/img_job_1_0.png"]);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
    expect(db.imageAssets[0]).toMatchObject({
      id: "img_job_1_0",
      thumbnail_storage_key: null,
      thumbnail_mime_type: null,
      thumbnail_byte_size: null,
      thumbnail_sha256: null,
    });
  });

  it("retries the same image bytes after a transient storage failure without calling the provider again", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    const originalKey = "space_1/job_1/img_job_1_0.png";
    const images = new WritableMemoryObjectStore({ failAttemptsByKey: new Map([[originalKey, 1]]) });
    vi.spyOn(globalThis, "setTimeout").mockImplementation((((fn: (...args: never[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown) as typeof setTimeout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await processGenerationMessage({ jobId: "job_1", spaceId: "space_1" }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(images.putCalls.filter((key) => key === originalKey).length).toBeGreaterThanOrEqual(2);
    expect(images.objects.has(originalKey)).toBe(true);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("recovers the actual PNG object after a JPEG request and transient DB failure without another provider POST", async () => {
    const encryptionKey = "test-encryption-key-123";
    const job = makeJob({ output_format: "jpeg" });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey), { failImageAssetAttempts: 1 });
    const images = new WritableMemoryObjectStore();
    let providerPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") providerPosts += 1;
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(
      processGenerationMessage(
        { jobId: "job_1", spaceId: "space_1" },
        {
          APP_ENCRYPTION_KEY: encryptionKey,
          DB: db,
          IMAGES: images,
          REQUEST_TIMEOUT_MS: "600000",
        } as never,
        { retryPostProcessingErrors: true },
      ),
    ).rejects.toMatchObject({ code: "image_asset_persist_failed", retryScope: "post_processing" });

    const checkpointKey = providerResultCheckpointStorageKey(job, 0);
    const checkpoint = JSON.parse(new TextDecoder().decode(images.objects.get(checkpointKey)!)) as {
      image?: { b64_json?: string };
      storedImage?: { storageKey?: string };
    };
    expect(images.objects.has("space_1/job_1/img_job_1_0.png")).toBe(true);
    expect(images.objects.has(checkpointKey)).toBe(true);
    expect(checkpoint.image?.b64_json).toBeUndefined();
    expect(checkpoint.storedImage?.storageKey).toBe("space_1/job_1/img_job_1_0.png");

    await processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        APP_ENCRYPTION_KEY: encryptionKey,
        DB: db,
        IMAGES: images,
        REQUEST_TIMEOUT_MS: "600000",
      } as never,
      { retryPostProcessingErrors: true },
    );

    expect(providerPosts).toBe(1);
    expect(images.objects.has(checkpointKey)).toBe(false);
    expect(db.imageAssets).toEqual([expect.objectContaining({ id: "img_job_1_0" })]);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("keeps a transient fetch failure retryable instead of failing the job on the first attempt", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(
      processGenerationMessage(
        { jobId: "job_1", spaceId: "space_1" },
        {
          APP_ENCRYPTION_KEY: encryptionKey,
          DB: db,
          IMAGES: new WritableMemoryObjectStore(),
          REQUEST_TIMEOUT_MS: "600000",
        } as never,
        { retryProviderErrors: true },
      ),
    ).rejects.toMatchObject({ code: "provider_request_failed", retryable: true });
    expect(db.completedJob).toBeNull();
    expect(db.jobStatusUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "running", errorCode: "provider_request_failed", stage: "waiting_provider" }),
    ]));
  });

  it("completes the same job after a queue-level retry when the network recovers", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    let providerPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        providerPosts += 1;
        if (providerPosts === 1) {
          const error = new TypeError("fetch failed");
          Object.assign(error, { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
          throw error;
        }
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(
      processGenerationMessage(
        { jobId: "job_1", spaceId: "space_1" },
        {
          APP_ENCRYPTION_KEY: encryptionKey,
          DB: db,
          IMAGES: images,
          REQUEST_TIMEOUT_MS: "600000",
        } as never,
        { retryProviderErrors: true },
      ),
    ).rejects.toMatchObject({ code: "provider_request_failed", retryable: true });

    await processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        APP_ENCRYPTION_KEY: encryptionKey,
        DB: db,
        IMAGES: images,
        REQUEST_TIMEOUT_MS: "600000",
      } as never,
    );

    expect(providerPosts).toBe(2);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
  });
});

describe("provider image result compatibility", () => {
  it("marks timed-out multi-image slots as failed and keeps full timeout per provider request", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob({ quantity: 4 }), await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const fetchCalls: Array<{ body: ImageGenerationRequestBody; signal?: AbortSignal }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: never[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal ?? undefined;
        fetchCalls.push({ body: JSON.parse(String(init?.body ?? "{}")) as ImageGenerationRequestBody, signal });
        if (fetchCalls.length <= 2) {
          return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        signal?.throwIfAborted();
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        DB: db,
        IMAGES: images,
        APP_ENCRYPTION_KEY: encryptionKey,
        REQUEST_TIMEOUT_MS: "600000",
        PROVIDER_IMAGE_CONCURRENCY: "1",
        PROVIDER_TIMEOUT_RETRY_ATTEMPTS: "0",
      } as never,
    );

    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls.map((call) => call.body.n)).toEqual([1, 1, 1, 1]);
    expect(db.completedJob).toMatchObject({
      status: "partial_succeeded",
      errorCode: "provider_timeout",
    });
    expect(db.results.map((result) => `${result.result_index}:${result.status}:${result.error_code ?? ""}`)).toEqual([
      "0:succeeded:",
      "1:succeeded:",
      "2:failed:provider_timeout",
      "3:failed:provider_timeout",
    ]);
    expect(db.imageAssets.map((image) => image.id)).toEqual(["img_job_1_0", "img_job_1_1"]);
  });

  it("downloads URL-style image results and preserves the actual image format", async () => {
    const bytes = PNG_SIGNATURE;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );

    const result = await resolveProviderImageBinary(
      { url: "https://img.sulmes.com/images/example.png" },
      "jpeg",
      10_000,
    );

    expect(result.bytes).toEqual(bytes);
    expect(result.format).toBe("png");
    expect(result.mimeType).toBe("image/png");
    expect(fetch).toHaveBeenCalledWith(
      "https://img.sulmes.com/images/example.png",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "image/*",
          "User-Agent": "oh-myimage/1.0",
        }),
      }),
    );
  });

  it("accepts generic binary content types and keeps the image file signature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(PNG_SIGNATURE, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );

    const result = await resolveProviderImageBinary({ url: "https://img.example.com/final.bin" }, "jpeg", 10_000);

    expect(result.bytes).toEqual(PNG_SIGNATURE);
    expect(result.format).toBe("png");
    expect(result.mimeType).toBe("image/png");
  });

  it("retries a transient URL download failure and stores the returned image", async () => {
    const bytes = PNG_SIGNATURE;
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(bytes, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        ),
    );

    const resultPromise = resolveProviderImageBinary({ url: "https://img.example.com/final.png" }, "png", 10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.bytes).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a provider image URL while the generated file is not available yet", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
        .mockResolvedValueOnce(new Response(PNG_SIGNATURE, { status: 200, headers: { "Content-Type": "image/png" } })),
    );

    const resultPromise = resolveProviderImageBinary({ url: "https://img.example.com/final.png" }, "png", 10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.bytes).toEqual(PNG_SIGNATURE);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses provider authorization only for same-origin image downloads", async () => {
    const authorizationHeaders: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        authorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
        return new Response(PNG_SIGNATURE, { status: 200, headers: { "Content-Type": "image/png" } });
      }),
    );

    const options = { providerBaseURL: "https://api.example.com/v1", apiKey: "provider-secret" };
    await resolveProviderImageBinary({ url: "https://api.example.com/v1/files/final.png" }, "png", 10_000, options);
    await resolveProviderImageBinary({ url: "https://cdn.example.com/files/final.png" }, "png", 10_000, options);

    expect(authorizationHeaders).toEqual(["Bearer provider-secret", null]);
  });

  it("retries retryable image URL status codes but keeps the retry count bounded", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("temporarily unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );

    const resultPromise = resolveProviderImageBinary({ url: "https://img.example.com/final.png" }, "png", 10_000);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "provider_image_download_failed",
      retryable: true,
      retryScope: "post_processing",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers the same checkpointed provider URL on a later queue delivery without re-submitting generation", async () => {
    const encryptionKey = "test-encryption-key-123";
    const db = new GenerationFlowDatabase(makeJob(), await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    let providerPosts = 0;
    let imageDownloads = 0;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: never[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          providerPosts += 1;
          return new Response(JSON.stringify({ data: [{ url: "https://img.example.com/final.png" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        imageDownloads += 1;
        if (imageDownloads <= 5) {
          return new Response("temporarily unavailable", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
        return new Response(PNG_SIGNATURE, { status: 200, headers: { "Content-Type": "image/png" } });
      }),
    );

    const firstAttempt = processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        APP_ENCRYPTION_KEY: encryptionKey,
        DB: db,
        IMAGES: images,
        REQUEST_TIMEOUT_MS: "10000",
      } as never,
      { retryPostProcessingErrors: true },
    );
    const firstRejection = expect(firstAttempt).rejects.toMatchObject({
      code: "provider_image_download_failed",
      retryable: true,
      retryScope: "post_processing",
    });
    await firstRejection;

    const checkpointKey = providerResultCheckpointStorageKey(makeJob(), 0);
    expect(images.objects.has(checkpointKey)).toBe(true);

    await processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        APP_ENCRYPTION_KEY: encryptionKey,
        DB: db,
        IMAGES: images,
        REQUEST_TIMEOUT_MS: "10000",
      } as never,
      { retryPostProcessingErrors: true },
    );

    expect(providerPosts).toBe(1);
    expect(imageDownloads).toBe(6);
    expect(db.results).toEqual([expect.objectContaining({ result_index: 0, status: "succeeded", error_code: null })]);
    expect(images.objects.has("space_1/job_1/img_job_1_0.png")).toBe(true);
    expect(images.objects.has(checkpointKey)).toBe(false);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("downloads a checkpointed provider URL after the job runtime budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T11:20:00.000Z"));
    const encryptionKey = "test-encryption-key-123";
    const job = makeJob({ started_at: "2026-08-02 11:00:00" });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    const checkpointKey = providerResultCheckpointStorageKey(job, 0);
    await images.put(
      checkpointKey,
      JSON.stringify({
        version: 1,
        acceptedAt: "2026-08-02T11:13:00.000Z",
        image: { url: "https://img.example.com/final.png" },
        revisedPrompt: null,
      }),
    );
    let providerPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          providerPosts += 1;
          throw new Error("should not submit generation again");
        }
        return new Response(PNG_SIGNATURE, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    await processGenerationMessage(
      { jobId: "job_1", spaceId: "space_1" },
      {
        APP_ENCRYPTION_KEY: encryptionKey,
        DB: db,
        IMAGES: images,
        REQUEST_TIMEOUT_MS: "10000",
        GENERATION_JOB_MAX_RUNTIME_MS: "840000",
      } as never,
      { retryPostProcessingErrors: true },
    );

    expect(providerPosts).toBe(0);
    expect(images.objects.has("space_1/job_1/img_job_1_0.png")).toBe(true);
    expect(images.objects.has(checkpointKey)).toBe(false);
    expect(db.completedJob).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("downloads provider images over http when the provider returns an http URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(PNG_SIGNATURE, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );

    const result = await resolveProviderImageBinary({ url: "http://img.example.com/final.png" }, "png", 10_000);

    expect(result.bytes).toEqual(PNG_SIGNATURE);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://img.example.com/final.png", expect.anything());
  });

  it("rejects provider image URLs that are not http or https before fetching", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(resolveProviderImageBinary({ url: "ftp://img.example.com/final.png" }, "png", 10_000)).rejects.toMatchObject({
      code: "provider_image_download_blocked",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects private provider image URL hosts before fetching", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(resolveProviderImageBinary({ url: "https://127.0.0.1/final.png" }, "png", 10_000)).rejects.toMatchObject({
      code: "provider_image_download_blocked",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries html error pages returned instead of the generated image", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>not an image</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );

    const resultPromise = resolveProviderImageBinary({ url: "https://img.example.com/final.png" }, "png", 10_000);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "provider_image_download_failed",
      retryable: true,
      retryScope: "post_processing",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { body: "GIF89a", contentType: "image/gif", filename: "final.gif", format: "gif" },
    { body: "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>", contentType: "image/svg+xml", filename: "final.svg", format: "svg" },
  ])("accepts $format image downloads and preserves their actual MIME type", async ({ body, contentType, filename, format }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": contentType } })),
    );

    const result = await resolveProviderImageBinary({ url: `https://img.example.com/${filename}` }, "png", 10_000);

    expect(result.format).toBe(format);
    expect(result.mimeType).toBe(contentType);
    expect(new TextDecoder().decode(result.bytes)).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported image content types without retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-an-avif", {
          status: 200,
          headers: { "Content-Type": "image/avif" },
        }),
      ),
    );

    await expect(resolveProviderImageBinary({ url: "https://img.example.com/final.avif" }, "png", 10_000)).rejects.toMatchObject({
      code: "provider_image_download_invalid_content_type",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects provider image downloads that declare excessive content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("tiny", {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": String(26 * 1024 * 1024) },
        }),
      ),
    );

    await expect(resolveProviderImageBinary({ url: "https://img.example.com/final.png" }, "png", 10_000)).rejects.toMatchObject({
      code: "provider_image_download_too_large",
    });
  });

  it("rejects invalid base64 image bytes before storing them", async () => {
    await expect(resolveProviderImageBinary({ b64_json: "AQID" }, "png", 10_000)).rejects.toMatchObject({
      code: "provider_image_invalid_data",
      retryable: false,
    });
  });

  it("does not retry timed out generation requests when immediate retries are disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html><head><title>504 Gateway Time-out</title></head></html>", {
            status: 504,
            headers: { "Content-Type": "text/html" },
          }),
        ),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((((fn: (...args: never[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown) as typeof setTimeout);

    await expect(
      requestGenerationBatchWithRecovery(
        makeJob(),
        {
          id: "cred_1",
          space_id: "space_1",
          base_url: "https://image.example.com/v1",
          model: "gpt-image-2",
          prompt_optimizer_model: "gpt-5.5",
          encrypted_api_key: "encrypted",
          api_key_hint: "sk-...test",
          last_test_ok: 1,
          last_tested_at: "2026-05-15T00:00:00.000Z",
          prompt_base_url: null,
          prompt_encrypted_api_key: null,
          prompt_api_key_hint: null,
          prompt_last_test_ok: 0,
          prompt_last_tested_at: null,
          created_at: "2026-05-15T00:00:00.000Z",
          updated_at: "2026-05-15T00:00:00.000Z",
        },
        "test-key",
        600_000,
        {
          DB: new RecordingDatabase(),
          IMAGES: new MemoryObjectStore({}),
          PROVIDER_TIMEOUT_RETRY_ATTEMPTS: "0",
        } as never,
        "idem-1",
      ),
    ).rejects.toMatchObject({ code: "provider_timeout" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const firstHeaders = vi.mocked(fetch).mock.calls[0]?.[1] ? new Headers((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).headers) : null;
    expect(firstHeaders?.get("Idempotency-Key")).toBe("idem-1");
  });

  it("turns transient fetch failures into retryable provider errors with a useful message", async () => {
    const error = new TypeError("fetch failed");
    Object.assign(error, { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(
      requestGenerationBatchWithRecovery(
        makeJob(),
        {
          id: "cred_1",
          space_id: "space_1",
          base_url: "https://image.example.com/v1",
          model: "gpt-image-2",
          prompt_optimizer_model: "gpt-5.5",
          encrypted_api_key: "encrypted",
          api_key_hint: "sk-...test",
          last_test_ok: 1,
          last_tested_at: "2026-05-15T00:00:00.000Z",
          prompt_base_url: null,
          prompt_encrypted_api_key: null,
          prompt_api_key_hint: null,
          prompt_last_test_ok: 0,
          prompt_last_tested_at: null,
          created_at: "2026-05-15T00:00:00.000Z",
          updated_at: "2026-05-15T00:00:00.000Z",
        },
        "test-key",
        600_000,
        {
          DB: new RecordingDatabase(),
          IMAGES: new MemoryObjectStore({}),
          PROVIDER_TIMEOUT_RETRY_ATTEMPTS: "0",
        } as never,
        "idem-1",
      ),
    ).rejects.toMatchObject({
      code: "provider_request_failed",
      retryable: true,
      message: "无法连接模型服务：连接被重置（ECONNRESET），请稍后重试。",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries timed out generation requests when explicitly enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html><head><title>504 Gateway Time-out</title></head></html>", {
            status: 504,
            headers: { "Content-Type": "text/html" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("<html><head><title>504 Gateway Time-out</title></head></html>", {
            status: 504,
            headers: { "Content-Type": "text/html" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [{ url: "https://img.example.com/final.png" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((((fn: (...args: never[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown) as typeof setTimeout);

    const response = await requestGenerationBatchWithRecovery(
      makeJob(),
      {
        id: "cred_1",
        space_id: "space_1",
        base_url: "https://image.example.com/v1",
        model: "gpt-image-2",
        prompt_optimizer_model: "gpt-5.5",
        encrypted_api_key: "encrypted",
        api_key_hint: "sk-...test",
        last_test_ok: 1,
        last_tested_at: "2026-05-15T00:00:00.000Z",
        prompt_base_url: null,
        prompt_encrypted_api_key: null,
        prompt_api_key_hint: null,
        prompt_last_test_ok: 0,
        prompt_last_tested_at: null,
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
      },
      "test-key",
      600_000,
      {
        DB: new RecordingDatabase(),
        IMAGES: new MemoryObjectStore({}),
        PROVIDER_TIMEOUT_RETRY_ATTEMPTS: "2",
      } as never,
      "idem-1",
    );

    expect(response.data?.[0]?.url).toBe("https://img.example.com/final.png");
    expect(fetch).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[0]).toBe("https://image.example.com/v1/images/generations");
    expect(calls[1]?.[0]).toBe("https://image.example.com/v1/images/generations");
    expect(calls[2]?.[0]).toBe("https://image.example.com/v1/images/generations");
    const firstHeaders = calls[0]?.[1] ? new Headers((calls[0][1] as RequestInit).headers) : null;
    const secondHeaders = calls[1]?.[1] ? new Headers((calls[1][1] as RequestInit).headers) : null;
    const thirdHeaders = calls[2]?.[1] ? new Headers((calls[2][1] as RequestInit).headers) : null;
    expect(firstHeaders?.get("Idempotency-Key")).toBe("idem-1");
    expect(secondHeaders?.get("Idempotency-Key")).toBe("idem-1");
    expect(thirdHeaders?.get("Idempotency-Key")).toBe("idem-1");
  });

  it("keeps retryable provider timeouts out of the failed slot state", () => {
    expect(shouldPersistFailedResult(new ProviderError("provider_timeout", "timeout", true))).toBe(false);
    expect(shouldPersistFailedResult(new ProviderError("provider_upstream_error", "bad gateway", true))).toBe(false);
    expect(shouldPersistFailedResult(new ProviderError("provider_content_rejected", "blocked", false))).toBe(true);
  });
});

describe("prompt optimizer provider helpers", () => {
  it("defaults to gpt-5.5", () => {
    expect(resolvePromptOptimizerModel(undefined)).toBe("gpt-5.5");
    expect(resolvePromptOptimizerModel("")).toBe("gpt-5.5");
  });

  it("uses configured prompt optimizer model", () => {
    expect(resolvePromptOptimizerModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("falls back when prompt optimizer model is unsupported", () => {
    expect(resolvePromptOptimizerModel("gpt-5.5-mini")).toBe("gpt-5.5");
  });

  it("maps image-only models to a Responses-capable model", () => {
    expect(resolveResponsesModel("image-2", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveResponsesModel("gpt-image-2.5-flare", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveResponsesModel("gpt-image-2.5-sunburst", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveResponsesModel("gpt-image-2", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveResponsesModel("gpt-image-2", "gpt-image-1")).toBe("gpt-5.5");
    expect(resolveResponsesModel("gpt-5.4-mini", "gpt-5.5")).toBe("gpt-5.4-mini");
  });

  it("extracts text from output_text", () => {
    expect(extractResponsesOutputText({ output_text: "optimized prompt" })).toBe("optimized prompt");
  });

  it("extracts nested output text content", () => {
    expect(
      extractResponsesOutputText({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "first line" },
              { type: "output_text", text: "second line" },
            ],
          },
        ],
      }),
    ).toBe("first line\nsecond line");
  });

  it("tells the optimizer when numbered reference images are present", () => {
    const input = promptOptimizationInput({
      prompt: "保留第一个图的基本形状，参考第二个图的风格",
      aspectRatio: "16:9",
      width: 1536,
      height: 864,
      quality: "auto",
      outputFormat: "png",
      background: "auto",
      referenceImageCount: 2,
      hasSourceImage: true,
      hasMaskImage: false,
    });

    expect(input).toContain("参考图数量：2");
    expect(input).toContain("第1张图是当前编辑目标");
  });

  it("tells the optimizer when the request is a masked local edit", () => {
    const input = promptOptimizationInput({
      prompt: "把选区改成玻璃材质",
      aspectRatio: "1:1",
      width: 1024,
      height: 1024,
      quality: "high",
      outputFormat: "png",
      background: "auto",
      referenceImageCount: 1,
      hasSourceImage: true,
      hasMaskImage: true,
    });

    expect(input).toContain("是否为局部重绘：是");
    expect(input).toContain("只改遮罩选区");
  });
});

describe("Image API generation helpers", () => {
  it("uses Image API endpoints for generation and reference-image edits", () => {
    expect(imageGenerationEndpointPath(makeJob())).toBe("/images/generations");
    expect(imageGenerationEndpointPath(makeJob({ reference_image_storage_key: "space/job/ref.png" }))).toBe("/images/edits");
  });

  it("keeps compatibility payloads free of provider-specific response fields", () => {
    const payload = buildImageGenerationPayload(makeJob({ quantity: 4 }), 1);

    expect(payload).toEqual({
      model: "gpt-image-2",
      prompt: "product shot",
      n: 1,
      size: "1024x1024",
      quality: "high",
      output_format: "png",
      background: "auto",
      moderation: "auto",
      user: "space_1",
    });
  });

  it("tells the provider to use reference-only inputs actively", () => {
    const payload = buildImageGenerationPayload(makeJob({ reference_image_storage_key: "space/job/reference.png" }), 1);

    expect(payload.prompt).toContain("product shot");
    expect(payload.prompt).toContain("Use the attached reference image(s) as active visual input");
    expect(payload.prompt).toContain("make that change visibly clear");
  });

  it("distinguishes a continued-creation source from supplemental references", () => {
    const payload = buildImageGenerationPayload(
      makeJob({
        reference_image_storage_key: "space/job/reference-1.png",
        reference_images_json: JSON.stringify([
          { storageKey: "space/job/reference-1.png", role: "source" },
          { storageKey: "space/job/reference-2.png", role: "reference" },
        ]),
      }),
      1,
    );

    expect(payload.prompt).toContain("first attached image is the primary source image to edit");
    expect(payload.prompt).toContain("later attached images are supplemental references");
  });

  it("adds provider-only mask instructions for selected-area edits", () => {
    const payload = buildImageGenerationPayload(
      makeJob({
        prompt: "把选区改成玻璃舷窗",
        reference_image_storage_key: "space/job/reference.png",
        mask_image_storage_key: "space/job/mask.png",
      }),
      1,
    );

    expect(payload.prompt).toContain("把选区改成玻璃舷窗");
    expect(payload.prompt).toContain("Treat the user's prompt as the replacement content for that selected area");
    expect(payload.prompt).toContain("Replace the masked content so the selected area matches the user's prompt exactly");
    expect(payload.prompt).toContain("Only edit the area selected by the alpha mask's transparent pixels.");
    expect(payload.prompt).toContain("Preserve every unmasked area");
  });

  it("uses the original prompt when resolving masked edit background behavior", () => {
    const payload = buildImageGenerationPayload(
      makeJob({
        prompt: "把选区改成玻璃舷窗",
        reference_image_storage_key: "space/job/reference.png",
        mask_image_storage_key: "space/job/mask.png",
      }),
      1,
    );

    expect(payload.background).toBe("auto");
  });

  it("builds Image Edits multipart fields with image array and optional mask", () => {
    const payload = buildImageGenerationPayload(
      makeJob({
        reference_image_storage_key: "space/job/reference.png",
        mask_image_storage_key: "space/job/mask.png",
      }),
      1,
    );
    const formData = buildImageGenerationFormData(
      payload,
      { blob: new Blob(["reference"], { type: "image/png" }), filename: "source.png" },
      { blob: new Blob(["mask"], { type: "image/png" }), filename: "source-mask.png" },
    );
    const referenceImage = formData.get("image[]") as File;
    const maskImage = formData.get("mask") as File;

    expect(formData.get("image")).toBeNull();
    expect(formData.get("response_format")).toBeNull();
    expect(formData.get("prompt")).toBe(payload.prompt);
    expect(referenceImage).toBeInstanceOf(File);
    expect(referenceImage.name).toBe("source.png");
    expect(maskImage).toBeInstanceOf(File);
    expect(maskImage.name).toBe("source-mask.png");
  });

  it("builds Image Edits multipart fields with multiple reference images", () => {
    const payload = buildImageGenerationPayload(makeJob({ reference_images_json: JSON.stringify([{ storageKey: "space/job/reference-1.png" }]) }), 1);
    const formData = buildImageGenerationFormData(payload, [
      { blob: new Blob(["reference-1"], { type: "image/png" }), filename: "source-1.png" },
      { blob: new Blob(["reference-2"], { type: "image/webp" }), filename: "source-2.webp" },
    ]);
    const referenceImages = formData.getAll("image[]") as File[];

    expect(formData.get("image")).toBeNull();
    expect(referenceImages).toHaveLength(2);
    expect(referenceImages.map((image) => image.name)).toEqual(["source-1.png", "source-2.webp"]);
  });

  it("sends stored source, supplemental references, and mask to Image Edits in the persisted order", async () => {
    const encryptionKey = "test-encryption-key-123";
    const sourceKey = "space_1/job_1/reference-1.png";
    const styleKey = "space_1/job_1/reference-2.webp";
    const maskKey = "space_1/job_1/mask.png";
    const job = makeJob({
      prompt: "keep the silhouette but apply the material from image 2",
      reference_image_storage_key: sourceKey,
      reference_images_json: JSON.stringify([
        { storageKey: sourceKey, mimeType: "image/png", name: "source.png", byteSize: 12, role: "source" },
        { storageKey: styleKey, mimeType: "image/webp", name: "style.webp", byteSize: 11, role: "reference" },
      ]),
      mask_image_storage_key: maskKey,
      mask_image_name: "selection.png",
    });
    const db = new GenerationFlowDatabase(job, await encryptSecret("test-key", encryptionKey));
    const images = new WritableMemoryObjectStore();
    images.objects.set(sourceKey, new TextEncoder().encode("source-bytes").buffer);
    images.objects.set(styleKey, new TextEncoder().encode("style-bytes").buffer);
    images.objects.set(maskKey, new TextEncoder().encode("mask-bytes").buffer);
    let providerUrl = "";
    let providerBody: FormData | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        providerUrl = String(url);
        providerBody = init?.body as FormData;
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_SIGNATURE).toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await processGenerationMessage({ jobId: "job_1", spaceId: "space_1" }, {
      APP_ENCRYPTION_KEY: encryptionKey,
      DB: db,
      IMAGES: images,
      REQUEST_TIMEOUT_MS: "600000",
    } as never);

    expect(providerUrl).toBe("https://image.example.com/v1/images/edits");
    expect(providerBody).toBeInstanceOf(FormData);
    const referenceFiles = providerBody!.getAll("image[]") as File[];
    expect(referenceFiles.map((file) => file.name)).toEqual(["source.png", "style.webp"]);
    expect(await Promise.all(referenceFiles.map(async (file) => new TextDecoder().decode(await file.arrayBuffer())))).toEqual([
      "source-bytes",
      "style-bytes",
    ]);
    const maskFile = providerBody!.get("mask") as File;
    expect(maskFile.name).toBe("selection.png");
    expect(new TextDecoder().decode(await maskFile.arrayBuffer())).toBe("mask-bytes");
    expect(providerBody!.get("response_format")).toBeNull();
    expect(String(providerBody!.get("prompt"))).toContain("first attached image is the primary source image to edit");
    expect(db.completedJob).toMatchObject({ status: "succeeded" });
  });

  it("includes compression for jpeg and webp Image API payloads", () => {
    const payload = buildImageGenerationPayload(
      makeJob({
        output_format: "webp",
        compression: 80,
      }),
      1,
    );

    expect(payload.output_compression).toBe(80);
  });

  it.each(["png", "gif", "svg"])("omits compression for %s Image API payloads", (outputFormat) => {
    const payload = buildImageGenerationPayload(makeJob({ output_format: outputFormat, compression: 80 }), 1);

    expect(payload.output_compression).toBeUndefined();
  });

  it("uses transparent background automatically when png or webp prompts request it", () => {
    expect(resolveImageBackground("生成一个透明背景的产品图标", "png")).toBe("transparent");
    expect(resolveImageBackground("minimal app icon with transparent background", "webp")).toBe("transparent");
  });

  it("does not use transparent background for jpeg or negated prompts", () => {
    expect(resolveImageBackground("生成一个透明背景的产品图标", "jpeg")).toBe("auto");
    expect(resolveImageBackground("产品海报，不需要透明背景", "png")).toBe("auto");
  });

  it("keeps explicit non-auto backgrounds for compatibility", () => {
    expect(resolveImageBackground("透明背景图标", "png", "opaque")).toBe("opaque");
    expect(resolveImageBackground("普通产品图", "webp", "transparent")).toBe("transparent");
  });
});

function makeJob(overrides: Partial<GenerationJobRecord> = {}): GenerationJobRecord {
  return {
    id: "job_1",
    space_id: "space_1",
    conversation_id: "job_1",
    status: "queued",
    prompt: "product shot",
    aspect_ratio: "1:1",
    width: 1024,
    height: 1024,
    quality: "high",
    quantity: 1,
    output_format: "png",
    background: "auto",
    compression: null,
    moderation: "auto",
    model: "gpt-image-2",
    base_url_hash: null,
    reference_image_storage_key: null,
    reference_image_mime_type: null,
    reference_image_name: null,
    reference_image_byte_size: null,
    reference_images_json: null,
    mask_image_storage_key: null,
    mask_image_mime_type: null,
    mask_image_name: null,
    mask_image_byte_size: null,
    stage: null,
    progress_current: 0,
    progress_total: null,
    error_reason: null,
    revised_prompt: null,
    usage_json: null,
    error_code: null,
    error_message: null,
    created_at: "2026-05-14T00:00:00Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

class RecordingDatabase implements AppDatabase {
  readonly queries: string[] = [];

  prepare(query: string) {
    this.queries.push(query);
    return {
      bind: () => this.prepare(query),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    };
  }
}

class MemoryObjectStore implements AppObjectStore {
  readonly getCalls: string[] = [];

  constructor(private readonly objects: Record<string, ArrayBuffer>) {}

  async put(): Promise<unknown> {
    throw new Error("put is not expected");
  }

  async get(key: string) {
    this.getCalls.push(key);
    const bytes = this.objects[key];
    if (!bytes) return null;
    return {
      body: null,
      httpMetadata: { contentType: "image/png" },
      async arrayBuffer() {
        return bytes;
      },
    };
  }

  async delete(): Promise<void> {}
}

interface ImageGenerationRequestBody {
  n: number;
}

interface GenerationResultRow {
  id: string;
  space_id: string;
  job_id: string;
  result_index: number;
  status: string;
  image_asset_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ImageAssetRow {
  id: string;
  space_id: string;
  job_id: string;
  thumbnail_storage_key?: string | null;
  thumbnail_mime_type?: string | null;
  thumbnail_byte_size?: number | null;
  thumbnail_sha256?: string | null;
}

class GenerationFlowDatabase implements AppDatabase {
  readonly results: GenerationResultRow[] = [];
  readonly imageAssets: ImageAssetRow[] = [];
  readonly jobStatusUpdates: Array<{ status: string; errorCode: string | null; errorMessage: string | null; stage: string }> = [];
  completedJob: { status: string; errorCode: string | null; errorMessage: string | null } | null = null;

  constructor(
    private readonly job: GenerationJobRecord,
    private readonly encryptedApiKey: string,
    readonly options: { failImageAssetAttempts?: number } = {},
  ) {}

  prepare(query: string): AppPreparedStatement {
    return new GenerationFlowStatement(this, query);
  }

  findResult(jobId: string, resultIndex: number): GenerationResultRow | undefined {
    return this.results.find((result) => result.job_id === jobId && result.result_index === resultIndex);
  }
}

class GenerationFlowStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: GenerationFlowDatabase,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("SELECT * FROM generation_jobs WHERE id = ?")) {
      return this.db["job"] as T;
    }
    if (this.query.includes("SELECT * FROM api_credentials WHERE space_id = ?")) {
      return {
        id: "cred_1",
        space_id: "space_1",
        base_url: "https://image.example.com/v1",
        model: "gpt-image-2",
        prompt_optimizer_model: "gpt-5.5",
        encrypted_api_key: this.db["encryptedApiKey"],
        api_key_hint: "sk-...test",
        last_test_ok: 1,
        last_tested_at: "2026-05-15T00:00:00.000Z",
        prompt_base_url: null,
        prompt_encrypted_api_key: null,
        prompt_api_key_hint: null,
        prompt_last_test_ok: 0,
        prompt_last_tested_at: null,
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
      } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    if (this.query.includes("FROM image_assets") && this.query.includes("WHERE job_id = ?")) {
      const [jobId, spaceId] = this.values as [string, string];
      return { results: this.db.imageAssets.filter((image) => image.job_id === jobId && image.space_id === spaceId) as T[] };
    }
    if (this.query.includes("FROM generation_job_results")) {
      const [spaceId, jobId] = this.values as [string, string];
      return {
        results: this.db.results
          .filter((result) => result.space_id === spaceId && result.job_id === jobId)
          .sort((a, b) => a.result_index - b.result_index) as T[],
      };
    }
    return { results: [] };
  }

  async run(): Promise<unknown> {
    if (this.query.includes("INSERT INTO generation_job_results")) {
      const [id, spaceId, jobId, resultIndex, status, imageAssetId, errorCode, errorMessage, startedAt, completedAt] = this.values as [
        string,
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      const existing = this.db.findResult(jobId, resultIndex);
      const row = {
        id,
        space_id: spaceId,
        job_id: jobId,
        result_index: resultIndex,
        status,
        image_asset_id: imageAssetId,
        error_code: errorCode,
        error_message: errorMessage,
        started_at: existing?.started_at ?? startedAt,
        completed_at: completedAt,
      };
      if (existing) Object.assign(existing, row);
      else this.db.results.push(row);
      return {};
    }
    if (this.query.includes("INSERT INTO image_assets")) {
      if ((this.db.options.failImageAssetAttempts ?? 0) > 0) {
        this.db.options.failImageAssetAttempts = (this.db.options.failImageAssetAttempts ?? 0) - 1;
        throw new Error("transient image asset insert failure");
      }
      const [id, spaceId, jobId, , , , width, height, , , thumbnailStorageKey, thumbnailMimeType, thumbnailByteSize, thumbnailSha256] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
      ];
      const imageAsset = {
        id,
        space_id: spaceId,
        job_id: jobId,
        width,
        height,
        thumbnail_storage_key: thumbnailStorageKey,
        thumbnail_mime_type: thumbnailMimeType,
        thumbnail_byte_size: thumbnailByteSize,
        thumbnail_sha256: thumbnailSha256,
      };
      const existing = this.db.imageAssets.find((image) => image.id === id);
      if (existing) Object.assign(existing, imageAsset);
      else this.db.imageAssets.push(imageAsset);
      return {};
    }
    if (this.query.includes("INSERT INTO rate_limit_events")) {
      return {};
    }
    if (this.query.includes("UPDATE generation_jobs") && this.query.includes("revised_prompt")) {
      const [status, _revisedPrompt, _usageJson, errorCode, errorMessage] = this.values as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      this.db.completedJob = { status, errorCode, errorMessage };
      return {};
    }
    if (this.query.includes("UPDATE generation_jobs")) {
      const [status, errorCode, errorMessage, _errorReason, stage] = this.values as [string, string | null, string | null, string | null, string];
      this.db.jobStatusUpdates.push({ status, errorCode, errorMessage, stage });
      return {};
    }
    throw new Error(`Unexpected query: ${this.query}`);
  }
}

class WritableMemoryObjectStore implements AppObjectStore {
  readonly objects = new Map<string, ArrayBuffer>();
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];

  constructor(private readonly options: { failKeys?: Set<string>; failAttemptsByKey?: Map<string, number> } = {}) {}

  async put(key: string, value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string): Promise<unknown> {
    this.putCalls.push(key);
    if (this.options.failKeys?.has(key)) throw new Error(`failed to put ${key}`);
    const remainingFailures = this.options.failAttemptsByKey?.get(key) ?? 0;
    if (remainingFailures > 0) {
      this.options.failAttemptsByKey?.set(key, remainingFailures - 1);
      throw new Error(`transiently failed to put ${key}`);
    }
    let bytes: ArrayBuffer;
    if (typeof value === "string") bytes = new TextEncoder().encode(value).buffer;
    else if (value instanceof Blob) bytes = await value.arrayBuffer();
    else if (value instanceof ArrayBuffer) bytes = value;
    else if (ArrayBuffer.isView(value)) bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    else throw new Error("stream writes are not supported by this test store");
    this.objects.set(key, bytes);
    return {};
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: null,
      httpMetadata: { contentType: key.endsWith(".json") ? "application/json" : "image/png" },
      async arrayBuffer() {
        return bytes;
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }
}
