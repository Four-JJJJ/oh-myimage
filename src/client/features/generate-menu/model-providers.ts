import type { ImageProviderProfile } from "../../api";
import { IMAGE_MODEL_OPTIONS, imageModelLabel } from "../../../image-models";

export interface ComposerModelProvider {
  id: string;
  name: string;
  modelSource?: "discovered" | "preset";
  models: Array<{ value: string; label: string }>;
}

export function composerModelProvidersFromProfiles(
  profiles: readonly ImageProviderProfile[] | null | undefined,
  fallbackModels: readonly string[] = IMAGE_MODEL_OPTIONS,
): ComposerModelProvider[] {
  return (profiles ?? [])
    .map((profile) => {
      const id = profile.id?.trim();
      if (!id) return null;
      return {
        id,
        name: profile.name?.trim() || "未命名配置",
        ...(profile.modelSource ? { modelSource: profile.modelSource } : {}),
        models: composerModelsForProvider(profile.models, fallbackModels),
      };
    })
    .filter((provider): provider is ComposerModelProvider => provider !== null);
}

export function resolveComposerProviderSelection(
  providers: readonly ComposerModelProvider[],
  selectedProviderId: string | null | undefined,
  selectedModel: string | null | undefined,
): { providerId: string; model: string } | null {
  if (providers.length === 0) return null;
  const preferred = providers.find((provider) => provider.id === selectedProviderId);
  const matching = providers.find((provider) => provider.models.some((model) => model.value === selectedModel));
  const provider = preferred ?? matching ?? providers[0];
  const model = provider.models.find((item) => item.value === selectedModel)?.value ?? provider.models[0]?.value ?? "";
  return { providerId: provider.id, model };
}

function composerModelsForProvider(models: readonly string[] | null | undefined, fallbackModels: readonly string[]) {
  const source = models ?? (fallbackModels.length > 0 ? fallbackModels : []);
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const model of source) {
    const value = model.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    options.push({ value, label: imageModelLabel(value) });
  }
  return options;
}
