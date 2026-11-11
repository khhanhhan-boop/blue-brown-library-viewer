const CACHE_NAME = "blue-brown-viewer-v35-project-links";
const APP_SHELL = ["./index.html", "./viewer.css", "./viewer.js", "./config.js", "./vendor/supabase.min.js", "./icon.png", "./icon.png?v=20261108A", "./icon-maskable.png", "./icon-maskable.png?v=20261108A", "./apple-touch-icon.png", "./apple-touch-icon.png?v=20261108A", "./manifest.webmanifest", "./manifest.webmanifest?v=20261108A"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match("./index.html"))));
});
