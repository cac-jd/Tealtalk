'use strict';

// End-to-end encryption (docs/E2EE.md): the server can't decrypt anything, but it checks that key
// bundles are genuine and that every envelope is well formed and addressed to exactly the right
// people with their current keys. Nothing in here ever logs a bundle, backup or envelope.

const crypto = require('node:crypto');
const { HttpError } = require('./util');

/** Upload type for encrypted files: opaque bytes, no magic-byte check. */
const E2EE_MIME = 'application/vnd.tealtalk.e2ee';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_BACKUP_BYTES = 4 * 1024;
const P256_SPKI_BYTES = 91; // an uncompressed P-256 spki is exactly 91 bytes (bundle keys must be this)
const KEY_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const B64U_RE = /^[A-Za-z0-9_-]*$/;
const RECIPIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WRAPPED_KEY_BYTES = 12 + 32 + 16; // iv || AES-GCM(256-bit K) with its 16-byte tag

const BUNDLE_FIELDS = ['v', 'encPub', 'sigPub', 'keyId', 'createdAt', 'selfSig'];
const BACKUP_FIELDS = ['v', 'keyId', 'iv', 'ct'];
const ENVELOPE_FIELDS = ['v', 'kind', 'senderKeyId', 'eph', 'iv', 'ct', 'keys', 'sig'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** True when `obj` has exactly the `required` own keys (plus any of `optional`). */
function hasExactFields(obj, required, optional = []) {
  const keys = Object.keys(obj);
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * Decodes canonical, unpadded base64url. Returns a Buffer, or null when the value is not a string,
 * has padding or other characters, isn't the canonical encoding, or its decoded length is outside
 * [minBytes, maxBytes].
 */
function decodeB64u(value, minBytes = 0, maxBytes = Infinity) {
  if (typeof value !== 'string' || !B64U_RE.test(value) || value.length % 4 === 1) return null;
  if (value.length > Math.ceil((maxBytes * 4) / 3)) return null;
  const buf = Buffer.from(value, 'base64url');
  if (buf.toString('base64url') !== value) return null;
  if (buf.length < minBytes || buf.length > maxBytes) return null;
  return buf;
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Parses spki DER and returns the KeyObject if it is an EC P-256 public key, else null. */
function p256PublicKey(der) {
  if (!der) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    if (!key.asymmetricKeyDetails || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') return null;
    return key;
  } catch {
    return null;
  }
}

/** keyId = b64u(SHA-256(0x01 || sigPub || encPub)), over the spki DER bytes. */
function computeKeyId(sigPubDer, encPubDer) {
  return b64u(crypto.createHash('sha256').update(Buffer.from([0x01])).update(sigPubDer).update(encPubDer).digest());
}

/** The bytes a bundle's selfSig signs. */
function selfSigData(userId, keyId, createdAt) {
  return Buffer.from(`tealtalk-keys-v1|${userId}|${keyId}|${createdAt}`, 'utf8');
}

const bad = (msg) => new HttpError(400, msg);

/**
 * Validates an account key bundle for `userId` (docs/E2EE.md, "Account key bundle"). Both keys must
 * be uncompressed P-256 spki (exactly 91 bytes), keyId must recompute, selfSig must verify for this
 * user and createdAt must be within a day of `now`. With `allowOld` (the account has no current key,
 * e.g. a device re-publishing its key after the server lost it) an older createdAt is accepted, but
 * never one more than a day in the future. Returns the normalized bundle (exactly the six fields).
 */
function validateBundle(bundle, userId, now, { allowOld = false } = {}) {
  if (!isPlainObject(bundle) || !hasExactFields(bundle, BUNDLE_FIELDS)) throw bad('Invalid key bundle');
  if (bundle.v !== 1) throw bad('Unsupported key bundle version');
  const encDer = decodeB64u(bundle.encPub, P256_SPKI_BYTES, P256_SPKI_BYTES);
  const sigDer = decodeB64u(bundle.sigPub, P256_SPKI_BYTES, P256_SPKI_BYTES);
  if (!p256PublicKey(encDer)) throw bad('encPub must be a P-256 public key');
  const sigKey = p256PublicKey(sigDer);
  if (!sigKey) throw bad('sigPub must be a P-256 public key');
  if (typeof bundle.keyId !== 'string' || !KEY_ID_RE.test(bundle.keyId) || bundle.keyId !== computeKeyId(sigDer, encDer)) {
    throw bad("keyId doesn't match the keys");
  }
  const { createdAt } = bundle;
  const tooOld = !allowOld && createdAt < now - DAY_MS;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > now + DAY_MS || tooOld) {
    throw bad("createdAt must be the current time (check your phone's clock)");
  }
  const sig = decodeB64u(bundle.selfSig, 64, 64);
  let ok = false;
  if (sig) {
    try {
      ok = crypto.verify('sha256', selfSigData(userId, bundle.keyId, createdAt), { key: sigKey, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      ok = false;
    }
  }
  if (!ok) throw bad("The key bundle's signature doesn't verify");
  return {
    v: 1,
    encPub: bundle.encPub,
    sigPub: bundle.sigPub,
    keyId: bundle.keyId,
    createdAt,
    selfSig: bundle.selfSig,
  };
}

/** Validates the encrypted private-key backup `{ v: 1, keyId, iv, ct }` (at most 4 KB of JSON). */
function validateBackup(backup, keyId) {
  if (!isPlainObject(backup) || !hasExactFields(backup, BACKUP_FIELDS)) throw bad('Invalid key backup');
  if (backup.v !== 1) throw bad('Unsupported key backup version');
  if (backup.keyId !== keyId) throw bad("The backup's keyId doesn't match the bundle");
  if (!decodeB64u(backup.iv, 12, 12)) throw bad('Invalid key backup');
  if (!decodeB64u(backup.ct, 17, MAX_BACKUP_BYTES)) throw bad('Invalid key backup');
  const normalized = { v: 1, keyId: backup.keyId, iv: backup.iv, ct: backup.ct };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BACKUP_BYTES) throw bad('The key backup is too big');
  return normalized;
}

/**
 * Checks an envelope's shape (docs/E2EE.md, "Envelope"): every field present and nothing else,
 * sane base64url lengths, at most 64 KB of JSON and `kind` equal to `expectedKind`. Recipients are
 * checked separately against the conversation (see checkRecipients). Returns the envelope.
 *
 * An optional `clientId` field inside the envelope is tolerated when it equals the request's
 * clientId (the request's clientId is what the server stores and returns).
 */
function validateEnvelope(env, expectedKind, clientId, maxRecipients) {
  if (!isPlainObject(env) || !hasExactFields(env, ENVELOPE_FIELDS, ['clientId'])) throw bad('Invalid encrypted message');
  if ('clientId' in env && env.clientId !== clientId) throw bad('Invalid encrypted message');
  if (Buffer.byteLength(JSON.stringify(env)) > MAX_ENVELOPE_BYTES) throw new HttpError(413, 'That message is too big');
  if (env.v !== 1) throw bad('Unsupported encrypted message version');
  if (env.kind !== expectedKind) throw bad("The encrypted message's kind doesn't match");
  if (typeof env.senderKeyId !== 'string' || !KEY_ID_RE.test(env.senderKeyId)) throw bad('Invalid encrypted message');
  if (!p256PublicKey(decodeB64u(env.eph, P256_SPKI_BYTES, P256_SPKI_BYTES))) throw bad('Invalid encrypted message');
  if (!decodeB64u(env.iv, 12, 12)) throw bad('Invalid encrypted message');
  if (!decodeB64u(env.ct, 16, MAX_ENVELOPE_BYTES)) throw bad('Invalid encrypted message');
  if (!decodeB64u(env.sig, 64, 64)) throw bad('Invalid encrypted message');
  if (!isPlainObject(env.keys)) throw bad('Invalid encrypted message');
  const ids = Object.keys(env.keys);
  if (!ids.length || ids.length > maxRecipients) throw bad('Invalid encrypted message');
  for (const id of ids) {
    const entry = env.keys[id];
    if (!RECIPIENT_ID_RE.test(id) || !isPlainObject(entry) || !hasExactFields(entry, ['k', 'w'])) {
      throw bad('Invalid encrypted message');
    }
    if (typeof entry.k !== 'string' || !KEY_ID_RE.test(entry.k)) throw bad('Invalid encrypted message');
    if (!decodeB64u(entry.w, WRAPPED_KEY_BYTES, WRAPPED_KEY_BYTES)) throw bad('Invalid encrypted message');
  }
  return env;
}

/**
 * Delivery checks, in the order docs/E2EE.md lists them:
 * 1. senderKeyId is the sender's current keyId, else 409 { error: "keys_changed" }
 * 2. the recipients are exactly `audience` (everyone who can see the message, sender included),
 *    else 409 { error: "members_changed", members }
 * 3. every recipient has keys, else 409 { error: "missing_keys", missing }
 * 4. each `k` is that recipient's current keyId, else 409 { error: "keys_changed", keys: { userId: Bundle } }
 *    (only the recipients whose key differs are listed)
 *
 * `keysFor(userIds)` returns a Map userId -> { keyId, bundle } of current keys.
 */
function checkRecipients(env, senderId, audience, keysFor) {
  const current = keysFor(audience.includes(senderId) ? audience : [...audience, senderId]);
  const mine = current.get(senderId);
  if (!mine || env.senderKeyId !== mine.keyId) throw new HttpError(409, 'keys_changed');
  const got = Object.keys(env.keys);
  const want = new Set(audience);
  if (got.length !== want.size || !got.every((id) => want.has(id))) {
    throw new HttpError(409, 'members_changed', null, { members: [...audience] });
  }
  const missing = audience.filter((id) => !current.has(id));
  if (missing.length) throw new HttpError(409, 'missing_keys', null, { missing });
  const changed = {};
  let anyChanged = false;
  for (const id of audience) {
    const cur = current.get(id);
    if (env.keys[id].k !== cur.keyId) {
      changed[id] = cur.bundle;
      anyChanged = true;
    }
  }
  if (anyChanged) throw new HttpError(409, 'keys_changed', null, { keys: changed });
}

module.exports = {
  E2EE_MIME,
  MAX_ENVELOPE_BYTES,
  MAX_BACKUP_BYTES,
  KEY_ID_RE,
  decodeB64u,
  computeKeyId,
  selfSigData,
  p256PublicKey,
  validateBundle,
  validateBackup,
  validateEnvelope,
  checkRecipients,
};
