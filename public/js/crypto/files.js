// Record-based file encryption for photos, videos, voice messages and thumbnails
// (docs/E2EE.md "Files"). WebCrypto only; no DOM. Works on Blobs (read slice by
// slice) and Uint8Arrays, so a 250 MB video is never held in memory twice.

import { utf8, concat, uint32be, b64u, fromB64u, randomBytes, toBytes } from './encoding.js';

const subtle = () => globalThis.crypto.subtle;

export const RECORD_SIZE = 262144; // 256 KiB of plaintext per record
export const TAG_BYTES = 16;
export const E2EE_MIME = 'application/vnd.tealtalk.e2ee';
const AAD_PREFIX = utf8('tealtalk-file-v1');
const MAX_RECORD_SIZE = 16 * 1024 * 1024;

export class FileDecryptError extends Error {
  constructor() {
    super('Can’t decrypt this file');
    this.code = 'undecryptable';
  }
}

/** Number of records: an empty file is one empty final record. */
export function recordCount(size, recordSize = RECORD_SIZE) {
  return Math.max(1, Math.ceil(size / recordSize));
}

/** Ciphertext size = size + 16 × number of records. */
export function cipherSize(size, recordSize = RECORD_SIZE) {
  return size + TAG_BYTES * recordCount(size, recordSize);
}

/** A fresh key for one file: { key, noncePrefix, recordSize } (b64u strings, as in the payload). */
export function newFileKey(recordSize = RECORD_SIZE) {
  return { key: b64u(randomBytes(32)), noncePrefix: b64u(randomBytes(8)), recordSize };
}

function checkParams({ key, noncePrefix, recordSize }) {
  const keyBytes = fromB64u(key);
  const prefix = fromB64u(noncePrefix);
  if (keyBytes.length !== 32 || prefix.length !== 8) throw new TypeError('Bad file key');
  if (!Number.isInteger(recordSize) || recordSize < 1 || recordSize > MAX_RECORD_SIZE) throw new TypeError('Bad record size');
  return { keyBytes, prefix, recordSize };
}

async function importKey(keyBytes, usage) {
  return subtle().importKey('raw', keyBytes, 'AES-GCM', false, [usage]);
}

function nonce(prefix, i) {
  return concat(prefix, uint32be(i));
}

function recordAad(i, last) {
  return concat(AAD_PREFIX, uint32be(i), Uint8Array.of(last ? 1 : 0));
}

async function readPlain(source, start, end) {
  if (source instanceof Uint8Array) return source.subarray(start, end);
  return new Uint8Array(await source.slice(start, end).arrayBuffer());
}

function sourceSize(source) {
  return source instanceof Uint8Array ? source.length : source.size;
}

/**
 * Encrypts `source` (Blob/File or Uint8Array) lazily. `read(start, end)` returns
 * the ciphertext bytes [start, end) as a Uint8Array, encrypting only the records
 * that range touches. Records are deterministic for a key, nonce prefix and index,
 * so a resumed upload can start at any offset and get byte-identical output.
 */
export async function createEncryptor(source, params) {
  if (!(source instanceof Uint8Array)) source = source instanceof ArrayBuffer ? toBytes(source) : source;
  const { keyBytes, prefix, recordSize } = checkParams(params);
  const key = await importKey(keyBytes, 'encrypt');
  const plainSize = sourceSize(source);
  const count = recordCount(plainSize, recordSize);
  const cipherRecord = recordSize + TAG_BYTES;
  const size = cipherSize(plainSize, recordSize);

  async function encryptRecord(i) {
    const start = i * recordSize;
    const plain = await readPlain(source, start, Math.min(plainSize, start + recordSize));
    const last = i === count - 1;
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonce(prefix, i), additionalData: recordAad(i, last) }, key, plain);
    return new Uint8Array(ct);
  }

  async function read(start, end) {
    start = Math.max(0, start);
    end = Math.min(size, end);
    if (end <= start) return new Uint8Array(0);
    const first = Math.floor(start / cipherRecord);
    const lastIndex = Math.floor((end - 1) / cipherRecord);
    const parts = [];
    for (let i = first; i <= lastIndex; i++) {
      const rec = await encryptRecord(i);
      const recStart = i * cipherRecord;
      const from = Math.max(0, start - recStart);
      const to = Math.min(rec.length, end - recStart);
      parts.push(from === 0 && to === rec.length ? rec : rec.subarray(from, to));
    }
    return parts.length === 1 ? parts[0] : concat(...parts);
  }

  return { size, plainSize, records: count, read, encryptRecord };
}

/** Encrypt a whole (small) file at once. */
export async function encryptBytes(source, params) {
  const enc = await createEncryptor(source, params);
  return enc.read(0, enc.size);
}

/**
 * Decrypts a ciphertext stream record by record. Feed it chunks of any size with
 * push(); it returns plaintext pieces as records complete. finish() throws if
 * records are missing, cut off, reordered or extended.
 * `size` is the plaintext size from the encrypted payload.
 */
export class RecordDecryptor {
  constructor(params, size) {
    const { keyBytes, prefix, recordSize } = checkParams(params);
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Bad size');
    this.keyBytes = keyBytes;
    this.prefix = prefix;
    this.recordSize = recordSize;
    this.count = recordCount(size, recordSize);
    this.cipherTotal = cipherSize(size, recordSize);
    this.received = 0;
    this.index = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.key = null;
    this.failed = false;
  }

  recordLength(i) {
    if (i < this.count - 1) return this.recordSize + TAG_BYTES;
    return this.cipherTotal - (this.count - 1) * (this.recordSize + TAG_BYTES);
  }

  async decryptRecord(bytes) {
    if (!this.key) this.key = await importKey(this.keyBytes, 'decrypt');
    const i = this.index;
    const last = i === this.count - 1;
    try {
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: nonce(this.prefix, i), additionalData: recordAad(i, last) }, this.key, bytes);
      this.index++;
      return new Uint8Array(plain);
    } catch {
      this.failed = true;
      throw new FileDecryptError();
    }
  }

  take(n) {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.pending[0];
      const need = n - at;
      if (head.length <= need) {
        out.set(head, at);
        at += head.length;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, need), at);
        this.pending[0] = head.subarray(need);
        at += need;
      }
    }
    this.pendingBytes -= n;
    return out;
  }

  /** Returns the plaintext of any records completed by this chunk. */
  async push(chunk) {
    if (this.failed) throw new FileDecryptError();
    const bytes = toBytes(chunk);
    this.received += bytes.length;
    if (this.received > this.cipherTotal) {
      this.failed = true;
      throw new FileDecryptError(); // extended
    }
    if (bytes.length) {
      this.pending.push(bytes);
      this.pendingBytes += bytes.length;
    }
    const out = [];
    while (this.index < this.count && this.pendingBytes >= this.recordLength(this.index)) {
      out.push(await this.decryptRecord(this.take(this.recordLength(this.index))));
    }
    return out;
  }

  /** Call when the stream ended: throws unless every record arrived and verified. */
  finish() {
    if (this.failed || this.index !== this.count || this.pendingBytes !== 0 || this.received !== this.cipherTotal) {
      this.failed = true;
      throw new FileDecryptError();
    }
  }
}

/**
 * Decrypt a whole ciphertext (Blob or Uint8Array) into a Blob of type `mime`.
 * Reads the Blob slice by slice and groups plaintext into Blob parts as it goes.
 */
export async function decryptToBlob(cipher, params, size, mime) {
  const dec = new RecordDecryptor(params, size);
  const parts = [];
  const total = cipher instanceof Uint8Array ? cipher.length : cipher.size;
  if (total !== dec.cipherTotal) throw new FileDecryptError();
  const step = (params.recordSize + TAG_BYTES) * 16;
  for (let at = 0; at < total; at += step) {
    const chunk = cipher instanceof Uint8Array ? cipher.subarray(at, at + step) : new Uint8Array(await cipher.slice(at, at + step).arrayBuffer());
    const plain = await dec.push(chunk);
    if (plain.length) parts.push(new Blob(plain));
  }
  if (total === 0) await dec.push(new Uint8Array(0));
  dec.finish();
  return new Blob(parts, { type: mime || '' });
}
