/**
 * OPS-4 (v1.67.0) — minimalni service worker za PWA namestitev (tablica).
 *
 * STRATEGIJA: passthrough BREZ predpomnilnika (network-only).
 * Namen je izključno izpolnjevanje pogoja za "namesti aplikacijo" (Android/
 * Chrome zahteva SW z fetch handlerjem). Kakršno koli predpomnjenje bi tvegalo
 * zastarele Next.js chunk-e (stale cache = error boundary — lekcija iz OPS-2),
 * zato je to najvarnejša možna implementacija.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(fetch(e.request))
})
