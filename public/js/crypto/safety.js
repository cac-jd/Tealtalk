// Safety numbers (docs/E2EE.md "Safety numbers"). WebCrypto only; no DOM.

import { utf8, concat, fromB64u } from './encoding.js';

const ITERATIONS = 1024;

/**
 * 30 digits for one user. input = 0x00 0x01 || sigPub || encPub || utf8(userId);
 * h = input, then 1024 times h = SHA-256(h || input); the first 30 bytes of the
 * result, in 5-byte chunks, each read as a big-endian uint40 mod 100000.
 */
export async function fingerprintDigits(userId, sigPubBytes, encPubBytes) {
  const input = concat(Uint8Array.of(0x00, 0x01), sigPubBytes, encPubBytes, utf8(userId));
  let h = input;
  for (let i = 0; i < ITERATIONS; i++) {
    h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', concat(h, input)));
  }
  let out = '';
  for (let c = 0; c < 6; c++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[c * 5 + j];
    out += String(n % 100000).padStart(5, '0');
  }
  return out;
}

function bundleBytes(bundle) {
  return [fromB64u(bundle.sigPub), fromB64u(bundle.encPub)];
}

/**
 * The 60-digit number for a pair: the lower userId's 30 digits first.
 * a, b: { userId, bundle } (bundles already verified).
 */
export async function safetyNumber(a, b) {
  const [first, second] = a.userId < b.userId ? [a, b] : [b, a];
  const d1 = await fingerprintDigits(first.userId, ...bundleBytes(first.bundle));
  const d2 = await fingerprintDigits(second.userId, ...bundleBytes(second.bundle));
  return d1 + d2;
}

/** "12345 67890 …": 12 groups of 5. */
export function formatSafetyNumber(digits) {
  return String(digits).match(/.{1,5}/g).join(' ');
}
