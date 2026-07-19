/* ==========================================================================
   simul — sw.js
   Cache l'app shell pour un usage hors-ligne. Les tuiles de carte
   restent en reseau (network-only, echec silencieux si offline) :
   la geoloc/carte est un bonus, jamais un blocage pour capturer.
   ========================================================================== */

const CACHE_NAME = 'simul-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/capture.js',
  './js/storage.js',
  './js/map.js',
  './js/share.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Tuiles OSM et tout appel externe : reseau uniquement, jamais de cache.
  if (url.origin !== self.location.origin){
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
