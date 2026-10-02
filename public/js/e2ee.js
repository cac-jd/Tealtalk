// End-to-end encryption glue (docs/E2EE.md): this device's account key, the key
// directory with trust-on-first-use pins, sealing outgoing envelopes (with the
// server's 409 retry rules) and opening incoming ones into cached "views".
//
// Decrypted text only ever lives in memory here. Failures surface as two fixed
// states, 'unverified' and 'undecryptable'; nothing ever falls back to plaintext.
//
// The server is never trusted with who gets a message or with which key:
//  - we only seal to a contact's pinned key; a different key from the server is a
//    safety-number change (a notice, and a confirmation first if they were verified)
//  - a 1:1 chat is only ever sealed to its two people; new people in a group get a
//    local notice before anything is sealed to them
//  - this device never deletes or replaces its own key on the server's word

import { Api, ApiError } from './api.js';
import { state, emit, getConversation, upsertConversation, userName } from './store.js';
import { createAccountKeys, restoreFromBackup, verifyBundle } from './crypto/keys.js';
import { sealEnvelope, openEnvelope, messageAad, EnvelopeError } from './crypto/envelope.js';
import { canonical, fromB64u } from './crypto/encoding.js';
import { safetyNumber } from './crypto/safety.js';
import { RECORD_SIZE } from './crypto/files.js';
import * as keystore from './crypto/keystore.js';

// ---------------------------------------------------------------------------
// errors the UI and outbox act on

/** Some members have never opened TealTalk since encryption arrived: no key to encrypt to. */
export class MissingKeysError extends Error {
  constructor(userIds) {
    super('Waiting for keys');
    this.userIds = userIds;
  }
}

/** A verified contact's key changed: the person has to confirm before we send to them. */
export class SafetyCheckNeeded extends Error {
  constructor(userIds) {
    super('Safety number changed');
    this.userIds = userIds;
  }
}

/** This device has no usable key right now (setting up, or replaced on another device). */
export class KeysNotReadyError extends Error {
  constructor() {
    super('Encryption isn’t set up on this device yet.');
  }
}

/** Something about the keys or members didn't check out. The message is safe to show. */
export class SealError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// this device's key

/** 'unknown' | 'loading' | 'ready' | 'show-recovery' | 'needs-recovery' | 'error' */
let keyState = 'unknown';
let keyError = '';
/** My key was changed on another device: { at, keyId } (shown on the recovery screen). */
let keyConflict = null;
let account = null;
let remoteKeys = null; // { bundle, backup } from GET /api/keys/me
let myPub = null; // verified public keys for my own bundle
let loadSeq = 0;
/** The recovery key of a key made in this session, until the person confirms they saved it. Never stored. */
let pendingRecoveryKey = null;
/** A key made here whose recovery key was never confirmed (and is gone after a reload). */
let recoveryUnconfirmed = false;

/** userId -> contact pin, see savePin() */
const contacts = new Map();
/** keyId -> { keyId, encPriv } keys this device used before (still open old messages). */
const oldKeys = new Map();
/** conversationId -> { conversationId, owner, isGroup, members, notices } */
const memberLists = new Map();
/** conversationId -> id of the first encrypted message seen there */
const firstEncrypted = new Map();

function setKeyState(next, error = '') {
  keyState = next;
  keyError = error;
  emit('keys-state', next);
}

export function getKeyState() {
  return { state: keyState, error: keyError, resetElsewhere: !!keyConflict, conflict: keyConflict, recoveryUnconfirmed };
}

export function keysReady() {
  return keyState === 'ready' && !!account;
}

/** The recovery key just made on this device (shown once), or ''. */
export function recoveryKeyText() {
  return pendingRecoveryKey || '';
}

export function myKeyId() {
  return account ? account.keyId : null;
}

function meId() {
  return state.me ? state.me.id : null;
}

/** What goes into IndexedDB: never the recovery key. */
function storable(record) {
  const out = { ...record };
  delete out.recoveryKey;
  return out;
}

async function adoptAccount(record) {
  account = record;
  myPub = await verifyBundle(record.bundle, record.userId);
  resetViews();
}

function dropAccount() {
  account = null;
  myPub = null;
  resetViews();
}

/** Load the pins, old keys, member lists and markers that belong to `userId`. */
async function loadLocalState(userId) {
  contacts.clear();
  oldKeys.clear();
  memberLists.clear();
  firstEncrypted.clear();
  const pins = await keystore.listContacts();
  if (pins.some((c) => c.owner && c.owner !== userId)) {
    await keystore.clearContacts(); // another account's pins
  } else {
    for (const c of pins) contacts.set(c.userId, c);
  }
  for (const k of await keystore.localGetAll('oldKeys')) {
    if (k.userId === userId) oldKeys.set(k.keyId, k);
    else await keystore.localDelete('oldKeys', k.id);
  }
  for (const m of await keystore.localGetAll('members')) {
    if (m.owner === userId) memberLists.set(m.conversationId, m);
    else await keystore.localDelete('members', m.conversationId);
  }
  const marker = await keystore.localGet('meta', 'firstEncrypted');
  if (marker && marker.owner === userId && marker.value && typeof marker.value === 'object') {
    for (const [convId, id] of Object.entries(marker.value)) if (Number.isSafeInteger(id)) firstEncrypted.set(convId, id);
  } else if (marker) {
    await keystore.localDelete('meta', 'firstEncrypted');
  }
}

/**
 * Work out this device's key state for `user` after login or launch: ready, set
 * up a new key (only if neither the server nor this device has one), or ask for
 * the recovery key. This device's key is never deleted or replaced here.
 */
export async function loadKeys(user) {
  if (!user) return;
  const seq = ++loadSeq;
  setKeyState('loading');
  if (!keystore.keystoreAvailable()) {
    setKeyState('error', 'This browser can’t store encryption keys. Try another browser, or turn off private browsing.');
    return;
  }
  let local = null;
  try {
    // Keys left behind by another account on this device: forget them.
    const all = await keystore.listAccounts();
    if (all.some((a) => a.userId !== user.id)) {
      await keystore.clearKeystore();
      for (const name of ['oldKeys', 'members', 'meta', 'outbox', 'outboxKey']) await keystore.localClear(name);
    }
    local = await keystore.getAccount(user.id);
    if (local && 'recoveryKey' in local) {
      // Older versions stored the recovery key: remove it.
      local = storable(local);
      await keystore.putAccount(local);
    }
    await loadLocalState(user.id);
  } catch {
    if (seq === loadSeq) setKeyState('error', 'TealTalk couldn’t open its key storage on this device.');
    return;
  }
  if (seq !== loadSeq) return;
  const unconfirmedState = (record) => {
    if (record.recoverySaved !== false) return 'ready';
    if (pendingRecoveryKey) return 'show-recovery';
    recoveryUnconfirmed = true; // the key text is gone (reloaded before confirming)
    return 'ready';
  };

  // The usual launch: this device's key is set up. Use it at once (also offline),
  // and check with the server in the background that it's still the current one.
  if (local && local.published && local.bundle) {
    try {
      await adoptAccount(local);
      setKeyState(unconfirmedState(local));
    } catch {
      dropAccount();
    }
  }

  let remote;
  try {
    remote = await Api.myKeys();
  } catch (err) {
    if (seq !== loadSeq || keyState === 'ready' || keyState === 'show-recovery') return;
    setKeyState('error', err.isNetwork ? 'Can’t reach TealTalk to set up encryption. Check your connection.' : err.message);
    return;
  }
  if (seq !== loadSeq) return;
  remoteKeys = { bundle: (remote && remote.bundle) || null, backup: (remote && remote.backup) || null };

  try {
    const rb = remoteKeys.bundle;
    if (rb && local && local.keyId === rb.keyId) {
      const record = storable({ ...local, bundle: local.bundle || rb, published: true });
      if (!record.backup) record.backup = local.pendingBackup || (remoteKeys.backup && remoteKeys.backup.keyId === local.keyId ? remoteKeys.backup : null);
      delete record.pendingBackup;
      if (!local.published || !local.backup) await keystore.putAccount(record);
      if (!(keyState === 'ready' && account && account.keyId === record.keyId)) await adoptAccount(record);
      else account = record;
      keyConflict = null;
      setKeyState(unconfirmedState(record));
      return;
    }
    if (!rb) {
      // The server has no key for me. If this device has one, put it back (never a new one).
      // Exception: a key made here that never got uploaded and whose recovery key nobody
      // saw (the app reloaded) was never used: make a new one so its recovery key is shown.
      const neverUsed = local && !local.published && local.recoverySaved === false && !pendingRecoveryKey;
      if (local && !neverUsed) await republish(local);
      else await generate(user.id);
      return;
    }
    // The account has a key this device doesn't.
    try {
      await verifyBundle(rb, user.id);
    } catch {
      dropAccount();
      setKeyState('error', 'TealTalk couldn’t verify your account’s key. Try again later.');
      return;
    }
    if (local) {
      await retireAccount(local);
      if (local.published) keyConflict = { at: Math.min(rb.createdAt, Date.now()), keyId: rb.keyId };
    }
    dropAccount();
    setKeyState('needs-recovery');
  } catch (err) {
    if (seq !== loadSeq) return;
    if (keyState === 'ready' && account) return; // keep working with this device's key
    setKeyState('error', err instanceof ApiError && !err.isNetwork ? err.message : 'Couldn’t set up encryption. Check your connection and try again.');
  }
}

/**
 * Keep this device's key, but stop using it for new messages: it moves to the
 * "oldKeys" store (still opens messages sent to it) and leaves the account store.
 */
async function retireAccount(record) {
  const old = { id: `${record.userId}|${record.keyId}`, userId: record.userId, keyId: record.keyId, encPriv: record.encPriv, bundle: record.bundle, retiredAt: Date.now() };
  await keystore.localPut('oldKeys', old);
  oldKeys.set(old.keyId, old);
  await keystore.deleteAccount(record.userId);
  if (account && account.keyId === record.keyId) dropAccount();
}

/** The server lost my key (bundle: null) but this device has it: upload the same bundle and backup again. */
async function republish(record) {
  const backup = record.backup || record.pendingBackup;
  if (!backup || !record.bundle) {
    throw new SealError('TealTalk’s server doesn’t have your key, and this device can’t upload it again. Try again later.');
  }
  await publish(record, backup);
}

async function publish(record, backup) {
  const { bundle } = await Api.putKeys(record.bundle, backup);
  const next = storable({ ...record, bundle: bundle && bundle.keyId === record.keyId ? bundle : record.bundle, backup, published: true });
  delete next.pendingBackup;
  await keystore.putAccount(next);
  remoteKeys = { bundle: next.bundle, backup };
  await adoptAccount(next);
  keystore.requestPersistence();
  keyConflict = null;
  if (next.recoverySaved === false && !pendingRecoveryKey) recoveryUnconfirmed = true;
  setKeyState(next.recoverySaved !== false || !pendingRecoveryKey ? 'ready' : 'show-recovery');
}

/** Make, store and publish a new key (first setup, Start fresh, Reset key). */
async function generate(userId) {
  const { bundle, backup, account: acct } = await createAccountKeys(userId);
  pendingRecoveryKey = acct.recoveryKey;
  recoveryUnconfirmed = false;
  // Stored first (without the recovery key), so a failed upload can be retried with the same key.
  const record = storable({ ...acct, bundle, backup, published: false, recoverySaved: false });
  await keystore.putAccount(record);
  await publish(record, backup);
}

/** Start fresh / Reset key: a new key. The old one stays on this device for old messages. */
export async function resetKeys() {
  const user = state.me;
  if (!user) throw new KeysNotReadyError();
  loadSeq++;
  const before = keyState;
  setKeyState('loading');
  try {
    const current = account || (await keystore.getAccount(user.id));
    if (current) await retireAccount(current);
    await generate(user.id);
    keyConflict = null;
  } catch (err) {
    setKeyState(account ? 'ready' : before === 'error' ? 'error' : 'needs-recovery');
    throw err;
  }
}

/**
 * Unlock this device with the recovery key. Throws RecoveryKeyFormatError (typo)
 * or RecoveryError (wrong key) from crypto/keys.js.
 */
export async function recover(text) {
  const user = state.me;
  if (!user) throw new KeysNotReadyError();
  if (!remoteKeys || !remoteKeys.bundle || !remoteKeys.backup) {
    remoteKeys = await Api.myKeys();
  }
  const restored = await restoreFromBackup(user.id, text, remoteKeys.backup, remoteKeys.bundle);
  const record = storable({ ...restored, backup: remoteKeys.backup, published: true, recoverySaved: true });
  const current = await keystore.getAccount(user.id);
  if (current && current.keyId !== record.keyId) await retireAccount(current);
  await keystore.putAccount(record);
  await adoptAccount(record);
  keyConflict = null;
  recoveryUnconfirmed = false;
  keystore.requestPersistence();
  setKeyState('ready');
}

function normalizeGroup(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * The person re-typed the last group of the recovery key to show they saved it.
 * Returns false (and changes nothing) if it doesn't match.
 */
export async function confirmRecoverySaved(lastGroup) {
  if (!account || !pendingRecoveryKey) return false;
  const groups = pendingRecoveryKey.split('-');
  if (normalizeGroup(lastGroup) !== normalizeGroup(groups[groups.length - 1])) return false;
  pendingRecoveryKey = null;
  recoveryUnconfirmed = false;
  account = { ...account, recoverySaved: true };
  try {
    await keystore.putAccount(storable(account));
  } catch {
    /* asked again next launch at worst */
  }
  if (keyState === 'show-recovery') setKeyState('ready');
  return true;
}

/**
 * Logout: delete this device's private keys (current and old). Pins, member lists
 * and markers stay for the next login of the same account (P3); another account
 * signing in clears them.
 */
export async function deleteLocalKeys() {
  const userId = meId() || (account && account.userId);
  try {
    if (userId) await keystore.deleteAccount(userId);
    else await keystore.clearKeystore();
    for (const k of await keystore.localGetAll('oldKeys')) await keystore.localDelete('oldKeys', k.id);
  } catch {
    /* nothing stored */
  }
  forgetKeys();
}

/** Drop everything held in memory (session ended). */
export function forgetKeys() {
  loadSeq++;
  account = null;
  myPub = null;
  remoteKeys = null;
  keyConflict = null;
  pendingRecoveryKey = null;
  recoveryUnconfirmed = false;
  contacts.clear();
  oldKeys.clear();
  memberLists.clear();
  firstEncrypted.clear();
  current.clear();
  verifiedCache.clear();
  editSeen.clear();
  originals.clear();
  resetViews();
  keyState = 'unknown';
  keyError = '';
}

/**
 * The server says my key may have changed (a keys_changed about me, or a `keys`
 * event). Ask it, and:
 *  - same key: nothing to do
 *  - no key at all: put this device's key back
 *  - another key: this device's key moves to oldKeys and the person decides
 *    (recovery key for the new key, or start fresh). Nothing is deleted.
 */
async function checkMyKey() {
  if (!account) throw new KeysNotReadyError();
  const mine = account;
  const remote = await Api.myKeys();
  remoteKeys = { bundle: (remote && remote.bundle) || null, backup: (remote && remote.backup) || null };
  const rb = remoteKeys.bundle;
  if (rb && rb.keyId === mine.keyId) return;
  if (!rb) {
    await republish(mine);
    return;
  }
  try {
    await verifyBundle(rb, mine.userId);
  } catch {
    throw new SealError('TealTalk couldn’t verify your account’s key. Try again later.');
  }
  loadSeq++;
  await retireAccount(mine);
  keyConflict = { at: Math.min(rb.createdAt, Date.now()), keyId: rb.keyId };
  setKeyState('needs-recovery');
  throw new KeysNotReadyError();
}

// ---------------------------------------------------------------------------
// key directory

/** `${userId}|${keyId}` -> Promise<verified bundle> */
const verifiedCache = new Map();
/** userId -> { v: verified | null, at } (current keys) */
const current = new Map();
const CURRENT_TTL_MS = 5 * 60 * 1000;

class FutureBundle extends Error {}

/** A bundle dated more than a day ahead is never accepted (it would outrank any real key). */
function checkDate(v) {
  if (!(v.bundle.createdAt <= Date.now() + DAY_MS)) throw new FutureBundle();
  return v;
}

function verified(userId, bundle) {
  const key = `${userId}|${bundle && bundle.keyId}`;
  let p = verifiedCache.get(key);
  if (!p) {
    p = verifyBundle(bundle, userId);
    verifiedCache.set(key, p);
    p.catch(() => verifiedCache.delete(key));
  }
  return p.then(checkDate);
}

class BundleMissing extends Error {}

/** A sender's bundle for an older (or current) key, verified for that sender. */
function bundleFor(userId, keyId) {
  if (account && userId === account.userId) {
    // My own messages: only keys this device has had. Anything else is the server's word.
    if (keyId === account.keyId) return verified(userId, account.bundle);
    const old = oldKeys.get(keyId);
    if (old && old.bundle) return verified(userId, old.bundle);
    return Promise.reject(new BundleMissing());
  }
  const cur = current.get(userId);
  if (cur && cur.v && cur.v.keyId === keyId) return Promise.resolve(cur.v);
  const pin = contacts.get(userId);
  if (pin && pin.bundle && pin.bundle.keyId === keyId) return verified(userId, pin.bundle);
  const key = `${userId}|${keyId}`;
  let p = verifiedCache.get(key);
  if (!p) {
    p = Api.userKey(userId, keyId).then(
      ({ bundle }) => {
        if (!bundle || bundle.keyId !== keyId) throw new BundleMissing();
        return verifyBundle(bundle, userId);
      },
      (err) => {
        if (err.status === 404 || err.status === 400) throw new BundleMissing();
        throw err;
      },
    );
    verifiedCache.set(key, p);
    p.catch(() => verifiedCache.delete(key));
  }
  return p.then(checkDate);
}

/**
 * The keys to seal to: Map userId -> verified pinned bundle | null (no keys yet).
 * The server's current key for each person goes through the pin first, so a key
 * we haven't pinned is a safety-number change before anything is sealed to it.
 */
async function currentBundles(userIds, { fresh = false } = {}) {
  const now = Date.now();
  const need = userIds.filter((id) => {
    const c = current.get(id);
    return fresh || !c || now - c.at > CURRENT_TTL_MS || !c.v;
  });
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { keys } = await Api.keysFor(chunk);
    for (const id of chunk) {
      const bundle = keys && Object.prototype.hasOwnProperty.call(keys, id) ? keys[id] : null;
      if (!bundle) {
        current.set(id, { v: null, at: now });
        continue;
      }
      let v;
      try {
        v = await verified(id, bundle);
      } catch {
        throw new SealError(`Couldn’t verify ${userName(null, id)}’s key. Try again later.`);
      }
      current.set(id, { v, at: now });
      trustOffered(id, v);
    }
  }
  const out = new Map();
  for (const id of userIds) {
    const v = (current.get(id) || {}).v || null;
    if (v && (!contacts.get(id) || contacts.get(id).keyId !== v.keyId)) trustOffered(id, v); // cached earlier
    const pin = contacts.get(id);
    out.set(id, v && pin && pin.keyId === v.keyId ? v : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// trust on first use
//
// pin = { userId, owner, keyId, bundle, createdAt, seenKeyIds, verified, firstSeenAt,
//         pinnedAt, unackedKeyIds, needsAck, changes: [{ at, keyId }] }
//  - keyId/bundle: the key we seal to
//  - seenKeyIds: other keys of theirs we've accepted (older keys still verify their old messages)
//  - unackedKeyIds: new keys that appeared while they were verified, not yet confirmed
//    ("Send anyway" or verifying again clears it); needsAck = unackedKeyIds.length > 0

function savePin(pin) {
  const next = { ...pin, owner: meId() || pin.owner, needsAck: !!(pin.unackedKeyIds && pin.unackedKeyIds.length) };
  contacts.set(next.userId, next);
  keystore.putContact(next).catch(() => {});
  views = new WeakMap(); // flags on messages depend on the pin
  emit('safety', next.userId);
  return next;
}

function newPin(userId, v) {
  const now = Date.now();
  return { userId, keyId: v.keyId, bundle: v.bundle, createdAt: v.bundle.createdAt, seenKeyIds: [v.keyId], verified: false, firstSeenAt: now, pinnedAt: now, unackedKeyIds: [], changes: [] };
}

const uniq = (list) => [...new Set(list)];

/**
 * A key of theirs we haven't seen: a safety-number change. One notice per new key
 * in every chat with them, and if they were verified, they aren't any more and the
 * next send asks first. `moveTo` moves the pin (the key we seal to).
 */
function recordChange(pin, keyId, hintAt, moveTo) {
  const now = Date.now();
  const lower = pin.pinnedAt || pin.firstSeenAt || 0;
  const at = Math.max(lower, Math.min(now, Number.isFinite(hintAt) ? hintAt : now));
  const known = (pin.changes || []).some((c) => c.keyId === keyId);
  const next = { ...pin, seenKeyIds: uniq([...(pin.seenKeyIds || []), pin.keyId, keyId]).slice(-50) };
  if (!known) next.changes = [...(pin.changes || []), { at, keyId }].slice(-20);
  if (pin.verified) {
    next.verified = false;
    next.unackedKeyIds = uniq([...(pin.unackedKeyIds || []), keyId]);
  } else if ((pin.unackedKeyIds || []).length) {
    next.unackedKeyIds = uniq([...pin.unackedKeyIds, keyId]);
  }
  if (moveTo) {
    next.keyId = moveTo.keyId;
    next.bundle = moveTo.bundle;
    next.createdAt = moveTo.bundle.createdAt;
    next.pinnedAt = now;
  }
  const saved = savePin(next);
  if (!known) emit('key-changed', pin.userId);
  return saved;
}

/** The server offers `v` as their current key (to seal to, or in a `keys` event). */
function trustOffered(userId, v) {
  if (!v || userId === meId()) return;
  const pin = contacts.get(userId);
  if (!pin) {
    savePin(newPin(userId, v));
    return;
  }
  if (pin.keyId === v.keyId) {
    if (!pin.bundle) savePin({ ...pin, bundle: v.bundle, createdAt: v.bundle.createdAt });
    return;
  }
  recordChange(pin, v.keyId, Date.now(), v); // any other key, whatever its date
}

/** A message from userId signed with `v` (sent at about `sentAt`). */
function trustReceived(userId, v, sentAt) {
  if (!v || userId === meId()) return;
  const pin = contacts.get(userId);
  if (!pin) {
    savePin(newPin(userId, v));
    return;
  }
  if (pin.keyId === v.keyId || (pin.seenKeyIds || []).includes(v.keyId)) return;
  // Neither pinned nor seen: a change first (the pin stays: we still seal to the key we know).
  recordChange(pin, v.keyId, Number.isFinite(sentAt) ? sentAt - 1 : Date.now(), null);
}

/** 'unverified-key' when this sender key appeared after the person was verified and isn't confirmed yet. */
function keyFlag(userId, keyId) {
  const pin = contacts.get(userId);
  return pin && (pin.unackedKeyIds || []).includes(keyId) ? 'unverified-key' : null;
}

/** `keys` WebSocket event: someone (maybe me, on another device) published a new key. */
export async function handleKeysEvent(userId, bundle) {
  if (typeof userId !== 'string' || !bundle) return;
  if (userId === meId()) {
    if (account && bundle.keyId !== account.keyId) {
      // Only act on a genuine bundle, and then ask the server rather than trust the event.
      try {
        await verifyBundle(bundle, userId);
      } catch {
        return;
      }
      try {
        await checkMyKey();
      } catch {
        /* the state change (if any) is shown by the recovery screen */
      }
    }
    return;
  }
  let v;
  try {
    v = await verified(userId, bundle);
  } catch {
    return; // not a valid bundle for that user (or dated in the future): ignore it
  }
  current.set(userId, { v, at: Date.now() });
  trustOffered(userId, v);
  emit('keys-available', userId);
}

/** Pin info for the UI: { verified, needsAck, keyId, changes } or null. */
export function contactInfo(userId) {
  const pin = contacts.get(userId);
  return pin
    ? { verified: !!pin.verified, needsAck: !!pin.needsAck, keyId: pin.keyId, changes: pin.changes || [] }
    : null;
}

/** Safety-number changes of these users, for the notices in a chat: [{ userId, at }]. */
export function safetyChanges(userIds) {
  const out = [];
  for (const id of userIds) {
    const pin = contacts.get(id);
    for (const c of (pin && pin.changes) || []) out.push({ userId: id, at: c.at, keyId: c.keyId });
  }
  return out;
}

/** The 60 digits with userId's current key (fetched fresh), and that keyId. */
export async function safetyNumberWith(userId) {
  if (!keysReady()) throw new KeysNotReadyError();
  const bundles = await currentBundles([userId], { fresh: true });
  const theirs = bundles.get(userId);
  if (!theirs) throw new MissingKeysError([userId]);
  const digits = await safetyNumber({ userId: account.userId, bundle: account.bundle }, { userId, bundle: theirs.bundle });
  return { digits, keyId: theirs.keyId };
}

export function markVerified(userId, keyId) {
  const pin = contacts.get(userId);
  if (!pin || pin.keyId !== keyId) return false;
  savePin({ ...pin, verified: true, unackedKeyIds: [] });
  return true;
}

export function unmarkVerified(userId) {
  const pin = contacts.get(userId);
  if (pin) savePin({ ...pin, verified: false });
}

/** "Send anyway" after a verified contact's key changed. */
export function acknowledgeChange(userIds) {
  for (const id of userIds) {
    const pin = contacts.get(id);
    if (pin && pin.needsAck) savePin({ ...pin, unackedKeyIds: [] });
  }
}

// ---------------------------------------------------------------------------
// who may receive what (never just the server's word)

/** "<name> was added to this chat" notices, made on this device: [{ userId, at }]. */
export function memberNotices(conversationId) {
  const rec = memberLists.get(conversationId);
  return rec ? rec.notices || [] : [];
}

function saveMembers(rec) {
  const next = { ...rec, owner: meId() || rec.owner };
  memberLists.set(next.conversationId, next);
  keystore.localPut('members', next).catch(() => {});
  return next;
}

/**
 * Check the people we're about to seal for against what this device knows about
 * the chat. A 1:1 chat is only ever sealed to its two people. In a group, anyone
 * new gets a local notice first (the server decides group membership: a known limit).
 */
async function checkAudience(conversationId, ids) {
  const me = account.userId;
  let conv = getConversation(conversationId);
  if (!conv || !Array.isArray(conv.members)) {
    ({ conversation: conv } = await Api.conversation(conversationId));
    upsertConversation(conv);
  }
  const serverIds = uniq((conv.members || []).map((m) => m.id));
  let rec = memberLists.get(conversationId);
  if (!rec) {
    const first = uniq([...serverIds, ...ids]);
    if (!conv.isGroup && (first.length !== 2 || !first.includes(me))) {
      throw new SealError('This chat should have exactly two people, but the server listed someone else. TealTalk didn’t send your message.');
    }
    rec = saveMembers({ conversationId, isGroup: !!conv.isGroup, members: first, notices: [] });
    return;
  }
  const known = new Set(rec.members);
  const added = ids.filter((id) => !known.has(id));
  if (!rec.isGroup) {
    if (added.length) {
      throw new SealError('This is a one-to-one chat, but the server listed someone else in it. TealTalk didn’t send your message.');
    }
    return;
  }
  // People the server no longer lists left the group: forget them, so coming back shows a notice again.
  const stillThere = rec.members.filter((id) => id === me || serverIds.includes(id) || ids.includes(id));
  if (!added.length && stillThere.length === rec.members.length) return;
  const now = Date.now();
  saveMembers({
    ...rec,
    members: uniq([...stillThere, ...added]),
    notices: [...(rec.notices || []), ...added.map((userId) => ({ userId, at: now }))].slice(-100),
  });
  if (added.length) emit('members-changed', conversationId);
}

// ---------------------------------------------------------------------------
// sealing

async function myRecipient() {
  return { userId: account.userId, keyId: account.keyId, encPub: myPub.encPub };
}

async function sealFor({ conversationId, clientId, kind, payload, recipientIds, fresh }) {
  if (!keysReady()) throw new KeysNotReadyError();
  if ([conversationId, clientId].some((x) => typeof x !== 'string' || x.includes('|'))) throw new SealError('Couldn’t send this message.');
  const me = account.userId;
  await checkAudience(conversationId, recipientIds);
  const others = recipientIds.filter((id) => id !== me);
  const bundles = await currentBundles(others, { fresh });
  const missing = others.filter((id) => !bundles.get(id));
  if (missing.length) throw new MissingKeysError(missing);
  const needAck = others.filter((id) => contacts.get(id) && contacts.get(id).needsAck);
  if (needAck.length) throw new SafetyCheckNeeded(needAck);
  const recipients = [await myRecipient()];
  for (const id of others) {
    const v = bundles.get(id);
    const pin = contacts.get(id);
    // Only ever the pinned key.
    if (!v || !pin || pin.keyId !== v.keyId) throw new SealError('Couldn’t check everyone’s keys. Try again.');
    recipients.push({ userId: id, keyId: pin.keyId, encPub: v.encPub });
  }
  const envelope = await sealEnvelope({
    conversationId,
    senderId: me,
    senderKeyId: account.keyId,
    sigPriv: account.sigPriv,
    clientId,
    kind,
    payload,
    recipients,
  });
  // We know what we sealed: our own copy never needs decrypting.
  remember(envelope, { conversationId, senderId: me, clientId }, { payload, senderKeyId: account.keyId });
  return envelope;
}

/** members_changed: only accept people the conversation really lists (fetched fresh). */
async function checkedMembers(conversationId, members) {
  const { conversation } = await Api.conversation(conversationId);
  upsertConversation(conversation);
  const ids = new Set((conversation.members || []).map((m) => m.id));
  const list = [...new Set(members)];
  if (!list.length || !list.every((id) => typeof id === 'string' && ids.has(id)) || !list.includes(account.userId)) {
    throw new SealError('The people in this chat don’t match. Reload TealTalk and try again.');
  }
  return list;
}

/**
 * Seal `payload` for `recipientIds` (plus me) and hand the envelope to `post`.
 * Follows the server's 409s: refetch members or keys and seal again.
 * Throws MissingKeysError, SafetyCheckNeeded, KeysNotReadyError, SealError or ApiError.
 */
export async function sendSealed({ conversationId, kind, payload, clientId, recipientIds, post }) {
  if (!keysReady()) throw new KeysNotReadyError();
  let ids = [...new Set([...recipientIds, account.userId])];
  let fresh = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const envelope = await sealFor({ conversationId, clientId, kind, payload, recipientIds: ids, fresh });
    try {
      return await post(envelope);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409 || !err.data) throw err;
      const code = err.data.error;
      if (code === 'members_changed' && Array.isArray(err.data.members)) {
        ids = await checkedMembers(conversationId, err.data.members);
      } else if (code === 'keys_changed') {
        const keys = err.data.keys && typeof err.data.keys === 'object' ? err.data.keys : null;
        if (!keys || !Object.keys(keys).length) await checkMyKey();
        fresh = true;
      } else if (code === 'missing_keys' && Array.isArray(err.data.missing)) {
        throw new MissingKeysError(err.data.missing.filter((id) => typeof id === 'string'));
      } else {
        throw err;
      }
    }
  }
  throw new SealError('Couldn’t send this message. Try again.');
}

/** Who can see a message, as a first guess: its envelope's recipients still in the chat. */
export function audienceGuess(conv, msg) {
  const members = (conv && conv.members ? conv.members : []).map((m) => m.id);
  if (msg && msg.e2ee && msg.e2ee.keys) {
    const had = new Set(Object.keys(msg.e2ee.keys));
    const both = members.filter((id) => had.has(id));
    if (both.length) return both;
  }
  return members;
}

export function waitingText(conv, userIds) {
  const names = userIds.map((id) => userName(conv, id));
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Waiting for ${list || 'someone'} to open TealTalk`;
}

/** The original message an edit or reaction is about: its sender and clientId. */
function targetOf(msg) {
  return { senderId: msg.senderId, clientId: msg.clientId };
}

/** The payload for editing `msg` to `body`: bound to the original message, numbered. */
export function editPayload(msg, body) {
  const kind = `edit:${msg.id}`;
  const seen = editSeen.get(editKey(msg));
  return { kind, body, target: targetOf(msg), seq: (seen ? seen.seq : 0) + 1 };
}

/** The payload for reacting to `msg` with `emoji`, bound to the original message. */
export function reactionPayload(msg, emoji) {
  const kind = `reaction:${msg.id}`;
  return { kind, emoji, target: targetOf(msg) };
}

// ---------------------------------------------------------------------------
// opening envelopes

/** env.sig -> { full, payload, senderKeyId } | { full, error } */
const opened = new Map();
/** env.sig -> Promise (decryption in flight) */
const inflight = new Map();
/** env.sig -> time before which a failed network fetch isn't retried */
const retryAt = new Map();
/** message object -> its final view */
let views = new WeakMap();
const MAX_OPENED = 5000;

function fullKey(envelope, ctx) {
  return `${messageAad(ctx.conversationId, ctx.senderId, ctx.clientId, envelope.kind)}\n${canonical(envelope)}`;
}

function remember(envelope, ctx, result) {
  if (opened.size >= MAX_OPENED) opened.delete(opened.keys().next().value);
  opened.set(envelope.sig, { full: fullKey(envelope, ctx), ...result });
}

/** A previous result for exactly this envelope in exactly this context, or null. */
function lookup(envelope, ctx) {
  const hit = opened.get(envelope.sig);
  return hit && hit.full === fullKey(envelope, ctx) ? hit : null;
}

function resetViews() {
  opened.clear();
  inflight.clear();
  retryAt.clear();
  views = new WeakMap();
}

let changedConvs = new Set();
let notifyTimer = null;
function notify(convId) {
  changedConvs.add(convId);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const ids = changedConvs;
    changedConvs = new Set();
    for (const id of ids) emit('messages', id);
    emit('conversations');
  }, 16);
}

/** The private key this envelope was sealed to on this device: the current one or an old one. */
function myKeyFor(envelope) {
  const entry = envelope && envelope.keys && Object.prototype.hasOwnProperty.call(envelope.keys, account.userId) ? envelope.keys[account.userId] : null;
  if (entry && entry.k !== account.keyId && oldKeys.has(entry.k)) {
    return { userId: account.userId, keyId: entry.k, encPriv: oldKeys.get(entry.k).encPriv };
  }
  return { userId: account.userId, keyId: account.keyId, encPriv: account.encPriv };
}

async function openOne(envelope, ctx, kinds) {
  const sender = await bundleFor(ctx.senderId, envelope.senderKeyId).catch((err) => {
    if (err instanceof BundleMissing || err instanceof FutureBundle || (err instanceof Error && err.code === 'bad_bundle')) return null;
    throw err; // network: try again later
  });
  if (!sender) return { error: 'unverified' };
  const expectedKind = kinds.includes(envelope.kind) ? envelope.kind : kinds[0];
  try {
    const payload = await openEnvelope(
      envelope,
      { conversationId: ctx.conversationId, senderId: ctx.senderId, clientId: ctx.clientId, expectedKind },
      sender,
      myKeyFor(envelope),
    );
    if (ctx.senderId !== account.userId) trustReceived(ctx.senderId, sender, ctx.sentAt);
    return { payload, senderKeyId: envelope.senderKeyId };
  } catch (err) {
    return { error: err instanceof EnvelopeError ? err.code : 'undecryptable' };
  }
}

/** Sync: the result for an envelope if known; otherwise starts opening it and returns null. */
function resolve(envelope, ctx, kinds) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.sig !== 'string' || typeof ctx.clientId !== 'string') {
    return { error: 'unverified' };
  }
  // The AAD joins these with '|': a value containing one could pose as another context.
  if ([ctx.conversationId, ctx.senderId, ctx.clientId].some((x) => typeof x !== 'string' || x.includes('|'))) {
    return { error: 'undecryptable' };
  }
  const hit = lookup(envelope, ctx);
  if (hit) return hit;
  if (!keysReady()) return null;
  if (inflight.has(envelope.sig) || (retryAt.get(envelope.sig) || 0) > Date.now()) return null;
  const p = openOne(envelope, ctx, kinds).then(
    (result) => {
      remember(envelope, ctx, result);
    },
    () => {
      retryAt.set(envelope.sig, Date.now() + 15000);
    },
  );
  inflight.set(envelope.sig, p);
  p.finally(() => {
    inflight.delete(envelope.sig);
    notify(ctx.conversationId);
  });
  return null;
}

/** Retry envelopes whose sender key couldn't be fetched (e.g. back online). */
export function retryPending() {
  if (!retryAt.size) return;
  retryAt.clear();
  views = new WeakMap();
  emit('views-reset');
  emit('conversations');
}

// ---- payload checks ----

const MIME_KIND = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/mpeg': 'audio',
  'audio/webm': 'audio',
  'audio/ogg': 'audio',
};

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 100000 ? v : null);

function b64uBytes(v, n) {
  try {
    return typeof v === 'string' && fromB64u(v).length === n;
  } catch {
    return false;
  }
}

function fileInfo(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id, 64) || !allowedIds.has(raw.id)) return null;
  const mime = isStr(raw.mime, 100) ? raw.mime.split(';')[0].trim().toLowerCase() : '';
  const family = MIME_KIND[mime];
  if (!family) return null;
  if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > 2 ** 32) return null;
  if (!b64uBytes(raw.key, 32) || !b64uBytes(raw.noncePrefix, 8)) return null;
  const recordSize = raw.recordSize === undefined ? RECORD_SIZE : raw.recordSize;
  if (!Number.isInteger(recordSize) || recordSize < 1024 || recordSize > 16 * 1024 * 1024) return null;
  return {
    id: raw.id,
    mime,
    family,
    size: raw.size,
    width: dim(raw.width),
    height: dim(raw.height),
    key: raw.key,
    noncePrefix: raw.noncePrefix,
    recordSize,
  };
}

function cleanAttachments(list, msg) {
  if (!Array.isArray(list)) return [];
  const server = new Map((msg.attachments || []).map((a) => [a.id, a]));
  const ids = new Set(server.keys());
  const out = [];
  for (const raw of list.slice(0, 20)) {
    const f = fileInfo(raw, ids);
    if (!f) continue;
    const kind = ['image', 'video', 'audio'].includes(raw.kind) ? raw.kind : f.family;
    if (kind !== f.family) continue;
    const thumb = raw.thumb ? fileInfo(raw.thumb, ids) : null;
    const durationMs = Number.isInteger(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : null;
    out.push({
      ...f,
      kind,
      durationMs,
      expired: !!(server.get(f.id) || {}).expired,
      thumb: thumb && thumb.family === 'image' && !(server.get(thumb.id) || {}).expired ? thumb : null,
    });
  }
  return out;
}

function cleanReplyTo(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.id)) return null;
  return {
    id: raw.id,
    senderId: isStr(raw.senderId, 64) ? raw.senderId : null,
    snippet: typeof raw.snippet === 'string' ? raw.snippet.slice(0, 200) : '',
  };
}

function cleanEmoji(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 16 ? raw : null;
}

/** Does an edit/reaction payload name exactly this message as its target? */
function targetMatches(p, msg) {
  const t = p && p.target;
  return !!t && typeof t === 'object' && t.senderId === msg.senderId && t.clientId === msg.clientId && typeof t.clientId === 'string';
}

// ---- views ----

const EMPTY_VIEW = Object.freeze({ status: 'plain', body: '', attachments: [], replyTo: null, reactions: {}, warning: null, final: true });

function addReaction(out, emoji, userId) {
  if (!emoji) return;
  for (const users of Object.values(out)) {
    const i = users.indexOf(userId);
    if (i >= 0) users.splice(i, 1);
  }
  (out[emoji] = out[emoji] || []).push(userId);
}

/**
 * Reactions. Encrypted messages: only decrypted envelopes { userId: Envelope } whose
 * payload targets this very message. Legacy messages: the old plaintext shapes.
 */
function reactionsOf(msg) {
  const out = {};
  let final = true;
  if (!msg.e2ee) {
    const legacy = msg.legacyReactions || {};
    for (const [emoji, users] of Object.entries(legacy)) for (const u of Array.isArray(users) ? users : []) addReaction(out, emoji, u);
  }
  const clientIds = msg.reactionClientIds || {};
  for (const [key, value] of Object.entries(msg.reactions || {})) {
    if (Array.isArray(value)) {
      if (!msg.e2ee) for (const u of value) addReaction(out, key, u); // pre-v3 shape, legacy messages only
      continue;
    }
    const r = resolve(value, { conversationId: msg.conversationId, senderId: key, clientId: clientIds[key] }, [`reaction:${msg.id}`]);
    if (!r) {
      final = false;
      continue;
    }
    if (r.payload && targetMatches(r.payload, msg)) addReaction(out, cleanEmoji(r.payload.emoji), key);
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return { reactions: out, final };
}

/** `${conversationId}|${id}` -> { senderId, clientId, attachments, replyTo } of originals we decrypted. */
const originals = new Map();
/** `${conversationId}|${senderId}|${clientId}` -> { seq, body } newest edit seen per message. */
const editSeen = new Map();

function editKey(msg) {
  return `${msg.conversationId}|${msg.senderId}|${msg.clientId}`;
}

let markerTimer = null;
function noteEncrypted(convId, id) {
  if (typeof convId !== 'string' || !Number.isSafeInteger(id)) return;
  const known = firstEncrypted.get(convId);
  if (known !== undefined && known <= id) return;
  firstEncrypted.set(convId, id);
  if (markerTimer || !meId()) return;
  markerTimer = setTimeout(() => {
    markerTimer = null;
    keystore.localPut('meta', { key: 'firstEncrypted', owner: meId(), value: Object.fromEntries(firstEncrypted) }).catch(() => {});
  }, 500);
}

/**
 * What to show for a message: { status, body, attachments, replyTo, reactions, warning }.
 * status: 'plain' (system/unsent) | 'legacy' (sent before encryption) | 'pending'
 *         | 'ok' | 'unverified' | 'undecryptable'
 * warning: null | 'unencrypted' (no encryption where there should be) | 'unverified-key'
 *          (sent with a key that appeared after the person was verified)
 */
export function messageView(msg) {
  if (!msg) return EMPTY_VIEW;
  const memo = views.get(msg);
  if (memo) return memo;
  let view;
  if (msg.system || msg.deletedAt) {
    view = EMPTY_VIEW;
  } else if (!msg.e2ee) {
    const { reactions } = reactionsOf(msg);
    // After the first encrypted message in a chat, nothing unencrypted is real.
    const first = firstEncrypted.get(msg.conversationId);
    const warning = first !== undefined && Number.isSafeInteger(msg.id) && msg.id > first ? 'unencrypted' : null;
    // Never memoized: the marker may arrive later.
    view = { status: 'legacy', body: msg.body || '', attachments: [], legacyAttachment: msg.attachment || null, replyTo: null, reactions, warning, final: false };
  } else {
    noteEncrypted(msg.conversationId, msg.id);
    const isEdit = msg.e2ee && msg.e2ee.kind !== 'message';
    // An original message opens with its own clientId; an edit with the edit's.
    const ctx = {
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      clientId: isEdit ? msg.e2eeClientId || msg.clientId : msg.clientId,
      sentAt: msg.createdAt,
    };
    const main = resolve(msg.e2ee, ctx, ['message', `edit:${msg.id}`]);
    const { reactions, final } = reactionsOf(msg);
    if (!main) {
      view = { status: 'pending', body: '', attachments: [], replyTo: null, reactions, warning: null, final: false };
    } else if (main.error) {
      view = { status: main.error, body: '', attachments: [], replyTo: null, reactions, warning: null, final };
    } else {
      const p = main.payload;
      const okey = `${msg.conversationId}|${msg.id}`;
      let body = typeof p.body === 'string' ? p.body.slice(0, 4000) : '';
      let attachments;
      let replyTo;
      let status = 'ok';
      let seq = 0;
      if (p.kind === 'message') {
        attachments = cleanAttachments(p.attachments, msg);
        replyTo = cleanReplyTo(p.replyTo);
        originals.set(okey, { senderId: msg.senderId, clientId: msg.clientId, attachments, replyTo });
        if (originals.size > 2000) originals.delete(originals.keys().next().value);
      } else {
        const orig = originals.get(okey);
        const sameOrig = !orig || (orig.senderId === msg.senderId && orig.clientId === msg.clientId);
        if (!targetMatches(p, msg) || !sameOrig || !Number.isSafeInteger(p.seq) || p.seq < 1) {
          status = 'unverified';
          body = '';
        } else {
          seq = p.seq;
          const key = editKey(msg);
          const seen = editSeen.get(key);
          if (!seen || p.seq > seen.seq) {
            editSeen.set(key, { seq: p.seq, body });
            if (editSeen.size > 5000) editSeen.delete(editSeen.keys().next().value);
          } else if (p.seq < seen.seq) {
            body = seen.body; // an older edit served again: keep the newest we've seen
            seq = seen.seq;
          }
        }
        attachments = orig ? orig.attachments : [];
        replyTo = orig ? orig.replyTo : null;
      }
      if (status === 'ok') {
        const warning = msg.senderId !== meId() ? keyFlag(msg.senderId, main.senderKeyId) : null;
        view = { status, body, attachments, replyTo, reactions, warning, seq, final };
      } else {
        view = { status, body: '', attachments: [], replyTo: null, reactions, warning: null, final };
      }
    }
  }
  if (view.final) views.set(msg, view);
  return view;
}

/** Resolves once a message's text is available (or a short wait passes). */
export async function viewReady(msg, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = messageView(msg);
    if (v.status !== 'pending' || Date.now() > end) return v;
    const waits = [...inflight.values()];
    if (!waits.length) await new Promise((r) => setTimeout(r, 50));
    else await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 200))]);
  }
}
