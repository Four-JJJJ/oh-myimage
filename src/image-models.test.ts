import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_MODEL, IMAGE_MODEL_OPTIONS, imageModelLabel } from "./image-models";

describe("image model catalog", () => {
  it("keeps the selectable upstream IDs and product labels aligned", () => {
    expect(IMAGE_MODEL_OPTIONS).toEqual([
      "gpt-image-2",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
    ]);
    expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-2.5-flare");
    expect(IMAGE_MODEL_OPTIONS.map(imageModelLabel)).toEqual([
      "image-2",
      "Image 2.5 Flare",
      "Image 2.5 Sunburst",
    ]);
  });
});
