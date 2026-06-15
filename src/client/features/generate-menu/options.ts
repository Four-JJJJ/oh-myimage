export const qualityLabels: Record<string, string> = {
  auto: "自动",
  low: "低质量",
  medium: "中质量",
  high: "高质量",
};

export const formatLabels: Record<string, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WEBP",
};

export const ratioLabels: Record<string, string> = {
  custom: "自定义",
};

export const ratioOptions = ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "custom"] as const;
export const resolutionOptions = ["1K", "2K", "4K"] as const;
export const qualityOptions = ["auto", "low", "medium", "high"] as const;
export const formatOptions = ["png", "jpeg", "webp"] as const;

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
