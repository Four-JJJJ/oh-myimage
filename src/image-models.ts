export const IMAGE_MODEL_OPTIONS = [
  "gpt-image-2",
  "gpt-image-2.6",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "grok-imagine-image",
  "grok-imagine-image-2.0",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-nano-banana-2.1",
] as const;

export type ImageModel = (typeof IMAGE_MODEL_OPTIONS)[number];

export const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2.5-flare";

// Official IDs verified against the vendors' image-generation docs (2026-10-28).
// Presets are suggestions, not models discovered or verified at a provider.
export const OFFICIAL_IMAGE_MODEL_PRESETS = [
  "gpt-image-2",
  "gpt-image-2.6",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-nano-banana-2.1",
  "grok-imagine-image-2.0",
] as const;

const imageModelAliases: Record<string, ImageModel> = {
  "gpt-image-2": "gpt-image-2",
  "image-2": "gpt-image-2",
  "gpt-image-2.6": "gpt-image-2.6",
  "image-2.6": "gpt-image-2.6",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
  "image-2.5-flare": "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "grok-imagine-image": "grok-imagine-image",
  "grok-imagine-image-1.0": "grok-imagine-image",
  "grok-2-image": "grok-imagine-image",
  "grok-2-image-1212": "grok-imagine-image",
  "grok-imagine-image-2.0": "grok-imagine-image-2.0",
  "grok-imagine-image-2": "grok-imagine-image-2.0",
  "gemini-2.5-flash-image": "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview": "gemini-2.5-flash-image",
  "nano-banana": "gemini-2.5-flash-image",
  "gemini-3-pro-image": "gemini-3-pro-image",
  "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
  "nano-banana-pro": "gemini-3-pro-image",
  "gemini-3.1-flash-image": "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image",
  "gemini-nano-banana-2.1": "gemini-nano-banana-2.1",
  "nano-banana-2.1": "gemini-nano-banana-2.1",
};

export function canonicalImageModel(model: string): ImageModel | null {
  const normalized = model.trim().toLowerCase();
  return imageModelAliases[normalized] ?? null;
}

export function isKnownImageModel(model: string): boolean {
  return canonicalImageModel(model) !== null;
}

const BASE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_2_6_OUTPUT_FORMATS = [...BASE_OUTPUT_FORMATS, "gif", "svg"] as const;
const IMAGE_2_6_FAMILY = /^(?:gpt-image|image)-2\.6(?:$|[-_.])/i;

/** Provider-discovered variants such as gpt-image-2.6-flare-lite share the 2.6 output capabilities. */
export function isImage26FamilyModel(model: string): boolean {
  return IMAGE_2_6_FAMILY.test(model.trim());
}

export function outputFormatsForModel(model: string): readonly string[] {
  return isImage26FamilyModel(model) ? IMAGE_2_6_OUTPUT_FORMATS : BASE_OUTPUT_FORMATS;
}

export function isOutputFormatSupportedForModel(model: string, outputFormat: string): boolean {
  return outputFormatsForModel(model).includes(outputFormat);
}

export function imageModelLabel(model: string): string {
  return model.trim();
}

export type ImageModelGroup = "OpenAI" | "Gemini" | "Grok" | "其他";

const IMAGE_MODEL_GROUP_ORDER: readonly ImageModelGroup[] = ["OpenAI", "Gemini", "Grok", "其他"];

export function imageModelGroup(model: string): ImageModelGroup {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gpt-image") || normalized.startsWith("dall-e") || normalized.startsWith("dalle")) return "OpenAI";
  if (normalized.startsWith("gemini") || normalized.includes("nano-banana")) return "Gemini";
  if (normalized.startsWith("grok")) return "Grok";
  return "其他";
}

function compareOpenAIImageModels(left: string, right: string): number {
  const parse = (model: string) => {
    const match = model.trim().toLowerCase().match(/^(?:gpt-)?image-(\d+(?:\.\d+)?)(?:-(sunburst|flare))?(?:-(pro|lite))?$/);
    if (!match) return null;
    return {
      version: match[1].split(".").map(Number),
      family: match[2] === "sunburst" ? 0 : match[2] === "flare" ? 1 : 2,
      tier: match[3] === "pro" ? 0 : match[3] === "lite" ? 1 : 2,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  const versionLength = Math.max(a.version.length, b.version.length);
  for (let index = 0; index < versionLength; index += 1) {
    const difference = (b.version[index] ?? 0) - (a.version[index] ?? 0);
    if (difference) return difference;
  }
  return a.family - b.family || a.tier - b.tier;
}

export interface GroupedImageModelOptions<T> {
  group: ImageModelGroup;
  models: T[];
}

export function groupImageModelOptions<T>(options: readonly T[], modelOf: (item: T) => string): GroupedImageModelOptions<T>[] {
  const buckets = new Map<ImageModelGroup, T[]>();
  for (const item of options) {
    const group = imageModelGroup(modelOf(item));
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  return IMAGE_MODEL_GROUP_ORDER.flatMap((group) => {
    const models = buckets.get(group);
    if (!models) return [];
    if (group === "OpenAI") {
      const originalOrder = new Map(models.map((item, index) => [item, index]));
      models.sort((left, right) => compareOpenAIImageModels(modelOf(left), modelOf(right))
        || (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
    }
    return [{ group, models }];
  });
}

const BASE_QUALITY_TIERS = ["auto", "low", "medium", "high"] as const;
const EXTENDED_QUALITY_TIERS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const GROK_QUALITY_TIERS = ["auto", "low", "medium"] as const;

const imageModelQualityTiers: Record<ImageModel, readonly string[]> = {
  "gpt-image-2": BASE_QUALITY_TIERS,
  "gpt-image-2.6": BASE_QUALITY_TIERS,
  "gpt-image-2.5-flare": EXTENDED_QUALITY_TIERS,
  "gpt-image-2.5-sunburst": EXTENDED_QUALITY_TIERS,
  "grok-imagine-image": GROK_QUALITY_TIERS,
  "grok-imagine-image-2.0": GROK_QUALITY_TIERS,
  "gemini-2.5-flash-image": BASE_QUALITY_TIERS,
  "gemini-3-pro-image": BASE_QUALITY_TIERS,
  "gemini-3-pro-image-preview": BASE_QUALITY_TIERS,
  "gemini-3.1-flash-image": BASE_QUALITY_TIERS,
  "gemini-3.1-flash-image-preview": BASE_QUALITY_TIERS,
  "gemini-nano-banana-2.1": BASE_QUALITY_TIERS,
};

export function qualityTiersForModel(model: string): readonly string[] {
  const canonical = canonicalImageModel(model);
  if (canonical) return imageModelQualityTiers[canonical];
  return BASE_QUALITY_TIERS;
}

export function clampQualityForModel(model: string, quality: string): string {
  const tiers = qualityTiersForModel(model.trim() || DEFAULT_IMAGE_MODEL);
  return tiers.includes(quality) ? quality : "auto";
}

export const RATIO_OPTIONS = ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"] as const;
export const RESOLUTION_OPTIONS = ["1K", "2K", "4K"] as const;

const RATIO_BASE_SIZES: Record<string, [number, number]> = {
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1536, 1152],
  "3:4": [1152, 1536],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "1:1": [1024, 1024],
};

const RESOLUTION_LONG_EDGE: Record<string, number> = {
  "1K": 1536,
  "2K": 2048,
  "4K": 3840,
};

export const MAX_IMAGE_PIXELS = 8_294_400;
export const MAX_IMAGE_SIDE = 3840;

export function sizeForRatioResolution(ratio: string, resolution: string): [number, number] {
  const [baseWidth, baseHeight] = RATIO_BASE_SIZES[ratio] ?? RATIO_BASE_SIZES["16:9"];
  const longEdge = RESOLUTION_LONG_EDGE[resolution] ?? RESOLUTION_LONG_EDGE["1K"];
  const scale = longEdge / Math.max(baseWidth, baseHeight);
  return [roundTo16(baseWidth * scale), roundTo16(baseHeight * scale)];
}

export function isSupportedImageSize(width: number, height: number): boolean {
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return false;
  return width * height <= MAX_IMAGE_PIXELS;
}

export function resolutionOptionsForRatio(ratio: string): string[] {
  return RESOLUTION_OPTIONS.filter((resolution) => {
    const [width, height] = sizeForRatioResolution(ratio, resolution);
    return isSupportedImageSize(width, height);
  });
}

export function clampResolutionForRatio(ratio: string, resolution: string): string {
  const options = resolutionOptionsForRatio(ratio);
  return options.includes(resolution) ? resolution : options[options.length - 1] ?? "1K";
}

function roundTo16(value: number): number {
  return Math.round(value / 16) * 16;
}

export interface DiscoveredImageModel {
  id: string;
  label: string;
}

// Provider 模型目录全量透传：上游模型名随时可能改（如 nano-banana → banana-lite），
// 不按名称关键词猜测是否为图片模型，由站长在设置里自行选择。
export function imageModelsFromProviderCatalog(modelIds: readonly string[]): DiscoveredImageModel[] {
  const discovered = new Map<string, DiscoveredImageModel>();
  for (const modelId of modelIds) {
    const id = modelId.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (discovered.has(key)) continue;
    discovered.set(key, { id, label: imageModelLabel(id) });
  }
  return [...discovered.values()];
}
