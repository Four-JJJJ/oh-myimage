import { envNumber } from "./http";

export const RATIO_TO_SIZE = {
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1536, 1152],
  "3:4": [1152, 1536],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "1:1": [1024, 1024],
} as const;

const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const FORMATS = new Set(["png", "webp", "jpeg"]);
const BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const MODERATIONS = new Set(["auto", "low"]);

export interface GenerationInput {
  prompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  quality: "auto" | "low" | "medium" | "high";
  quantity: number;
  outputFormat: "png" | "webp" | "jpeg";
  background: "auto" | "opaque" | "transparent";
  compression: number;
  moderation: "auto" | "low";
  turnstileToken?: string;
}

export interface PromptOptimizationInput {
  prompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  quality: string;
  outputFormat: string;
  background: string;
  referenceImageCount: number;
  hasSourceImage: boolean;
  hasMaskImage: boolean;
}

export function parseGenerationInput(raw: unknown, maxImagesValue?: string): { input?: GenerationInput; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "请求体格式不正确。" };
  const body = raw as Record<string, unknown>;
  const maxImages = Math.min(envNumber(maxImagesValue, 4), 10);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { error: "请输入提示词。" };
  if (prompt.length > 32_000) return { error: "提示词最多 32000 个字符。" };

  const aspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio : "1:1";
  const ratioSize = RATIO_TO_SIZE[aspectRatio as keyof typeof RATIO_TO_SIZE];
  const hasExplicitSize = body.width !== undefined && body.height !== undefined;
  let width = hasExplicitSize ? toInt(body.width, ratioSize?.[0] ?? 1024) : ratioSize?.[0] ?? toInt(body.width, 1024);
  let height = hasExplicitSize ? toInt(body.height, ratioSize?.[1] ?? 1024) : ratioSize?.[1] ?? toInt(body.height, 1024);

  const quality = typeof body.quality === "string" && QUALITIES.has(body.quality) ? body.quality : "auto";
  const quantity = toInt(body.quantity, 1);
  const outputFormat = typeof body.outputFormat === "string" && FORMATS.has(body.outputFormat) ? body.outputFormat : "png";
  const background = typeof body.background === "string" && BACKGROUNDS.has(body.background) ? body.background : "auto";
  const compression = toInt(body.compression, 100);
  const moderation = typeof body.moderation === "string" && MODERATIONS.has(body.moderation) ? body.moderation : "auto";
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : undefined;

  if (quantity < 1 || quantity > maxImages) return { error: `单次生成数量必须在 1-${maxImages} 之间。` };
  const sizeError = validateSize(width, height);
  if (sizeError) return { error: sizeError };
  if (ratioSize && hasExplicitSize && !matchesRatio(width, height, ratioSize[0], ratioSize[1])) {
    return { error: "宽高必须匹配所选图片比例。" };
  }
  if (compression < 0 || compression > 100) return { error: "压缩率必须在 0-100 之间。" };
  if (background === "transparent" && outputFormat === "jpeg") {
    return { error: "透明背景只能使用 PNG 或 WebP 格式。" };
  }

  return {
    input: {
      prompt,
      aspectRatio,
      width,
      height,
      quality: quality as GenerationInput["quality"],
      quantity,
      outputFormat: outputFormat as GenerationInput["outputFormat"],
      background: background as GenerationInput["background"],
      compression,
      moderation: moderation as GenerationInput["moderation"],
      turnstileToken,
    },
  };
}

export function parsePromptOptimizationInput(raw: unknown): { input?: PromptOptimizationInput; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "请求体格式不正确。" };
  const body = raw as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { error: "请输入提示词。" };
  if (prompt.length > 32_000) return { error: "提示词最多 32000 个字符。" };

  const aspectRatio = typeof body.aspectRatio === "string" && body.aspectRatio.trim() ? body.aspectRatio.trim() : "1:1";
  const ratioSize = RATIO_TO_SIZE[aspectRatio as keyof typeof RATIO_TO_SIZE];
  const width = toInt(body.width, ratioSize?.[0] ?? 1024);
  const height = toInt(body.height, ratioSize?.[1] ?? 1024);
  const quality = typeof body.quality === "string" && QUALITIES.has(body.quality) ? body.quality : "auto";
  const outputFormat = typeof body.outputFormat === "string" && FORMATS.has(body.outputFormat) ? body.outputFormat : "png";
  const background = typeof body.background === "string" && BACKGROUNDS.has(body.background) ? body.background : "auto";
  const referenceImageCount = Math.min(Math.max(toInt(body.referenceImageCount, 0), 0), 8);
  const hasSourceImage = body.hasSourceImage === true;
  const hasMaskImage = body.hasMaskImage === true;

  return {
    input: {
      prompt,
      aspectRatio,
      width,
      height,
      quality,
      outputFormat,
      background,
      referenceImageCount,
      hasSourceImage,
      hasMaskImage,
    },
  };
}

export function validateSize(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "宽高必须是整数。";
  if (width < 16 || height < 16) return "宽高不能小于 16。";
  if (width % 16 !== 0 || height % 16 !== 0) return "宽高必须能被 16 整除。";
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return "图片比例必须在 1:3 到 3:1 之间。";
  if (width > 3840 || height > 3840) return "图片长边不能超过 3840px。";
  const totalPixels = width * height;
  if (totalPixels < 655_360 || totalPixels > 8_294_400) return "图片总像素必须在 655360 到 8294400 之间。";
  return null;
}

function matchesRatio(width: number, height: number, ratioWidth: number, ratioHeight: number): boolean {
  const actual = width / height;
  const expected = ratioWidth / ratioHeight;
  return Math.abs(actual - expected) / expected < 0.015;
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
