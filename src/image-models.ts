export const IMAGE_MODEL_OPTIONS = [
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

export type ImageModel = (typeof IMAGE_MODEL_OPTIONS)[number];

export const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2.5-flare";

const imageModelLabels: Record<ImageModel, string> = {
  "gpt-image-2": "image-2",
  "gpt-image-2.5-flare": "Image 2.5 Flare",
  "gpt-image-2.5-sunburst": "Image 2.5 Sunburst",
};

export function imageModelLabel(model: string): string {
  return imageModelLabels[model as ImageModel] ?? model.replace(/^gpt-/, "");
}
