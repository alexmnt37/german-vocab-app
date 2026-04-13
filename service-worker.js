/*
  WORTSCHATZ — Service Worker
  Caches all core app files so the app works
  fully offline after the first load.
*/

// ── Cache name — bump the version string to force
//    a fresh cache when you deploy an update ──
const CACHE_NAME = 'wortschatz-v1';

// All files that must be available offline
const CORE_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
];

// ── INSTALL: pre-cache all core files ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CORE_FILES);
    })
  );
  // Activate the new SW immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── ACTIVATE: delete any old caches from previous versions ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ── FETCH: serve from cache, fall back to network ──
// Strategy: Cache First for core app files,
//           Network First for Google Fonts (they may update).
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (e.g. POST)
  if (event.request.method !== 'GET') return;

  // For Google Fonts: try network first, fall back to cache
  if (url.hostname.includes('fonts.')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache a clone for next time
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For everything else: try cache first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      // Not in cache — fetch from network and cache for next time
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
