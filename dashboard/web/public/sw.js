// Fleet service worker: pushes from the dashboard server, and an offline copy of the app and your notes.
// Online, everything comes from the Mac. When the Mac can't be reached, the app shell and the last copy of
// your lists and ideas are served from here (marked X-Fleet-Offline so the page can say so).
const SHELL = 'fleet-shell-v1'
const DATA = 'fleet-data-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

async function fromCache(cacheName, key) {
  const hit = await (await caches.open(cacheName)).match(key)
  if (!hit) return null
  const headers = new Headers(hit.headers)
  headers.set('X-Fleet-Offline', '1')
  return new Response(await hit.blob(), { status: hit.status, headers })
}

// a request that hangs (a flaky phone connection) gives up after 10 s and uses the saved copy, instead of waiting a minute
const timeout = (request, ms) => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('timeout')), ms)
  fetch(request).then(r => { clearTimeout(t); ok(r) }, e => { clearTimeout(t); fail(e) })
})

async function networkFirst(request, cacheName, key = request) {
  try {
    const res = await timeout(request, request.mode === 'navigate' ? 15_000 : 10_000)
    if (res.ok) (await caches.open(cacheName)).put(key, res.clone())
    return res
  } catch {
    return (await fromCache(cacheName, key))
      ?? new Response(JSON.stringify({ error: "Your Mac isn't reachable right now." }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Fleet-Offline': '1' } })
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone())
  return res
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin || e.request.method !== 'GET' || url.pathname.startsWith('/ws/')) return
  if (url.pathname.startsWith('/api/')) {
    if (/^\/api\/(lists|ideas|folders|settings)(\?|$)/.test(url.pathname + url.search.slice(0, 1))) e.respondWith(networkFirst(e.request, DATA))
    return
  }
  if (e.request.mode === 'navigate') return e.respondWith(networkFirst(e.request, SHELL, '/'))
  if (url.pathname.startsWith('/assets/') || /\.(png|webmanifest|svg)$/.test(url.pathname)) e.respondWith(cacheFirst(e.request))
})

self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {}
  e.waitUntil(self.registration.showNotification(d.title || 'Fleet', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || '/' },
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const w = windows[0]
    return w ? w.navigate(url).then(n => (n || w).focus()) : self.clients.openWindow(url)
  }))
})
