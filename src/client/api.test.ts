import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedImageRetryUrl, getGenerationStatus } from "./api";

describe("generation status requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bypasses HTTP caches and encodes the requested job id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, job: {}, images: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await getGenerationStatus("job/1");

    expect(fetchMock).toHaveBeenCalledWith("/api/generations/job%2F1", expect.objectContaining({
      cache: "no-store",
      headers: expect.any(Headers),
      signal: expect.any(AbortSignal),
    }));
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Cache-Control")).toBe("no-cache");
  });

  it("retries once after a stalled status request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, job: {}, images: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const request = getGenerationStatus("job_1", 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases a stalled status read at its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const request = getGenerationStatus("job_1", 500);
    const expectation = expect(request).rejects.toThrow("获取生成状态超时，系统会自动重试。");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });
});

describe("generated image cache bypass URLs", () => {
  it("bypasses the Service Worker and gives every retry a fresh URL", () => {
    expect(generatedImageRetryUrl("/api/images/img_1/download?raw=1", 0)).toBe("/api/images/img_1/download?raw=1&sw=0&retry=0");
    expect(generatedImageRetryUrl("/api/images/img_1/download?raw=1", 1)).toBe("/api/images/img_1/download?raw=1&sw=0&retry=1");
  });
});
