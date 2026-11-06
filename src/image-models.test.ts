import { describe, expect, it } from "vitest";
import {
  canonicalImageModel,
  clampQualityForModel,
  DEFAULT_IMAGE_MODEL,
  groupImageModelOptions,
  IMAGE_MODEL_OPTIONS,
  OFFICIAL_IMAGE_MODEL_PRESETS,
  imageModelGroup,
  imageModelLabel,
  imageModelsFromProviderCatalog,
  outputFormatsForModel,
  qualityTiersForModel,
} from "./image-models";

describe("image model catalog", () => {
  it("keeps official presets separate from legacy IDs and third-party aliases", () => {
    expect(OFFICIAL_IMAGE_MODEL_PRESETS).toEqual([
      "gpt-image-2", "gpt-image-2.6", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
      "gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1", "grok-imagine-image-2.0",
    ]);
    expect(OFFICIAL_IMAGE_MODEL_PRESETS.some((id) => id.endsWith("-preview"))).toBe(false);
  });
  it("keeps the selectable upstream IDs verbatim", () => {
    expect(IMAGE_MODEL_OPTIONS).toEqual([
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
    ]);
    expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-2.5-flare");
    // Labels come from the provider, so they are the IDs themselves.
    expect(IMAGE_MODEL_OPTIONS.map(imageModelLabel)).toEqual([...IMAGE_MODEL_OPTIONS]);
  });

  it("keeps provider catalog model ids verbatim", () => {
    expect(canonicalImageModel("grok-2-image-1212")).toBe("grok-imagine-image");
    expect(canonicalImageModel("gemini-3-pro-image-preview")).toBe("gemini-3-pro-image-preview");
    expect(canonicalImageModel("gemini-3.1-flash-image-preview")).toBe("gemini-3.1-flash-image-preview");
    expect(canonicalImageModel("nano-banana-2.1")).toBe("gemini-nano-banana-2.1");
    expect(
      imageModelsFromProviderCatalog([
        "gpt-4o",
        "grok-imagine-image-2",
        "gemini-2.5-flash-image-preview",
        "gemini-2.5-flash-image",
        "grok-imagine-image-2",
      ]).map((model) => model.id),
    ).toEqual(["gpt-4o", "grok-imagine-image-2", "gemini-2.5-flash-image-preview", "gemini-2.5-flash-image"]);
  });

  it("keeps renamed upstream model ids that no image-name hint matches", () => {
    expect(
      imageModelsFromProviderCatalog([
        "gemini-banana-2.1-lite",
        "gemini-3.1-flash-lite",
        "gemini-3-pro-lite",
      ]).map((model) => model.id),
    ).toEqual(["gemini-banana-2.1-lite", "gemini-3.1-flash-lite", "gemini-3-pro-lite"]);
  });

  it("keeps newly added provider image models that are not in the built-in list", () => {
    expect(
      imageModelsFromProviderCatalog([
        "flux-1.1-pro",
        "seedream-4.0",
        "some-new-image-model",
        "gpt-5.5",
      ]).map((model) => model.id),
    ).toEqual(["flux-1.1-pro", "seedream-4.0", "some-new-image-model", "gpt-5.5"]);
  });

  it("uses the provider model id as the label", () => {
    expect(imageModelsFromProviderCatalog(["gpt-image-2.5-flare", "some-new-image-model"])).toEqual([
      { id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare" },
      { id: "some-new-image-model", label: "some-new-image-model" },
    ]);
  });
});

describe("image model groups", () => {
  it("classifies models into vendor groups", () => {
    expect(imageModelGroup("gpt-image-2.5-flare")).toBe("OpenAI");
    expect(imageModelGroup("gemini-3-pro-image")).toBe("Gemini");
    expect(imageModelGroup("gemini-nano-banana-2.1")).toBe("Gemini");
    expect(imageModelGroup("grok-imagine-image-2.0")).toBe("Grok");
    expect(imageModelGroup("seedream-4.0")).toBe("其他");
    expect(imageModelGroup("")).toBe("其他");
  });

  it("orders groups OpenAI, Gemini, Grok and keeps in-group order stable", () => {
    const groups = groupImageModelOptions(IMAGE_MODEL_OPTIONS, (model) => model);
    expect(groups.map((group) => group.group)).toEqual(["OpenAI", "Gemini", "Grok"]);
    expect(groups[0].models).toEqual(["gpt-image-2", "gpt-image-2.6", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    expect(groups[1].models).toEqual([
      "gemini-2.5-flash-image",
      "gemini-3-pro-image",
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview",
      "gemini-nano-banana-2.1",
    ]);
    expect(groups[2].models).toEqual(["grok-imagine-image", "grok-imagine-image-2.0"]);
  });

  it("appends unknown models as a trailing group", () => {
    const groups = groupImageModelOptions(
      ["seedream-4.0", "gpt-image-2", "flux-1.1-pro"],
      (model) => model,
    );
    expect(groups.map((group) => group.group)).toEqual(["OpenAI", "其他"]);
    expect(groups[1].models).toEqual(["seedream-4.0", "flux-1.1-pro"]);
  });
});

describe("output formats per model", () => {
  it("only enables GIF and SVG for image-2.6", () => {
    expect(outputFormatsForModel("gpt-image-2.6")).toEqual(["png", "jpeg", "webp", "gif", "svg"]);
    expect(outputFormatsForModel("image-2.6")).toEqual(["png", "jpeg", "webp", "gif", "svg"]);
    expect(outputFormatsForModel("gpt-image-2.6-flare-lite")).toEqual(["png", "jpeg", "webp", "gif", "svg"]);
    expect(outputFormatsForModel("gpt-image-2.5-flare")).toEqual(["png", "jpeg", "webp"]);
    expect(outputFormatsForModel("")).toEqual(["png", "jpeg", "webp"]);
  });
});

describe("quality tiers per model", () => {
  it("returns model-specific quality tiers", () => {
    expect(qualityTiersForModel("gpt-image-2")).toEqual(["auto", "low", "medium", "high"]);
    expect(qualityTiersForModel("gpt-image-2.6")).toEqual(["auto", "low", "medium", "high"]);
    expect(qualityTiersForModel("gpt-image-2.5-flare")).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(qualityTiersForModel("gpt-image-2.5-sunburst")).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(qualityTiersForModel("grok-imagine-image-2.0")).toEqual(["auto", "low", "medium"]);
    expect(qualityTiersForModel("gemini-3.1-flash-image")).toEqual(["auto", "low", "medium", "high"]);
  });

  it("falls back to base tiers for unknown models", () => {
    expect(qualityTiersForModel("unknown-model")).toEqual(["auto", "low", "medium", "high"]);
    expect(qualityTiersForModel("")).toEqual(["auto", "low", "medium", "high"]);
  });

  it("clamps unsupported quality values to auto", () => {
    expect(clampQualityForModel("gpt-image-2", "xhigh")).toBe("auto");
    expect(clampQualityForModel("gpt-image-2", "max")).toBe("auto");
    expect(clampQualityForModel("gpt-image-2", "high")).toBe("high");
    expect(clampQualityForModel("gpt-image-2.5-flare", "xhigh")).toBe("xhigh");
    expect(clampQualityForModel("gpt-image-2.5-flare", "max")).toBe("max");
    expect(clampQualityForModel("", "xhigh")).toBe("xhigh");
    expect(clampQualityForModel("", "max")).toBe("max");
  });
});
