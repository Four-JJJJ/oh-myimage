import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImageGenerationFormData,
  buildImageGenerationPayload,
  buildProviderImagePrompt,
  extractResponsesOutputText,
  imageGenerationEndpointPath,
  requestGenerationBatchWithRecovery,
  providerErrorCode,
  resolveProviderImageBinary,
  providerStatusMessage,
  providerErrorRetryable,
  resolvePromptOptimizerModel,
  resolveProviderImageBatchSize,
  resolveProviderImageConcurrency,
  resolveProviderTimeoutRetryAttempts,
  resolveImageBackground,
  resolveResponsesModel,
  recoverStoredImageForResult,
  shouldPersistFailedResult,
  ProviderError,
} from "./provider";
import { AppDatabase, AppObjectStore, GenerationJobRecord } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider generation batching", () => {
  it("defaults to single-image provider requests", () => {
    expect(resolveProviderImageBatchSize(undefined)).toBe(1);
  });

  it("clamps provider request batch size", () => {
    expect(resolveProviderImageBatchSize("0")).toBe(1);
    expect(resolveProviderImageBatchSize("2")).toBe(2);
    expect(resolveProviderImageBatchSize("10")).toBe(4);
  });

  it("defaults to two concurrent single-image provider requests", () => {
    expect(resolveProviderImageConcurrency(undefined)).toBe(2);
  });

  it("clamps provider image concurrency", () => {
    expect(resolveProviderImageConcurrency("0")).toBe(1);
    expect(resolveProviderImageConcurrency("2")).toBe(2);
    expect(resolveProviderImageConcurrency("2.8")).toBe(2);
    expect(resolveProviderImageConcurrency("10")).toBe(4);
  });

  it("defaults to no immediate provider timeout retries", () => {
    expect(resolveProviderTimeoutRetryAttempts(undefined)).toBe(0);
    expect(resolveProviderTimeoutRetryAttempts("1")).toBe(1);
    expect(resolveProviderTimeoutRetryAttempts("99")).toBe(3);
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
});

describe("provider save recovery", () => {
  it("recovers an already stored image object without requesting the provider again", async () => {
    const db = new RecordingDatabase();
    const images = new MemoryObjectStore({
      "space_1/job_1/img_job_1_0.png": new Uint8Array([1, 2, 3]).buffer,
    });

    const recovered = await recoverStoredImageForResult(makeJob(), 0, { DB: db, IMAGES: images } as never);

    expect(recovered?.imageId).toBe("img_job_1_0");
    expect(db.queries.join("\n")).toContain("INSERT INTO image_assets");
    expect(images.getCalls).toEqual(["space_1/job_1/img_job_1_0.png"]);
  });
});

describe("provider image result compatibility", () => {
  it("downloads URL-style image results and preserves the actual image format", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
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
  });

  it("does not retry timed out generation requests by default", async () => {
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
        } as never,
        "idem-1",
      ),
    ).rejects.toMatchObject({ code: "provider_timeout" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const firstHeaders = vi.mocked(fetch).mock.calls[0]?.[1] ? new Headers((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).headers) : null;
    expect(firstHeaders?.get("Idempotency-Key")).toBe("idem-1");
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
        PROVIDER_TIMEOUT_RETRY_ATTEMPTS: "1",
      } as never,
      "idem-1",
    );

    expect(response.data?.[0]?.url).toBe("https://img.example.com/final.png");
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[0]).toBe("https://image.example.com/v1/images/generations");
    expect(calls[1]?.[0]).toBe("https://image.example.com/v1/images/generations");
    const firstHeaders = calls[0]?.[1] ? new Headers((calls[0][1] as RequestInit).headers) : null;
    const secondHeaders = calls[1]?.[1] ? new Headers((calls[1][1] as RequestInit).headers) : null;
    expect(firstHeaders?.get("Idempotency-Key")).toBe("idem-1");
    expect(secondHeaders?.get("Idempotency-Key")).toBe("idem-1");
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
});

describe("Image API generation helpers", () => {
  it("uses Image API endpoints for generation and reference-image edits", () => {
    expect(imageGenerationEndpointPath(makeJob())).toBe("/images/generations");
    expect(imageGenerationEndpointPath(makeJob({ reference_image_storage_key: "space/job/ref.png" }))).toBe("/images/edits");
  });

  it("builds a single-image generation payload", () => {
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

  it("keeps reference-only edit prompts unchanged", () => {
    const payload = buildImageGenerationPayload(makeJob({ reference_image_storage_key: "space/job/reference.png" }), 1);

    expect(payload.prompt).toBe("product shot");
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
    expect(formData.get("prompt")).toBe(buildProviderImagePrompt(makeJob({ mask_image_storage_key: "space/job/mask.png" })));
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
