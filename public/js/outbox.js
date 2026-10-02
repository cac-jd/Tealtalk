// Optimistic sending. Every outgoing message gets a clientId and sits in the
// outbox (persisted to localStorage) until the server confirms it. Retries are
// safe because the server de-duplicates by clientId.
//
// Photos, videos and voice messages upload first (one at a time, resumable,
// with progress) and are then sent like any other message. Their files live
// only in memory, so they survive reconnects but not a reload. Text messages
// never wait behind an upload.

import { Api } from './api.js';
import { storage, uuid } from './dom.js';
import { state, on, emit, addMessages, pendingFor, liveNow } from './store.js';
import { uploadBlob, abandonUpload, UploadCancelled } from './uploads.js';

const OUTBOX_KEY = 'tt.outbox';

/**
 * clientId -> { file, thumb, mime, job, controller, thumbnailId } for media
 * waiting to upload (memory only; files don't fit localStorage).
 */
const blobs = new Map();

let flushing = false;
let retryTimer = null;
let retryDelay = 2000;

let uploadingId = null;
let uploadTimer = null;
let uploadDelay = 2000;

function persist() {
  const items = [...state.pending.values()]
    .filter((p) => !p.needsUpload) // un-uploaded files can't survive a reload
    .map(({ clientId, conversationId, body, attachmentId, media, replyToId, createdAt, state: s }) => ({
      clientId,
      conversationId,
      body,
      attachmentId,
      media,
      replyToId,
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

function revoke(p) {
  if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  if (p.fileUrl) URL.revokeObjectURL(p.fileUrl);
}

export function clearOutbox() {
  for (const p of state.pending.values()) revoke(p);
  for (const b of blobs.values()) if (b.controller) b.controller.abort();
  blobs.clear();
  storage.remove(OUTBOX_KEY);
}

/**
 * Queue a message.
 *  - media: { kind: 'image'|'video'|'audio', file, mime, thumb?, width?, height?, durationMs? }
 *  - replyToId: id of the message this answers
 */
export function enqueue({ conversationId, body = '', media = null, replyToId = null }) {
  const clientId = uuid();
  const pending = {
    clientId,
    conversationId,
    body,
    createdAt: Date.now(),
    state: 'sending',
  };
  if (replyToId) pending.replyToId = replyToId;
  if (media) {
    pending.needsUpload = true;
    pending.progress = 0;
    pending.media = {
      kind: media.kind,
      mime: media.mime,
      size: media.file.size,
      width: media.width || null,
      height: media.height || null,
      durationMs: media.durationMs || null,
    };
    // Preview in the bubble: the thumbnail (or the photo itself), the video's poster.
    const preview = media.thumb || (media.kind === 'image' ? media.file : null);
    if (preview) pending.localUrl = URL.createObjectURL(preview);
    // Voice messages can be played back before they finish uploading.
    if (media.kind === 'audio') pending.fileUrl = URL.createObjectURL(media.file);
    blobs.set(clientId, { file: media.file, thumb: media.thumb || null, mime: media.mime, job: {}, controller: null });
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
  if (p.needsUpload && !blobs.has(clientId)) return; // file lost after reload
  p.state = 'sending';
  p.error = null;
  persist();
  emit('messages', p.conversationId);
  flush();
}

export function discard(clientId) {
  const p = state.pending.get(clientId);
  if (!p) return;
  state.pending.delete(clientId);
  const b = blobs.get(clientId);
  if (b && b.controller) b.controller.abort();
  if (b) abandonUpload(b.job); // free the server's partial file now rather than in 24 h
  blobs.delete(clientId);
  revoke(p);
  persist();
  emit('messages', p.conversationId);
}

/** Stop an upload in progress and drop the message. */
export const cancelUpload = discard;

export function canRetry(p) {
  return !p.needsUpload || blobs.has(p.clientId);
}

function markFailed(p, error) {
  p.state = 'failed';
  p.error = error || null;
  persist();
  emit('messages', p.conversationId);
  emit('send-failed', p);
}

/** Send everything that is waiting, oldest first. Uploads run alongside. */
export async function flush() {
  if (!state.me) return;
  runUploads(true);
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    for (;;) {
      const next = [...state.pending.values()]
        .filter((p) => p.state === 'sending' && !p.needsUpload)
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
  const since = liveNow();
  try {
    const { message } = await Api.sendMessage(p.conversationId, {
      clientId: p.clientId,
      body: p.body,
      attachmentId: p.attachmentId,
      replyToId: p.replyToId,
    });
    // addMessages resolves the pending entry by clientId (unless the socket's copy,
    // perhaps already with a reaction, came first and did).
    addMessages(p.conversationId, [message], { since });
    if (state.pending.has(p.clientId)) state.pending.delete(p.clientId);
    persist();
    return true;
  } catch (err) {
    if (!state.pending.has(p.clientId)) return true; // resolved meanwhile (e.g. via WebSocket)
    if (err.isTransient) return false;
    if (err.status === 401) return false; // app is logging out
    markFailed(p, err.message); // 4xx: the server will never accept it as is
    return true;
  }
}

// ---------- uploads ----------

/** `now`: skip the back-off wait (back online, reconnected, or the user retried). */
function runUploads(now = false) {
  if (now && uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
  if (uploadingId || uploadTimer || !state.me) return;
  const next = [...state.pending.values()]
    .filter((p) => p.state === 'sending' && p.needsUpload && blobs.has(p.clientId))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;
  uploadingId = next.clientId;
  uploadOne(next).finally(() => {
    uploadingId = null;
    if (!uploadTimer) flush();
  });
}

let progressFrame = null;
const progressDirty = new Set();

function reportProgress(p, fraction) {
  p.progress = fraction;
  progressDirty.add(p);
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = null;
    for (const item of progressDirty) emit('upload-progress', item);
    progressDirty.clear();
  });
}

async function uploadOne(p) {
  const b = blobs.get(p.clientId);
  b.controller = new AbortController();
  const { signal } = b.controller;
  const m = p.media;
  try {
    if (b.thumb && !b.thumbnailId) {
      const thumb = await uploadBlob(b.thumb, { mime: 'image/jpeg', signal, chunked: false });
      b.thumbnailId = thumb.id;
    }
    const attachment = await uploadBlob(b.file, {
      mime: b.mime,
      meta: { width: m.width, height: m.height, durationMs: m.durationMs, thumbnailId: b.thumbnailId || null },
      job: b.job,
      signal,
      onProgress: (f) => reportProgress(p, f),
    });
    if (!state.pending.has(p.clientId)) return; // cancelled at the last moment
    p.attachmentId = attachment.id;
    p.media = { ...m, thumbnailId: b.thumbnailId || null };
    p.needsUpload = false;
    p.progress = 1;
    blobs.delete(p.clientId);
    uploadDelay = 2000;
    persist();
    emit('messages', p.conversationId);
  } catch (err) {
    if (err instanceof UploadCancelled || !state.pending.has(p.clientId)) {
      // Cancelled while the server was still creating the upload: discard() had no id to free yet.
      abandonUpload(b.job);
      return;
    }
    if (err.isTransient || err.status === 401) {
      // Dropped connection: resume from where the server got to, a bit later
      // (or right away when the network comes back: flush() skips the wait).
      uploadTimer = setTimeout(() => {
        uploadTimer = null;
        runUploads();
      }, uploadDelay);
      uploadDelay = Math.min(uploadDelay * 2, 30000);
      return;
    }
    markFailed(p, err.message);
  } finally {
    b.controller = null;
  }
}

// Sent: the bubble switches to the server's copy; free the local previews once it has.
on('pending-resolved', ({ pending }) => {
  if (pending.localUrl || pending.fileUrl) setTimeout(() => revoke(pending), 60000);
});

export function hasPending(convId) {
  return pendingFor(convId).length > 0;
}
