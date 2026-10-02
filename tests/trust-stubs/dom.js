// Stand-in for public/js/dom.js: localStorage as a Map.
const ls = (globalThis.__localStorage ||= new Map());
export const storage = {
  get(key, fallback = null) {
    return ls.has(key) ? JSON.parse(ls.get(key)) : fallback;
  },
  set(key, value) {
    ls.set(key, JSON.stringify(value));
  },
  remove(key) {
    ls.delete(key);
  },
};
export function uuid() {
  return globalThis.crypto.randomUUID();
}
