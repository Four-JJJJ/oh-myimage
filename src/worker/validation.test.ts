import { describe, expect, it } from "vitest";
import { parseGenerationInput, validateSize } from "./validation";

describe("generation validation", () => {
  it("maps known ratios to supported dimensions", () => {
    const result = parseGenerationInput({ prompt: "product shot", aspectRatio: "16:9", quantity: 2 }, "4");
    expect(result.input?.width).toBe(1536);
    expect(result.input?.height).toBe(864);
  });

  it("rejects too many images", () => {
    const result = parseGenerationInput({ prompt: "product shot", quantity: 5 }, "4");
    expect(result.error).toContain("1-4");
  });

  it("rejects invalid custom dimensions", () => {
    expect(validateSize(1025, 1024)).toContain("16");
    expect(validateSize(4000, 1024)).toContain("1:3");
  });

  it("rejects transparent jpeg", () => {
    const result = parseGenerationInput({
      prompt: "transparent icon",
      outputFormat: "jpeg",
      background: "transparent",
    });
    expect(result.error).toContain("透明背景");
  });
});
