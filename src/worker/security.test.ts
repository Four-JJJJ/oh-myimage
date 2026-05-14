import { describe, expect, it } from "vitest";
import { buildProviderEndpoint, isTokenFourjBaseURL, validateBaseURL } from "./security";

describe("baseURL safety", () => {
  it("accepts public HTTPS provider URLs", () => {
    expect(validateBaseURL("https://api.openai.com/v1").ok).toBe(true);
  });

  it("rejects non-HTTPS URLs", () => {
    expect(validateBaseURL("http://api.openai.com/v1").ok).toBe(false);
  });

  it("rejects localhost and IP literals", () => {
    expect(validateBaseURL("https://localhost/v1").ok).toBe(false);
    expect(validateBaseURL("https://127.0.0.1/v1").ok).toBe(false);
    expect(validateBaseURL("https://[::1]/v1").ok).toBe(false);
  });

  it("builds OpenAI compatible endpoints", () => {
    expect(buildProviderEndpoint("https://api.openai.com/v1", "/images/generations")).toBe(
      "https://api.openai.com/v1/images/generations",
    );
  });

  it("detects token.fourj.space provider URLs", () => {
    expect(isTokenFourjBaseURL("https://token.fourj.space/v1")).toBe(true);
    expect(isTokenFourjBaseURL("https://api.openai.com/v1")).toBe(false);
    expect(isTokenFourjBaseURL("https://not-token.fourj.space/v1")).toBe(false);
  });
});
