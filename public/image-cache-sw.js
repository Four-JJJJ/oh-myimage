const IMAGE_CACHE_NAME = "oh-myimage-generated-images-v2";
const IMAGE_CACHE_MAX_ENTRIES = 200;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("oh-myimage-generated-images-") && key !== IMAGE_CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!isCacheableImageRequest(url, request)) return;

  event.respondWith(cacheFirst(request, event));
});

function isCacheableImageRequest(url, request) {
  if (url.searchParams.get("sw") === "0") return false;
  if (url.searchParams.get("download") === "1") return false;
  if (/^\/api\/images\/[^/]+\/download$/.test(url.pathname)) return url.searchParams.get("raw") === "1";
  if (/^\/api\/images\/[^/]+\/thumbnail$/.test(url.pathname)) return true;
  if (/^\/api\/generations\/[^/]+\/references\/\d+$/.test(url.pathname)) return true;
  return request.destination === "image" && url.pathname.startsWith("/api/inspirations/");
}

async function cacheFirst(request, event) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && isImageResponse(response)) {
    // 写入缓存放到后台执行，不阻塞返回响应；否则读大图时页面 fetch 会被
    // cache.put 消费 body 拖住，进度停在 0%。
    event.waitUntil(
      cache.put(request, response.clone()).then(() => trimImageCache(cache)).catch(() => undefined),
    );
  }
  return response;
}

function isImageResponse(response) {
  return (response.headers.get("Content-Type") || "").toLowerCase().startsWith("image/");
}

async function trimImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_MAX_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_MAX_ENTRIES).map((request) => cache.delete(request)));
}

self.__OH_MYIMAGE_IMAGE_CACHE_TEST__ = {
  IMAGE_CACHE_NAME,
  IMAGE_CACHE_MAX_ENTRIES,
  isCacheableImageRequest,
  trimImageCache,
};
