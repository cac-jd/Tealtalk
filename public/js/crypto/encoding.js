// Byte encodings for TealTalk's end-to-end encryption (docs/E2EE.md).
// Pure functions with no DOM, so the same file runs in the browser and in Node.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text) {
  return encoder.encode(String(text));
}

/** Decode UTF-8, refusing invalid byte sequences. */
export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected bytes');
}

export function concat(...parts) {
  let length = 0;
  for (const p of parts) length += toBytes(p).length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    const b = toBytes(p);
    out.set(b, at);
    at += b.length;
  }
  return out;
}

export function uint32be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('uint32 out of range');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function bytesEqual(a, b) {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- base64url without padding ----------

export function b64u(data) {
  const bytes = toBytes(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

/** Strict decode: rejects padding, other alphabets and non-canonical trailing bits. */
export function fromB64u(text) {
  if (typeof text !== 'string' || !B64U_RE.test(text) || text.length % 4 === 1) {
    throw new TypeError('Invalid base64url');
  }
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64u(out) !== text) throw new TypeError('Invalid base64url');
  return out;
}

/** Length in bytes of a b64u string of `n` bytes. */
export function b64uLength(n) {
  return Math.ceil((n * 4) / 3);
}

// ---------- canonical JSON ----------

/** JSON with object keys sorted recursively (UTF-16 code unit order) and no whitespace. */
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonical(v))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError('Value cannot be encoded');
}

// ---------- recovery keys (Crockford base32) ----------

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_BYTES = 20;
const RECOVERY_CHARS = 32;

export class RecoveryKeyFormatError extends Error {}

/** 20 bytes -> "7K3M-…" (32 characters in 8 groups of 4). */
export function encodeRecoveryKey(bytes) {
  const b = toBytes(bytes);
  if (b.length !== RECOVERY_BYTES) throw new RangeError('A recovery key is 20 bytes');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of b) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g).join('-');
}

/**
 * What the person typed -> 20 bytes. Case-insensitive, ignores spaces and dashes,
 * and reads O as 0 and I/L as 1. Throws RecoveryKeyFormatError otherwise.
 */
export function decodeRecoveryKey(text) {
  const cleaned = String(text || '')
    .toUpperCase()
    .replace(/[\s\-‐-―_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== RECOVERY_CHARS) throw new RecoveryKeyFormatError('A recovery key has 32 letters and digits.');
  const out = new Uint8Array(RECOVERY_BYTES);
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of cleaned) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new RecoveryKeyFormatError('That recovery key has a character that isn’t used in recovery keys.');
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >>> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}
