/* Filament service worker.
 *
 * The shell is a small set of immutable, content-hashed files. Strategy:
 *   · navigation  → cache-first on index.html (the shell is the same for
 *                   every route; the route lives in the hash), revalidated in
 *                   the background.
 *   · /assets/*   → cache-first, forever (names are content hashes).
 *   · /fonts/*    → cache-first, forever.
 *   · /api/*      → never cached: those are live filesystem reads.
 *
 * Cache-first here is what turns a reload into a ~0 ms network wait, which is
 * the whole "the UI is already there" feeling.
 */
const VERSION = "filament-v3";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/auth") {
    return; // never cache live data
  }

  const immutable = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/");

  if (immutable) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  if (req.mode === "navigate" || url.pathname === "/index.html" || url.pathname === "/") {
    event.respondWith(
      caches.match("/index.html").then((hit) => {
        const network = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("/index.html", copy));
            return res;
          })
          .catch(() => hit);
        return hit || network;
      })
    );
  }
});
