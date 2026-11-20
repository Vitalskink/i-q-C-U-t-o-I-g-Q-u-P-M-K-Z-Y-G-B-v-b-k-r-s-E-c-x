/*
 * Gams no longer keeps anything in the browser. This file exists only to take
 * over from the old offline service worker, throw its caches away and then
 * unregister itself, so a browser that still has the old worker installed
 * does not keep serving an old copy of the menu.
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (key) { return caches.delete(key); }));
    } catch (e) { /* ignore */ }
    try { await self.registration.unregister(); } catch (e) { /* ignore */ }
  })());
});
