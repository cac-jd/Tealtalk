// TealTalk service worker: offline app shell + web push.
// Never caches /api or /ws: messages and attachments always come from the server
// (attachments rely on the browser's normal HTTP cache instead).

const CACHE = 'tealtalk-shell-v4';
/**
 * Every file under public/, which is also exactly what the app fingerprint covers
 * (scripts/fingerprint.js). tests/crypto.test.js fails if this list goes stale.
 */
const FILES = [
  '/app.js',
  '/icons/apple-touch-icon.png',
  '/icons/badge-96.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon.svg',
  '/index.html',
  '/js/api.js',
  '/js/crypto/encoding.js',
  '/js/crypto/envelope.js',
  '/js/crypto/files.js',
  '/js/crypto/keys.js',
  '/js/crypto/keystore.js',
  '/js/crypto/safety.js',
  '/js/dom.js',
  '/js/e2ee.js',
  '/js/images.js',
  '/js/outbox.js',
  '/js/pwa.js',
  '/js/securemedia.js',
  '/js/socket.js',
  '/js/store.js',
  '/js/ui/auth.js',
  '/js/ui/chat.js',
  '/js/ui/chats.js',
  '/js/ui/common.js',
  '/js/ui/groupinfo.js',
  '/js/ui/keys.js',
  '/js/ui/media.js',
  '/js/ui/menu.js',
  '/js/ui/newchat.js',
  '/js/ui/recorder.js',
  '/js/ui/safety.js',
  '/js/ui/settings.js',
  '/js/uploads.js',
  '/js/video.js',
  '/manifest.webmanifest',
  '/package.json',
  '/styles.css',
  '/sw.js',
];
const SHELL = ['/', ...FILES];
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

// ---------- app fingerprint ----------
//
// Settings > About shows a fingerprint of the app this phone is actually running,
// computed from the cached copies, exactly like `npm run fingerprint`:
// SHA-256 over the sorted lines `path + "\n" + sha256hex(file) + "\n"`.

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function appFingerprint() {
  const cache = await caches.open(CACHE);
  const paths = [...FILES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let lines = '';
  for (const path of paths) {
    let response = await cache.match(path);
    if (!response) {
      // Not cached (e.g. the install couldn't fetch it): use, and keep, what the server sends now.
      response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error(`missing ${path}`);
      cache.put(path, response.clone()).catch(() => {});
    }
    lines += `${path}\n${hex(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))}\n`;
  }
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines)));
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (data.type !== 'fingerprint' || !port) return;
  event.waitUntil(
    appFingerprint().then(
      (fingerprint) => port.postMessage({ fingerprint }),
      () => port.postMessage({ fingerprint: null }),
    ),
  );
});

// ---------- push ----------
//
// Message pushes carry the encrypted envelope (docs/E2EE.md "Push"). The service worker
// opens the same IndexedDB key store as the page, verifies the sender's signature, and
// only then decrypts to show a real preview. Anything that doesn't check out shows
// "New message": never the server's own idea of the text.

const KEYS_DB = 'tealtalk-keys';
const KIND_LABEL = { image: 'Photo', video: 'Video', audio: 'Voice message' };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function fromB64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('b64u');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Same as canonical() in js/crypto/encoding.js. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' };

async function verifiedSigKey(bundle, userId, keyId) {
  if (!bundle || bundle.v !== 1 || bundle.keyId !== keyId) return null;
  const subtle = crypto.subtle;
  const sigPub = fromB64u(bundle.sigPub);
  const encPub = fromB64u(bundle.encPub);
  const id = b64u(new Uint8Array(await subtle.digest('SHA-256', concatBytes(Uint8Array.of(1), sigPub, encPub))));
  if (id !== keyId) return null;
  const key = await subtle.importKey('spki', sigPub, ECDSA_P256, false, ['verify']);
  const ok = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromB64u(bundle.selfSig),
    textEncoder.encode(`tealtalk-keys-v1|${userId}|${keyId}|${bundle.createdAt}`),
  );
  return ok ? key : null;
}

/**
 * The preview text for a push, or null when it can't be verified and decrypted.
 * store: { account: { userId, keyId, encPriv, bundle }, contacts: { userId: { bundle } } }
 */
async function previewFor(data, store) {
  try {
    const env = data && data.e2ee;
    const account = store && store.account;
    if (!env || env.v !== 1 || env.kind !== 'message' || !account) return null;
    const { conversationId, senderId, clientId } = data;
    if (typeof conversationId !== 'string' || typeof senderId !== 'string' || typeof clientId !== 'string') return null;
    const subtle = crypto.subtle;

    // 1. The sender's key, pinned on this device (or my own, from another of my devices).
    const contact = senderId === account.userId ? { bundle: account.bundle } : (store.contacts || {})[senderId];
    const sigKey = contact && (await verifiedSigKey(contact.bundle, senderId, env.senderKeyId));
    if (!sigKey) return null;

    // 2. Verify the signature before decrypting anything.
    const aad = `tealtalk-msg-v1|${conversationId}|${senderId}|${clientId}|${env.kind}`;
    const unsigned = { v: env.v, kind: env.kind, senderKeyId: env.senderKeyId, eph: env.eph, iv: env.iv, ct: env.ct, keys: env.keys };
    const signed = textEncoder.encode(`${canonicalJson(unsigned)}|${aad}`);
    if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, fromB64u(env.sig), signed))) return null;

    // 3. Unwrap my copy of the message key, then decrypt.
    const entry = env.keys && Object.prototype.hasOwnProperty.call(env.keys, account.userId) ? env.keys[account.userId] : null;
    if (!entry || entry.k !== account.keyId) return null;
    const ephSpki = fromB64u(env.eph);
    const ephPub = await subtle.importKey('spki', ephSpki, ECDH_P256, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: ephPub }, account.encPriv, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const info = textEncoder.encode(`tealtalk-wrap-v1|${conversationId}|${clientId}|${env.kind}|${account.userId}|${entry.k}`);
    const wrapKey = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(await subtle.digest('SHA-256', ephSpki)), info },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const w = fromB64u(entry.w);
    const rawKey = await subtle.decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12) }, wrapKey, w.subarray(12));
    const contentKey = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64u(env.iv), additionalData: textEncoder.encode(aad) },
      contentKey,
      fromB64u(env.ct),
    );
    const payload = JSON.parse(textDecoder.decode(plain));
    if (!payload || payload.kind !== env.kind) return null;

    const body = typeof payload.body === 'string' ? payload.body.replace(/\s+/g, ' ').trim() : '';
    if (body) return body.length > 100 ? `${body.slice(0, 99)}…` : body;
    const att = Array.isArray(payload.attachments) ? payload.attachments[0] : null;
    if (att) return KIND_LABEL[att.kind] || 'Attachment';
    return null;
  } catch {
    return null;
  }
}

// Lets tests/crypto.test.js run this exact code against envelopes from js/crypto/envelope.js.
self.__tealtalkPreview = previewFor;

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The key store for this envelope's recipient, or null (logged out, no keys on this device). */
async function loadKeyStore(env) {
  if (typeof indexedDB === 'undefined' || !env || !env.keys) return null;
  const open = indexedDB.open(KEYS_DB, 1);
  // Same schema as js/crypto/keystore.js, in case the page never created it.
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('account')) db.createObjectStore('account', { keyPath: 'userId' });
    if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'userId' });
  };
  const db = await idbRequest(open);
  try {
    const tx = db.transaction(['account', 'contacts'], 'readonly');
    const [accounts, contacts] = await Promise.all([
      idbRequest(tx.objectStore('account').getAll()),
      idbRequest(tx.objectStore('contacts').getAll()),
    ]);
    const account = accounts.find((a) => env.keys[a.userId] && env.keys[a.userId].k === a.keyId);
    if (!account) return null;
    const byUser = {};
    for (const c of contacts) byUser[c.userId] = c;
    return { account, contacts: byUser };
  } finally {
    db.close();
  }
}

async function showPush(data) {
  let body = 'New message';
  if (data.e2ee) {
    try {
      const text = await previewFor(data, await loadKeyStore(data.e2ee));
      if (text) body = text;
    } catch {
      /* "New message" */
    }
  }
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : null;
  const title = typeof data.title === 'string' && data.title ? data.title : 'TealTalk';
  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: conversationId || 'tealtalk',
    renotify: true,
    data: { conversationId },
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json() || {};
    } catch {
      data = {};
    }
  }
  event.waitUntil(showPush(data));
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
