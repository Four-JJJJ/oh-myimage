import { envNumber } from "./http";

export const RATIO_TO_SIZE = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
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

export function parseGenerationInput(raw: unknown, maxImagesValue?: string): { input?: GenerationInput; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "请求体格式不正确。" };
  const body = raw as Record<string, unknown>;
  const maxImages = Math.min(envNumber(maxImagesValue, 4), 10);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { error: "请输入提示词。" };
  if (prompt.length > 32_000) return { error: "提示词最多 32000 个字符。" };

  const aspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio : "1:1";
  const ratioSize = RATIO_TO_SIZE[aspectRatio as keyof typeof RATIO_TO_SIZE];
  let width = toInt(body.width, ratioSize?.[0] ?? 1024);
  let height = toInt(body.height, ratioSize?.[1] ?? 1024);
  if (ratioSize && aspectRatio !== "custom") {
    width = ratioSize[0];
    height = ratioSize[1];
  }

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

export function validateSize(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "宽高必须是整数。";
  if (width < 16 || height < 16) return "宽高不能小于 16。";
  if (width % 16 !== 0 || height % 16 !== 0) return "宽高必须能被 16 整除。";
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return "图片比例必须在 1:3 到 3:1 之间。";
  if (width > 3840 || height > 2160) return "图片尺寸不能超过 3840x2160。";
  return null;
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
