// ARECO Ops - minimal app-shell service worker.
// Only caches static assets (CSS/JS/icons), never HTML or API responses, so
// authenticated/role-specific pages are always fetched fresh from the network.
var CACHE_NAME = 'areco-shell-v1';
var SHELL_ASSETS = [
  '/static/css/areco-brand.css',
  '/static/js/app-shell.js',
  '/assets/areco-favicon-32.png',
  '/assets/areco-favicon-48.png',
  '/assets/areco-apple-touch.png',
  '/assets/areco-pwa-192.png',
  '/assets/areco-pwa-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isShellAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname.startsWith('/static/css/') ||
    url.pathname.startsWith('/static/js/') ||
    (url.pathname.startsWith('/assets/') && /\.(png|jpg|jpeg|svg|ico)$/i.test(url.pathname))
  );
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (!isShellAsset(url)) return; // let HTML pages and API calls hit the network untouched

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var fetchPromise = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || fetchPromise;
    })
  );
});
