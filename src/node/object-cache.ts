import type { AppObject, AppObjectStore } from "../worker/types";

export interface SmallObjectCacheOptions {
  /** Total bytes kept in memory across all cached objects. */
  maxTotalBytes: number;
  /** Objects larger than this are never cached. */
  maxObjectBytes: number;
  /** Only keys accepted here are cached; they must be immutable (content never changes under the same key). */
  shouldCache(key: string): boolean;
}

interface CacheEntry {
  bytes: Uint8Array;
  httpMetadata: AppObject["httpMetadata"];
}

/** Generated thumbnails are written once under a unique key and never rewritten. */
export function isGeneratedThumbnailKey(key: string): boolean {
  return /\/thumb_[^/]+$/.test(key);
}

export function resolveSmallObjectCacheOptions(env: NodeJS.ProcessEnv = process.env): SmallObjectCacheOptions | null {
  const maxMb = Number(env.THUMBNAIL_CACHE_MB ?? 64);
  if (!Number.isFinite(maxMb) || maxMb <= 0) return null;
  return {
    maxTotalBytes: Math.floor(maxMb * 1024 * 1024),
    maxObjectBytes: 1024 * 1024,
    shouldCache: isGeneratedThumbnailKey,
  };
}

/**
 * Wraps an object store with an in-memory LRU for small immutable objects
 * (generated thumbnails). A gallery page requests dozens of thumbnails at once;
 * serving repeats from memory skips the round trip to R2 for each one.
 */
export function withSmallObjectCache(store: AppObjectStore, options: SmallObjectCacheOptions): AppObjectStore {
  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry | null>>();
  let totalBytes = 0;

  const evict = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes.byteLength;
  };

  const remember = (key: string, entry: CacheEntry) => {
    evict(key);
    entries.set(key, entry);
    totalBytes += entry.bytes.byteLength;
    for (const oldestKey of entries.keys()) {
      if (totalBytes <= options.maxTotalBytes) break;
      evict(oldestKey);
    }
  };

  const load = async (key: string): Promise<CacheEntry | null> => {
    const object = await store.get(key);
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const entry = { bytes, httpMetadata: object.httpMetadata };
    if (bytes.byteLength <= options.maxObjectBytes) remember(key, entry);
    return entry;
  };

  const cached: AppObjectStore = {
    async get(key) {
      if (!options.shouldCache(key)) return store.get(key);
      const hit = entries.get(key);
      if (hit) {
        // Refresh recency (Map iteration order is insertion order).
        entries.delete(key);
        entries.set(key, hit);
        return cachedObject(hit);
      }
      let pending = inflight.get(key);
      if (!pending) {
        pending = load(key).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const entry = await pending;
      return entry ? cachedObject(entry) : null;
    },
    async put(key, value, putOptions) {
      evict(key);
      return store.put(key, value, putOptions);
    },
    async delete(key) {
      evict(key);
      return store.delete(key);
    },
  };
  if (store.copy) {
    const copy = store.copy.bind(store);
    cached.copy = async (sourceKey, destinationKey, copyOptions) => {
      evict(destinationKey);
      return copy(sourceKey, destinationKey, copyOptions);
    };
  }
  if (store.createPresignedGetUrl) cached.createPresignedGetUrl = store.createPresignedGetUrl.bind(store);
  return cached;
}

function cachedObject(entry: CacheEntry): AppObject {
  return {
    httpMetadata: entry.httpMetadata,
    get body(): ReadableStream<Uint8Array> {
      const bytes = entry.bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async arrayBuffer() {
      return entry.bytes.slice().buffer as ArrayBuffer;
    },
  };
}
