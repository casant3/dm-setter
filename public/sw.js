/*
 * Service worker.
 *
 * Its only job is to make the app installable and to serve the static build
 * assets quickly. It deliberately does NOT cache:
 *
 *   - any /api response, which is prospect data;
 *   - any HTML document, which is rendered behind authentication;
 *   - anything at all on a non-GET request.
 *
 * An offline cache of conversations would put private data in a store that
 * outlives the session and survives sign-out, which is not a trade worth making
 * for a tool that is useless without the network anyway.
 */

const CACHE = "dm-setter-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/icon-192.png", "/icon-512.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Everything private goes straight to the network, every time.
  if (!isStaticAsset(url)) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          // Build assets are content-hashed, so caching them is safe and stale
          // copies are impossible.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
