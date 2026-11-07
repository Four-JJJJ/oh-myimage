import { describe, expect, it } from "vitest";
import { readGenerationPreferences, writeGenerationPreferences } from "./preferences";
import { resolveComposerProviderSelection } from "./model-providers";

const defaults = { prompt: "", model: "gpt-image-2.5-flare", aspectRatio: "16:9", resolution: "1K", width: 1536, height: 864, quality: "auto", quantity: 1, outputFormat: "png", compression: 100 };
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("generation preferences", () => {
  it("restores all parameters and provider after reload without persisting prompt or other data", () => {
    const storage = memoryStorage();
    const form = { ...defaults, prompt: "private draft", model: "gpt-image-2.6", aspectRatio: "custom", resolution: "2K", width: 1280, height: 768, quality: "high", quantity: 3, outputFormat: "gif", compression: 70 };
    writeGenerationPreferences(storage, "space-a", form, "provider-b");
    const restored = readGenerationPreferences(storage, "space-a", defaults);
    expect(restored).toEqual({ form: { ...form, prompt: "" }, providerId: "provider-b" });
    expect(readGenerationPreferences(storage, "space-b", defaults)).toEqual({ form: defaults, providerId: null });
    const providers = [
      { id: "provider-a", name: "A", models: [{ value: "gemini-banana-2.1-lite", label: "first" }] },
      { id: "provider-b", name: "B", models: [{ value: "gpt-image-2.6", label: "saved" }] },
    ];
    expect(resolveComposerProviderSelection(providers, restored.providerId, restored.form.model)).toEqual({ providerId: "provider-b", model: "gpt-image-2.6" });
    expect(resolveComposerProviderSelection(providers.slice(0, 1), restored.providerId, restored.form.model)).toEqual({ providerId: "provider-a", model: "gemini-banana-2.1-lite" });
  });

  it("handles corrupt, unsupported and unavailable browser storage", () => {
    expect(readGenerationPreferences({ getItem: () => "{" }, "a", defaults).form).toEqual(defaults);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
    expect(readGenerationPreferences(blocked, "a", defaults).form).toEqual(defaults);
    expect(() => writeGenerationPreferences(blocked, "a", defaults, null)).not.toThrow();
    const invalid = readGenerationPreferences({ getItem: () => JSON.stringify({ model: "gpt-image-2", outputFormat: "gif", aspectRatio: "invalid", quantity: -1, compression: 200 }) }, "a", defaults);
    expect(invalid.form).toMatchObject({ outputFormat: "png", aspectRatio: "16:9", quantity: 1, compression: 100 });
  });
});
