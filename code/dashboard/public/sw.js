// ATProto Developer Feed Monitor — Service Worker (Section 5.2)
// Passive caching strategy: network-first, cache as fallback.

const CACHE_NAME = "dev-feed-v1";
const STATIC_ASSETS = ["/", "/feed", "/manifest.json"];

// Install event — pre-cache static shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate event — clean up old cache versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Fetch event — network-first, fallback to cache
self.addEventListener("fetch", (event) => {
  // Only intercept GET requests
  if (event.request.method !== "GET") return;

  // Do not intercept Firebase/Firestore API calls
  const url = new URL(event.request.url);
  if (
    url.hostname.endsWith("firebaseio.com") ||
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("firestore.googleapis.com")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a clone of any successful response
        if (response && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache on network failure
        return caches.match(event.request).then(
          (cached) => cached || new Response("Offline — no cached version available.", { status: 503 })
        );
      })
  );
});
