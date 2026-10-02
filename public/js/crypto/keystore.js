// On-device key storage in IndexedDB (docs/E2EE.md "On the device").
//   database "tealtalk-keys"
//   store "account":  { userId, keyId, encPriv, sigPriv, encPub, sigPub, bundle, backup, published, recoverySaved }
//                     (encPriv/sigPriv are non-extractable CryptoKeys; the recovery key is never stored)
//   store "contacts": { userId, owner, keyId, bundle, seenKeyIds, verified, ... } trust-on-first-use pins
// No DOM: also used by the service worker's copy of this logic (sw.js reads the same stores).
//
// Plus a second database for the account's other local state, so the service
// worker's copy of the "tealtalk-keys" schema never has to change:
//   database "tealtalk-local"
//   store "oldKeys":   { id: userId|keyId, userId, keyId, encPriv, bundle, retiredAt }
//                      keys this device used before (non-extractable), so old messages still open
//   store "members":   { conversationId, owner, isGroup, members: [userId], notices: [{ userId, at }] }
//   store "meta":      { key, owner, value } (e.g. the first encrypted message id per chat)
//   store "outbox":    { clientId, owner, iv, ct, savedAt } unsent messages, AES-GCM encrypted
//   store "outboxKey": { userId, key } the outbox's non-extractable AES-GCM CryptoKey

export const DB_NAME = 'tealtalk-keys';
export const DB_VERSION = 1;

let dbPromise = null;

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function keystoreAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('account')) db.createObjectStore('account', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'userId' });
    };
    open.onsuccess = () => {
      const db = open.result;
      // Another tab upgrading or deleting the database: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error);
    };
    open.onblocked = () => {
      /* wait: the other connection closes on versionchange */
    };
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(tx.objectStore(store))).then(
      (r) => {
        result = r;
      },
      reject,
    );
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function getAccount(userId) {
  return run('account', 'readonly', (s) => req(s.get(userId))).then((r) => r || null);
}

export function putAccount(account) {
  return run('account', 'readwrite', (s) => req(s.put(account)));
}

export function listAccounts() {
  return run('account', 'readonly', (s) => req(s.getAll()));
}

export function deleteAccount(userId) {
  return run('account', 'readwrite', (s) => req(s.delete(userId)));
}

export function getContact(userId) {
  return run('contacts', 'readonly', (s) => req(s.get(userId))).then((r) => r || null);
}

export function putContact(contact) {
  return run('contacts', 'readwrite', (s) => req(s.put(contact)));
}

export function listContacts() {
  return run('contacts', 'readonly', (s) => req(s.getAll()));
}

/** Forget every key and pin on this device (another account signs in). */
export async function clearKeystore() {
  await run('account', 'readwrite', (s) => req(s.clear()));
  await run('contacts', 'readwrite', (s) => req(s.clear()));
}

/** Forget every pin (they belonged to another account). */
export function clearContacts() {
  return run('contacts', 'readwrite', (s) => req(s.clear()));
}

/** Ask the browser not to evict our keys under storage pressure. */
export async function requestPersistence() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* not granted: keys still work, the recovery key is the safety net */
  }
  return false;
}

// ---------------------------------------------------------------------------
// database "tealtalk-local"

export const LOCAL_DB_NAME = 'tealtalk-local';
export const LOCAL_DB_VERSION = 1;
const LOCAL_STORES = {
  oldKeys: 'id',
  members: 'conversationId',
  meta: 'key',
  outbox: 'clientId',
  outboxKey: 'userId',
};

let localPromise = null;

function openLocal() {
  if (localPromise) return localPromise;
  localPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(LOCAL_STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        db.close();
        localPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      localPromise = null;
      reject(open.error);
    };
  });
  return localPromise;
}

async function runLocal(store, mode, fn) {
  if (!LOCAL_STORES[store]) throw new Error(`Unknown store ${store}`);
  const db = await openLocal();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(tx.objectStore(store))).then(
      (r) => {
        result = r;
      },
      reject,
    );
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function localGet(store, key) {
  return runLocal(store, 'readonly', (s) => req(s.get(key))).then((r) => r || null);
}

export function localGetAll(store) {
  return runLocal(store, 'readonly', (s) => req(s.getAll()));
}

export function localPut(store, value) {
  return runLocal(store, 'readwrite', (s) => req(s.put(value)));
}

export function localDelete(store, key) {
  return runLocal(store, 'readwrite', (s) => req(s.delete(key)));
}

export function localClear(store) {
  return runLocal(store, 'readwrite', (s) => req(s.clear()));
}
