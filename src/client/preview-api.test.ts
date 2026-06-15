import { describe, expect, it } from "vitest";
import { previewGenerationDelayMs, previewGenerationInputFromBody, previewGenerationInputFromRequest } from "./preview-api";

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

  it("treats continue-from-image requests as having one reference image", () => {
    expect(
      previewGenerationInputFromBody({ prompt: "继续", sourceImageId: "img_1" }).referenceImages,
    ).toEqual([
      expect.objectContaining({ name: "参考图 1", url: "/demo-preview.png" }),
    ]);
  });

  it("keeps uploaded reference images in multipart preview requests", async () => {
    const form = new FormData();
    form.set("prompt", "带参考图");
    form.append("referenceImage", new File(["a"], "source-one.png", { type: "image/png" }));
    form.append("referenceImage", new File(["b"], "source-two.webp", { type: "image/webp" }));
    const request = new Request("https://dev-gen.fourj.space/api/generations", { method: "POST", body: form });

    await expect(previewGenerationInputFromRequest(request)).resolves.toMatchObject({
      prompt: "带参考图",
      referenceImages: [
        { name: "source-one.png", mimeType: "image/png", byteSize: 1, url: "/demo-preview.png" },
        { name: "source-two.webp", mimeType: "image/webp", byteSize: 1, url: "/demo-preview.png" },
      ],
    });
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
