import { describe, expect, it } from "vitest";
import { formatGenerationSettingsSummary } from "./options";

describe("generate menu option helpers", () => {
  it("formats generation settings in the composer summary order", () => {
    expect(
      formatGenerationSettingsSummary({
        aspectRatio: "16:9",
        quality: "low",
        resolution: "2K",
        quantity: 4,
        outputFormat: "jpeg",
      }),
    ).toBe("16:9｜低质量｜2K｜4张｜JPEG");
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
    ).toBe("自定义｜自动｜1K｜1张｜PNG");
  });
});
