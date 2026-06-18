import { describe, expect, it } from "vitest";
import { createR2Store } from "./r2-store";

describe("createR2Store", () => {
  it("falls back to the Cloudflare R2 endpoint when R2_ENDPOINT is blank", async () => {
    const store = createR2Store({
      accountId: "acct123",
      endpoint: "",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "image-bucket",
    });

    const url = await store.createPresignedGetUrl?.("images/example.png");

    expect(url).toContain("acct123.r2.cloudflarestorage.com");
    expect(url).not.toContain("s3.auto.amazonaws.com");
  });
});
