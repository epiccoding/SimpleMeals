/**
 * Deliberately narrow in scope. Two jobs only:
 *
 * 1. Satisfy Chrome's installability requirement — a registered service
 *    worker with a fetch handler is one of the checks Chrome (and
 *    Bubblewrap, when this gets wrapped for the Play Store) runs before
 *    treating this as a "real" installable app.
 * 2. Cache the app *shell* — the static files that make the UI exist —
 *    so opening the app is fast and survives a flaky connection.
 *
 * It never caches anything from Supabase, and never caches third-party
 * CDN scripts (esm.sh, Google Fonts). Recipes, pantry status, and the
 * grocery list are exactly the kind of thing that must never be served
 * stale — showing "you have milk" from a cached response you don't
 * actually have anymore would be actively worse than no offline support
 * at all. Only the shell is cached; every real request still goes to
 * the network.
 */

// Bump this on every deploy that changes the shell files below, or
// visitors can get stuck on an old cached index.html/app.js forever.
const CACHE_NAME = "simplemeals-shell-v1";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names
        .filter((n) => n !== CACHE_NAME)
        .map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only ever handle same-origin GET requests for the shell files
  // themselves. Everything else — Supabase, esm.sh, Google Fonts,
  // analytics — passes straight through untouched.
  const isShellFile = url.origin === self.location.origin
    && event.request.method === "GET"
    && SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")));

  if (!isShellFile) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
      // Cache-first for instant loads; refreshes quietly in the
      // background so the next open picks up whatever just changed.
      return cached || network;
    })
  );
});
