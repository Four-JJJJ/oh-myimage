import { describe, expect, it } from "vitest";
import { updateGenerateForm } from "./GenerateMenuView";

const baseForm = {
  prompt: "",
  model: "gpt-image-2",
  aspectRatio: "16:9",
  resolution: "1K",
  width: 1536,
  height: 864,
  quality: "auto",
  quantity: 1,
  outputFormat: "png",
  compression: 100,
};

describe("generate menu form helpers", () => {
  it("keeps custom image dimensions when resolution changes", () => {
    const custom = { ...baseForm, aspectRatio: "custom", width: 1600, height: 900 };

    expect(updateGenerateForm(custom, "resolution", "2K")).toMatchObject({
      aspectRatio: "custom",
      resolution: "2K",
      width: 1600,
      height: 900,
    });
  });

  it("normalizes custom dimensions to multiples of 16", () => {
    expect(updateGenerateForm({ ...baseForm, aspectRatio: "custom" }, "width", 1611).width).toBe(1616);
    expect(updateGenerateForm({ ...baseForm, aspectRatio: "custom" }, "height", 7).height).toBe(16);
  });
});
