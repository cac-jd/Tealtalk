// Account keys: generation, the recovery-key backup, restore, and bundle checks
// (docs/E2EE.md "Keys"). WebCrypto only; no DOM.

import {
  utf8,
  fromUtf8,
  concat,
  b64u,
  fromB64u,
  canonical,
  randomBytes,
  bytesEqual,
  encodeRecoveryKey,
  decodeRecoveryKey,
  RecoveryKeyFormatError,
  RECOVERY_BYTES,
} from './encoding.js';

const subtle = () => globalThis.crypto.subtle;

export const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
export const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/** Largest backup we accept from the server (it caps backups at 4 KB too). */
const MAX_BACKUP_BYTES = 4096;
/** P-256 spki DER is always 91 bytes. */
export const SPKI_BYTES = 91;
export const KEY_ID_CHARS = 43;
export const SIG_BYTES = 64;

/** Thrown when a recovery key doesn't open the backup (wrong key, or a damaged backup). */
export class RecoveryError extends Error {
  constructor(message = 'That recovery key doesn’t match this account.') {
    super(message);
    this.code = 'recovery_failed';
  }
}

export class BundleError extends Error {
  constructor() {
    super('This key could not be verified.');
    this.code = 'bad_bundle';
  }
}

export async function sha256(data) {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

/** keyId = b64u(SHA-256(0x01 || sigPub || encPub)). */
export async function computeKeyId(sigPubBytes, encPubBytes) {
  return b64u(await sha256(concat(Uint8Array.of(1), sigPubBytes, encPubBytes)));
}

export function selfSigMessage(userId, keyId, createdAt) {
  return utf8(`tealtalk-keys-v1|${userId}|${keyId}|${createdAt}`);
}

export function importEncPub(spki) {
  return subtle().importKey('spki', spki, ECDH, true, []);
}

export function importSigPub(spki) {
  return subtle().importKey('spki', spki, ECDSA, true, ['verify']);
}

function importEncPriv(pkcs8) {
  return subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
}

function importSigPriv(pkcs8) {
  return subtle().importKey('pkcs8', pkcs8, ECDSA, false, ['sign']);
}

export async function sign(sigPriv, message) {
  return new Uint8Array(await subtle().sign(ECDSA_SIGN, sigPriv, message));
}

export async function verify(sigPub, signature, message) {
  try {
    return await subtle().verify(ECDSA_SIGN, sigPub, signature, message);
  } catch {
    return false;
  }
}

/** HKDF-SHA-256 -> AES-256-GCM key. */
export async function hkdfAesKey(ikm, salt, info, usages = ['encrypt', 'decrypt']) {
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

function backupKey(recoveryBytes, userId) {
  return hkdfAesKey(recoveryBytes, utf8(`tealtalk-backup|${userId}`), utf8('tealtalk-backup-v1'));
}

function backupAad(userId, keyId) {
  return utf8(`${userId}|${keyId}`);
}

/** backup = { v: 1, keyId, iv, ct } (docs/E2EE.md "Recovery key and backup"). */
export async function makeBackup(userId, keyId, encPkcs8, sigPkcs8, recoveryBytes) {
  const key = await backupKey(recoveryBytes, userId);
  const iv = randomBytes(12);
  const plain = utf8(canonical({ encPriv: b64u(encPkcs8), sigPriv: b64u(sigPkcs8) }));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: backupAad(userId, keyId) }, key, plain);
  return { v: 1, keyId, iv: b64u(iv), ct: b64u(ct) };
}

function bundleShapeOk(bundle) {
  return (
    !!bundle &&
    typeof bundle === 'object' &&
    bundle.v === 1 &&
    typeof bundle.encPub === 'string' &&
    typeof bundle.sigPub === 'string' &&
    typeof bundle.keyId === 'string' &&
    bundle.keyId.length === KEY_ID_CHARS &&
    Number.isSafeInteger(bundle.createdAt) &&
    bundle.createdAt > 0 &&
    typeof bundle.selfSig === 'string'
  );
}

/**
 * Check a public key bundle for `userId`: both keys are P-256 spki, the keyId
 * recomputes and the self-signature verifies. Returns the imported public keys.
 * Throws BundleError on any problem.
 */
export async function verifyBundle(bundle, userId) {
  try {
    if (!bundleShapeOk(bundle) || typeof userId !== 'string' || !userId) throw new Error('shape');
    const encPubBytes = fromB64u(bundle.encPub);
    const sigPubBytes = fromB64u(bundle.sigPub);
    if (encPubBytes.length !== SPKI_BYTES || sigPubBytes.length !== SPKI_BYTES) throw new Error('length');
    const keyId = await computeKeyId(sigPubBytes, encPubBytes);
    if (keyId !== bundle.keyId) throw new Error('keyId');
    const [encPub, sigPub] = await Promise.all([importEncPub(encPubBytes), importSigPub(sigPubBytes)]);
    const selfSig = fromB64u(bundle.selfSig);
    if (selfSig.length !== SIG_BYTES) throw new Error('sig length');
    const ok = await verify(sigPub, selfSig, selfSigMessage(userId, keyId, bundle.createdAt));
    if (!ok) throw new Error('sig');
    return { userId, keyId, bundle, encPub, sigPub, encPubBytes, sigPubBytes };
  } catch {
    throw new BundleError();
  }
}

/** Do these private keys belong to these public keys? (A damaged or swapped backup fails here.) */
async function keysMatch(encPriv, sigPriv, encPub, sigPub) {
  const probe = randomBytes(32);
  const signature = await sign(sigPriv, probe);
  if (!(await verify(sigPub, signature, probe))) return false;
  const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const a = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: encPub }, eph.privateKey, 256));
  const b = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: eph.publicKey }, encPriv, 256));
  return bytesEqual(a, b);
}

/**
 * Make a fresh key pair for `userId`.
 * Generate extractable keys -> export pkcs8 -> build the backup -> re-import as
 * non-extractable -> drop the extractable copies.
 * Returns { bundle, backup, account } where `account` is what the device stores.
 */
export async function createAccountKeys(userId, { now = Date.now() } = {}) {
  if (typeof userId !== 'string' || !userId) throw new TypeError('userId required');
  let enc = await subtle().generateKey(ECDH, true, ['deriveBits']);
  let sig = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  const encPubBytes = new Uint8Array(await subtle().exportKey('spki', enc.publicKey));
  const sigPubBytes = new Uint8Array(await subtle().exportKey('spki', sig.publicKey));
  let encPkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', enc.privateKey));
  let sigPkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', sig.privateKey));
  const keyId = await computeKeyId(sigPubBytes, encPubBytes);
  const createdAt = Math.floor(now);

  const recoveryBytes = randomBytes(RECOVERY_BYTES);
  const backup = await makeBackup(userId, keyId, encPkcs8, sigPkcs8, recoveryBytes);

  const encPriv = await importEncPriv(encPkcs8);
  const sigPriv = await importSigPriv(sigPkcs8);
  const selfSig = await sign(sigPriv, selfSigMessage(userId, keyId, createdAt));
  // Drop the extractable copies (best effort: JS can't force memory to be wiped).
  encPkcs8.fill(0);
  sigPkcs8.fill(0);
  encPkcs8 = sigPkcs8 = null;
  enc = sig = null;

  const bundle = {
    v: 1,
    encPub: b64u(encPubBytes),
    sigPub: b64u(sigPubBytes),
    keyId,
    createdAt,
    selfSig: b64u(selfSig),
  };
  const recoveryKey = encodeRecoveryKey(recoveryBytes);
  recoveryBytes.fill(0);
  return {
    bundle,
    backup,
    account: { userId, keyId, encPriv, sigPriv, encPub: bundle.encPub, sigPub: bundle.sigPub, recoveryKey, bundle },
  };
}

function backupShapeOk(backup) {
  return (
    !!backup &&
    typeof backup === 'object' &&
    backup.v === 1 &&
    typeof backup.keyId === 'string' &&
    typeof backup.iv === 'string' &&
    typeof backup.ct === 'string' &&
    backup.ct.length <= MAX_BACKUP_BYTES * 2
  );
}

/**
 * Open the backup with what the person typed. Checks the keyId matches the
 * account's current bundle and that the keys really pair with it.
 * Throws RecoveryKeyFormatError for a mistyped key, RecoveryError otherwise.
 */
export async function restoreFromBackup(userId, recoveryText, backup, bundle) {
  const recoveryBytes = decodeRecoveryKey(recoveryText); // RecoveryKeyFormatError
  try {
    if (!backupShapeOk(backup)) throw new Error('shape');
    const pub = await verifyBundle(bundle, userId);
    if (backup.keyId !== pub.keyId) throw new Error('keyId');
    const key = await backupKey(recoveryBytes, userId);
    const iv = fromB64u(backup.iv);
    if (iv.length !== 12) throw new Error('iv');
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: backupAad(userId, backup.keyId) },
      key,
      fromB64u(backup.ct),
    );
    const parsed = JSON.parse(fromUtf8(new Uint8Array(plain)));
    if (!parsed || typeof parsed.encPriv !== 'string' || typeof parsed.sigPriv !== 'string') throw new Error('content');
    const encPkcs8 = fromB64u(parsed.encPriv);
    const sigPkcs8 = fromB64u(parsed.sigPriv);
    const encPriv = await importEncPriv(encPkcs8);
    const sigPriv = await importSigPriv(sigPkcs8);
    encPkcs8.fill(0);
    sigPkcs8.fill(0);
    if (!(await keysMatch(encPriv, sigPriv, pub.encPub, pub.sigPub))) throw new Error('mismatch');
    return {
      userId,
      keyId: pub.keyId,
      encPriv,
      sigPriv,
      encPub: bundle.encPub,
      sigPub: bundle.sigPub,
      recoveryKey: encodeRecoveryKey(recoveryBytes),
      bundle,
    };
  } catch {
    throw new RecoveryError();
  } finally {
    recoveryBytes.fill(0);
  }
}

export { RecoveryKeyFormatError };
