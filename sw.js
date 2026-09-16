// sw.js -- offline play, and a cure for stale modules.
//
// Network first, cache second. That order is the whole point. A service
// worker that serves from cache first is how a site gets stuck on a version
// from last week, and this game has already been bitten once by a browser
// holding an old module against fresh HTML -- half the screen came out a slab
// of sky colour. Online you always get what was just deployed; the cache only
// answers when the network will not.
//
// Bump VERSION on any deploy that must evict the old cache outright. Day to
// day it does not need touching, because nothing stale is ever served while
// there is a network.

const VERSION = 'weblander-v1';

const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "js/audio.js",
  "js/biome.js",
  "js/blocks.js",
  "js/boats.js",
  "js/calibrate.js",
  "js/clouds.js",
  "js/daylight.js",
  "js/font.js",
  "js/game.js",
  "js/input.js",
  "js/landscape.js",
  "js/main.js",
  "js/maths.js",
  "js/model.js",
  "js/objects.js",
  "js/particles.js",
  "js/player.js",
  "js/renderer.js",
  "js/sea.js",
  "js/tanks.js",
  "js/tilt.js",
  "js/uav.js",
  "js/weather.js"
];

self.addEventListener('install', (e) => {
  // addAll fails the whole install if any single file 404s, which would leave
  // no worker at all. Fetch them individually and keep what we get.
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Only bank the good ones. Caching an error page is how a site starts
      // serving its own 404 offline.
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const hit = await caches.match(req);
      if (hit) return hit;
      // A navigation with nothing cached still deserves the game, not a
      // browser error page.
      if (req.mode === 'navigate') {
        const index = await caches.match('index.html');
        if (index) return index;
      }
      throw new Error('offline and not cached: ' + url.pathname);
    }
  })());
});
