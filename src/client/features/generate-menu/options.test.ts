import { describe, expect, it } from "vitest";
import { isSupportedImageSize, sizeForRatioResolution } from "../../../image-models";
import { clampCustomSize, clampResolutionForForm, customSizeHint, formatGenerationSettingsSummary, formatOptions, normalizeCustomSize, parseCustomSizeText, qualityLabels, qualityOptionsForModel, resolutionOptionsForForm } from "./options";

describe("generate menu option helpers", () => {
  it("offers GIF and SVG output formats", () => {
    expect(formatOptions).toEqual(["png", "jpeg", "webp", "gif", "svg"]);
  });

  it("formats generation settings in the composer summary order", () => {
    expect(
      formatGenerationSettingsSummary({
        aspectRatio: "16:9",
        quality: "low",
        resolution: "2K",
        quantity: 4,
        outputFormat: "jpeg",
      }),
    ).toBe("16:9｜Low｜2K｜4张｜JPEG");
  });

  it("labels custom aspect ratios for the composer summary", () => {
    expect(
      formatGenerationSettingsSummary({
        aspectRatio: "custom",
        quality: "auto",
        resolution: "1K",
        quantity: 1,
        outputFormat: "png",
      }),
    ).toBe("自定义｜Auto｜1K｜1张｜PNG");
  });

  it("narrows quality tiers when image-2 is selected and widens them for 2.5 models", () => {    expect(qualityOptionsForModel("gpt-image-2")).toEqual(["auto", "low", "medium", "high"]);
    expect(qualityOptionsForModel("gpt-image-2.5-flare")).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(qualityOptionsForModel("gpt-image-2.5-sunburst")).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(qualityOptionsForModel("gpt-image-2").map((quality) => qualityLabels[quality])).toEqual([
      "Auto",
      "Low",
      "Medium",
      "High",
    ]);
    expect(qualityOptionsForModel("gpt-image-2.5-flare").map((quality) => qualityLabels[quality])).toEqual([
      "Auto",
      "Low",
      "Medium",
      "High",
      "XHigh",
      "Max",
    ]);
  });

  it("drops resolutions that would exceed the provider pixel budget", () => {
    expect(resolutionOptionsForForm({ aspectRatio: "16:9" })).toEqual(["1K", "2K", "4K"]);
    expect(resolutionOptionsForForm({ aspectRatio: "9:16" })).toEqual(["1K", "2K", "4K"]);
    expect(resolutionOptionsForForm({ aspectRatio: "1:1" })).toEqual(["1K", "2K"]);
    expect(resolutionOptionsForForm({ aspectRatio: "4:3" })).toEqual(["1K", "2K"]);
    expect(resolutionOptionsForForm({ aspectRatio: "custom" })).toEqual(["1K", "2K", "4K"]);
  });

  it("falls back to the largest supported resolution when the ratio changes", () => {
    expect(clampResolutionForForm("1:1", "4K")).toBe("2K");
    expect(clampResolutionForForm("16:9", "4K")).toBe("4K");
    expect(clampResolutionForForm("custom", "4K")).toBe("4K");
  });

  it("keeps every generated size inside the provider limits", () => {
    for (const ratio of ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"]) {
      for (const resolution of resolutionOptionsForForm({ aspectRatio: ratio })) {
        const [width, height] = sizeForRatioResolution(ratio, resolution);
        expect(isSupportedImageSize(width, height)).toBe(true);
      }
    }
  });

  it("reads the raw custom size text without rewriting what the user types", () => {
    expect(parseCustomSizeText("1024")).toBe(1024);
    expect(parseCustomSizeText(" 1600 ")).toBe(1600);
    expect(parseCustomSizeText("")).toBeNull();
    expect(parseCustomSizeText("abc")).toBeNull();
    expect(clampCustomSize(1024)).toBe(1024);
    expect(clampCustomSize(4)).toBe(16);
    expect(clampCustomSize(9000)).toBe(3840);
  });

  it("snaps committed custom sizes to the 16px grid used by the worker", () => {
    expect(normalizeCustomSize(1024)).toBe(1024);
    expect(normalizeCustomSize(1000)).toBe(1008);
    expect(normalizeCustomSize(1611)).toBe(1616);
    expect(normalizeCustomSize(7)).toBe(16);
    expect(normalizeCustomSize(9000)).toBe(3840);
    expect(normalizeCustomSize(Number.NaN)).toBe(1024);
  });

  it("warns about custom sizes the worker would reject", () => {
    expect(customSizeHint(1600, 1040)).toBeNull();
    expect(customSizeHint(1024, 1024)).toBeNull();
    expect(customSizeHint(3840, 864)).toContain("1:3");
    expect(customSizeHint(512, 512)).toContain("总像素太小");
    expect(customSizeHint(3840, 3840)).toContain("总像素太大");
    expect(customSizeHint(0, 864)).toContain("整数");
  });
});
