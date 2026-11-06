import { describe, expect, it } from "vitest";
import { composerModelProvidersFromProfiles, resolveComposerProviderSelection } from "./model-providers";
import { OFFICIAL_IMAGE_MODEL_PRESETS } from "../../../image-models";

describe("composer model providers", () => {
  it("keeps the preset warning source when building selectable provider models", () => {
    const [provider] = composerModelProvidersFromProfiles([
      { id: "preset", name: "Preset", baseURL: "", model: "gpt-image-2", apiKeyHint: "", lastTestOk: true, lastTestedAt: null, models: [...OFFICIAL_IMAGE_MODEL_PRESETS], modelSource: "preset" },
    ], []);
    expect(provider.modelSource).toBe("preset");
    expect(provider.models.map((model) => model.value)).toEqual([...OFFICIAL_IMAGE_MODEL_PRESETS]);
  });
  it("keeps each configured provider and only its discovered models", () => {
    const providers = composerModelProvidersFromProfiles([
      { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com", model: "gpt-image-2", apiKeyHint: "sk-****", lastTestOk: true, lastTestedAt: null, models: ["gpt-image-2", "image-2.5-flare"] },
      { id: "grok", name: "xAI", baseURL: "https://api.x.ai", model: "grok-imagine-image", apiKeyHint: "xai-****", lastTestOk: true, lastTestedAt: null, models: ["grok-imagine-image-2.0"] },
    ]);

    expect(providers).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        models: [
          { value: "gpt-image-2", label: "gpt-image-2" },
          { value: "image-2.5-flare", label: "image-2.5-flare" },
        ],
      },
      {
        id: "grok",
        name: "xAI",
        models: [{ value: "grok-imagine-image-2.0", label: "grok-imagine-image-2.0" }],
      },
    ]);
  });

  it("does not invent models for a provider that has not been tested", () => {
    const providers = composerModelProvidersFromProfiles([
      { id: "untested", name: "Untested", baseURL: "", model: "gpt-image-2", apiKeyHint: "", lastTestOk: false, lastTestedAt: null },
    ], []);

    expect(providers[0]?.models).toEqual([]);
  });

  it("selects the first provider by default and keeps the current model when switching back", () => {
    const providers = composerModelProvidersFromProfiles([
      { id: "first", name: "First", baseURL: "", model: "gpt-image-2", apiKeyHint: "", lastTestOk: true, lastTestedAt: null, models: ["gpt-image-2"] },
      { id: "second", name: "Second", baseURL: "", model: "grok-imagine-image", apiKeyHint: "", lastTestOk: true, lastTestedAt: null, models: ["grok-imagine-image"] },
    ]);

    expect(resolveComposerProviderSelection(providers, null, "gpt-image-2.5-flare")).toEqual({
      providerId: "first",
      model: "gpt-image-2",
    });
    expect(resolveComposerProviderSelection(providers, "second", "grok-imagine-image")).toEqual({
      providerId: "second",
      model: "grok-imagine-image",
    });
  });
});
