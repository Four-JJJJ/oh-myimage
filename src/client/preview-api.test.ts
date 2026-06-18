import { describe, expect, it } from "vitest";
import { createPreviewRecord, previewGenerationDelayMs, previewGenerationInputFromBody, previewGenerationInputFromRequest, previewModeFromInputs } from "./preview-api";

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

  it("treats local edit preview requests as having both source and mask previews", async () => {
    const form = new FormData();
    form.set("prompt", "把莲改成荷");
    form.set("sourceImageId", "img_1");
    form.set("maskImage", new File(["mask"], "local-edit-mask.png", { type: "image/png" }));
    const request = new Request("https://dev-gen.fourj.space/api/generations", { method: "POST", body: form });

    await expect(previewGenerationInputFromRequest(request)).resolves.toMatchObject({
      prompt: "把莲改成荷",
      sourceImageId: "img_1",
      referenceImages: [
        { name: "局部重绘", mimeType: "image/png", byteSize: 0, url: "/demo-preview.png" },
        { name: "局部重绘遮罩", mimeType: "image/png", byteSize: 4, url: "/demo-preview.png" },
      ],
    });
  });

  it("stores a root conversation id for a brand new preview generation", () => {
    const record = createPreviewRecord("首次创作", "running");

    expect(record.job.conversation_id).toBe(record.job.id);
  });

  it("reuses the selected conversation id for continued preview prompts", () => {
    const root = createPreviewRecord("第一次创作", "succeeded", { conversationId: "job_root" });
    const continued = createPreviewRecord("继续补充细节", "running", previewGenerationInputFromBody({ prompt: "继续补充细节", conversationId: "job_root" }));

    expect(root.job.conversation_id).toBe("job_root");
    expect(continued.job.conversation_id).toBe("job_root");
  });

  it("inherits the original conversation id when regenerating a preview job", () => {
    const source = createPreviewRecord("第一次创作", "succeeded", { conversationId: "job_root" });
    const regenerated = createPreviewRecord("重新生成", "running", {}, source.job);

    expect(regenerated.job.conversation_id).toBe("job_root");
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

  it("does not auto-enable preview mode on dev acceptance domains", () => {
    expect(previewModeFromInputs("", null, "dev-gen.fourj.space")).toBeNull();
    expect(previewModeFromInputs("", "history", "dev-gen.fourj.space")).toBe("history");
    expect(previewModeFromInputs("?preview=generating", null, "dev-gen.fourj.space")).toBe("generating");
  });
});
