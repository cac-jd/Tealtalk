'use strict';

// E2EE helpers for the server tests (not a test file itself). Key bundles are genuinely valid:
// real P-256 keys from WebCrypto (globalThis.crypto.subtle), a real keyId and a real selfSig.
// Envelopes are structurally valid (right fields, sizes, kinds, recipients and keyIds) but their
// ciphertext, wrapped keys and signature are random bytes: the server can't decrypt or check them.

const { subtle } = globalThis.crypto;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

function b64u(bytes) {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url');
}

function randomB64u(n) {
  return require('node:crypto').randomBytes(n).toString('base64url');
}

async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', Buffer.concat(parts.map((p) => Buffer.from(p)))));
}

/** Signs `text` (utf8) with an ECDSA P-256 private key: raw r||s, 64 bytes, as WebCrypto does. */
async function sign(sigPriv, text) {
  return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigPriv, Buffer.from(text, 'utf8')));
}

/**
 * A fresh account key for `userId`: { bundle, backup, keyId, encPair, sigPair }.
 * `createdAt` defaults to now; `signAs` signs the selfSig for another userId (to test rejection).
 */
async function makeKeys(userId, { createdAt = Date.now(), signAs = userId } = {}) {
  const encPair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const sigPair = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const encPub = new Uint8Array(await subtle.exportKey('spki', encPair.publicKey));
  const sigPub = new Uint8Array(await subtle.exportKey('spki', sigPair.publicKey));
  const keyId = b64u(await sha256([0x01], sigPub, encPub));
  const selfSig = b64u(await sign(sigPair.privateKey, `tealtalk-keys-v1|${signAs}|${keyId}|${createdAt}`));
  const bundle = { v: 1, encPub: b64u(encPub), sigPub: b64u(sigPub), keyId, createdAt, selfSig };
  // The backup is opaque to the server; its shape is all that matters here.
  const backup = { v: 1, keyId, iv: randomB64u(12), ct: randomB64u(400) };
  return { bundle, backup, keyId, encPair, sigPair, userId };
}

/** A real, fresh ECDH P-256 spki for `eph`. */
async function ephemeralSpki() {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return b64u(await subtle.exportKey('spki', pair.publicKey));
}

/** A P-256 spki from Node (fast, for building many envelopes). Cached per process. */
let cachedEph = null;
function cachedEphemeral() {
  if (!cachedEph) {
    const { generateKeyPairSync } = require('node:crypto');
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    cachedEph = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  }
  return cachedEph;
}

/**
 * A structurally valid envelope. `recipients` is { userId: keyId } (include the sender).
 * `ctBytes` sets the ciphertext size (to test the size limits).
 */
function envelope({ kind = 'message', senderKeyId, recipients, ctBytes = 64, eph = cachedEphemeral() }) {
  const keys = {};
  for (const [userId, k] of Object.entries(recipients)) keys[userId] = { k, w: randomB64u(60) };
  return { v: 1, kind, senderKeyId, eph, iv: randomB64u(12), ct: randomB64u(ctBytes), keys, sig: randomB64u(64) };
}

/**
 * The same bytes as base64url `s`, but with the unused low bits of the last character set: a
 * non-canonical encoding that lenient decoders accept. Needs a length that isn't a multiple of 3.
 */
function nonCanonical(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(s.at(-1));
  const tweaked = s.slice(0, -1) + alphabet[last | 1];
  if (tweaked === s || Buffer.from(tweaked, 'base64url').toString('base64url') !== s) throw new Error('no spare bits to set');
  return tweaked;
}

module.exports = { b64u, randomB64u, nonCanonical, sha256, sign, makeKeys, ephemeralSpki, cachedEphemeral, envelope };
