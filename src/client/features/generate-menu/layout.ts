export const conversationTopPaddingPx = 40;
export const conversationHorizontalPaddingPx = 152;
export const conversationComposerGapPx = 40;
export const conversationComposerBottomOffsetPx = 24;
export const generationModuleGapPx = 24;
export const conversationFlowGapPx = 64;
export const scrollStickThresholdPx = 48;
export const collapsedPromptMaxLines = 5;
export const collapsedPromptLineHeightPx = 21;

export function conversationCanvasBottomPadding(composerHeight: number): number {
  return Math.max(composerHeight + conversationComposerGapPx + conversationComposerBottomOffsetPx, conversationTopPaddingPx);
}

export function isScrollNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = scrollStickThresholdPx): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

export function collapsedPromptMaxHeightPx(lines = collapsedPromptMaxLines, lineHeight = collapsedPromptLineHeightPx): number {
  return lines * lineHeight;
}
