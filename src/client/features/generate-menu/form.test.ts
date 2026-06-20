import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerPromptTextareaClassName,
  imagePreviewToolbarPositionClassName,
  imagePreviewActionKeys,
  generationRequestBody,
  composerOptimizeBeamClassName,
  composerOptimizeBeamProps,
  resolveConversationAutoScrollBehavior,
  resolveComposerPanelMode,
  resolveGenerationPollIntervalMs,
  loadingStatusAnimationDurationMs,
  loadingStatusLines,
  loadingStatusLoopLines,
  resolveHoverImageInlineActionCount,
  shouldCloseHoverImageOverflowOnSelect,
  shouldPollGeneration,
  shouldShowComposerOptimizeBeam,
  updateGenerateForm,
} from "./GenerateMenuView";
import { claimGenerationSubmitLock, mergePolledJobState } from "../../generation-state";

const baseForm = {
  prompt: "",
  model: "gpt-image-2",
  aspectRatio: "16:9",
  resolution: "1K",
  width: 1536,
  height: 864,
  quality: "auto",
  quantity: 1,
  outputFormat: "png",
  compression: 100,
};

describe("generate menu form helpers", () => {
  it("keeps the composer prompt field to a single visible vertical scrollbar", () => {
    expect(composerPromptTextareaClassName).toContain("resize-none");
    expect(composerPromptTextareaClassName).toContain("overflow-y-auto");
    expect(composerPromptTextareaClassName).toContain("overflow-x-hidden");
  });

  it("keeps placeholder and typed text on the same typography metrics", () => {
    expect(composerPromptTextareaClassName).toContain("ohm-composer-prompt-textarea");
    expect(composerPromptTextareaClassName).toContain("text-[15px]");
    expect(composerPromptTextareaClassName).toContain("leading-[21px]");
    expect(composerPromptTextareaClassName).toContain("placeholder:text-[15px]");
    expect(composerPromptTextareaClassName).toContain("placeholder:leading-[21px]");
  });

  it("wraps the prompt optimizer action in a contained colorful beam only while optimizing", () => {
    expect(shouldShowComposerOptimizeBeam(true)).toBe(true);
    expect(shouldShowComposerOptimizeBeam(false)).toBe(false);
    expect(composerOptimizeBeamProps).toEqual({
      size: "pulse-inner",
      colorVariant: "colorful",
      strength: 0.7,
    });
    expect(composerOptimizeBeamClassName).toContain("inline-flex");
  });

  it("exposes eight in-progress loading lines without start or finish phrasing", () => {
    expect(loadingStatusLines).toEqual([
      "正在生成图片",
      "正在排队处理",
      "正在渲染细节",
      "正在铺陈光影",
      "正在调整构图",
      "正在推敲层次",
      "正在润色质感",
      "正在平衡色彩",
    ]);
    expect(loadingStatusLines.every((line) => line.startsWith("正在"))).toBe(true);
    expect(loadingStatusLines.some((line) => /开始|完成|结束|即将/.test(line))).toBe(false);
  });

  it("adds the first line again at the end for a seamless loop handoff", () => {
    expect(loadingStatusLoopLines).toEqual([...loadingStatusLines, loadingStatusLines[0]]);
    expect(loadingStatusLoopLines).toHaveLength(loadingStatusLines.length + 1);
  });

  it("uses the longer loop timing for doubled per-line dwell", () => {
    expect(loadingStatusAnimationDurationMs).toBe(24_480);
  });

  it("keeps custom image dimensions when resolution changes", () => {
    const custom = { ...baseForm, aspectRatio: "custom", width: 1600, height: 900 };

    expect(updateGenerateForm(custom, "resolution", "2K")).toMatchObject({
      aspectRatio: "custom",
      resolution: "2K",
      width: 1600,
      height: 900,
    });
  });

  it("normalizes custom dimensions to multiples of 16", () => {
    expect(updateGenerateForm({ ...baseForm, aspectRatio: "custom" }, "width", 1611).width).toBe(1616);
    expect(updateGenerateForm({ ...baseForm, aspectRatio: "custom" }, "height", 7).height).toBe(16);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps sourceImageId and local edit masks in multipart generation requests", () => {
    const maskFile = new File(["mask"], "local-edit-mask.png", { type: "image/png" });

    const body = generationRequestBody(
      { ...baseForm, prompt: "换成太阳" },
      [],
      "img_1",
      "",
      { file: maskFile, name: "local-edit-mask.png", url: "blob:local-edit-mask", previewName: "局部重绘遮罩" },
    );

    expect(body).toBeInstanceOf(FormData);
    const formData = body as FormData;
    expect(formData.get("referenceImage")).toBeNull();
    expect((formData.get("maskImage") as File).name).toBe("local-edit-mask.png");
    expect(formData.get("sourceImageId")).toBe("img_1");
  });

  it("includes the selected conversation id when continuing an existing conversation", () => {
    const body = generationRequestBody(
      { ...baseForm, prompt: "继续补充细节" },
      [],
      undefined,
      "",
      null,
      "job_root",
    );

    expect(JSON.parse(body as string)).toMatchObject({
      prompt: "继续补充细节",
      conversationId: "job_root",
    });
  });

  it("omits conversation id for a brand new draft conversation", () => {
    const body = generationRequestBody(
      { ...baseForm, prompt: "第一次创作" },
      [],
      undefined,
      "",
      null,
    );

    expect(JSON.parse(body as string)).not.toHaveProperty("conversationId");
  });

  it("rejects duplicate generation submits while one request is already in flight", () => {
    const submitLock = { current: false };

    expect(claimGenerationSubmitLock(submitLock)).toBe(true);
    expect(claimGenerationSubmitLock(submitLock)).toBe(false);
  });

  it("does not let stale poll responses downgrade a finished job back to pending", () => {
    const finishedJob = {
      id: "job_1",
      status: "succeeded",
      stage: "completed",
      progress_current: 1,
      progress_total: 1,
      prompt: "机器人",
      aspect_ratio: "16:9",
      width: 1536,
      height: 864,
      quality: "auto",
      quantity: 1,
      output_format: "png",
      background: "auto",
      compression: 100,
      error_code: null,
      error_message: null,
      created_at: "2026-06-18T05:00:00.000Z",
      started_at: "2026-06-18T05:00:01.000Z",
      completed_at: "2026-06-18T05:00:10.000Z",
    } as const;

    const staleRunningJob = {
      ...finishedJob,
      status: "running",
      stage: "waiting_provider",
      progress_current: 0,
      completed_at: null,
    } as const;

    expect(mergePolledJobState(finishedJob, staleRunningJob)).toEqual(finishedJob);
    expect(mergePolledJobState(staleRunningJob, finishedJob)).toEqual(finishedJob);
  });

  it("backs off active generation polling as a job ages and skips hidden tabs", () => {
    const createdAt = "2026-06-18T05:00:00.000Z";
    expect(resolveGenerationPollIntervalMs(createdAt, Date.parse("2026-06-18T05:00:10.000Z"))).toBe(2000);
    expect(resolveGenerationPollIntervalMs(createdAt, Date.parse("2026-06-18T05:00:45.000Z"))).toBe(5000);
    expect(resolveGenerationPollIntervalMs(createdAt, Date.parse("2026-06-18T05:02:30.000Z"))).toBe(10000);
    expect(shouldPollGeneration("visible")).toBe(true);
    expect(shouldPollGeneration("hidden")).toBe(false);
  });

  it("keeps the large-image preview toolbar aligned with the inline image actions", () => {
    expect(imagePreviewActionKeys()).toEqual(["continue", "local-edit", "regenerate", "copy", "download", "delete"]);
  });

  it("moves trailing image actions into more when the card cannot fit every button", () => {
    expect(resolveHoverImageInlineActionCount({ actionCount: 6, availableWidth: 132 })).toBe(3);
  });

  it("lets destructive overflow menus close before opening their external confirm dialog", () => {
    expect(shouldCloseHoverImageOverflowOnSelect({ confirm: { title: "删除？", description: "确认删除", confirmLabel: "删除" } })).toBe(true);
    expect(shouldCloseHoverImageOverflowOnSelect({})).toBe(true);
  });

  it("places the large-image preview toolbar in the bottom-right corner", () => {
    expect(imagePreviewToolbarPositionClassName).toContain("bottom-4");
    expect(imagePreviewToolbarPositionClassName).toContain("right-4");
    expect(imagePreviewToolbarPositionClassName).not.toContain("left-4");
    expect(imagePreviewToolbarPositionClassName).not.toContain("top-4");
  });

  it("keeps the first composer in the figma top-anchor mode until the first message exists", () => {
    expect(resolveComposerPanelMode(0)).toBe("empty-first-message");
    expect(resolveComposerPanelMode(2)).toBe("conversation");
  });

  it("returns to the bottom-fixed conversation mode only after a successful first submission creates a flow", () => {
    const failedFirstSubmitFlowCount = 0;
    const succeededFirstSubmitFlowCount = 1;

    expect(resolveComposerPanelMode(failedFirstSubmitFlowCount)).toBe("empty-first-message");
    expect(resolveComposerPanelMode(succeededFirstSubmitFlowCount)).toBe("conversation");
  });

  it("jumps directly to the latest message when entering an existing conversation", () => {
    expect(
      resolveConversationAutoScrollBehavior({
        previousConversationId: null,
        nextConversationId: "job_root",
        previousFlowCount: 0,
        nextFlowCount: 3,
      }),
    ).toBe("auto");

    expect(
      resolveConversationAutoScrollBehavior({
        previousConversationId: "job_old",
        nextConversationId: "job_root",
        previousFlowCount: 4,
        nextFlowCount: 3,
      }),
    ).toBe("auto");
  });

  it("only uses smooth scrolling when appending a new message inside the same conversation", () => {
    expect(
      resolveConversationAutoScrollBehavior({
        previousConversationId: "job_root",
        nextConversationId: "job_root",
        previousFlowCount: 2,
        nextFlowCount: 3,
      }),
    ).toBe("smooth");

    expect(
      resolveConversationAutoScrollBehavior({
        previousConversationId: "job_root",
        nextConversationId: "job_root",
        previousFlowCount: 3,
        nextFlowCount: 3,
      }),
    ).toBe("auto");
  });
});
