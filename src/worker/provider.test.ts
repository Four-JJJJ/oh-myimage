import { describe, expect, it } from "vitest";
import {
  buildImageGenerationFormData,
  buildImageGenerationPayload,
  buildProviderImagePrompt,
  extractResponsesOutputText,
  imageGenerationEndpointPath,
  providerErrorCode,
  providerStatusMessage,
  resolvePromptOptimizerModel,
  resolveProviderImageBatchSize,
  resolveProviderImageConcurrency,
  resolveImageBackground,
  resolveResponsesModel,
} from "./provider";
import { GenerationJobRecord } from "./types";

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
    mask_image_storage_key: null,
    mask_image_mime_type: null,
    mask_image_name: null,
    mask_image_byte_size: null,
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
