const IMAGE_CACHE_NAME = "oh-myimage-generated-images-v1";

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

  event.respondWith(cacheFirst(request));
});

function isCacheableImageRequest(url, request) {
  if (url.searchParams.get("download") === "1") return false;
  if (/^\/api\/images\/[^/]+\/download$/.test(url.pathname)) return url.searchParams.get("raw") === "1";
  if (/^\/api\/generations\/[^/]+\/references\/\d+$/.test(url.pathname)) return true;
  return request.destination === "image" && url.pathname.startsWith("/api/inspirations/");
}

async function cacheFirst(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && isImageResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

function isImageResponse(response) {
  return (response.headers.get("Content-Type") || "").toLowerCase().startsWith("image/");
}
