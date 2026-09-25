// Optimistic sending. Every outgoing message gets a clientId and sits in the
// outbox (persisted to localStorage) until the server confirms it. Retries are
// safe because the server de-duplicates by clientId.

import { Api } from './api.js';
import { storage, uuid } from './dom.js';
import { state, emit, addMessages, pendingFor } from './store.js';

const OUTBOX_KEY = 'tt.outbox';

/** clientId -> Blob waiting to be uploaded (memory only; blobs don't fit localStorage). */
const blobs = new Map();

let flushing = false;
let retryTimer = null;
let retryDelay = 2000;

function persist() {
  const items = [...state.pending.values()]
    .filter((p) => !p.needsUpload) // un-uploaded photos can't survive a reload
    .map(({ clientId, conversationId, body, attachmentId, createdAt, state: s }) => ({
      clientId,
      conversationId,
      body,
      attachmentId,
      createdAt,
      state: s,
    }));
  storage.set(OUTBOX_KEY, items);
}

export function loadOutbox() {
  for (const item of storage.get(OUTBOX_KEY, [])) {
    if (!item || !item.clientId || !item.conversationId) continue;
    state.pending.set(item.clientId, { ...item, state: item.state === 'failed' ? 'failed' : 'sending' });
  }
}

export function clearOutbox() {
  for (const p of state.pending.values()) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  blobs.clear();
  storage.remove(OUTBOX_KEY);
}

/** Queue a message. `file` is an already-downscaled image Blob, if any. */
export function enqueue({ conversationId, body = '', file = null }) {
  const clientId = uuid();
  const pending = {
    clientId,
    conversationId,
    body,
    createdAt: Date.now(),
    state: 'sending',
  };
  if (file) {
    pending.needsUpload = true;
    pending.localUrl = URL.createObjectURL(file);
    blobs.set(clientId, file);
  }
  state.pending.set(clientId, pending);
  persist();
  emit('messages', conversationId);
  flush();
  return pending;
}

export function retry(clientId) {
  const p = state.pending.get(clientId);
  if (!p) return;
  if (p.needsUpload && !blobs.has(clientId)) return; // photo lost after reload
  p.state = 'sending';
  persist();
  emit('messages', p.conversationId);
  flush();
}

export function discard(clientId) {
  const p = state.pending.get(clientId);
  if (!p) return;
  state.pending.delete(clientId);
  blobs.delete(clientId);
  if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  persist();
  emit('messages', p.conversationId);
}

export function canRetry(p) {
  return !p.needsUpload || blobs.has(p.clientId);
}

function markFailed(p) {
  p.state = 'failed';
  persist();
  emit('messages', p.conversationId);
}

/** Send everything that is waiting, oldest first. */
export async function flush() {
  if (flushing || !state.me) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    for (;;) {
      const next = [...state.pending.values()]
        .filter((p) => p.state === 'sending')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      const ok = await sendOne(next);
      if (!ok) {
        // Transient failure: try again later (or on reconnect / online).
        retryTimer = setTimeout(flush, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
        break;
      }
      retryDelay = 2000;
    }
  } finally {
    flushing = false;
  }
}

async function sendOne(p) {
  try {
    if (p.needsUpload) {
      const blob = blobs.get(p.clientId);
      if (!blob) {
        markFailed(p);
        return true;
      }
      const { attachment } = await Api.uploadAttachment(blob);
      p.attachmentId = attachment.id;
      p.needsUpload = false;
      blobs.delete(p.clientId);
      persist();
    }
    const { message } = await Api.sendMessage(p.conversationId, {
      clientId: p.clientId,
      body: p.body,
      attachmentId: p.attachmentId,
    });
    // addMessages resolves the pending entry by clientId.
    addMessages(p.conversationId, [message]);
    if (state.pending.has(p.clientId)) state.pending.delete(p.clientId);
    persist();
    return true;
  } catch (err) {
    if (!state.pending.has(p.clientId)) return true; // resolved meanwhile (e.g. via WebSocket)
    if (err.isTransient) return false;
    if (err.status === 401) return false; // app is logging out
    markFailed(p); // 4xx: the server will never accept it as is
    return true;
  }
}

export function hasPending(convId) {
  return pendingFor(convId).length > 0;
}
