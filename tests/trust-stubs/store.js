// Stand-in for public/js/store.js: just enough state and events for e2ee.js and outbox.js.
export const state = (globalThis.__state ||= { me: null, pending: new Map() });
export const events = (globalThis.__events ||= []);
const listeners = new Map();
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}
export function emit(name, arg) {
  events.push([name, arg]);
  for (const fn of listeners.get(name) || []) fn(arg);
}
export function getConversation(id) {
  return (globalThis.__convs || {})[id];
}
export function upsertConversation(c) {
  (globalThis.__convs ||= {})[c.id] = c;
}
export function userName(c, id) {
  return id;
}
export function addMessages() {}
export function pendingFor(convId) {
  return [...state.pending.values()].filter((p) => p.conversationId === convId);
}
export function liveNow() {
  return 0;
}
