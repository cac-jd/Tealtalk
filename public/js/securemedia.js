// Encrypted photos, videos and voice messages: download the ciphertext with
// progress, decrypt it record by record into Blob parts, and hand out object
// URLs. URLs are revoked when the chat closes (or on logout). Files I sent from
// this device are "seeded" with the original, so they never need downloading.

import { getToken } from './api.js';
import { RecordDecryptor, cipherSize, FileDecryptError } from './crypto/files.js';

/** Plaintext is grouped into Blobs of about this size while decrypting. */
const GROUP_BYTES = 8 * 1024 * 1024;

export class MediaError extends Error {
  constructor(code) {
    const text = {
      undecryptable: 'Can’t decrypt this file',
      gone: 'No longer available',
      network: 'Couldn’t download. Tap to try again.',
    };
    super(text[code] || text.network);
    this.code = code;
  }
}

/** attachment id -> { blob, url, keep, promise, listeners, dead } */
const entries = new Map();

/** Register a file I just sent (the original, unencrypted Blob) under its attachment id. */
export function seedMedia(id, blob) {
  const old = entries.get(id);
  if (old && old.url) URL.revokeObjectURL(old.url);
  entries.set(id, { blob, url: null, keep: true, promise: null, listeners: new Set(), dead: false });
}

/** An object URL right now if the file is already decrypted here, else null. */
export function cachedMediaUrl(id) {
  const e = entries.get(id);
  if (!e || !e.blob) return null;
  if (!e.url) e.url = URL.createObjectURL(e.blob);
  return e.url;
}

async function download(file, onProgress) {
  const expected = cipherSize(file.size, file.recordSize);
  let res;
  try {
    const token = getToken();
    res = await fetch(`/api/attachments/${encodeURIComponent(file.id)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new MediaError('network');
  }
  if (res.status === 404 || res.status === 410) throw new MediaError('gone');
  if (!res.ok || !res.body) throw new MediaError('network');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== expected) throw new MediaError('undecryptable');

  const dec = new RecordDecryptor(file, file.size);
  const reader = res.body.getReader();
  const parts = [];
  let group = [];
  let groupBytes = 0;
  let got = 0;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw new MediaError('network');
      }
      if (chunk.done) break;
      got += chunk.value.length;
      for (const plain of await dec.push(chunk.value)) {
        group.push(plain);
        groupBytes += plain.length;
        if (groupBytes >= GROUP_BYTES) {
          parts.push(new Blob(group));
          group = [];
          groupBytes = 0;
        }
      }
      onProgress(Math.min(1, got / expected));
    }
    dec.finish();
  } catch (err) {
    reader.cancel().catch(() => {});
    if (err instanceof FileDecryptError) throw new MediaError('undecryptable');
    throw err instanceof MediaError ? err : new MediaError('undecryptable');
  }
  if (group.length) parts.push(new Blob(group));
  return new Blob(parts, { type: file.mime });
}

/**
 * Decrypted object URL for a file from an encrypted payload
 * ({ id, mime, size, key, noncePrefix, recordSize }). Concurrent calls share one download.
 */
export function loadMedia(file, onProgress) {
  const ready = cachedMediaUrl(file.id);
  if (ready) return Promise.resolve(ready);
  let e = entries.get(file.id);
  if (e && e.promise) {
    if (onProgress) e.listeners.add(onProgress);
    return e.promise;
  }
  e = { blob: null, url: null, keep: false, promise: null, listeners: new Set(onProgress ? [onProgress] : []), dead: false };
  entries.set(file.id, e);
  const entry = e;
  entry.promise = download(file, (f) => {
    for (const fn of entry.listeners) fn(f);
  }).then(
    (blob) => {
      if (entry.dead) throw new MediaError('network');
      entry.blob = blob;
      entry.promise = null;
      entry.listeners.clear();
      return cachedMediaUrl(file.id);
    },
    (err) => {
      if (entries.get(file.id) === entry) entries.delete(file.id);
      throw err;
    },
  );
  return entry.promise;
}

/**
 * Revoke object URLs and drop downloaded files (the chat closed). Files I sent
 * from this device stay seeded unless `all` (logout).
 */
export function releaseMedia({ all = false } = {}) {
  for (const [id, e] of entries) {
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = null;
    if (all || !e.keep) {
      e.dead = true;
      entries.delete(id);
    }
  }
}
