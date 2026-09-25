// TealTalk service worker: offline app shell + web push.
// Never caches /api or /ws: messages and attachments always come from the server
// (attachments rely on the browser's normal HTTP cache instead).

const CACHE = 'tealtalk-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/images.js',
  '/js/outbox.js',
  '/js/pwa.js',
  '/js/socket.js',
  '/js/store.js',
  '/js/ui/auth.js',
  '/js/ui/chat.js',
  '/js/ui/chats.js',
  '/js/ui/common.js',
  '/js/ui/newchat.js',
  '/js/ui/settings.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/badge-96.png',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add one by one so a single missing file doesn't abort the install.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tealtalk-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isLive(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/ws');
}

/**
 * App shell: network first (so updates land immediately and all modules stay
 * the same version), falling back to the cache when offline or very slow.
 */
async function shellFetch(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    // Only an HTML page may become the app shell (not, say, an icon opened in a tab).
    const isShell = cacheKey !== '/index.html' || (response.headers.get('content-type') || '').startsWith('text/html');
    if (response.ok && response.type === 'basic' && isShell) cache.put(cacheKey, response.clone()).catch(() => {});
    return response;
  });
  network.catch(() => {}); // avoid an unhandled rejection if the timeout wins
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const winner = await Promise.race([network, timeout]);
    if (winner) return winner;
  } catch {
    /* network failed: fall back to cache */
  }
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  return network; // nothing cached: wait for the network after all
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLive(url)) return; // straight to the network, never cached

  if (request.mode === 'navigate') {
    event.respondWith(shellFetch(request, '/index.html'));
    return;
  }
  event.respondWith(shellFetch(request, url.pathname));
});

// ---------- push ----------

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }
  const conversationId = data.conversationId || null;
  const title = data.title || 'TealTalk';
  const options = {
    body: data.body || 'New message',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: conversationId || 'tealtalk',
    renotify: true,
    data: { conversationId },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = (event.notification.data && event.notification.data.conversationId) || null;
  const target = conversationId ? `/#/c/${encodeURIComponent(conversationId)}` : '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        try {
          await existing.focus();
        } catch {
          /* focus can be refused; still route it */
        }
        existing.postMessage({ type: 'open-conversation', conversationId });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
