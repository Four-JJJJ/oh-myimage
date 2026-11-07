import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("image cache service worker policy", () => {
  it("uses a bounded v2 generated-image cache and includes thumbnails", () => {
    const policy = loadImageCachePolicy();

    expect(policy.IMAGE_CACHE_NAME).toBe("oh-myimage-generated-images-v2");
    expect(policy.IMAGE_CACHE_MAX_ENTRIES).toBe(200);
    expect(policy.isCacheableImageRequest(new URL("https://local.test/api/images/img_1/download?raw=1&sw=0"), { destination: "image" })).toBe(false);
    expect(policy.isCacheableImageRequest(new URL("https://local.test/api/images/img_1/thumbnail?sw=0"), { destination: "image" })).toBe(false);
    expect(policy.isCacheableImageRequest(new URL("https://local.test/api/images/img_1/thumbnail"), { destination: "image" })).toBe(true);
    expect(policy.isCacheableImageRequest(new URL("https://local.test/api/images/img_1/download?raw=1"), { destination: "image" })).toBe(true);
    expect(policy.isCacheableImageRequest(new URL("https://local.test/api/images/img_1/download?raw=1&download=1"), { destination: "image" })).toBe(false);
  });

  it("maps explicit downloads onto the cached inline original", () => {
    const policy = loadImageCachePolicy();
    expect(policy.cachedOriginalUrlForDownload(new URL("https://local.test/api/images/img_1/download?raw=1&download=1"))).toBe("https://local.test/api/images/img_1/download?raw=1");
    expect(policy.cachedOriginalUrlForDownload(new URL("https://local.test/api/images/img_1/download?raw=1&download=1&sw=0"))).toBeNull();
    expect(policy.cachedOriginalUrlForDownload(new URL("https://local.test/api/images/img_1/download?raw=1"))).toBeNull();
    expect(policy.cachedOriginalUrlForDownload(new URL("https://local.test/api/images/img_1/thumbnail?download=1"))).toBeNull();
  });

  it("serves a cached original as an attachment and falls back to the network on a miss", async () => {
    const cachedOriginal = new Response("png-bytes", {
      headers: { "Content-Type": "image/png", "Content-Disposition": 'inline; filename="img_1.png"' },
    });
    const store = new Map([["https://local.test/api/images/img_1/download?raw=1", cachedOriginal]]);
    const networkCalls: string[] = [];
    const policy = loadImageCachePolicy({
      caches: {
        keys: async () => [],
        delete: async () => true,
        open: async () => ({ match: async (url: string) => store.get(url) }),
      },
      fetch: async (request: Request) => {
        networkCalls.push(request.url);
        return new Response("network");
      },
    });

    const hit = await policy.downloadFromCache(new Request("https://local.test/api/images/img_1/download?raw=1&download=1"), "https://local.test/api/images/img_1/download?raw=1");
    expect(hit.headers.get("Content-Disposition")).toBe('attachment; filename="img_1.png"');
    expect(await hit.text()).toBe("png-bytes");
    expect(networkCalls).toEqual([]);

    const miss = await policy.downloadFromCache(new Request("https://local.test/api/images/img_2/download?raw=1&download=1"), "https://local.test/api/images/img_2/download?raw=1");
    expect(await miss.text()).toBe("network");
    expect(networkCalls).toEqual(["https://local.test/api/images/img_2/download?raw=1&download=1"]);
  });

  it("writes cache in the background so large image responses are not blocked", async () => {
    const source = readFileSync(resolve(process.cwd(), "public/image-cache-sw.js"), "utf8");
    expect(source).toContain("event.waitUntil(");
    expect(source).not.toContain("await cache.put(request, response.clone())");
  });

  it("evicts the oldest cache entries beyond the configured limit", async () => {
    const policy = loadImageCachePolicy();
    const deleted: string[] = [];
    const cache = {
      async keys() {
        return Array.from({ length: 202 }, (_, index) => ({ url: `https://local.test/api/images/img_${index}/thumbnail` }));
      },
      async delete(request: { url: string }) {
        deleted.push(request.url);
        return true;
      },
    };

    await policy.trimImageCache(cache);

    expect(deleted).toEqual(["https://local.test/api/images/img_0/thumbnail", "https://local.test/api/images/img_1/thumbnail"]);
  });
});

function loadImageCachePolicy(overrides: Record<string, unknown> = {}) {
  const source = readFileSync(resolve(process.cwd(), "public/image-cache-sw.js"), "utf8");
  const listeners: Record<string, unknown> = {};
  const context = {
    URL,
    Promise,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({}),
    },
    self: {
      location: { origin: "https://local.test" },
      addEventListener(type: string, handler: unknown) {
        listeners[type] = handler;
      },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
    },
    fetch: async () => new Response(),
    Response,
    Headers,
    ...overrides,
  };
  vm.runInNewContext(source, context);
  return (context.self as unknown as { __OH_MYIMAGE_IMAGE_CACHE_TEST__: ImageCachePolicy }).__OH_MYIMAGE_IMAGE_CACHE_TEST__;
}

interface ImageCachePolicy {
  IMAGE_CACHE_NAME: string;
  IMAGE_CACHE_MAX_ENTRIES: number;
  isCacheableImageRequest(url: URL, request: { destination?: string }): boolean;
  cachedOriginalUrlForDownload(url: URL): string | null;
  downloadFromCache(request: Request, originalUrl: string): Promise<Response>;
  trimImageCache(cache: { keys(): Promise<Array<{ url: string }>>; delete(request: { url: string }): Promise<boolean> }): Promise<void>;
}
