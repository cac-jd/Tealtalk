// Optimistic sending. Every outgoing message gets a clientId and sits in the
// outbox (persisted on this device only, in IndexedDB, encrypted with a
// non-extractable AES-GCM key made for this account) until the server
// confirms it. Messages that failed or are held back expire after 7 days. The outbox keeps the plaintext and seals a fresh envelope on
// every attempt, so a retry after members or keys changed is encrypted for the
// right people. Retries are safe because the server de-duplicates by clientId.
//
// Photos, videos and voice messages are encrypted while they upload (one at a
// time, resumable, with progress) and then sent like any other message. Their
// files live only in memory, so they survive reconnects but not a reload. Text
// messages never wait behind an upload.

import { Api, ApiError } from './api.js';
import { storage, uuid } from './dom.js';
import { state, on, emit, addMessages, pendingFor, liveNow, getConversation, upsertConversation } from './store.js';
import { uploadBlob, abandonUpload, UploadCancelled, SMALL_UPLOAD_MAX } from './uploads.js';
import { sendSealed, contactInfo, MissingKeysError, SafetyCheckNeeded, KeysNotReadyError, SealError } from './e2ee.js';
import { createEncryptor, newFileKey, E2EE_MIME } from './crypto/files.js';
import { utf8, fromUtf8 } from './crypto/encoding.js';
import * as keystore from './crypto/keystore.js';
import { seedMedia } from './securemedia.js';

/** Where older versions kept the outbox, in plaintext: moved into IndexedDB on load. */
const LEGACY_OUTBOX_KEY = 'tt.outbox';
/** Failed or held-back messages are dropped after this long. */
export const OUTBOX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** A message waiting for someone's key is retried at least this often. */
const KEYS_RETRY_MS = 30000;
const THUMB_SIDE = 480;

/**
 * clientId -> { file, thumb, mime, job, controller, thumbnailId, fileKey, thumbKey }
 * for media waiting to upload (memory only; files don't fit localStorage).
 */
const blobs = new Map();

let flushing = false;
let retryTimer = null;
let retryDelay = 2000;

let uploadingId = null;
let uploadTimer = null;
let uploadDelay = 2000;

// ---------- storage (IndexedDB, encrypted) ----------

/** Whose outbox is in memory, and its key: { userId, key: CryptoKey }. */
let outboxKey = null;
/** Resolves when the stored outbox has been read (writes wait for it). */
let loading = null;
/** Serializes writes. */
let writing = Promise.resolve();
let persistTimer = null;

function snapshot(p) {
  const { clientId, conversationId, body, attachments, attachmentIds, media, replyToId, replyTo, createdAt, state: s, failedAt, blockedSince } = p;
  return { clientId, conversationId, body, attachments, attachmentIds, media, replyToId, replyTo, createdAt, state: s, failedAt, blockedSince };
}

function aad(userId, clientId) {
  return utf8(`tealtalk-outbox-v1|${userId}|${clientId}`);
}

/** This account's outbox key: made once, non-extractable, kept in IndexedDB as a CryptoKey. */
async function keyFor(userId) {
  if (outboxKey && outboxKey.userId === userId) return outboxKey.key;
  let rec = await keystore.localGet('outboxKey', userId);
  if (!rec || !rec.key) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    rec = { userId, key };
    await keystore.localPut('outboxKey', rec);
  }
  outboxKey = { userId, key: rec.key };
  return rec.key;
}

async function seal(userId, item) {
  const key = await keyFor(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, item.clientId) }, key, utf8(JSON.stringify(item))));
  return { clientId: item.clientId, owner: userId, iv, ct, savedAt: Date.now() };
}

async function unseal(userId, rec) {
  const key = await keyFor(userId);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aad(userId, rec.clientId) }, key, rec.ct);
  return JSON.parse(fromUtf8(new Uint8Array(plain)));
}

function expired(item, now = Date.now()) {
  if (item.state === 'failed' && now - (item.failedAt || item.createdAt || 0) > OUTBOX_EXPIRY_MS) return true;
  if (item.blockedSince && now - item.blockedSince > OUTBOX_EXPIRY_MS) return true;
  return false;
}

/** Write what's pending now (soon, batched). Un-uploaded files can't survive a reload. */
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writing = writing.then(saveAll, saveAll);
  }, 0);
}

/** Wait until everything persisted so far has been written. */
export async function outboxSaved() {
  while (persistTimer || loading) {
    if (loading) await loading;
    await new Promise((r) => setTimeout(r, 0));
    await writing;
  }
  await writing;
}

async function saveAll() {
  if (loading) await loading;
  const userId = state.me && state.me.id;
  if (!userId) return;
  try {
    const keep = new Set();
    for (const p of state.pending.values()) {
      if (p.needsUpload) continue;
      keep.add(p.clientId);
      await keystore.localPut('outbox', await seal(userId, snapshot(p)));
    }
    for (const rec of await keystore.localGetAll('outbox')) {
      if (rec.owner === userId && !keep.has(rec.clientId)) await keystore.localDelete('outbox', rec.clientId);
    }
  } catch {
    /* storage unavailable: the outbox lives in memory only */
  }
}

function addLoaded(item) {
  if (!item || typeof item.clientId !== 'string' || !item.conversationId) return false;
  if (item.attachmentId && !item.attachments) return false; // from before encryption: can't be sent any more
  if (expired(item) || state.pending.has(item.clientId)) return false;
  state.pending.set(item.clientId, { ...item, state: item.state === 'failed' ? 'failed' : 'sending' });
  return true;
}

/**
 * Read the stored outbox into memory (and move any plaintext copy an older version
 * left in localStorage into encrypted storage). Resolves when done.
 */
export function loadOutbox() {
  if (loading) return loading;
  const userId = state.me && state.me.id;
  if (!userId) return Promise.resolve();
  loading = (async () => {
    const convs = new Set();
    const legacy = storage.get(LEGACY_OUTBOX_KEY, null);
    if (Array.isArray(legacy)) for (const item of legacy) if (addLoaded(item)) convs.add(item.conversationId);
    try {
      for (const rec of await keystore.localGetAll('outbox')) {
        if (rec.owner !== userId) {
          await keystore.localDelete('outbox', rec.clientId); // another account's
          continue;
        }
        let item = null;
        try {
          item = await unseal(userId, rec);
        } catch {
          item = null; // key gone or record damaged: can't be sent any more
        }
        if (item && item.clientId === rec.clientId && addLoaded(item)) convs.add(item.conversationId);
        else await keystore.localDelete('outbox', rec.clientId);
      }
    } catch {
      /* storage unavailable */
    }
    loading = null;
    await saveAll();
    if (legacy !== null) storage.remove(LEGACY_OUTBOX_KEY);
    for (const id of convs) emit('messages', id);
    if (convs.size) flush();
  })();
  return loading;
}

function revoke(p) {
  if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  if (p.fileUrl) URL.revokeObjectURL(p.fileUrl);
}

/** Session ended: forget the outbox here and on this device (and its key). */
export function clearOutbox() {
  for (const p of state.pending.values()) revoke(p);
  for (const b of blobs.values()) if (b.controller) b.controller.abort();
  blobs.clear();
  storage.remove(LEGACY_OUTBOX_KEY);
  clearTimeout(persistTimer);
  persistTimer = null;
  outboxKey = null;
  const wipe = async () => {
    try {
      await keystore.localClear('outbox');
      await keystore.localClear('outboxKey');
    } catch {
      /* nothing stored */
    }
  };
  writing = writing.then(wipe, wipe);
}

/**
 * Queue a message.
 *  - media: { kind: 'image'|'video'|'audio', file, mime, thumb?, width?, height?, durationMs? }
 *  - replyTo: { id, senderId, snippet } of the message this answers
 */
export function enqueue({ conversationId, body = '', media = null, replyTo = null }) {
  const clientId = uuid();
  const pending = {
    clientId,
    conversationId,
    body,
    createdAt: Date.now(),
    state: 'sending',
  };
  if (replyTo) {
    pending.replyToId = replyTo.id;
    pending.replyTo = { id: replyTo.id, senderId: replyTo.senderId || null, snippet: (replyTo.snippet || '').slice(0, 200) };
  }
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
  p.blocked = null;
  p.failedAt = null; // tried again by hand: a fresh 7 days
  p.blockedSince = null;
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
  p.failedAt = Date.now();
  p.blocked = null;
  persist();
  emit('messages', p.conversationId);
  emit('send-failed', p);
}

/** Held back until someone has a key ('keys') or a changed safety number is confirmed ('safety'). */
function block(p, reason, userIds) {
  p.blocked = { reason, userIds, at: Date.now() };
  if (!p.blockedSince) p.blockedSince = p.blocked.at; // kept across reloads: expires after 7 days
  persist();
  emit('messages', p.conversationId);
  if (reason === 'safety') emit('safety-needed', { conversationId: p.conversationId, userIds });
}

/** Messages held back for matching reasons get another try. */
export function unblock(match = () => true) {
  let any = false;
  for (const p of state.pending.values()) {
    if (p.blocked && match(p.blocked)) {
      p.blocked = null;
      any = true;
      emit('messages', p.conversationId);
    }
  }
  if (any) flush();
}

/** Messages in a conversation held back for a safety-number confirmation: their userIds. */
export function safetyBlocked(convId) {
  const ids = new Set();
  for (const p of pendingFor(convId)) if (p.blocked && p.blocked.reason === 'safety') for (const id of p.blocked.userIds) ids.add(id);
  return [...ids];
}

/** Send everything that is waiting, oldest first. Uploads run alongside. */
export async function flush() {
  if (!state.me) return;
  runUploads(true);
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  const now = Date.now();
  for (const p of [...state.pending.values()]) {
    if (expired(p, now)) {
      discard(p.clientId);
      continue;
    }
    if (p.blocked && p.blocked.reason === 'keys' && now - p.blocked.at > KEYS_RETRY_MS) p.blocked = null;
  }
  try {
    for (;;) {
      const next = [...state.pending.values()]
        .filter((p) => p.state === 'sending' && !p.needsUpload && !p.blocked)
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
  if (!retryTimer && [...state.pending.values()].some((p) => p.blocked && p.blocked.reason === 'keys')) {
    retryTimer = setTimeout(flush, KEYS_RETRY_MS + 1000);
  }
}

async function conversationFor(convId) {
  const known = getConversation(convId);
  if (known) return known;
  const { conversation } = await Api.conversation(convId);
  upsertConversation(conversation);
  return conversation;
}

async function sendOne(p) {
  const since = liveNow();
  try {
    const conv = await conversationFor(p.conversationId);
    const payload = {
      kind: 'message',
      body: p.body || '',
      attachments: p.attachments || [],
      replyTo: p.replyTo || null,
    };
    const { message } = await sendSealed({
      conversationId: p.conversationId,
      kind: 'message',
      payload,
      clientId: p.clientId,
      recipientIds: (conv.members || []).map((m) => m.id),
      post: (e2ee) =>
        Api.sendMessage(p.conversationId, {
          clientId: p.clientId,
          e2ee,
          attachmentIds: p.attachmentIds,
          replyToId: p.replyToId,
        }),
    });
    // addMessages resolves the pending entry by clientId (unless the socket's copy,
    // perhaps already with a reaction, came first and did).
    addMessages(p.conversationId, [message], { since });
    if (state.pending.has(p.clientId)) state.pending.delete(p.clientId);
    persist();
    return true;
  } catch (err) {
    if (!state.pending.has(p.clientId)) return true; // resolved meanwhile (e.g. via WebSocket)
    if (err instanceof MissingKeysError) {
      block(p, 'keys', err.userIds);
      return true;
    }
    if (err instanceof SafetyCheckNeeded) {
      block(p, 'safety', err.userIds);
      return true;
    }
    if (err instanceof KeysNotReadyError) return false;
    if (err instanceof SealError) {
      markFailed(p, err.message);
      return true;
    }
    if (err instanceof ApiError) {
      if (err.isTransient) return false;
      if (err.status === 401) return false; // app is logging out
      markFailed(p, err.message); // 4xx: the server will never accept it as is
      return true;
    }
    markFailed(p, 'Couldn’t encrypt this message. Try again.');
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

/** The thumbnail's size: the original scaled to fit 480 px. */
function thumbSize(m) {
  if (!m.width || !m.height) return { width: null, height: null };
  const scale = Math.min(1, THUMB_SIDE / Math.max(m.width, m.height));
  return { width: Math.max(1, Math.round(m.width * scale)), height: Math.max(1, Math.round(m.height * scale)) };
}

async function uploadOne(p) {
  const b = blobs.get(p.clientId);
  b.controller = new AbortController();
  const { signal } = b.controller;
  const m = p.media;
  // Keys are made once per file and kept across attempts: a resumed upload must
  // re-encrypt to exactly the same bytes.
  if (!b.fileKey) b.fileKey = newFileKey();
  if (b.thumb && !b.thumbKey) b.thumbKey = newFileKey();
  try {
    if (b.thumb && !b.thumbnailId) {
      const thumbEnc = await createEncryptor(b.thumb, b.thumbKey);
      const thumb = await uploadBlob(thumbEnc, { mime: E2EE_MIME, signal, chunked: false });
      b.thumbnailId = thumb.id;
      seedMedia(thumb.id, b.thumb);
    }
    const enc = await createEncryptor(b.file, b.fileKey);
    const attachment = await uploadBlob(enc, {
      mime: E2EE_MIME,
      job: b.job,
      signal,
      chunked: enc.size > SMALL_UPLOAD_MAX || m.kind === 'video',
      onProgress: (f) => reportProgress(p, f),
    });
    if (!state.pending.has(p.clientId)) return; // cancelled at the last moment
    seedMedia(attachment.id, b.file.type === m.mime ? b.file : new Blob([b.file], { type: m.mime }));
    const thumb = b.thumbnailId
      ? { id: b.thumbnailId, mime: 'image/jpeg', size: b.thumb.size, ...thumbSize(m), ...b.thumbKey }
      : null;
    p.attachments = [
      {
        id: attachment.id,
        mime: m.mime,
        size: b.file.size,
        width: m.width,
        height: m.height,
        durationMs: m.durationMs,
        kind: m.kind,
        ...b.fileKey,
        thumb,
      },
    ];
    p.attachmentIds = b.thumbnailId ? [attachment.id, b.thumbnailId] : [attachment.id];
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
    markFailed(p, err instanceof ApiError ? err.message : 'Couldn’t encrypt this file.');
  } finally {
    b.controller = null;
  }
}

// Sent: the bubble switches to the server's copy; free the local previews once it has.
on('pending-resolved', ({ pending }) => {
  if (pending.localUrl || pending.fileUrl) setTimeout(() => revoke(pending), 60000);
});

// Someone we were waiting for opened TealTalk (published a key): try again now.
on('keys-available', (userId) => unblock((b) => b.reason === 'keys' && b.userIds.includes(userId)));
// A changed safety number was confirmed ("Send anyway" or verified again).
on('safety', () =>
  unblock((b) => b.reason === 'safety' && b.userIds.every((id) => !(contactInfo(id) || {}).needsAck)),
);

export function hasPending(convId) {
  return pendingFor(convId).length > 0;
}
