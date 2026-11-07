import type { GenerateForm } from "./GenerateMenuView";
import { clampQualityForModel, outputFormatsForModel, sizeForRatioResolution } from "../../../image-models";
import { clampCustomSize, clampResolutionForForm, ratioOptions, resolutionOptions } from "./options";

export function generationPreferencesKey(spaceId: string): string {
  return `oh-myimage:generation-preferences:v1:${spaceId}`;
}

export function readGenerationPreferences(storage: Pick<Storage, "getItem">, spaceId: string, defaults: GenerateForm) {
  const fallback = { form: { ...defaults }, providerId: null as string | null };
  try {
    const saved = JSON.parse(storage.getItem(generationPreferencesKey(spaceId)) ?? "null");
    if (!saved || typeof saved !== "object") return fallback;
    const form = { ...defaults };
    if (typeof saved.model === "string" && saved.model.trim()) form.model = saved.model;
    if (ratioOptions.includes(saved.aspectRatio)) form.aspectRatio = saved.aspectRatio;
    if (resolutionOptions.includes(saved.resolution)) form.resolution = saved.resolution;
    form.resolution = clampResolutionForForm(form.aspectRatio, form.resolution);
    if (form.aspectRatio === "custom") {
      for (const key of ["width", "height"] as const) {
        if (typeof saved[key] === "number" && Number.isFinite(saved[key])) form[key] = clampCustomSize(saved[key]);
      }
    } else {
      [form.width, form.height] = sizeForRatioResolution(form.aspectRatio, form.resolution);
    }
    if (typeof saved.quality === "string") form.quality = clampQualityForModel(form.model, saved.quality);
    if (outputFormatsForModel(form.model).includes(saved.outputFormat)) form.outputFormat = saved.outputFormat;
    if (Number.isInteger(saved.quantity) && saved.quantity >= 1 && saved.quantity <= 4) form.quantity = saved.quantity;
    if (Number.isInteger(saved.compression) && saved.compression >= 0 && saved.compression <= 100) form.compression = saved.compression;
    return { form, providerId: typeof saved.providerId === "string" && saved.providerId ? saved.providerId : null };
  } catch {
    return fallback;
  }
}

export function writeGenerationPreferences(storage: Pick<Storage, "setItem">, spaceId: string, form: GenerateForm, providerId: string | null): void {
  const { model, aspectRatio, resolution, width, height, quality, quantity, outputFormat, compression } = form;
  try {
    storage.setItem(generationPreferencesKey(spaceId), JSON.stringify({ model, aspectRatio, resolution, width, height, quality, quantity, outputFormat, compression, providerId }));
  } catch {
    // Storage may be unavailable or full; generation must remain usable.
  }
}
