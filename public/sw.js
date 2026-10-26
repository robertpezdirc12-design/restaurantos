/**
 * OPS-4 (v1.67.0) — minimalni service worker za PWA namestitev (tablica).
 * OPS-7 (v1.70.0) — push + notificationclick handler (Web Push, brez cache sprememb).
 *
 * STRATEGIJA: passthrough BREZ predpomnilnika (network-only).
 * Namen je izključno izpolnjevanje pogoja za "namesti aplikacijo" (Android/
 * Chrome zahteva SW z fetch handlerjem) + prejem push obvestil. Kakršno koli
 * predpomnjenje bi tvegalo zastarele Next.js chunk-e (stale cache = error
 * boundary — lekcija iz OPS-2), zato ostaja passthrough.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(fetch(e.request))
})

// OPS-7: push obvestila (nova naročila → kuhinja/bar, pripravljeno → natakar)
self.addEventListener('push', (e) => {
  let data = { title: 'RestaurantOS', body: '' }
  try {
    if (e.data) data = { ...data, ...e.data.json() }
  } catch (err) {
    if (e.data) data.body = e.data.text().slice(0, 140)
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'RestaurantOS', {
      body: data.body || '',
      tag: data.tag || undefined,
      data: { url: data.url || '/dashboard' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [120, 60, 120],
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/dashboard'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.navigate(url)
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
