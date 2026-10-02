'use strict';

// Trust rules of the real client code (public/js/e2ee.js and outbox.js), run in Node
// with an in-memory server, store and key store (tests/trust-stubs). Each test is an
// exploit from the security review that used to work, and must not any more:
//   C1 pins bypassed by older- (or future-) dated keys      C3 the server choosing recipients
//   C4 the server making a device drop or replace its key   C5 edits/reactions moved or rolled back
//   C6 server-written plaintext                              P1/P3/P4/P8 smaller ones

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');
const STUBS = path.join(__dirname, 'trust-stubs');
const load = (rel) => import(pathToFileURL(path.join(PUBLIC_JS, rel)).href);

let E; // e2ee.js
let K; // crypto/keys.js
let V; // crypto/envelope.js
let O; // outbox.js
let ApiError;

test.before(async () => {
  register(pathToFileURL(path.join(STUBS, 'loader.mjs')).href, pathToFileURL(__filename));
  [E, K, V, O] = await Promise.all([load('e2ee.js'), load('crypto/keys.js'), load('crypto/envelope.js'), load('outbox.js')]);
  ({ ApiError } = await import(pathToFileURL(path.join(STUBS, 'api.js')).href));
});

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// a small world: alice (this device), maya (a verified contact), the server

const keyCache = new Map();
async function keysFor(userId, opts) {
  const tag = `${userId}|${JSON.stringify(opts || {})}`;
  if (!keyCache.has(tag)) keyCache.set(tag, await K.createAccountKeys(userId, opts));
  return keyCache.get(tag);
}

function resetStubs() {
  E.forgetKeys();
  const ks = globalThis.__ks;
  ks.account.clear();
  ks.contacts.clear();
  for (const m of Object.values(ks.local)) m.clear();
  globalThis.__events.length = 0;
  globalThis.__state.me = { id: 'alice' };
  globalThis.__state.pending.clear();
  globalThis.__localStorage.clear();
}

function pin(userId, k, { verified = true } = {}) {
  const at = Date.now() - HOUR;
  return { userId, owner: 'alice', keyId: k.bundle.keyId, bundle: k.bundle, createdAt: k.bundle.createdAt, seenKeyIds: [k.bundle.keyId], verified, firstSeenAt: at, pinnedAt: at, unackedKeyIds: [], changes: [] };
}

/**
 * Sets up alice's device and a server. `server.keys` is what GET /api/keys returns,
 * `server.history` what GET /api/keys/:userId?keyId= finds.
 */
async function world({ verified = true, isGroup = false, members = ['alice', 'maya'] } = {}) {
  if (!globalThis.__ks) await import(pathToFileURL(path.join(STUBS, 'keystore.js')).href);
  resetStubs();
  const alice = await keysFor('alice');
  const maya = await keysFor('maya', { now: Date.now() - HOUR });
  const account = { ...alice.account, backup: alice.backup, published: true, recoverySaved: true };
  delete account.recoveryKey;
  globalThis.__ks.account.set('alice', account);
  globalThis.__ks.contacts.set('maya', pin('maya', maya, { verified }));
  const server = {
    me: { bundle: alice.bundle, backup: alice.backup },
    keys: { maya: maya.bundle },
    history: new Map([[maya.bundle.keyId, maya.bundle]]),
    posted: [],
    puts: [],
  };
  globalThis.__convs = { c1: { id: 'c1', isGroup, members: members.map((id) => ({ id })) } };
  globalThis.__Api = {
    myKeys: async () => server.me,
    putKeys: async (bundle, backup) => {
      server.puts.push({ bundle, backup });
      server.me = { bundle, backup };
      return { bundle };
    },
    keysFor: async (ids) => ({ keys: Object.fromEntries(ids.map((id) => [id, server.keys[id] || null])) }),
    userKey: async (u, keyId) => {
      const b = server.history.get(keyId);
      if (!b) throw new ApiError(404, 'Key not found');
      return { bundle: b };
    },
    conversation: async (id) => ({ conversation: globalThis.__convs[id] }),
  };
  await E.loadKeys({ id: 'alice' });
  assert.equal(E.getKeyState().state, 'ready');
  return { alice, maya, server };
}

async function recipient(userId, k) {
  const v = await K.verifyBundle(k.bundle, userId);
  return { userId, keyId: k.bundle.keyId, encPub: v.encPub };
}

/** An envelope "from" `senderId`, signed with `signer`'s key, for these recipients. */
async function sealAs(senderId, signer, { clientId, kind = 'message', payload, to, conversationId = 'c1' }) {
  return V.sealEnvelope({
    conversationId,
    senderId,
    senderKeyId: signer.bundle.keyId,
    sigPriv: signer.account.sigPriv,
    clientId,
    kind,
    payload: payload || { kind, body: 'hello', attachments: [], replyTo: null },
    recipients: to,
  });
}

const textPayload = (body) => ({ kind: 'message', body, attachments: [], replyTo: null });

function send(body, post, extra = {}) {
  return E.sendSealed({
    conversationId: 'c1',
    kind: 'message',
    clientId: extra.clientId || globalThis.crypto.randomUUID(),
    recipientIds: extra.recipientIds || ['alice', 'maya'],
    payload: textPayload(body),
    post,
  });
}

// ---------------------------------------------------------------------------
// C1: pins

test('C1-A: a message signed with an older-dated key the server made is not a normal trusted message', async () => {
  const { alice, maya } = await world({ verified: true });
  const forged = await keysFor('maya', { now: Date.now() - 30 * DAY }); // dated before Maya's real key
  const env = await sealAs('maya', forged, {
    clientId: 'cid1',
    payload: textPayload('Please send the money to IBAN X'),
    to: [await recipient('alice', alice), await recipient('maya', forged)],
  });
  // The server will serve the forged bundle as a "historic" key.
  const server = globalThis.__Api;
  server.userKey = async (u, keyId) => ({ bundle: keyId === forged.bundle.keyId ? forged.bundle : maya.bundle });
  const msg = { id: 7, conversationId: 'c1', senderId: 'maya', clientId: 'cid1', e2ee: env, attachments: [], createdAt: Date.now() };
  await E.viewReady(msg);
  const v = E.messageView({ ...msg });
  assert.equal(v.warning, 'unverified-key', 'flagged: sent with a key you haven’t verified');
  const changes = E.safetyChanges(['maya']);
  assert.equal(changes.length, 1, 'a safety-number change notice');
  assert.equal(changes[0].keyId, forged.bundle.keyId);
  const info = E.contactInfo('maya');
  assert.equal(info.verified, false);
  assert.equal(info.needsAck, true);
  assert.equal(info.keyId, maya.bundle.keyId, 'we keep sealing to the pinned key');
});

test('C1-A (unverified contact): a new key shows a notice, no flag', async () => {
  const { alice } = await world({ verified: false });
  const forged = await keysFor('maya', { now: Date.now() - 30 * DAY });
  globalThis.__Api.userKey = async () => ({ bundle: forged.bundle });
  const env = await sealAs('maya', forged, { clientId: 'cid1', to: [await recipient('alice', alice), await recipient('maya', forged)] });
  const msg = { id: 7, conversationId: 'c1', senderId: 'maya', clientId: 'cid1', e2ee: env, attachments: [], createdAt: Date.now() };
  await E.viewReady(msg);
  assert.equal(E.messageView({ ...msg }).warning, null);
  assert.equal(E.safetyChanges(['maya']).length, 1);
  // A message from a key we've accepted before is not another change.
  const env2 = await sealAs('maya', forged, { clientId: 'cid2', to: [await recipient('alice', alice), await recipient('maya', forged)] });
  await E.viewReady({ ...msg, id: 8, clientId: 'cid2', e2ee: env2 });
  assert.equal(E.safetyChanges(['maya']).length, 1);
});

test('C1-B: sending to a verified contact while the server offers another (older) key asks first', async () => {
  const { server } = await world({ verified: true });
  const forged = await keysFor('maya', { now: Date.now() - 30 * DAY });
  server.keys.maya = forged.bundle;
  await assert.rejects(
    send('secret', async (e) => server.posted.push(e)),
    (err) => err instanceof E.SafetyCheckNeeded && err.userIds.includes('maya'),
  );
  assert.equal(server.posted.length, 0, 'nothing sealed to the new key before the person confirms');
  assert.equal(E.safetyChanges(['maya']).length, 1, 'notice in their chats');
  assert.equal(E.contactInfo('maya').needsAck, true);
  // "Send anyway": now it goes to the (new) pinned key.
  E.acknowledgeChange(['maya']);
  await send('secret', async (e) => server.posted.push(e));
  assert.equal(server.posted.length, 1);
  assert.equal(server.posted[0].keys.maya.k, forged.bundle.keyId);
  assert.equal(E.contactInfo('maya').keyId, forged.bundle.keyId);
});

test('C1-B (unverified contact): another key is a notice, then the message goes', async () => {
  const { server } = await world({ verified: false });
  const next = await keysFor('maya', { now: Date.now() });
  server.keys.maya = next.bundle;
  await send('hi', async (e) => server.posted.push(e));
  assert.equal(server.posted.length, 1);
  assert.equal(server.posted[0].keys.maya.k, next.bundle.keyId);
  assert.equal(E.safetyChanges(['maya']).length, 1);
});

test('C1: bundles dated more than a day ahead are refused (sealing and receiving)', async () => {
  const { alice, maya, server } = await world({ verified: false });
  const future = await keysFor('maya', { now: Date.now() + 2 * DAY });
  server.keys.maya = future.bundle;
  await assert.rejects(send('x', async (e) => server.posted.push(e)), (err) => err instanceof E.SealError);
  assert.equal(server.posted.length, 0);
  assert.equal(E.contactInfo('maya').keyId, maya.bundle.keyId, 'pin unchanged');
  assert.equal(E.safetyChanges(['maya']).length, 0);
  globalThis.__Api.userKey = async () => ({ bundle: future.bundle });
  const env = await sealAs('maya', future, { clientId: 'cidf', to: [await recipient('alice', alice), await recipient('maya', future)] });
  const v = await E.viewReady({ id: 9, conversationId: 'c1', senderId: 'maya', clientId: 'cidf', e2ee: env, attachments: [] });
  assert.equal(v.status, 'unverified');
});

test('a message "from me" signed with a key this device never had is not trusted', async () => {
  const { alice } = await world();
  const fakeMe = await keysFor('alice', { now: Date.now() - 10 * DAY });
  globalThis.__Api.userKey = async () => ({ bundle: fakeMe.bundle });
  const env = await sealAs('alice', fakeMe, { clientId: 'cidme', to: [await recipient('alice', alice)] });
  const v = await E.viewReady({ id: 10, conversationId: 'c1', senderId: 'alice', clientId: 'cidme', e2ee: env, attachments: [] });
  assert.equal(v.status, 'unverified');
});

// ---------------------------------------------------------------------------
// C3: recipients

test('C3-D: a 1:1 chat is never sealed to a third person the server adds', async () => {
  const { server } = await world();
  await send('first', async (e) => server.posted.push(e)); // this device learns the chat's two people
  const eve = await keysFor('eve');
  server.keys.eve = eve.bundle;
  globalThis.__convs.c1 = { id: 'c1', isGroup: false, members: [{ id: 'alice' }, { id: 'maya' }, { id: 'eve' }] };
  let tries = 0;
  await assert.rejects(
    send('secret 2', async (e) => {
      if (tries++ === 0) throw new ApiError(409, 'members_changed', { error: 'members_changed', members: ['alice', 'maya', 'eve'] });
      server.posted.push(e);
      return { message: {} };
    }),
    (err) => err instanceof E.SealError,
  );
  assert.equal(server.posted.length, 1);
  assert.ok(server.posted.every((e) => !('eve' in e.keys)), 'nothing sealed to eve');
  // Even with "isGroup" flipped by the server, this device remembers it as a 1:1 chat.
  globalThis.__convs.c1 = { ...globalThis.__convs.c1, isGroup: true };
  await assert.rejects(send('secret 3', async (e) => server.posted.push(e), { recipientIds: ['alice', 'maya', 'eve'] }), E.SealError);
  assert.equal(server.posted.length, 1);
});

test('C3-D: a 1:1 chat first seen with three people is refused', async () => {
  const { server } = await world({ members: ['alice', 'maya', 'eve'] });
  server.keys.eve = (await keysFor('eve')).bundle;
  await assert.rejects(send('x', async (e) => server.posted.push(e), { recipientIds: ['alice', 'maya', 'eve'] }), E.SealError);
  assert.equal(server.posted.length, 0);
});

test('C3: in a group, someone new gets a local notice before anything is sealed to them', async () => {
  const { server } = await world({ isGroup: true });
  await send('hi all', async (e) => server.posted.push(e));
  assert.deepEqual(E.memberNotices('c1'), []);
  const eve = await keysFor('eve');
  server.keys.eve = eve.bundle;
  globalThis.__convs.c1 = { id: 'c1', isGroup: true, members: [{ id: 'alice' }, { id: 'maya' }, { id: 'eve' }] };
  await send('hello eve', async (e) => server.posted.push(e), { recipientIds: ['alice', 'maya', 'eve'] });
  const notices = E.memberNotices('c1');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].userId, 'eve');
  assert.ok('eve' in server.posted[1].keys);
  assert.ok(globalThis.__events.some(([n, id]) => n === 'members-changed' && id === 'c1'));
});

// ---------------------------------------------------------------------------
// C4: this device's own key

test('C4-C: the server claiming my key changed never deletes it; old messages still open', async () => {
  const { alice, maya, server } = await world();
  // An old message to my current key.
  const old = await sealAs('maya', maya, { clientId: 'old1', payload: textPayload('from before'), to: [await recipient('alice', alice), await recipient('maya', maya)] });
  const fakeMe = await keysFor('alice', { now: Date.now() + 1000 });
  server.me = { bundle: fakeMe.bundle, backup: fakeMe.backup };
  await assert.rejects(
    send('x', async () => {
      throw new ApiError(409, 'keys_changed', { error: 'keys_changed' });
    }),
    (err) => err instanceof E.KeysNotReadyError,
  );
  const st = E.getKeyState();
  assert.equal(st.state, 'needs-recovery');
  assert.ok(st.conflict && st.conflict.keyId === fakeMe.bundle.keyId, 'the key-conflict screen');
  const kept = globalThis.__ks.local.oldKeys.get(`alice|${alice.bundle.keyId}`);
  assert.ok(kept && kept.encPriv, 'my private key is kept (oldKeys), not deleted');
  assert.equal(server.puts.length, 0);
  // Recovery with the (new) key's recovery key: messages to the old key still open.
  await E.recover(fakeMe.account.recoveryKey);
  assert.equal(E.getKeyState().state, 'ready');
  assert.equal(E.myKeyId(), fakeMe.bundle.keyId);
  const v = await E.viewReady({ id: 3, conversationId: 'c1', senderId: 'maya', clientId: 'old1', e2ee: old, attachments: [] });
  assert.equal(v.status, 'ok');
  assert.equal(v.body, 'from before');
});

test('C4-C: a keys WebSocket event about me can’t delete my key either', async () => {
  const { alice, server } = await world();
  const fakeMe = await keysFor('alice', { now: Date.now() + 1000 });
  server.me = { bundle: fakeMe.bundle, backup: fakeMe.backup };
  await E.handleKeysEvent('alice', fakeMe.bundle);
  assert.equal(E.getKeyState().state, 'needs-recovery');
  assert.ok(globalThis.__ks.local.oldKeys.get(`alice|${alice.bundle.keyId}`).encPriv);
  // "Start fresh" keeps it too.
  await E.resetKeys();
  assert.equal(E.getKeyState().state, 'show-recovery');
  assert.ok(globalThis.__ks.local.oldKeys.has(`alice|${alice.bundle.keyId}`));
});

test('C4-E: the server saying I have no key makes the device re-publish its own key, not a new one', async () => {
  const { alice, server } = await world();
  E.forgetKeys();
  server.me = { bundle: null, backup: null };
  await E.loadKeys({ id: 'alice' });
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].bundle.keyId, alice.bundle.keyId, 'the same key');
  assert.deepEqual(server.puts[0].backup, alice.backup, 'with the stored backup');
  assert.equal(globalThis.__ks.account.get('alice').keyId, alice.bundle.keyId);
  assert.equal(E.getKeyState().state, 'ready');
  assert.equal(E.recoveryKeyText(), '', 'no new recovery key');
});

test('C4-E: keys_changed then { bundle: null } re-publishes too', async () => {
  const { alice, server } = await world();
  server.me = { bundle: null, backup: null };
  let first = true;
  await send('x', async (e) => {
    if (first) {
      first = false;
      throw new ApiError(409, 'keys_changed', { error: 'keys_changed' });
    }
    server.posted.push(e);
  });
  assert.equal(server.puts.length, 1);
  assert.equal(server.puts[0].bundle.keyId, alice.bundle.keyId);
  assert.equal(server.posted.length, 1);
});

// ---------------------------------------------------------------------------
// C5: edits and reactions

async function aliceMsgs() {
  const { alice, maya } = await world({ verified: false });
  const to = [await recipient('alice', alice), await recipient('maya', maya)];
  const sealA = (clientId, kind, payload) => sealAs('alice', alice, { clientId, kind, payload, to });
  const sealM = (clientId, kind, payload) => sealAs('maya', maya, { clientId, kind, payload, to });
  return { alice, maya, sealA, sealM };
}

test('C5-R: a reaction moved by the server onto another message is not shown', async () => {
  const { sealA, sealM } = await aliceMsgs();
  const m40 = await sealA('ca', 'message', textPayload('Want to get lunch?'));
  const m41 = await sealA('cb', 'message', textPayload('Should I sell the house?'));
  // Maya reacts 👍 to message 40 ("ca").
  const r40 = await sealM('rx', 'reaction:40', { kind: 'reaction:40', emoji: '👍', target: { senderId: 'alice', clientId: 'ca' } });
  // The server serves id 40 with message 41's envelope and keeps the reaction on it.
  const swapped = { id: 40, conversationId: 'c1', senderId: 'alice', clientId: 'cb', e2eeClientId: 'cb', e2ee: m41, attachments: [], reactions: { maya: r40 }, reactionClientIds: { maya: 'rx' }, legacyReactions: {} };
  await E.viewReady(swapped);
  await tick();
  assert.deepEqual(E.messageView({ ...swapped }).reactions, {}, 'the 👍 was for "Want to get lunch?"');
  // Where it belongs, it shows.
  const real = { ...swapped, clientId: 'ca', e2eeClientId: 'ca', e2ee: m40 };
  await E.viewReady(real);
  await tick();
  assert.deepEqual(E.messageView({ ...real }).reactions, { '👍': ['maya'] });
  // A reaction without a target is ignored.
  const bare = await sealM('ry', 'reaction:40', { kind: 'reaction:40', emoji: '😂' });
  const withBare = { ...real, reactions: { maya: bare }, reactionClientIds: { maya: 'ry' } };
  await E.viewReady(withBare);
  await tick();
  assert.deepEqual(E.messageView({ ...withBare }).reactions, {});
});

test('C5-R: a message served with another clientId in e2eeClientId opens with its own clientId', async () => {
  const { sealA } = await aliceMsgs();
  const m41 = await sealA('cb', 'message', textPayload('Should I sell the house?'));
  // Claims to be message "ca" but carries "cb"'s envelope: the AAD doesn't match.
  const v = await E.viewReady({ id: 40, conversationId: 'c1', senderId: 'alice', clientId: 'ca', e2eeClientId: 'cb', e2ee: m41, attachments: [] });
  assert.equal(v.status, 'unverified');
});

test('C5-E: an older edit served again shows the newest one seen; edits must name their message and seq', async () => {
  const { sealA } = await aliceMsgs();
  const target = { senderId: 'alice', clientId: 'ca' };
  const e1 = await sealA('e1', 'edit:40', { kind: 'edit:40', body: 'edit one', target, seq: 1 });
  const e2 = await sealA('e2', 'edit:40', { kind: 'edit:40', body: 'edit two', target, seq: 2 });
  const base = { id: 40, conversationId: 'c1', senderId: 'alice', clientId: 'ca', attachments: [], reactions: {}, editedAt: 1 };
  let v = await E.viewReady({ ...base, e2eeClientId: 'e2', e2ee: e2 });
  assert.equal(v.body, 'edit two');
  v = await E.viewReady({ ...base, e2eeClientId: 'e1', e2ee: e1 });
  assert.equal(v.status, 'ok');
  assert.equal(v.body, 'edit two', 'rolled-back edit rejected');
  // The next edit from this device continues the numbering.
  assert.equal(E.editPayload({ ...base }, 'three').seq, 3);
  assert.deepEqual(E.editPayload({ ...base }, 'three').target, target);
  // No seq, or another target: not shown as the message.
  const noSeq = await sealA('e3', 'edit:40', { kind: 'edit:40', body: 'no seq', target });
  assert.equal((await E.viewReady({ ...base, e2eeClientId: 'e3', e2ee: noSeq })).status, 'unverified');
  const other = await sealA('e4', 'edit:40', { kind: 'edit:40', body: 'moved', target: { senderId: 'alice', clientId: 'zz' }, seq: 9 });
  assert.equal((await E.viewReady({ ...base, e2eeClientId: 'e4', e2ee: other })).status, 'unverified');
  // The reviewer's version: an edit with neither.
  const bare = await sealA('e5', 'edit:40', { kind: 'edit:40', body: 'edit one (wrong)' });
  assert.equal((await E.viewReady({ ...base, e2eeClientId: 'e5', e2ee: bare })).status, 'unverified');
});

// ---------------------------------------------------------------------------
// C6: plaintext from the server

test('C6-L: server-made reactions on encrypted messages and unencrypted messages after encryption began', async () => {
  const { sealA } = await aliceMsgs();
  const m41 = await sealA('cb', 'message', textPayload('Should I sell the house?'));
  const inj = { id: 41, conversationId: 'c1', senderId: 'alice', clientId: 'cb', e2ee: m41, attachments: [], reactions: { '❤️': ['maya'] }, reactionClientIds: {}, legacyReactions: { '😂': ['maya'] } };
  await E.viewReady(inj);
  await tick();
  assert.deepEqual(E.messageView({ ...inj }).reactions, {}, 'no plaintext reactions on an encrypted message');
  // e2ee: null after the first encrypted message in the chat: a warning, not a legacy message.
  const later = { id: 99, conversationId: 'c1', senderId: 'maya', clientId: 'zz', e2ee: null, body: 'server-written text', attachments: [], legacyReactions: {} };
  const v = E.messageView(later);
  assert.equal(v.warning, 'unencrypted');
  // Older plaintext (from before encryption) is the usual legacy message.
  const earlier = { ...later, id: 12, legacyReactions: { '👍': ['maya'] } };
  const w = E.messageView(earlier);
  assert.equal(w.status, 'legacy');
  assert.equal(w.warning, null);
  assert.deepEqual(w.reactions, { '👍': ['maya'] });
  // The marker is remembered on the device.
  await tick(600);
  assert.equal(globalThis.__ks.local.meta.get('firstEncrypted').value.c1, 41);
});

// ---------------------------------------------------------------------------
// P8, P1, P3

test('P8: an envelope context containing "|" is never opened', async () => {
  const { sealA } = await aliceMsgs();
  const env = await sealA('a|b', 'message', textPayload('x'));
  const v = await E.viewReady({ id: 50, conversationId: 'c1', senderId: 'alice', clientId: 'a|b', e2ee: env, attachments: [] });
  assert.equal(v.status, 'undecryptable');
});

test('P1: the recovery key is shown once and never stored; confirming needs its last group', async () => {
  await world();
  // An old record with the recovery key in it is cleaned on load.
  globalThis.__ks.account.set('alice', { ...globalThis.__ks.account.get('alice'), recoveryKey: 'AAAA-BBBB' });
  E.forgetKeys();
  await E.loadKeys({ id: 'alice' });
  assert.ok(!('recoveryKey' in globalThis.__ks.account.get('alice')));
  // A new key: the recovery key is in memory only.
  await E.resetKeys();
  assert.equal(E.getKeyState().state, 'show-recovery');
  const text = E.recoveryKeyText();
  assert.match(text, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  const stored = JSON.stringify(Object.keys(globalThis.__ks.account.get('alice')));
  assert.ok(!stored.includes('recoveryKey'));
  for (const v of Object.values(globalThis.__ks.account.get('alice'))) assert.notEqual(v, text);
  assert.equal(await E.confirmRecoverySaved('0000'), false);
  assert.equal(E.getKeyState().state, 'show-recovery');
  assert.equal(await E.confirmRecoverySaved(text.slice(-4).toLowerCase()), true);
  assert.equal(E.getKeyState().state, 'ready');
  assert.equal(E.recoveryKeyText(), '');
});

test('P3: pins survive logout for the same account, not for another one', async () => {
  await world();
  E.markVerified('maya', E.contactInfo('maya').keyId);
  await E.deleteLocalKeys();
  assert.equal(globalThis.__ks.account.size, 0, 'private keys gone');
  assert.equal(globalThis.__ks.contacts.size, 1, 'pins kept');
  globalThis.__ks.account.set('alice', (() => {
    const a = { ...keyCache.get('alice|{}').account, backup: keyCache.get('alice|{}').backup, published: true, recoverySaved: true };
    delete a.recoveryKey;
    return a;
  })());
  await E.loadKeys({ id: 'alice' });
  assert.equal(E.contactInfo('maya').verified, true);
  await E.deleteLocalKeys();
  globalThis.__state.me = { id: 'bob' };
  globalThis.__Api.myKeys = async () => ({ bundle: null, backup: null });
  await E.loadKeys({ id: 'bob' });
  assert.equal(E.contactInfo('maya'), null);
  assert.equal(globalThis.__ks.contacts.size, 0);
});

// ---------------------------------------------------------------------------
// P4: the outbox

test('P4: the outbox is stored encrypted under a non-extractable key, migrated, and expires', async () => {
  await world();
  E.forgetKeys(); // not sending in this test: the outbox only stores
  const pending = globalThis.__state.pending;
  // An older version's plaintext outbox in localStorage gets moved.
  globalThis.__localStorage.set('tt.outbox', JSON.stringify([{ clientId: 'legacy1', conversationId: 'c1', body: 'old secret words', createdAt: Date.now() }]));
  await O.loadOutbox();
  assert.ok(pending.has('legacy1'));
  assert.ok(!globalThis.__localStorage.has('tt.outbox'), 'plaintext copy removed');
  O.enqueue({ conversationId: 'c1', body: 'very secret words' });
  await O.outboxSaved();
  const recs = [...globalThis.__ks.local.outbox.values()];
  assert.equal(recs.length, 2);
  const all = JSON.stringify(recs.map((r) => ({ ...r, ct: Buffer.from(r.ct).toString('latin1') })));
  assert.ok(!all.includes('secret words'), 'no plaintext at rest');
  const { key } = globalThis.__ks.local.outboxKey.get('alice');
  assert.ok(key instanceof CryptoKey);
  assert.equal(key.extractable, false);
  // A reload: everything comes back from the encrypted store.
  const bodies = [...pending.values()].map((p) => p.body).sort();
  pending.clear();
  await O.loadOutbox();
  assert.deepEqual([...pending.values()].map((p) => p.body).sort(), bodies);
  // A message that failed 8 days ago is dropped on load.
  const failed = [...pending.values()][0];
  failed.state = 'failed';
  failed.failedAt = Date.now() - 8 * DAY;
  O.retry('nope'); // no-op, just to keep the API exercised
  pending.set(failed.clientId, failed);
  O.enqueue({ conversationId: 'c1', body: 'trigger a save' });
  await O.outboxSaved();
  pending.clear();
  await O.loadOutbox();
  assert.ok(!pending.has(failed.clientId), 'expired');
  assert.equal(pending.size, 2);
  O.clearOutbox();
  await O.outboxSaved();
  assert.equal(globalThis.__ks.local.outbox.size, 0);
  assert.equal(globalThis.__ks.local.outboxKey.size, 0);
});
