// Message envelopes: one format for new messages, edits and reactions
// (docs/E2EE.md "Messages"). WebCrypto only; no DOM.

import { utf8, fromUtf8, concat, b64u, fromB64u, canonical, randomBytes } from './encoding.js';
import { sha256, hkdfAesKey, sign, verify, ECDH, SPKI_BYTES, KEY_ID_CHARS, SIG_BYTES } from './keys.js';

const subtle = () => globalThis.crypto.subtle;

/** Envelope JSON over this is refused (the server caps it at 64 KB too). */
export const MAX_ENVELOPE_BYTES = 64 * 1024;
const WRAPPED_BYTES = 12 + 32 + 16;
const KIND_RE = /^(message|edit:[1-9][0-9]{0,15}|reaction:[1-9][0-9]{0,15})$/;
/** The fields of a v1 envelope, in no particular order. Anything else is ignored. */
const FIELDS = ['v', 'kind', 'senderKeyId', 'eph', 'iv', 'ct', 'keys'];

/**
 * Every failure to open an envelope ends here with one of two codes, and nothing
 * about which step failed: 'unverified' (signature) or 'undecryptable' (all else).
 */
export class EnvelopeError extends Error {
  constructor(code) {
    super(code === 'unverified' ? "Couldn't verify this message" : "Can't decrypt this message");
    this.code = code;
  }
}

export function isValidKind(kind) {
  return typeof kind === 'string' && KIND_RE.test(kind);
}

export function messageAad(conversationId, senderId, clientId, kind) {
  return `tealtalk-msg-v1|${conversationId}|${senderId}|${clientId}|${kind}`;
}

function wrapInfo(conversationId, clientId, kind, userId, keyId) {
  return utf8(`tealtalk-wrap-v1|${conversationId}|${clientId}|${kind}|${userId}|${keyId}`);
}

async function wrapKeyFor(privateKey, publicKey, ephSpki, info, usages) {
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
  try {
    return await hkdfAesKey(shared, await sha256(ephSpki), info, usages);
  } finally {
    shared.fill(0);
  }
}

/** The bytes the sender signs: canonical(envelope without sig) + '|' + AAD. */
function signedBytes(envelope, aad) {
  const unsigned = {};
  for (const f of FIELDS) unsigned[f] = envelope[f];
  return utf8(`${canonical(unsigned)}|${aad}`);
}

function isB64uOf(value, bytes) {
  if (typeof value !== 'string') return false;
  try {
    return fromB64u(value).length === bytes;
  } catch {
    return false;
  }
}

/** Structural checks that need no keys. True if the envelope looks like a v1 envelope. */
export function envelopeShapeOk(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  if (env.v !== 1 || !isValidKind(env.kind)) return false;
  if (typeof env.senderKeyId !== 'string' || env.senderKeyId.length !== KEY_ID_CHARS) return false;
  if (!isB64uOf(env.eph, SPKI_BYTES) || !isB64uOf(env.iv, 12) || !isB64uOf(env.sig, SIG_BYTES)) return false;
  if (typeof env.ct !== 'string' || env.ct.length < 22 || env.ct.length > MAX_ENVELOPE_BYTES) return false;
  if (!env.keys || typeof env.keys !== 'object' || Array.isArray(env.keys)) return false;
  const entries = Object.entries(env.keys);
  if (!entries.length || entries.length > 1000) return false;
  for (const [, entry] of entries) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.k !== 'string' || entry.k.length !== KEY_ID_CHARS) return false;
    if (!isB64uOf(entry.w, WRAPPED_BYTES)) return false;
  }
  return true;
}

/**
 * Seal `payload` (which must carry the same `kind`) for `recipients`
 * ([{ userId, keyId, encPub: CryptoKey }], including the sender).
 */
export async function sealEnvelope({ conversationId, senderId, senderKeyId, sigPriv, clientId, kind, payload, recipients }) {
  if (!isValidKind(kind)) throw new TypeError('Bad envelope kind');
  if (!payload || payload.kind !== kind) throw new TypeError('Payload kind must match');
  if (!recipients || !recipients.length) throw new TypeError('No recipients');
  const aad = messageAad(conversationId, senderId, clientId, kind);

  const contentKeyBytes = randomBytes(32);
  const contentKey = await subtle().importKey('raw', contentKeyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, contentKey, utf8(JSON.stringify(payload)));

  const eph = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const ephSpki = new Uint8Array(await subtle().exportKey('spki', eph.publicKey));
  const keys = {};
  try {
    for (const r of recipients) {
      if (keys[r.userId]) throw new TypeError('Duplicate recipient');
      const wrapKey = await wrapKeyFor(eph.privateKey, r.encPub, ephSpki, wrapInfo(conversationId, clientId, kind, r.userId, r.keyId), ['encrypt']);
      const wiv = randomBytes(12);
      const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv: wiv }, wrapKey, contentKeyBytes);
      keys[r.userId] = { k: r.keyId, w: b64u(concat(wiv, new Uint8Array(wrapped))) };
    }
  } finally {
    contentKeyBytes.fill(0);
  }

  const envelope = { v: 1, kind, senderKeyId, eph: b64u(ephSpki), iv: b64u(iv), ct: b64u(ct), keys };
  envelope.sig = b64u(await sign(sigPriv, signedBytes(envelope, aad)));
  return envelope;
}

/**
 * Verify, then open an envelope.
 *  - context: { conversationId, senderId, clientId, expectedKind }
 *  - sender: { keyId, sigPub } from the sender's verified bundle for envelope.senderKeyId
 *  - me: { userId, keyId, encPriv }
 * Returns the payload. The signature is checked before anything is decrypted.
 * Throws EnvelopeError('unverified' | 'undecryptable').
 */
export async function openEnvelope(envelope, { conversationId, senderId, clientId, expectedKind }, sender, me) {
  let aad;
  try {
    if (!envelopeShapeOk(envelope)) throw new Error('shape');
    if (expectedKind !== undefined && envelope.kind !== expectedKind) throw new Error('kind');
    if (!sender || sender.keyId !== envelope.senderKeyId || !sender.sigPub) throw new Error('sender');
    aad = messageAad(conversationId, senderId, clientId, envelope.kind);
    const ok = await verify(sender.sigPub, fromB64u(envelope.sig), signedBytes(envelope, aad));
    if (!ok) throw new Error('sig');
  } catch {
    throw new EnvelopeError('unverified');
  }
  try {
    const entry = Object.prototype.hasOwnProperty.call(envelope.keys, me.userId) ? envelope.keys[me.userId] : null;
    if (!entry || entry.k !== me.keyId) throw new Error('not for me');
    const ephSpki = fromB64u(envelope.eph);
    const ephPub = await subtle().importKey('spki', ephSpki, ECDH, false, []);
    const wrapKey = await wrapKeyFor(me.encPriv, ephPub, ephSpki, wrapInfo(conversationId, clientId, envelope.kind, me.userId, entry.k), ['decrypt']);
    const w = fromB64u(entry.w);
    const contentKeyBytes = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12) }, wrapKey, w.subarray(12)));
    let contentKey;
    try {
      contentKey = await subtle().importKey('raw', contentKeyBytes, 'AES-GCM', false, ['decrypt']);
    } finally {
      contentKeyBytes.fill(0);
    }
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64u(envelope.iv), additionalData: utf8(aad) },
      contentKey,
      fromB64u(envelope.ct),
    );
    const payload = JSON.parse(fromUtf8(new Uint8Array(plain)));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.kind !== envelope.kind) {
      throw new Error('payload');
    }
    return payload;
  } catch {
    throw new EnvelopeError('undecryptable');
  }
}
