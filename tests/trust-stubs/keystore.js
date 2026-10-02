// Stand-in for public/js/crypto/keystore.js: IndexedDB as in-memory Maps
// (CryptoKey objects are kept as they are, like IndexedDB's structured clone).
const db = (globalThis.__ks ||= {
  account: new Map(),
  contacts: new Map(),
  local: { oldKeys: new Map(), members: new Map(), meta: new Map(), outbox: new Map(), outboxKey: new Map() },
});
const KEYPATH = { oldKeys: 'id', members: 'conversationId', meta: 'key', outbox: 'clientId', outboxKey: 'userId' };
const copy = (v) => (v && typeof v === 'object' ? { ...v } : v);
export const keystoreAvailable = () => true;
export async function getAccount(id) {
  return copy(db.account.get(id)) || null;
}
export async function putAccount(a) {
  db.account.set(a.userId, copy(a));
}
export async function listAccounts() {
  return [...db.account.values()].map(copy);
}
export async function deleteAccount(id) {
  db.account.delete(id);
}
export async function getContact(id) {
  return copy(db.contacts.get(id)) || null;
}
export async function putContact(c) {
  db.contacts.set(c.userId, copy(c));
}
export async function listContacts() {
  return [...db.contacts.values()].map(copy);
}
export async function clearKeystore() {
  db.account.clear();
  db.contacts.clear();
}
export async function clearContacts() {
  db.contacts.clear();
}
export async function requestPersistence() {
  return true;
}
export async function localGet(store, key) {
  return copy(db.local[store].get(key)) || null;
}
export async function localGetAll(store) {
  return [...db.local[store].values()].map(copy);
}
export async function localPut(store, value) {
  db.local[store].set(value[KEYPATH[store]], copy(value));
}
export async function localDelete(store, key) {
  db.local[store].delete(key);
}
export async function localClear(store) {
  db.local[store].clear();
}
