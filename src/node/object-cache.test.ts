import { describe, expect, it, vi } from "vitest";
import type { AppObjectStore } from "../worker/types";
import { isGeneratedThumbnailKey, resolveSmallObjectCacheOptions, withSmallObjectCache } from "./object-cache";

function memoryStore(objects: Record<string, Uint8Array>) {
  const get = vi.fn(async (key: string) => {
    const bytes = objects[key];
    if (!bytes) return null;
    return {
      body: new Response(bytes as Uint8Array<ArrayBuffer>).body,
      httpMetadata: { contentType: "image/webp" },
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  });
  const store: AppObjectStore = {
    get,
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
  };
  return { store, get };
}

const thumbKey = "space/job/thumb_img_job_0.webp";

describe("withSmallObjectCache", () => {
  it("serves repeated thumbnail reads from memory with a fresh body each time", async () => {
    const { store, get } = memoryStore({ [thumbKey]: new Uint8Array([1, 2, 3]) });
    const cached = withSmallObjectCache(store, { maxTotalBytes: 1024, maxObjectBytes: 1024, shouldCache: isGeneratedThumbnailKey });

    const first = await cached.get(thumbKey);
    const second = await cached.get(thumbKey);
    expect(get).toHaveBeenCalledTimes(1);
    expect(second?.httpMetadata?.contentType).toBe("image/webp");
    expect(new Uint8Array(await new Response(first!.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await new Response(second!.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("deduplicates concurrent misses", async () => {
    const { store, get } = memoryStore({ [thumbKey]: new Uint8Array([9]) });
    const cached = withSmallObjectCache(store, { maxTotalBytes: 1024, maxObjectBytes: 1024, shouldCache: isGeneratedThumbnailKey });
    await Promise.all([cached.get(thumbKey), cached.get(thumbKey), cached.get(thumbKey)]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache for non-thumbnail keys and missing objects", async () => {
    const { store, get } = memoryStore({ "space/job/img_job_0.png": new Uint8Array([1]) });
    const cached = withSmallObjectCache(store, { maxTotalBytes: 1024, maxObjectBytes: 1024, shouldCache: isGeneratedThumbnailKey });
    await cached.get("space/job/img_job_0.png");
    await cached.get("space/job/img_job_0.png");
    expect(get).toHaveBeenCalledTimes(2);
    expect(await cached.get("space/job/thumb_missing.webp")).toBeNull();
  });

  it("evicts least recently used entries past the byte budget and on delete", async () => {
    const keys = ["a/thumb_1.webp", "a/thumb_2.webp", "a/thumb_3.webp"];
    const { store, get } = memoryStore(Object.fromEntries(keys.map((key) => [key, new Uint8Array(4)])));
    const cached = withSmallObjectCache(store, { maxTotalBytes: 8, maxObjectBytes: 8, shouldCache: isGeneratedThumbnailKey });
    await cached.get(keys[0]);
    await cached.get(keys[1]);
    await cached.get(keys[0]); // touch 1 so 2 becomes the oldest
    await cached.get(keys[2]); // evicts 2
    get.mockClear();
    await cached.get(keys[0]);
    await cached.get(keys[2]);
    expect(get).not.toHaveBeenCalled();
    await cached.get(keys[1]);
    expect(get).toHaveBeenCalledTimes(1);

    await cached.delete(keys[2]);
    await cached.get(keys[2]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSmallObjectCacheOptions", () => {
  it("defaults to 64MB and can be disabled", () => {
    expect(resolveSmallObjectCacheOptions({})?.maxTotalBytes).toBe(64 * 1024 * 1024);
    expect(resolveSmallObjectCacheOptions({ THUMBNAIL_CACHE_MB: "0" })).toBeNull();
  });
});
