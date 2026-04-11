const CACHE = "video-player-shell-v1";
const ASSETS = [
  "./index.html",
  "./styles.css",
  "./player.js",
  "./manifest.webmanifest",
  "./icons/app.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const url = new URL(request.url);
        if (url.origin !== self.location.origin) return response;
        const copy = response.clone();
        if (response.status === 200) {
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
