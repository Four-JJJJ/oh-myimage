import { describe, expect, it } from "vitest";
import {
  buildProviderEndpoint,
  getUnsafeIPAddressReason,
  isTokenFourjBaseURL,
  isUnsafeIPAddress,
  validateBaseURL,
  validateResolvedBaseURL,
} from "./security";

describe("baseURL safety", () => {
  it("accepts public HTTPS provider URLs", () => {
    expect(validateBaseURL("https://api.openai.com/v1").ok).toBe(true);
  });

  it("rejects non-HTTPS URLs", () => {
    expect(validateBaseURL("http://api.openai.com/v1").ok).toBe(false);
  });

  it("rejects credentials, query strings, hashes, localhost, local domains, and IP literals", () => {
    expect(validateBaseURL("https://user:pass@api.openai.com/v1").ok).toBe(false);
    expect(validateBaseURL("https://api.openai.com/v1?debug=true").ok).toBe(false);
    expect(validateBaseURL("https://api.openai.com/v1#models").ok).toBe(false);
    expect(validateBaseURL("https://localhost/v1").ok).toBe(false);
    expect(validateBaseURL("https://service.localhost/v1").ok).toBe(false);
    expect(validateBaseURL("https://printer.local/v1").ok).toBe(false);
    expect(validateBaseURL("https://127.0.0.1/v1").ok).toBe(false);
    expect(validateBaseURL("https://2130706433/v1").ok).toBe(false);
    expect(validateBaseURL("https://[::1]/v1").ok).toBe(false);
  });

  it("classifies unsafe IPv4 ranges", () => {
    expect(getUnsafeIPAddressReason("10.0.0.12")).toBe("private");
    expect(getUnsafeIPAddressReason("172.16.0.1")).toBe("private");
    expect(getUnsafeIPAddressReason("192.168.1.2")).toBe("private");
    expect(getUnsafeIPAddressReason("127.0.0.1")).toBe("loopback");
    expect(getUnsafeIPAddressReason("169.254.169.254")).toBe("link_local");
    expect(getUnsafeIPAddressReason("100.64.0.1")).toBe("carrier_grade_nat");
    expect(getUnsafeIPAddressReason("198.18.0.1")).toBe("benchmarking");
    expect(getUnsafeIPAddressReason("203.0.113.10")).toBe("documentation");
    expect(getUnsafeIPAddressReason("224.0.0.1")).toBe("multicast");
    expect(isUnsafeIPAddress("8.8.8.8")).toBe(false);
  });

  it("classifies unsafe IPv6 ranges", () => {
    expect(getUnsafeIPAddressReason("::")).toBe("unspecified");
    expect(getUnsafeIPAddressReason("::1")).toBe("loopback");
    expect(getUnsafeIPAddressReason("::ffff:127.0.0.1")).toBe("ipv4_mapped");
    expect(getUnsafeIPAddressReason("fc00::1")).toBe("unique_local");
    expect(getUnsafeIPAddressReason("fd12:3456::1")).toBe("unique_local");
    expect(getUnsafeIPAddressReason("fe80::1")).toBe("link_local");
    expect(getUnsafeIPAddressReason("2001:db8::1")).toBe("documentation");
    expect(getUnsafeIPAddressReason("ff02::1")).toBe("multicast");
    expect(isUnsafeIPAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("validates DNS-resolved public addresses via an injectable resolver", async () => {
    await expect(validateResolvedBaseURL("https://api.openai.com/v1", async () => ["8.8.8.8"])).resolves.toEqual({
      ok: true,
      normalized: "https://api.openai.com/v1",
    });
  });

  it("rejects DNS-resolved private and IPv6 link-local addresses", async () => {
    await expect(validateResolvedBaseURL("https://api.openai.com/v1", async () => ["10.0.0.5"])).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("private"),
    });

    await expect(
      validateResolvedBaseURL("https://api.openai.com/v1", async () => [{ address: "fe80::1", family: 6 }]),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("link_local"),
    });
  });

  it("fails closed when DNS resolution fails or returns no addresses", async () => {
    await expect(
      validateResolvedBaseURL("https://api.openai.com/v1", async () => {
        throw new Error("resolver unavailable");
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "baseURL 主机 DNS 解析失败，无法确认安全性。",
    });

    await expect(validateResolvedBaseURL("https://api.openai.com/v1", async () => [])).resolves.toMatchObject({
      ok: false,
      error: "baseURL 主机 DNS 未返回可验证地址。",
    });
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
