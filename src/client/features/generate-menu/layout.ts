export const conversationTopPaddingPx = 40;
export const conversationPanelMaxWidthPx = 840;
export const conversationViewportPaddingPx = 16;
export const conversationPanelWidthClassName = "w-[min(840px,calc(100vw-32px))] max-w-[calc(100vw-32px)]";
export const conversationHorizontalPaddingPx = 0;
export const conversationMessageWidthClassName = "w-full";
export const conversationComposerGapPx = 40;
export const conversationComposerBottomOffsetPx = 24;
export const generationModuleGapPx = 24;
export const conversationFlowGapPx = 64;
export const scrollStickThresholdPx = 48;
export const collapsedPromptMaxLines = 5;
export const collapsedPromptLineHeightPx = 21;
export const emptyFirstComposerTopPercent = 34.7;
export const emptyStateCopyToComposerGapPx = 40;

export type ComposerLayoutMode = "empty-first-message" | "conversation";

export function resolveComposerLayoutMode(flowCount: number): ComposerLayoutMode {
  return flowCount > 0 ? "conversation" : "empty-first-message";
}

export function conversationCanvasBottomPadding(composerHeight: number, layoutMode: ComposerLayoutMode = "conversation"): number {
  if (layoutMode === "empty-first-message") return conversationTopPaddingPx;
  return Math.max(composerHeight + conversationComposerGapPx + conversationComposerBottomOffsetPx, conversationTopPaddingPx);
}

export function isScrollNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = scrollStickThresholdPx): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

export function collapsedPromptMaxHeightPx(lines = collapsedPromptMaxLines, lineHeight = collapsedPromptLineHeightPx): number {
  return lines * lineHeight;
}
