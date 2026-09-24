/* TeslaNaviGeorgia — service worker
 * Keeps what the app needs on the device, so it starts at once and shows the map
 * already seen even on a slow or missing connection:
 * - the app itself (page, styles, scripts, icons) is stored as one set per
 *   deployment, so a page never mixes old and new files. A new deployment is
 *   fetched in the background and used from the next start.
 * - the map library: its files are versioned by path, so they are kept for good.
 * - map pieces (vector tiles, label fonts, sprites, 3D elevation) are kept as they
 *   are fetched, up to a limit, oldest out first.
 * - the road updates and the speed camera list: fresh when online, the last copy
 *   when not.
 * Routes, speed limits, search and the phone inbox always go to the network.
 */
'use strict';

// src/worker.js replaces this with the deployment id, so every deployment is a new
// service worker, and with it a fresh copy of the app
const VERSION = '__VERSION__';

const APP_CACHE = `app-${VERSION}`;
const LIB_CACHE = 'lib-v1';
const MAP_CACHE = 'map-v1';
const DATA_CACHE = 'data-v1';
// Entries, not bytes: a dense city tile is ~300 KB, a rural one or a font far less
const MAP_LIMIT = 1000;

const APP_FILES = [
  '/', '/send', '/style.css', '/boot.js', '/nav.js', '/app.js',
  '/manifest.webmanifest', '/icon.svg', '/favicon-32.png', '/icon-192.png', '/apple-touch-icon.png',
  '/vendor/qrcode-generator-2.0.4/qrcode.js',
];
// The map library for current screens. Older screens keep theirs on first use.
const LIB_FILES = [
  '/vendor/maplibre-gl-5.24.0/maplibre-gl.js',
  '/vendor/maplibre-gl-5.24.0/maplibre-gl.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    // no-cache: take this deployment's files from the server, not the HTTP cache
    await app.addAll(APP_FILES.map((url) => new Request(url, { cache: 'no-cache' })));
    const lib = await caches.open(LIB_CACHE);
    for (const url of LIB_FILES) {
      if (!(await lib.match(url))) await lib.add(url).catch(() => {});
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // Deep links (/?to=…) and shared links (/send?url=…) are the same two pages
    if (req.mode === 'navigate' && url.pathname === '/') return event.respondWith(fromApp('/', req));
    if (req.mode === 'navigate' && url.pathname === '/send') return event.respondWith(fromApp('/send', req));
    if (APP_FILES.includes(url.pathname)) return event.respondWith(fromApp(url.pathname, req));
    if (url.pathname.startsWith('/vendor/')) return event.respondWith(cacheFirst(event, LIB_CACHE));
    if (url.pathname.startsWith('/api/dem/')) return event.respondWith(cacheFirst(event, MAP_CACHE));
    if (url.pathname === '/updates.json' || url.pathname === '/api/cameras') {
      return event.respondWith(networkFirst(event, DATA_CACHE));
    }
    return;   // routes, speed limits, search, the inbox: straight to the network
  }

  if (url.hostname === 'tiles.openfreemap.org') {
    // Tiles, fonts and sprites sit under versioned paths and never change
    if (/\.(pbf|png|json)$/.test(url.pathname)) return event.respondWith(cacheFirst(event, MAP_CACHE));
    // The styles and the tile index move on when OpenFreeMap publishes new data
    return event.respondWith(staleWhileRevalidate(event, MAP_CACHE));
  }
});

// This deployment's copy; the network only if it is missing
async function fromApp(key, req) {
  const hit = await (await caches.open(APP_CACHE)).match(key);
  return hit || fetch(req);
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) event.waitUntil(keep(cache, event.request, res.clone()));
  return res;
}

async function networkFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(event.request);
    if (res.ok) event.waitUntil(keep(cache, event.request, res.clone()));
    return res;
  } catch (err) {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const fresh = fetch(event.request).then((res) => {
    if (res.ok) event.waitUntil(keep(cache, event.request, res.clone()));
    return res;
  });
  if (!hit) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return hit;
}

// Store a response. Every 50 stores the map cache is trimmed, oldest entries
// first (keys() lists them in the order they were stored).
let putsSinceTrim = 0;
async function keep(cache, req, res) {
  try {
    await cache.put(req, res);
  } catch {
    return;   // storage full or refused: the app still works from the network
  }
  if (++putsSinceTrim < 50) return;
  putsSinceTrim = 0;
  const map = await caches.open(MAP_CACHE);
  const keys = await map.keys();
  for (let i = 0; i < keys.length - MAP_LIMIT; i++) await map.delete(keys[i]);
}
