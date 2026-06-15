import { describe, expect, it } from "vitest";
import {
  conversationComposerBottomOffsetPx,
  collapsedPromptMaxHeightPx,
  collapsedPromptMaxLines,
  collapsedPromptLineHeightPx,
  conversationCanvasBottomPadding,
  conversationComposerGapPx,
  conversationFlowGapPx,
  conversationTopPaddingPx,
  generationModuleGapPx,
  isScrollNearBottom,
} from "./layout";
import { generationStageLayout } from "./GenerateMenuView";
import type { ImageItem } from "../../api";

describe("generate menu layout helpers", () => {
  it("keeps the first message offset and generation module gap stable", () => {
    expect(conversationTopPaddingPx).toBe(40);
    expect(generationModuleGapPx).toBe(24);
    expect(conversationFlowGapPx).toBe(64);
  });

  it("reserves enough canvas bottom space for the floating composer", () => {
    expect(conversationCanvasBottomPadding(170)).toBe(170 + conversationComposerGapPx + conversationComposerBottomOffsetPx);
    expect(conversationCanvasBottomPadding(0)).toBeGreaterThanOrEqual(conversationTopPaddingPx);
    expect(conversationCanvasBottomPadding(0)).toBe(conversationComposerGapPx + conversationComposerBottomOffsetPx);
  });

  it("treats near-bottom scroll positions as sticky", () => {
    expect(isScrollNearBottom(552, 400, 1000)).toBe(true);
    expect(isScrollNearBottom(480, 400, 1000)).toBe(false);
    expect(isScrollNearBottom(600, 400, 1000, 8)).toBe(true);
  });

  it("caps collapsed prompts at exactly five lines", () => {
    expect(collapsedPromptMaxLines).toBe(5);
    expect(collapsedPromptLineHeightPx).toBe(21);
    expect(collapsedPromptMaxHeightPx()).toBe(105);
  });

  it("stitches multiple generated images horizontally at their source ratio", () => {
    const images = Array.from({ length: 3 }, (_, index) => ({
      id: `img_${index}`,
      jobId: "job_1",
      url: "/demo.png",
      width: 1536,
      height: 1152,
      format: "png",
      createdAt: "2026-06-15T00:00:00.000Z",
    })) satisfies ImageItem[];

    expect(generationStageLayout({ width: 1536, height: 1152, quantity: 3 }, images)).toEqual({
      width: 840,
      height: 210,
      columns: 3,
    });
  });
});
