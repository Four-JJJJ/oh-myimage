import { describe, expect, it } from "vitest";
import { isInspirationQueueMessage, normalizeInspirationUrl, parseInspirationTags } from "./inspiration";

describe("inspiration helpers", () => {
  it("normalizes X status URLs without enabling webpage scraping", () => {
    const result = normalizeInspirationUrl("https://x.com/example/status/1234567890?s=20#fragment");
    expect(result).toEqual({
      normalizedUrl: "https://x.com/example/status/1234567890",
      sourceKey: "x",
      tweetId: "1234567890",
    });
  });

  it("rejects unsafe import URLs", () => {
    expect(() => normalizeInspirationUrl("http://example.com/image")).toThrow("HTTPS");
    expect(() => normalizeInspirationUrl("https://127.0.0.1/image")).toThrow("内网");
  });

  it("parses stored tag JSON defensively", () => {
    expect(parseInspirationTags('["product","poster",3,""]')).toEqual(["product", "poster"]);
    expect(parseInspirationTags("not json")).toEqual([]);
  });

  it("detects inspiration queue messages", () => {
    expect(isInspirationQueueMessage({ type: "inspiration-source", sourceId: "src_civitai", trigger: "scheduled" })).toBe(true);
    expect(isInspirationQueueMessage({ jobId: "job_1", spaceId: "spc_1" })).toBe(false);
  });
});
