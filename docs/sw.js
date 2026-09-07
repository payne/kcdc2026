"use strict";

/* ---------------------------------------------------------------------
 * Service worker: makes the app shell and last-fetched data available
 * offline. Strategy is plain cache-first for every same-origin GET —
 * once something has been fetched once (on install, or opportunistically
 * at runtime), it's served from the cache instantly and without a
 * network round-trip, including with no connection at all.
 *
 * This worker does NOT decide when data is stale. app.js owns that: it
 * polls the tiny data/version.json marker and, when a hash in it has
 * changed, explicitly deletes that one cache entry and re-fetches it
 * (see checkForUpdates() in app.js). CACHE_NAME here must match the
 * constant of the same name in app.js.
 * ------------------------------------------------------------------- */

const CACHE_NAME = "kcdc2026-v1";

// Core shell — precached on install so the very first offline load (after
// at least one prior online visit) still renders. Data files aren't listed
// here; they get cached the first time app.js fetches them.
const APP_SHELL = ["./", "index.html", "app.js", "style.css", "data/version.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // event.waitUntil, not a detached promise: without it the browser
        // can tear down the worker as soon as `res` is returned, before
        // this write ever lands, and the response would never get cached.
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
        }
        return res;
      });
    })
  );
});
