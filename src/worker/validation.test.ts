import { describe, expect, it } from "vitest";
import { parseGenerationInput, parsePromptOptimizationInput, validateSize } from "./validation";

describe("generation validation", () => {
  it("maps known ratios to supported dimensions", () => {
    const result = parseGenerationInput({ prompt: "product shot", aspectRatio: "16:9", quantity: 2 }, "4");
    expect(result.input?.width).toBe(1536);
    expect(result.input?.height).toBe(864);
  });

  it("maps poster ratios from the generator UI", () => {
    const landscape = parseGenerationInput({ prompt: "poster", aspectRatio: "4:3" });
    const portrait = parseGenerationInput({ prompt: "poster", aspectRatio: "3:4" });
    expect(landscape.input?.width).toBe(1536);
    expect(landscape.input?.height).toBe(1152);
    expect(portrait.input?.width).toBe(1152);
    expect(portrait.input?.height).toBe(1536);
  });

  it("accepts explicit vertical 4K dimensions for a selected ratio", () => {
    const result = parseGenerationInput({
      prompt: "vertical poster",
      aspectRatio: "9:16",
      width: 2160,
      height: 3840,
    });
    expect(result.error).toBeUndefined();
    expect(result.input?.width).toBe(2160);
    expect(result.input?.height).toBe(3840);
  });

  it("rejects too many images", () => {
    const result = parseGenerationInput({ prompt: "product shot", quantity: 5 }, "4");
    expect(result.error).toContain("1-4");
  });

  it("rejects invalid custom dimensions", () => {
    expect(validateSize(1025, 1024)).toContain("16");
    expect(validateSize(4000, 1024)).toContain("1:3");
    expect(validateSize(3856, 2176)).toContain("3840");
    expect(validateSize(512, 512)).toContain("总像素");
  });

  it.each([
    ["gif", "gpt-image-2.6"],
    ["svg", "gpt-image-2.6"],
    ["gif", "gpt-image-2.6-flare-lite"],
    ["svg", "image-2.6-flare-lite"],
  ])("accepts %s output for image-2.6 family model %s", (outputFormat, model) => {
    const result = parseGenerationInput({ prompt: "animated icon", model, outputFormat });

    expect(result.error).toBeUndefined();
    expect(result.input?.outputFormat).toBe(outputFormat);
  });

  it.each(["gif", "svg"])("rejects %s output for models other than image-2.6", (outputFormat) => {
    const result = parseGenerationInput({ prompt: "static image", model: "gpt-image-2.5-flare", outputFormat });

    expect(result.input).toBeUndefined();
    expect(result.error).toContain("仅支持 image-2.6");
  });

  it("accepts transparent png backgrounds", () => {
    const result = parseGenerationInput({
      prompt: "transparent icon",
      outputFormat: "png",
      background: "transparent",
    });
    expect(result.error).toBeUndefined();
    expect(result.input?.background).toBe("transparent");
  });

  it("rejects transparent jpeg backgrounds", () => {
    const result = parseGenerationInput({
      prompt: "transparent icon",
      outputFormat: "jpeg",
      background: "transparent",
    });
    expect(result.error).toContain("透明背景");
  });

  it("accepts xhigh and max quality for gpt-image-2.5 models", () => {
    const xhigh = parseGenerationInput({ prompt: "poster", quality: "xhigh", model: "gpt-image-2.5-flare" });
    const max = parseGenerationInput({ prompt: "poster", quality: "max", model: "gpt-image-2.5-sunburst" });
    expect(xhigh.input?.quality).toBe("xhigh");
    expect(max.input?.quality).toBe("max");
  });

  it("clamps xhigh and max quality to auto for gpt-image-2", () => {
    const xhigh = parseGenerationInput({ prompt: "poster", quality: "xhigh", model: "gpt-image-2" });
    const max = parseGenerationInput({ prompt: "poster", quality: "max", model: "gpt-image-2" });
    expect(xhigh.input?.quality).toBe("auto");
    expect(max.input?.quality).toBe("auto");
  });

  it("keeps xhigh and max quality when no model is specified", () => {
    const xhigh = parseGenerationInput({ prompt: "poster", quality: "xhigh" });
    expect(xhigh.input?.quality).toBe("xhigh");
  });
});

describe("prompt optimization validation", () => {
  it("rejects empty prompts", () => {
    const result = parsePromptOptimizationInput({ prompt: "   " });
    expect(result.error).toContain("请输入提示词");
  });

  it("rejects overly long prompts", () => {
    const result = parsePromptOptimizationInput({ prompt: "a".repeat(32_001) });
    expect(result.error).toContain("32000");
  });

  it("accepts valid prompt optimization input", () => {
    const result = parsePromptOptimizationInput({
      prompt: "赛博朋克城市",
      aspectRatio: "16:9",
      width: 1536,
      height: 864,
      quality: "high",
      outputFormat: "webp",
      background: "auto",
      referenceImageCount: 2,
      hasSourceImage: true,
      hasMaskImage: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({
      prompt: "赛博朋克城市",
      aspectRatio: "16:9",
      width: 1536,
      height: 864,
      quality: "high",
      outputFormat: "webp",
      background: "auto",
      referenceImageCount: 2,
      hasSourceImage: true,
      hasMaskImage: true,
    });
  });

  it("uses safe defaults for missing reference context", () => {
    const result = parsePromptOptimizationInput({ prompt: "赛博朋克城市" });

    expect(result.input).toMatchObject({ referenceImageCount: 0, hasSourceImage: false, hasMaskImage: false });
  });
});
