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

  it.each([
    ["https://api.xyaigc.xyz", "https://api.xyaigc.xyz/v1"],
    [" https://api.xyaigc.xyz/ ", "https://api.xyaigc.xyz/v1"],
    ["https://api.xyaigc.xyz///", "https://api.xyaigc.xyz/v1"],
    ["https://api.xyaigc.xyz/v1/", "https://api.xyaigc.xyz/v1"],
    ["https://provider.example/api/v1/", "https://provider.example/api/v1"],
    ["https://provider.example/openai", "https://provider.example/openai"],
    ["https://provider.example/v1beta/", "https://provider.example/v1beta"],
    ["https://provider.example:8443", "https://provider.example:8443/v1"],
  ])("normalizes %s without changing explicit API paths", (input, normalized) => {
    expect(validateBaseURL(input)).toEqual({ ok: true, normalized });
    expect(validateBaseURL(normalized).normalized).toBe(normalized);
    for (const endpoint of ["/models", "/images/generations", "/images/edits", "/responses"]) {
      expect(buildProviderEndpoint(input, endpoint)).toBe(`${normalized}${endpoint}`);
    }
  });

  it.each([
    "http://provider.example", "https://localhost", "https://127.0.0.1",
    "https://user:pass@provider.example", "https://provider.example?key=secret",
    "https://provider.example#fragment", "not-a-url",
  ])("still rejects unsafe or invalid domain-only URLs: %s", (input) => {
    expect(validateBaseURL(input).ok).toBe(false);
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
