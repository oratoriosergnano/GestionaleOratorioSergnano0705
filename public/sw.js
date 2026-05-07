// Service Worker — Oratorio Sergnano Gestionale
// VERSIONE: aggiorna questo numero ad ogni deploy importante
const CACHE_VERSION = 'oratorio-v4'
const CACHE_STATIC  = CACHE_VERSION

const OFFLINE_ASSETS = ['/', '/index.html']

// ── INSTALL ──────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(c => c.addAll(OFFLINE_ASSETS))
      .catch(() => {})
  )
  self.skipWaiting()
})

// ── ACTIVATE — elimina cache vecchie ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_STATIC).map(k => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// ── FETCH — Network first ─────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = e.request.url
  if (url.includes('supabase.co'))      return
  if (url.includes('api.qrserver.com')) return
  if (url.includes('fonts.googleapis')) return
  if (url.includes('fonts.gstatic'))    return
  if (url.includes('kaspersky-labs.com')) return // Ignora Kaspersky per evitare errori in console

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && url.startsWith(self.location.origin)) {
          const clone = res.clone()
          caches.open(CACHE_STATIC).then(c => c.put(e.request, clone))
        }
        return res
      })
      .catch(() =>
        caches.match(e.request).then(cached =>
          cached || caches.match('/index.html')
        )
      )
  )
})

// ── PUSH NOTIFICATIONS (compatibile iOS + Android) ────────────────────
self.addEventListener('push', e => {
  let titolo = 'Oratorio di Sergnano'
  let corpo  = 'Hai una nuova notifica.'
  let url    = '/'

  try {
    if (e.data) {
      try {
        const d = e.data.json()
        titolo = d.titolo || titolo
        corpo  = d.corpo  || corpo
        url    = d.url    || url
      } catch {
        corpo = e.data.text() || corpo
      }
    }
  } catch {}

  e.waitUntil(
    self.registration.showNotification(titolo, {
      body:     corpo,
      icon:     '/logo-oratorio.png',
      badge:    '/logo-oratorio.png',
      vibrate:  [200, 100, 200],
      tag:      'oratorio-' + Date.now(),
      renotify: true,
      data:     { url },
    })
  )
})

// ── CLICK NOTIFICA → apre l'app ───────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = e.notification.data?.url || '/'
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes(self.location.origin) && 'focus' in c)
      if (existing) return existing.focus()
      return clients.openWindow(url)
    })
  )
})

// ── SKIP WAITING dal client ───────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
