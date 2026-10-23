// Fleet service worker: shows pushes from the dashboard server and opens the agent they're about.
// No offline caching: the page is useless without the Mac anyway.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

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
