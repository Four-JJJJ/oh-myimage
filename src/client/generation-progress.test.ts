import { describe, expect, it } from "vitest";
import type { GenerationJob } from "./api";
import { generationProgressSummary } from "./generation-progress";

function generationJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job_1",
    status: "running",
    stage: "waiting_provider",
    progress_current: 0,
    progress_total: 3,
    prompt: "test",
    aspect_ratio: "1:1",
    width: 1024,
    height: 1024,
    quality: "low",
    quantity: 3,
    output_format: "png",
    background: "auto",
    compression: 100,
    error_code: null,
    error_message: null,
    created_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("generation progress summary", () => {
  it("labels in-flight progress as processed work instead of successful images", () => {
    expect(generationProgressSummary(generationJob({ progress_current: 3 }))).toBe("已处理 3/3");
  });

  it("separates successful and failed slots for a fully failed job", () => {
    expect(
      generationProgressSummary(
        generationJob({
          status: "failed",
          stage: "failed",
          progress_current: 3,
          results: [0, 1, 2].map((index) => ({
            index,
            status: "failed" as const,
            imageId: null,
            errorCode: "provider_image_download_failed",
            errorMessage: "download failed",
            startedAt: null,
            completedAt: "2026-07-31T00:01:00.000Z",
          })),
        }),
      ),
    ).toBe("成功 0/3 · 失败 3/3");
  });

  it("reports mixed outcomes without treating failed slots as successes", () => {
    expect(
      generationProgressSummary(
        generationJob({
          status: "partial_succeeded",
          stage: "completed",
          results: [
            {
              index: 0,
              status: "succeeded",
              imageId: "img_1",
              errorCode: null,
              errorMessage: null,
              startedAt: null,
              completedAt: "2026-07-31T00:01:00.000Z",
            },
            {
              index: 1,
              status: "succeeded",
              imageId: "img_2",
              errorCode: null,
              errorMessage: null,
              startedAt: null,
              completedAt: "2026-07-31T00:01:00.000Z",
            },
            {
              index: 2,
              status: "failed",
              imageId: null,
              errorCode: "provider_image_download_failed",
              errorMessage: "download failed",
              startedAt: null,
              completedAt: "2026-07-31T00:01:00.000Z",
            },
          ],
        }),
      ),
    ).toBe("成功 2/3 · 失败 1/3");
  });

  it("uses persisted image count when older terminal records have no per-slot results", () => {
    expect(generationProgressSummary(generationJob({ status: "partial_succeeded", results: undefined }), 1)).toBe(
      "成功 1/3 · 失败 2/3",
    );
  });
});
