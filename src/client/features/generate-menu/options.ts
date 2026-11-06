import { clampResolutionForRatio, qualityTiersForModel, RATIO_OPTIONS, RESOLUTION_OPTIONS, resolutionOptionsForRatio } from "../../../image-models";

export const qualityLabels: Record<string, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const formatLabels: Record<string, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WEBP",
  gif: "GIF",
  svg: "SVG",
};

export const ratioLabels: Record<string, string> = {
  custom: "自定义",
};

export const ratioOptions = [...RATIO_OPTIONS, "custom"] as const;
export const resolutionOptions = RESOLUTION_OPTIONS;
export const qualityOptions = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const formatOptions = ["png", "jpeg", "webp", "gif", "svg"] as const;

export function qualityOptionsForModel(model: string): readonly string[] {
  return qualityTiersForModel(model);
}

export function resolutionOptionsForForm(form: { aspectRatio: string }): string[] {
  if (form.aspectRatio === "custom") return [...RESOLUTION_OPTIONS];
  const options = resolutionOptionsForRatio(form.aspectRatio);
  return options.length > 0 ? options : [...RESOLUTION_OPTIONS];
}

export function clampResolutionForForm(aspectRatio: string, resolution: string): string {
  return aspectRatio === "custom" ? resolution : clampResolutionForRatio(aspectRatio, resolution);
}

export const CUSTOM_SIZE_MIN = 16;
export const CUSTOM_SIZE_MAX = 3840;
export const CUSTOM_SIZE_STEP = 16;
export const CUSTOM_SIZE_MIN_PIXELS = 655_360;
export const CUSTOM_SIZE_MAX_PIXELS = 8_294_400;

/** Keeps the number the user is still typing; rounding happens only when the field is committed. */
export function clampCustomSize(value: number): number {
  if (!Number.isFinite(value)) return 1024;
  return Math.min(CUSTOM_SIZE_MAX, Math.max(CUSTOM_SIZE_MIN, Math.trunc(value)));
}

/** Server requires multiples of 16, so the committed custom size snaps to the grid. */
export function normalizeCustomSize(value: number): number {
  if (!Number.isFinite(value)) return 1024;
  const stepped = Math.round(clampCustomSize(value) / CUSTOM_SIZE_STEP) * CUSTOM_SIZE_STEP;
  return Math.min(CUSTOM_SIZE_MAX, Math.max(CUSTOM_SIZE_MIN, stepped));
}

export function parseCustomSizeText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mirrors the worker size rules so the composer can warn before submitting. */
export function customSizeHint(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < CUSTOM_SIZE_MIN || height < CUSTOM_SIZE_MIN) {
    return `宽高必须是 ${CUSTOM_SIZE_MIN} 以上的整数。`;
  }
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return "宽高比例需在 1:3 到 3:1 之间。";
  const pixels = width * height;
  if (pixels < CUSTOM_SIZE_MIN_PIXELS) return "总像素太小，宽高乘积不能小于 655360。";
  if (pixels > CUSTOM_SIZE_MAX_PIXELS) return "总像素太大，宽高乘积不能大于 8294400。";
  return null;
}

export interface GenerationSettingsSummaryInput {
  aspectRatio: string;
  quality: string;
  resolution: string;
  quantity: number;
  outputFormat: string;
}

export function generationSettingsSummaryParts(settings: GenerationSettingsSummaryInput): string[] {
  return [
    ratioLabels[settings.aspectRatio] ?? settings.aspectRatio,
    qualityLabels[settings.quality] ?? settings.quality,
    settings.resolution,
    `${settings.quantity}张`,
    formatLabels[settings.outputFormat] ?? settings.outputFormat.toUpperCase(),
  ];
}

export function formatGenerationSettingsSummary(settings: GenerationSettingsSummaryInput): string {
  return generationSettingsSummaryParts(settings).join("｜");
}
