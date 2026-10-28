import { runSync } from './sync.js';

// Bump VERSION on every deploy: it triggers the in-app "update" prompt.
const VERSION = 'hk-v1';
const SHELL = [
  '/', '/styles.css', '/app.js', '/db.js', '/sync.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // API: network only, never cached
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('/').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

// Background Sync: flush the outbox even if the app is closed
self.addEventListener('sync', (e) => {
  if (e.tag !== 'hk-sync') return;
  e.waitUntil(runSync().then((r) => {
    if (!r.ok && r.reason !== 'auth' && r.reason !== 'busy') throw new Error(r.reason); // browser retries
  }));
});