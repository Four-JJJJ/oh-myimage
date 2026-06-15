import { describe, expect, it } from "vitest";
import { previewGenerationDelayMs, previewGenerationInputFromBody } from "./preview-api";

describe("preview API generation input", () => {
  it("preserves selected ratio and quantity for acceptance previews", () => {
    expect(
      previewGenerationInputFromBody({
        prompt: "验收参数",
        aspectRatio: "4:3",
        width: "1536",
        height: "1152",
        quality: "auto",
        quantity: "3",
        outputFormat: "png",
      }),
    ).toMatchObject({
      prompt: "验收参数",
      aspectRatio: "4:3",
      width: 1536,
      height: 1152,
      quantity: 3,
      outputFormat: "png",
    });
  });

  it("clamps preview quantity to the visible menu range", () => {
    expect(previewGenerationInputFromBody({ prompt: "too many", quantity: "8" }).quantity).toBe(4);
    expect(previewGenerationInputFromBody({ prompt: "too few", quantity: "0" }).quantity).toBe(1);
  });

  it("keeps loading active longer for multi-image preview jobs", () => {
    expect(previewGenerationDelayMs(1, "")).toBe(11000);
    expect(previewGenerationDelayMs(4, "")).toBe(20000);
  });

  it("allows acceptance checks to override preview loading duration", () => {
    expect(previewGenerationDelayMs(1, "?previewDelayMs=25000")).toBe(25000);
    expect(previewGenerationDelayMs(1, "?previewDelayMs=999999")).toBe(120000);
  });
});
