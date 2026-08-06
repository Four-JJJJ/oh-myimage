import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveGenerationQueueAttempts } from "./env";

describe("node generation queue attempts", () => {
  it("defaults to three deliveries for safe post-processing recovery without provider retry", () => {
    expect(resolveGenerationQueueAttempts(undefined)).toBe(3);
    expect(resolveGenerationQueueAttempts("0", "0")).toBe(1);
  });

  it("uses the larger explicitly configured retry budget", () => {
    expect(resolveGenerationQueueAttempts("1", "0")).toBe(2);
    expect(resolveGenerationQueueAttempts("0", "2")).toBe(3);
    expect(resolveGenerationQueueAttempts("3", "2")).toBe(4);
  });

  it("keeps checked-in Node environment examples on the no-retry default", () => {
    for (const relativePath of ["../../.env.example", "../../deploy/oh-myimage-dev.env.example"]) {
      const contents = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(contents).toContain('PROVIDER_TIMEOUT_RETRY_ATTEMPTS="0"');
      expect(contents).toContain('PROVIDER_RETRY_ATTEMPTS="0"');
      expect(contents).toContain('POST_PROCESSING_RETRY_ATTEMPTS="2"');
      expect(contents).toContain('POST_PROCESSING_RETRY_DELAY_SECONDS="5"');
      expect(contents).toContain('GENERATION_JOB_MAX_RUNTIME_MS="840000"');
    }
  });
});
