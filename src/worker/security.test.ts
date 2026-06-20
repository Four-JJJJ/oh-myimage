import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderEndpoint, isTokenFourjBaseURL, validateBaseURL, verifyTurnstile } from "./security";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("detects Small Token provider URLs", () => {
    expect(isTokenFourjBaseURL("https://token.fourj.space/v1")).toBe(true);
    expect(isTokenFourjBaseURL("https://image.fourj.space/v1")).toBe(true);
    expect(isTokenFourjBaseURL("https://api.openai.com/v1")).toBe(false);
    expect(isTokenFourjBaseURL("https://not-token.fourj.space/v1")).toBe(false);
  });
});

describe("Turnstile verification", () => {
  it("uses an abort signal for Cloudflare verification requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyTurnstile("turnstile-token", new Request("https://local.test/api/auth/space-login"), {
        TURNSTILE_SECRET_KEY: "secret",
      } as never),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
