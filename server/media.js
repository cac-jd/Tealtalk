'use strict';

// Photos, videos and voice messages: accepted types, magic-byte checks, HTTP Range parsing,
// and the hourly sweep that removes expired media and abandoned uploads.

const fs = require('node:fs');
const path = require('node:path');

/** Accepted upload types and the kind ("family") each belongs to. */
const MEDIA_TYPES = new Map([
  ['image/jpeg', 'image'],
  ['image/png', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
  ['video/webm', 'video'],
  ['audio/mp4', 'audio'],
  ['audio/aac', 'audio'],
  ['audio/mpeg', 'audio'],
  ['audio/webm', 'audio'],
  ['audio/ogg', 'audio'],
]);

/** Bytes needed from the start of a file to recognize it. */
const SNIFF_BYTES = 16;

/** `image/jpeg; charset=x` -> `image/jpeg` (lowercase), or '' */
function baseMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function kindOf(mime) {
  return MEDIA_TYPES.get(baseMime(mime)) || null;
}

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

const ascii = (s) => [...Buffer.from(s, 'latin1')];

/**
 * Recognizes a file format from its first bytes. Returns
 * { format, kinds } where kinds are the families that format may carry, or null.
 */
function sniff(buf) {
  if (!buf || buf.length < 3) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { format: 'jpeg', kinds: ['image'] };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: 'png', kinds: ['image'] };
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return { format: 'gif', kinds: ['image'] };
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return { format: 'webp', kinds: ['image'] };
  // ISO base media (MP4, MOV, M4A, 3GP): a box whose type is `ftyp` at offset 4, then a
  // four-character major brand (isom, mp41, mp42, qt  , M4A , M4V , 3gp4, ...).
  if (startsWith(buf, ascii('ftyp'), 4) && buf.length >= 12 && buf.readUInt32BE(0) >= 8) {
    const brand = buf.subarray(8, 12);
    if ([...brand].every((b) => b >= 0x20 && b <= 0x7e)) return { format: 'mp4', kinds: ['video', 'audio'] };
    return null;
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { format: 'webm', kinds: ['video', 'audio'] };
  if (startsWith(buf, ascii('OggS'))) return { format: 'ogg', kinds: ['audio'] };
  if (startsWith(buf, ascii('ID3'))) return { format: 'mp3', kinds: ['audio'] };
  if (buf.length >= 2 && buf[0] === 0xff) {
    const b = buf[1];
    // AAC ADTS: 12-bit sync, layer 00 (FFF1 / FFF9, with or without CRC).
    if ((b & 0xf6) === 0xf0) return { format: 'aac', kinds: ['audio'] };
    // MPEG audio frame: 11-bit sync, a valid version and a non-reserved layer.
    if ((b & 0xe0) === 0xe0 && (b & 0x18) !== 0x08 && (b & 0x06) !== 0) return { format: 'mp3', kinds: ['audio'] };
  }
  return null;
}

/** True if the file's first bytes are a format of the declared type's family. */
function matchesKind(buf, kind) {
  const found = sniff(buf);
  return !!found && found.kinds.includes(kind);
}

/**
 * Parses a Range header against a file of `size` bytes. Only a single `bytes=` range is honoured.
 * Returns null to serve the whole file (no header, another unit, several ranges or bad syntax),
 * { unsatisfiable: true } for a 416, or { start, end } (inclusive).
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a.length > 15 || b.length > 15) return { unsatisfiable: true };
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null; // invalid range-spec: ignore the header (RFC 9110 14.1.1)
  if (start >= size) return { unsatisfiable: true };
  return { start, end: b === '' ? size - 1 : Math.min(Number(b), size - 1) };
}

/** Removes files from the uploads directory, ignoring ones already gone. */
function removeFiles(uploadsDir, names) {
  for (const name of names) {
    try {
      fs.rmSync(path.join(uploadsDir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

function partFile(uploadsDir, uploadId) {
  return path.join(uploadsDir, `.part-${uploadId}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = DAY_MS;

/**
 * Hourly housekeeping: deletes media older than MEDIA_RETENTION_DAYS (the message keeps an
 * `expired: true` attachment) and resumable uploads left unfinished for 24 hours.
 */
class MediaSweeper {
  constructor({ store, uploadsDir, retentionDays = 0, intervalMs = 60 * 60 * 1000, now = Date.now, log = console }) {
    this.store = store;
    this.uploadsDir = uploadsDir;
    this.retentionDays = retentionDays;
    this.now = now;
    this.log = log;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref();
  }

  /** Runs one sweep now. Returns { expired: [attachmentId], abandoned: [uploadId] }. */
  sweep() {
    const result = { expired: [], abandoned: [] };
    if (this.store.closed) return result;
    try {
      const now = this.now();
      if (this.retentionDays > 0) {
        result.expired = this.store.expireAttachmentsBefore(now - this.retentionDays * DAY_MS);
        removeFiles(this.uploadsDir, result.expired);
      }
      result.abandoned = this.store.deleteUploadsBefore(now - UPLOAD_TTL_MS);
      removeFiles(
        this.uploadsDir,
        result.abandoned.map((id) => `.part-${id}`)
      );
    } catch (err) {
      if (!this.store.closed) this.log.error('media sweep failed:', err && err.message);
    }
    return result;
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = {
  MEDIA_TYPES,
  SNIFF_BYTES,
  baseMime,
  kindOf,
  sniff,
  matchesKind,
  parseRange,
  removeFiles,
  partFile,
  MediaSweeper,
  UPLOAD_TTL_MS,
};
