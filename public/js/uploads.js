// Uploading photos, videos and voice messages at full quality.
//
// Files up to 10 MB (except videos) go in one request. Bigger files and all
// videos use the resumable upload API: 5 MB chunks, and after a dropped
// connection we ask the server how much it has and carry on from there.

import { api, ApiError, getToken } from './api.js';

export const SMALL_UPLOAD_MAX = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled.');
    this.cancelled = true;
  }
}

/** A raw-body request with upload progress (fetch has none). */
function xhrSend(method, url, { body, headers = {}, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new UploadCancelled());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
    const onAbort = () => xhr.abort();
    // A phone going offline often leaves the request hanging: give up at once and resume later.
    const onOffline = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    window.addEventListener('offline', onOffline);
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      window.removeEventListener('offline', onOffline);
    };
    const networkError = () => {
      cleanup();
      if (signal && signal.aborted) reject(new UploadCancelled());
      else reject(new ApiError(0, navigator.onLine ? 'Could not reach TealTalk.' : 'You are offline.'));
    };
    xhr.onerror = networkError;
    xhr.ontimeout = networkError;
    xhr.onabort = networkError;
    xhr.onload = () => {
      cleanup();
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, data });
      else {
        const err = new ApiError(
          xhr.status,
          (data && typeof data.error === 'string' && data.error) ||
            (xhr.status === 413 ? 'That file is too large to send.' : `Upload failed (${xhr.status}).`),
        );
        err.data = data;
        reject(err);
      }
    };
    xhr.send(body);
  });
}

function metaQuery(meta) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(meta || {})) if (v !== null && v !== undefined) params.set(k, String(v));
  const q = params.toString();
  return q ? `?${q}` : '';
}

function cleanMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/**
 * Upload `blob` and return the attachment.
 *  - mime: the type to store
 *  - meta: { width, height, durationMs, thumbnailId }
 *  - job: a plain object kept by the caller across attempts; it remembers the
 *    resumable upload id so a retry continues instead of starting over
 *  - onProgress(fraction), signal (AbortSignal: cancels)
 */
export async function uploadBlob(blob, { mime, meta = {}, job = {}, onProgress = () => {}, signal, chunked }) {
  const useChunks = chunked ?? (blob.size > SMALL_UPLOAD_MAX || mime.startsWith('video/'));
  if (!useChunks) {
    const { data } = await xhrSend('POST', `/api/attachments${metaQuery(meta)}`, {
      body: blob,
      headers: { 'Content-Type': mime },
      signal,
      onProgress: (loaded) => onProgress(Math.min(0.99, loaded / blob.size)),
    });
    onProgress(1);
    return data.attachment;
  }

  const size = blob.size;
  let chunkSize = job.chunkSize || 5 * 1024 * 1024;
  let received = 0;
  if (job.uploadId) {
    // Resuming: ask the server how far it got.
    try {
      const status = await api(`/api/uploads/${encodeURIComponent(job.uploadId)}`);
      received = status.received;
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      job.uploadId = null; // expired or gone: start again
    }
  }
  if (!job.uploadId) {
    const created = await api('/api/uploads', { method: 'POST', body: { mime, size } });
    job.uploadId = created.uploadId;
    job.chunkSize = chunkSize = created.chunkSize || chunkSize;
    received = created.received || 0;
  }
  const path = `/api/uploads/${encodeURIComponent(job.uploadId)}`;
  onProgress(received / size);

  for (let attempt = 0; ; attempt++) {
    while (received < size) {
      if (signal && signal.aborted) throw new UploadCancelled();
      const end = Math.min(size, received + chunkSize);
      const offset = received;
      try {
        const { data } = await xhrSend('PUT', path, {
          body: blob.slice(offset, end),
          headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) },
          signal,
          onProgress: (loaded) => onProgress(Math.min(0.99, (offset + loaded) / size)),
        });
        received = data && Number.isFinite(data.received) ? data.received : end;
      } catch (err) {
        // The server has a different idea of the offset (e.g. an earlier chunk did land): use it.
        if (err.status === 409 && err.data && Number.isFinite(err.data.received)) received = err.data.received;
        else throw err;
      }
      onProgress(Math.min(0.99, received / size));
    }

    if (signal && signal.aborted) throw new UploadCancelled();
    try {
      const { attachment } = await api(`${path}/complete`, { method: 'POST', body: cleanMeta(meta) });
      job.uploadId = null;
      onProgress(1);
      return attachment;
    } catch (err) {
      // 409: the server is missing bytes after all. Ask where it is and send the rest.
      if (err.status !== 409 || attempt >= 2) throw err;
      received = (await api(path)).received;
    }
  }
}

/** Tell the server to drop a half-finished resumable upload (best effort). */
export function abandonUpload(job) {
  if (!job || !job.uploadId) return;
  const id = job.uploadId;
  job.uploadId = null;
  // Give the server a moment to notice the aborted chunk first (it refuses with 409 meanwhile).
  const attempt = (n) =>
    setTimeout(() => {
      api(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((err) => {
        if (err.status === 409 && n < 3) attempt(n + 1);
      });
    }, 1000 * n);
  attempt(1);
}
