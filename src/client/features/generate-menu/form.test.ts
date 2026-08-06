import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerPromptTextareaClassName,
  imagePreviewToolbarGroupClassName,
  imagePreviewToolbarPositionClassName,
  imagePreviewActionKeys,
  imagePreviewActionsWithDismiss,
  remainingReferenceSlots,
  resolveImagePreviewChromeState,
  resolveImagePreviewProgressPercent,
  generationRequestBody,
  composerOptimizeBeamClassName,
  composerOptimizeBeamProps,
  createQueuedGenerationJob,
  resolveConversationAutoScrollBehavior,
  resolveComposerPanelMode,
  resolveActiveGenerationRecordsRefreshIntervalMs,
  resolveInitialGenerationStatusTimeoutMs,
  resolveGenerationPollRequestInit,
  resolveGenerationPollIntervalMs,
  shouldRefreshActiveGenerationRecords,
  shouldRefreshActiveGenerationRecordsOnLifecycleEvent,
  shouldRefreshActiveGenerationRecordsOnTimer,
  shouldRefreshGenerationOnLifecycleEvent,
  shouldShowReferenceCarryoverHint,
  shouldPreserveReferenceImage,
  loadingStatusAnimationDurationMs,
  loadingStatusLines,
  loadingStatusLoopLines,
  resolveHoverImageInlineActionCount,
  shouldCloseHoverImageOverflowOnSelect,
  shouldDismissImagePreviewAfterAction,
  shouldPollGeneration,
  shouldShowComposerOptimizeBeam,
  updateGenerateForm,
  buildFlowChips,
} from "./GenerateMenuView";
import { claimGenerationSubmitLock, mergePolledJobState } from "../../generation-state";

const source = readFileSync(fileURLToPath(new URL("./GenerateMenuView.tsx", import.meta.url)), "utf8");

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
  it("shows successful and failed image counts separately for terminal jobs", () => {
    const chips = buildFlowChips({
      id: "job_1",
      status: "failed",
      elapsedSeconds: 42,
      images: [],
      job: {
        id: "job_1",
        status: "failed",
        stage: "failed",
        progress_current: 3,
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
        error_code: "provider_image_download_failed",
        error_message: "download failed",
        created_at: "2026-07-31T00:00:00.000Z",
        results: [0, 1, 2].map((index) => ({
          index,
          status: "failed" as const,
          imageId: null,
          errorCode: "provider_image_download_failed",
          errorMessage: "download failed",
          startedAt: null,
          completedAt: "2026-07-31T00:01:00.000Z",
        })),
      },
    });

    expect(chips).toContain("成功 0/3 · 失败 3/3");
    expect(chips).not.toContain("3/3");
  });

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

  it("keeps a bounded percent for full-size image preview loading progress", () => {
    expect(resolveImagePreviewProgressPercent(0, 1000)).toBe(0);
    expect(resolveImagePreviewProgressPercent(420, 1000)).toBe(42);
    expect(resolveImagePreviewProgressPercent(1000, 1000)).toBe(100);
    expect(resolveImagePreviewProgressPercent(1200, 1000)).toBe(100);
    expect(resolveImagePreviewProgressPercent(500, 0)).toBeNull();
  });

  it("streams the full-size preview image through fetch so loading progress can update", () => {
    const previewSource = source.slice(source.indexOf("export function ImagePreview"), source.indexOf("function LocalEditDialog"));

    expect(previewSource).toContain("fetch(image.url");
    expect(previewSource).toContain("getReader()");
    expect(previewSource).toContain("URL.createObjectURL");
    expect(previewSource).not.toContain("new XMLHttpRequest");
  });

  it("exits preview loading on request or decode failure and offers an explicit retry", () => {
    const previewSource = source.slice(source.indexOf("export function ImagePreview"), source.indexOf("function LocalEditDialog"));

    expect(previewSource).toContain('setLoadState("error")');
    expect(previewSource).toContain('onLoad={() => setLoadState("loaded")}');
    expect(previewSource).toContain('onError={() => setLoadState("error")}');
    expect(previewSource).toContain("重新加载");
    expect(previewSource).toContain("setLoadAttempt((attempt) => attempt + 1)");
  });

  it("overlays the full-size preview placeholder and loading image without shifting horizontally", () => {
    const previewSource = source.slice(source.indexOf("export function ImagePreview"), source.indexOf("function LocalEditDialog"));

    expect(previewSource).toContain("loadedImageUrl");
    expect(previewSource).toContain("isolate");
    expect(previewSource).toContain("loadingProgressLabel");
    expect(previewSource).toContain("{loadingProgressLabel}");
    expect(previewSource).not.toContain("\"absolute inset-0 z-[1] m-auto");
  });

  it("falls back from a broken generated thumbnail to the original image", () => {
    const stageSource = source.slice(source.indexOf("function GenerationStageImageCell"), source.indexOf("function buildGeneratedImageActions"));

    expect(stageSource).toContain("image.thumbnailUrl ?? image.url");
    expect(stageSource).toContain("if (displayImageUrl !== image.url) setDisplayImageUrl(image.url)");
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

  it("keeps the continued-creation source alongside uploaded reference images", () => {
    const referenceFile = new File(["reference"], "style.png", { type: "image/png" });
    const body = generationRequestBody(
      { ...baseForm, prompt: "继续创作并参考这张图" },
      [{ file: referenceFile, name: "style.png", url: "blob:style" }],
      "img_1",
    );

    expect(body).toBeInstanceOf(FormData);
    const formData = body as FormData;
    expect(formData.get("sourceImageId")).toBe("img_1");
    expect((formData.get("referenceImage") as File).name).toBe("style.png");
  });

  it("reserves one reference slot for a continued-creation source image", () => {
    expect(remainingReferenceSlots(0, false)).toBe(8);
    expect(remainingReferenceSlots(0, true)).toBe(7);
    expect(remainingReferenceSlots(7, true)).toBe(0);
  });

  it("preserves accepted reference files byte-for-byte instead of recompressing them", () => {
    expect(shouldPreserveReferenceImage({ size: 10 * 1024 * 1024 })).toBe(true);
    expect(shouldPreserveReferenceImage({ size: 10 * 1024 * 1024 + 1 })).toBe(false);
    const prepareSource = source.slice(source.indexOf("async function prepareReferenceImage"), source.indexOf("function loadFileImage"));
    expect(prepareSource.indexOf("shouldPreserveReferenceImage(file)")).toBeLessThan(prepareSource.indexOf("loadFileImage(file)"));
  });

  it("warns that a normal follow-up prompt will not inherit the previous image", () => {
    expect(shouldShowReferenceCarryoverHint({ hasConversationImage: true, hasCurrentReference: false, prompt: "把颜色改成蓝色" })).toBe(true);
    expect(shouldShowReferenceCarryoverHint({ hasConversationImage: true, hasCurrentReference: true, prompt: "把颜色改成蓝色" })).toBe(false);
    expect(shouldShowReferenceCarryoverHint({ hasConversationImage: false, hasCurrentReference: false, prompt: "生成新图片" })).toBe(false);
    expect(shouldShowReferenceCarryoverHint({ hasConversationImage: true, hasCurrentReference: false, prompt: "   " })).toBe(false);
    expect(source).toContain("当前不会自动参考上一张图");
    expect(source).toContain("基于这张图片继续创作");
  });

  it("keeps the source image when adding an ordinary reference and only clears a local-edit mask", () => {
    const addReferenceSource = source.slice(source.indexOf("async function addReferenceFilesFromList"), source.indexOf("function clearAllReferences"));

    expect(addReferenceSource).not.toContain("setSourceImageId(undefined)");
    expect(addReferenceSource).not.toContain("setSourceImagePreview(null)");
    expect(addReferenceSource).toContain("setReferenceMask(null)");
  });

  it("closes a large preview before actions that enter another generation flow", () => {
    const calls: string[] = [];
    const onClose = () => calls.push("close");
    const onLocalEdit = () => calls.push("local-edit");
    const actions = imagePreviewActionsWithDismiss([
      { key: "local-edit", label: "局部编辑", icon: null, onSelect: onLocalEdit },
      { key: "copy", label: "复制提示词", icon: null, onSelect: vi.fn() },
    ], onClose);

    expect(shouldDismissImagePreviewAfterAction({ key: "local-edit" })).toBe(true);
    expect(shouldDismissImagePreviewAfterAction({ key: "copy" })).toBe(false);
    actions[0]?.onSelect?.();
    expect(calls).toEqual(["close", "local-edit"]);
  });

  it("falls back to a queued local job when the first status read is slow", () => {
    const queued = createQueuedGenerationJob("job_1", { ...baseForm, prompt: "带参考图继续创作" }, [
      { name: "参考图 1", mimeType: "image/png", byteSize: 128, url: "blob:reference" },
    ]);

    expect(resolveInitialGenerationStatusTimeoutMs()).toBe(8_000);
    expect(queued).toMatchObject({
      id: "job_1",
      status: "queued",
      stage: "queued",
      prompt: "带参考图继续创作",
      referenceImages: [{ name: "参考图 1" }],
    });
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
    expect(resolveGenerationPollIntervalMs(createdAt, Date.parse("2026-06-18T05:02:30.000Z"))).toBe(5000);
    expect(shouldPollGeneration("visible")).toBe(true);
    expect(shouldPollGeneration("hidden")).toBe(false);
  });

  it("detects active generation records that need a background rescan", () => {
    const finishedRecord = generationRecord("job_done", "succeeded");
    const queuedRecord = generationRecord("job_waiting", "queued");
    const runningJob = generationRecord("job_running", "running").job;

    expect(shouldRefreshActiveGenerationRecords({ records: [finishedRecord], activeJob: null })).toBe(false);
    expect(shouldRefreshActiveGenerationRecords({ records: [finishedRecord, queuedRecord], activeJob: null })).toBe(true);
    expect(shouldRefreshActiveGenerationRecords({ records: [finishedRecord], activeJob: runningJob })).toBe(true);
    expect(shouldRefreshActiveGenerationRecords({ records: [finishedRecord], activeJob: { ...runningJob, status: "failed" } })).toBe(false);
  });

  it("uses a light active-record rescan cadence and skips hidden tabs", () => {
    expect(resolveActiveGenerationRecordsRefreshIntervalMs()).toBeGreaterThanOrEqual(10_000);
    expect(resolveActiveGenerationRecordsRefreshIntervalMs()).toBeLessThanOrEqual(15_000);
    expect(shouldRefreshActiveGenerationRecordsOnTimer({ visibilityState: "visible", hasActiveRecords: true })).toBe(true);
    expect(shouldRefreshActiveGenerationRecordsOnTimer({ visibilityState: "visible", hasActiveRecords: false })).toBe(false);
    expect(shouldRefreshActiveGenerationRecordsOnTimer({ visibilityState: "hidden", hasActiveRecords: true })).toBe(false);
  });

  it("refreshes active records on lifecycle events only while visible", () => {
    expect(shouldRefreshActiveGenerationRecordsOnLifecycleEvent({ eventType: "visibilitychange", visibilityState: "visible", hasActiveRecords: true })).toBe(true);
    expect(shouldRefreshActiveGenerationRecordsOnLifecycleEvent({ eventType: "visibilitychange", visibilityState: "hidden", hasActiveRecords: true })).toBe(false);
    expect(shouldRefreshActiveGenerationRecordsOnLifecycleEvent({ eventType: "focus", visibilityState: "visible", hasActiveRecords: true })).toBe(true);
    expect(shouldRefreshActiveGenerationRecordsOnLifecycleEvent({ eventType: "online", visibilityState: "visible", hasActiveRecords: true })).toBe(true);
    expect(shouldRefreshActiveGenerationRecordsOnLifecycleEvent({ eventType: "online", visibilityState: "visible", hasActiveRecords: false })).toBe(false);
  });

  it("refreshes generation status immediately when the page can receive fresh updates again", () => {
    expect(shouldRefreshGenerationOnLifecycleEvent("visibilitychange", "visible")).toBe(true);
    expect(shouldRefreshGenerationOnLifecycleEvent("visibilitychange", "hidden")).toBe(false);
    expect(shouldRefreshGenerationOnLifecycleEvent("focus", "visible")).toBe(true);
    expect(shouldRefreshGenerationOnLifecycleEvent("online", "visible")).toBe(true);
  });

  it("bypasses browser cache when polling active generation status", () => {
    expect(resolveGenerationPollRequestInit()).toMatchObject({ cache: "no-store" });
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

  it("keeps the large-image preview toolbar free of drop shadow", () => {
    expect(imagePreviewToolbarGroupClassName).not.toContain("shadow");
  });

  it("hides large-image preview actions until the original image has loaded", () => {
    expect(resolveImagePreviewChromeState({ hasImageUrl: true, imageLoaded: false }).showActions).toBe(false);
    expect(resolveImagePreviewChromeState({ hasImageUrl: false, imageLoaded: false }).showActions).toBe(false);
    expect(resolveImagePreviewChromeState({ hasImageUrl: true, imageLoaded: true }).showActions).toBe(true);
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

function generationRecord(id: string, status: "queued" | "running" | "succeeded" | "partial_succeeded" | "failed" | "cancelled") {
  return {
    job: {
      id,
      status,
      stage: status === "queued" ? "queued" : status === "running" ? "waiting_provider" : "completed",
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
      completed_at: status === "queued" || status === "running" ? null : "2026-06-18T05:01:00.000Z",
    },
    images: [],
    elapsedSeconds: null,
  } as const;
}
