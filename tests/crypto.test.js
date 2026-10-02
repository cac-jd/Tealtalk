'use strict';

// Crypto unit tests (docs/E2EE.md "Tests that prove it"). They load the very same
// ES modules the browser runs, using Node's built-in WebCrypto.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CRYPTO_DIR = path.join(PUBLIC_DIR, 'js', 'crypto');
const load = (name) => import(pathToFileURL(path.join(CRYPTO_DIR, name)).href);

let E; // encoding
let K; // keys
let V; // envelope
let F; // files
let S; // safety

test.before(async () => {
  [E, K, V, F, S] = await Promise.all([
    load('encoding.js'),
    load('keys.js'),
    load('envelope.js'),
    load('files.js'),
    load('safety.js'),
  ]);
});

// ---------------------------------------------------------------------------
// helpers

const accounts = new Map();
async function account(userId) {
  if (!accounts.has(userId)) accounts.set(userId, await K.createAccountKeys(userId));
  return accounts.get(userId);
}

async function recipient(userId, acct) {
  const a = acct || (await account(userId));
  const pub = await K.verifyBundle(a.bundle, userId);
  return { userId, keyId: pub.keyId, encPub: pub.encPub };
}

async function senderOf(userId, acct) {
  const a = acct || (await account(userId));
  const pub = await K.verifyBundle(a.bundle, userId);
  return { keyId: pub.keyId, sigPub: pub.sigPub };
}

function meOf(a) {
  return { userId: a.account.userId, keyId: a.account.keyId, encPriv: a.account.encPriv };
}

const CTX = { conversationId: 'c_room1', senderId: 'u_alice', clientId: '11111111-2222-4333-8444-555555555555' };

async function sealFromAlice({ kind = 'message', payload, recipients = ['u_alice', 'u_bob'], ctx = CTX } = {}) {
  const alice = await account('u_alice');
  const rs = [];
  for (const id of recipients) rs.push(await recipient(id));
  return V.sealEnvelope({
    ...ctx,
    senderKeyId: alice.account.keyId,
    sigPriv: alice.account.sigPriv,
    kind,
    payload: payload || { kind, body: 'hello bob', attachments: [], replyTo: null },
    recipients: rs,
  });
}

async function openAs(userId, env, ctx = { ...CTX, expectedKind: env && env.kind }) {
  const me = await account(userId);
  return V.openEnvelope(env, ctx, await senderOf(ctx.senderId), meOf(me));
}

async function expectEnvelopeError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof V.EnvelopeError, `expected EnvelopeError, got ${err && err.stack}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Flip one bit in the middle of a b64u field, keeping it valid b64u of the same length. */
function flipB64u(value, at) {
  const bytes = E.fromB64u(value);
  const i = at === undefined ? Math.floor(bytes.length / 2) : at;
  bytes[i] ^= 0x01;
  return E.b64u(bytes);
}

function pattern(n, seed = 7) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

// ---------------------------------------------------------------------------
// encoding

test('b64u round trips and is strict', () => {
  for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 91]) {
    const b = pattern(n, n + 1);
    const s = E.b64u(b);
    assert.ok(!/[=+/]/.test(s));
    assert.equal(s.length, E.b64uLength(n));
    assert.deepEqual(E.fromB64u(s), b);
  }
  assert.equal(E.b64u(Uint8Array.of(0xfb, 0xff)), '-_8');
  assert.throws(() => E.fromB64u('-_8='));
  assert.throws(() => E.fromB64u('+/8'));
  assert.throws(() => E.fromB64u('A'));
  assert.throws(() => E.fromB64u('-_9')); // non-canonical trailing bits
  assert.throws(() => E.fromB64u(42));
});

test('canonical JSON sorts keys recursively and has no whitespace (known answer)', () => {
  const value = { v: 1, b: [3, { z: 'é', a: null }], a: { y: true, x: 'q"\n' }, skip: undefined, '10': 0, '9': -1.5 };
  assert.equal(E.canonical(value), '{"10":0,"9":-1.5,"a":{"x":"q\\"\\n","y":true},"b":[3,{"a":null,"z":"é"}],"v":1}');
  assert.equal(E.canonical({ B: 1, a: 2, _: 3 }), '{"B":1,"_":3,"a":2}');
  assert.equal(E.canonical([]), '[]');
  assert.throws(() => E.canonical({ n: NaN }));
});

test('recovery keys: Crockford base32 in 8 groups of 4 (known answer)', () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13 + 1);
  const text = E.encodeRecoveryKey(bytes);
  assert.equal(text, '0471-PA1N-897N-RTBP-GE89-VANQ-RK8X-XTZR'); // cross-checked with Python's base32
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(E.decodeRecoveryKey(text), bytes);
  const high = new Uint8Array(20);
  high[0] = 0xff;
  assert.equal(E.encodeRecoveryKey(high), 'ZW00-0000-0000-0000-0000-0000-0000-0000');
  assert.deepEqual(E.decodeRecoveryKey('zw00-0000-0000-0000-0000-0000-0000-0000'), high);
  // all zeros / all ones
  assert.equal(E.encodeRecoveryKey(new Uint8Array(20)), '0000-0000-0000-0000-0000-0000-0000-0000');
  assert.equal(E.encodeRecoveryKey(new Uint8Array(20).fill(255)), 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
});

test('recovery keys: typing is case-insensitive and reads O as 0, I and L as 1', () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13 + 1);
  // 0471-PA1N-… typed lower-case, with O for 0 and l/I for 1, odd spacing and no dashes
  assert.deepEqual(E.decodeRecoveryKey('o47l pain 897n rtbp ge89 vanq rk8x xtzr'), bytes);
  assert.deepEqual(E.decodeRecoveryKey('O47IPAlN897NRTBPGE89VANQRK8XXTZR'), bytes);
  assert.deepEqual(E.decodeRecoveryKey(' 0471-pa1n-897n-rtbp-ge89-vanq-rk8x-xtzr\n'), bytes);
  assert.throws(() => E.decodeRecoveryKey('U471-PA1N-897N-RTBP-GE89-VANQ-RK8X-XTZR'), E.RecoveryKeyFormatError);
  assert.throws(() => E.decodeRecoveryKey('0471-PA1N-897N-RTBP-GE89-VANQ-RK8X-XTZ'), E.RecoveryKeyFormatError);
  assert.throws(() => E.decodeRecoveryKey('0471-PA1N-897N-RTBP-GE89-VANQ-RK8X-XTZRR'), E.RecoveryKeyFormatError);
  assert.throws(() => E.decodeRecoveryKey(''), E.RecoveryKeyFormatError);
});

// ---------------------------------------------------------------------------
// keys

test('generated keys: bundle verifies, keyId recomputes, private keys are not extractable', async () => {
  const a = await K.createAccountKeys('u_keys', { now: 1790000000000 });
  const { bundle, backup, account: acct } = a;
  assert.equal(bundle.v, 1);
  assert.equal(bundle.keyId.length, 43);
  assert.equal(bundle.createdAt, 1790000000000);
  assert.equal(E.fromB64u(bundle.encPub).length, 91);
  assert.equal(E.fromB64u(bundle.sigPub).length, 91);
  assert.equal(E.fromB64u(bundle.selfSig).length, 64); // raw r||s
  assert.equal(bundle.keyId, await K.computeKeyId(E.fromB64u(bundle.sigPub), E.fromB64u(bundle.encPub)));
  const pub = await K.verifyBundle(bundle, 'u_keys');
  assert.equal(pub.keyId, bundle.keyId);
  assert.equal(acct.encPriv.extractable, false);
  assert.equal(acct.sigPriv.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', acct.encPriv));
  await assert.rejects(crypto.subtle.exportKey('pkcs8', acct.sigPriv));
  assert.match(acct.recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.deepEqual(Object.keys(backup).sort(), ['ct', 'iv', 'keyId', 'v']);
  assert.equal(backup.keyId, bundle.keyId);
  assert.ok(JSON.stringify(backup).length < 4096);
  // The self-signature is over the documented string (Node verifies with ieee-p1363).
  const nodeCrypto = require('node:crypto');
  const spki = nodeCrypto.createPublicKey({ key: Buffer.from(E.fromB64u(bundle.sigPub)), format: 'der', type: 'spki' });
  assert.ok(
    nodeCrypto.verify(
      'sha256',
      Buffer.from(`tealtalk-keys-v1|u_keys|${bundle.keyId}|${bundle.createdAt}`),
      { key: spki, dsaEncoding: 'ieee-p1363' },
      Buffer.from(E.fromB64u(bundle.selfSig)),
    ),
  );
});

test('bundles fail verification when tampered or claimed by another user', async () => {
  const { bundle } = await account('u_alice');
  const other = (await account('u_bob')).bundle;
  await assert.rejects(K.verifyBundle(bundle, 'u_bob'), K.BundleError);
  await assert.rejects(K.verifyBundle({ ...bundle, createdAt: bundle.createdAt + 1 }, 'u_alice'), K.BundleError);
  await assert.rejects(K.verifyBundle({ ...bundle, selfSig: flipB64u(bundle.selfSig) }, 'u_alice'), K.BundleError);
  await assert.rejects(K.verifyBundle({ ...bundle, encPub: other.encPub }, 'u_alice'), K.BundleError);
  await assert.rejects(K.verifyBundle({ ...bundle, keyId: other.keyId }, 'u_alice'), K.BundleError);
  await assert.rejects(K.verifyBundle({ ...bundle, v: 2 }, 'u_alice'), K.BundleError);
  await assert.rejects(K.verifyBundle(null, 'u_alice'), K.BundleError);
});

test('backup round trip restores working keys; wrong recovery key fails', async () => {
  const original = await K.createAccountKeys('u_restore');
  const typed = original.account.recoveryKey.toLowerCase().replace(/-/g, ' ');
  const restored = await K.restoreFromBackup('u_restore', typed, original.backup, original.bundle);
  assert.equal(restored.keyId, original.bundle.keyId);
  assert.equal(restored.recoveryKey, original.account.recoveryKey);
  assert.equal(restored.encPriv.extractable, false);
  assert.equal(restored.sigPriv.extractable, false);

  // The restored keys open a message sealed to the original bundle, and sign as that account.
  const env = await V.sealEnvelope({
    ...CTX,
    senderId: 'u_restore',
    senderKeyId: restored.keyId,
    sigPriv: restored.sigPriv,
    kind: 'message',
    payload: { kind: 'message', body: 'from my new phone', attachments: [], replyTo: null },
    recipients: [await recipient('u_restore', original)],
  });
  const payload = await V.openEnvelope(
    env,
    { ...CTX, senderId: 'u_restore', expectedKind: 'message' },
    await senderOf('u_restore', original),
    { userId: 'u_restore', keyId: restored.keyId, encPriv: restored.encPriv },
  );
  assert.equal(payload.body, 'from my new phone');

  // Wrong recovery key
  const wrong = E.encodeRecoveryKey(new Uint8Array(20).fill(7));
  await assert.rejects(K.restoreFromBackup('u_restore', wrong, original.backup, original.bundle), K.RecoveryError);
  // Mistyped (format) is a different, friendlier error
  await assert.rejects(K.restoreFromBackup('u_restore', 'not a key', original.backup, original.bundle), K.RecoveryKeyFormatError);
  // Right key, but the backup was bound to another userId
  await assert.rejects(K.restoreFromBackup('u_other', original.account.recoveryKey, original.backup, original.bundle), K.RecoveryError);
  // Tampered ciphertext or iv
  await assert.rejects(
    K.restoreFromBackup('u_restore', original.account.recoveryKey, { ...original.backup, ct: flipB64u(original.backup.ct) }, original.bundle),
    K.RecoveryError,
  );
  await assert.rejects(
    K.restoreFromBackup('u_restore', original.account.recoveryKey, { ...original.backup, iv: flipB64u(original.backup.iv) }, original.bundle),
    K.RecoveryError,
  );
  // keyId must match the account's current bundle
  const newer = await K.createAccountKeys('u_restore');
  await assert.rejects(K.restoreFromBackup('u_restore', original.account.recoveryKey, original.backup, newer.bundle), K.RecoveryError);
  await assert.rejects(
    K.restoreFromBackup('u_restore', original.account.recoveryKey, { ...original.backup, keyId: newer.bundle.keyId }, newer.bundle),
    K.RecoveryError,
  );
});

// ---------------------------------------------------------------------------
// envelopes

test('envelope round trip for messages, edits and reactions, for every recipient', async () => {
  const payloads = [
    { kind: 'message', body: 'hi 👋 there', attachments: [], replyTo: { id: 40, senderId: 'u_bob', snippet: 'earlier' } },
    { kind: 'edit:42', body: 'new text' },
    { kind: 'reaction:42', emoji: '❤️' },
  ];
  for (const payload of payloads) {
    const env = await sealFromAlice({ kind: payload.kind, payload, recipients: ['u_alice', 'u_bob', 'u_carol'] });
    assert.deepEqual(Object.keys(env).sort(), ['ct', 'eph', 'iv', 'keys', 'kind', 'senderKeyId', 'sig', 'v']);
    assert.deepEqual(Object.keys(env.keys).sort(), ['u_alice', 'u_bob', 'u_carol']);
    assert.equal(E.fromB64u(env.sig).length, 64);
    assert.equal(E.fromB64u(env.iv).length, 12);
    assert.equal(E.fromB64u(env.keys.u_bob.w).length, 60);
    for (const who of ['u_alice', 'u_bob', 'u_carol']) assert.deepEqual(await openAs(who, env), payload);
    assert.ok(!JSON.stringify(env).includes('new text'));
  }
});

test('the envelope signature is ECDSA over canonical(envelope without sig) | AAD (checked with node:crypto)', async () => {
  const env = await sealFromAlice();
  const { sig, ...rest } = env;
  const aad = `tealtalk-msg-v1|${CTX.conversationId}|${CTX.senderId}|${CTX.clientId}|message`;
  const nodeCrypto = require('node:crypto');
  const key = nodeCrypto.createPublicKey({ key: Buffer.from(E.fromB64u((await account('u_alice')).bundle.sigPub)), format: 'der', type: 'spki' });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(`${E.canonical(rest)}|${aad}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(E.fromB64u(sig))));
});

test('a non-recipient, or a device without the right key, cannot decrypt', async () => {
  const env = await sealFromAlice({ recipients: ['u_alice', 'u_bob'] });
  await expectEnvelopeError(openAs('u_carol', env), 'undecryptable');
  // Bob has reset his key: this device's (new) key isn't the one it was sealed to.
  const bobNew = await K.createAccountKeys('u_bob');
  await expectEnvelopeError(
    V.openEnvelope(env, { ...CTX, expectedKind: 'message' }, await senderOf('u_alice'), meOf(bobNew)),
    'undecryptable',
  );
});

test('tampering with ct, iv, keys, eph, sig, senderKeyId or kind fails before decrypting', async () => {
  const env = await sealFromAlice();
  const alice = await account('u_alice');
  const bobNew = await K.createAccountKeys('u_bob');
  const cases = {
    ct: { ...env, ct: flipB64u(env.ct) },
    iv: { ...env, iv: flipB64u(env.iv) },
    'keys.w': { ...env, keys: { ...env.keys, u_bob: { ...env.keys.u_bob, w: flipB64u(env.keys.u_bob.w) } } },
    'keys.k': { ...env, keys: { ...env.keys, u_bob: { ...env.keys.u_bob, k: bobNew.bundle.keyId } } },
    'keys dropped': { ...env, keys: { u_bob: env.keys.u_bob } },
    'keys added': { ...env, keys: { ...env.keys, u_mallory: env.keys.u_bob } },
    eph: { ...env, eph: (await sealFromAlice()).eph },
    sig: { ...env, sig: flipB64u(env.sig) },
    senderKeyId: { ...env, senderKeyId: bobNew.bundle.keyId },
    kind: { ...env, kind: 'edit:42' },
    v: { ...env, v: 2 },
  };
  for (const [name, bad] of Object.entries(cases)) {
    await assert.rejects(openAs('u_bob', bad, { ...CTX, expectedKind: bad.kind }), (err) => {
      assert.ok(err instanceof V.EnvelopeError, name);
      assert.equal(err.code, 'unverified', name);
      return true;
    });
  }
  // A kind the receiver didn't expect (e.g. a reaction replayed as an edit) fails too.
  const reaction = await sealFromAlice({ kind: 'reaction:42', payload: { kind: 'reaction:42', emoji: '😂' } });
  await expectEnvelopeError(openAs('u_bob', reaction, { ...CTX, expectedKind: 'edit:42' }), 'unverified');
  await expectEnvelopeError(openAs('u_bob', reaction, { ...CTX, expectedKind: 'reaction:43' }), 'unverified');
  // Signed by the right key id but checked against someone else's key.
  await expectEnvelopeError(
    V.openEnvelope(env, { ...CTX, expectedKind: 'message' }, { keyId: env.senderKeyId, sigPub: (await senderOf('u_bob')).sigPub }, meOf(await account('u_bob'))),
    'unverified',
  );
  // Sender bundle for a different keyId than the envelope names.
  await expectEnvelopeError(
    V.openEnvelope(env, { ...CTX, expectedKind: 'message' }, await senderOf('u_bob'), meOf(await account('u_bob'))),
    'unverified',
  );
  // Malformed envelopes
  for (const bad of [null, 'x', [], { ...env, keys: {} }, { ...env, iv: 'AAAA' }, { ...env, kind: 'message ' }]) {
    await expectEnvelopeError(openAs('u_bob', bad, { ...CTX, expectedKind: 'message' }), 'unverified');
  }
  assert.ok(alice);
});

test('a validly signed envelope whose content is damaged is undecryptable, never plaintext', async () => {
  // A malicious sender (Alice herself) signs garbage: signature fine, decryption fails.
  const alice = await account('u_alice');
  const env = await sealFromAlice();
  const garbage = { ...env, ct: flipB64u(env.ct) };
  delete garbage.sig;
  const aad = `tealtalk-msg-v1|${CTX.conversationId}|${CTX.senderId}|${CTX.clientId}|message`;
  const sig = await K.sign(alice.account.sigPriv, E.utf8(`${E.canonical(garbage)}|${aad}`));
  await expectEnvelopeError(openAs('u_bob', { ...garbage, sig: E.b64u(sig) }), 'undecryptable');
});

test('moving an envelope to another conversation, sender or clientId fails', async () => {
  const env = await sealFromAlice();
  await expectEnvelopeError(openAs('u_bob', env, { ...CTX, conversationId: 'c_other', expectedKind: 'message' }), 'unverified');
  await expectEnvelopeError(openAs('u_bob', env, { ...CTX, clientId: 'another-client-id', expectedKind: 'message' }), 'unverified');
  // Claimed by another sender: their key doesn't verify it, and with Alice's key the AAD differs.
  const bobAsSender = { ...CTX, senderId: 'u_bob', expectedKind: 'message' };
  await expectEnvelopeError(V.openEnvelope(env, bobAsSender, await senderOf('u_alice'), meOf(await account('u_bob'))), 'unverified');
});

test('sealing refuses a payload whose kind differs from the envelope kind', async () => {
  await assert.rejects(sealFromAlice({ kind: 'edit:1', payload: { kind: 'message', body: 'x' } }), TypeError);
  await assert.rejects(sealFromAlice({ kind: 'bogus', payload: { kind: 'bogus' } }), TypeError);
});

// ---------------------------------------------------------------------------
// files

async function encryptAll(data, params) {
  return F.encryptBytes(data, params);
}

async function decryptAll(cipher, params, size) {
  const blob = await F.decryptToBlob(cipher, params, size, 'image/jpeg');
  assert.equal(blob.type, 'image/jpeg');
  return new Uint8Array(await blob.arrayBuffer());
}

test('files round trip across record boundaries; ciphertext size = size + 16 per record', async () => {
  const params = { ...F.newFileKey(1024) };
  for (const size of [0, 1, 1023, 1024, 1025, 2048, 3 * 1024 + 5]) {
    const plain = pattern(size, size + 3);
    const cipher = await encryptAll(plain, params);
    assert.equal(cipher.length, size + 16 * Math.max(1, Math.ceil(size / 1024)), `size ${size}`);
    assert.equal(cipher.length, F.cipherSize(size, 1024));
    assert.deepEqual(await decryptAll(cipher, params, size), plain, `size ${size}`);
    // The same from Blobs
    const viaBlob = await F.encryptBytes(new Blob([plain]), params);
    assert.deepEqual(viaBlob, cipher);
    assert.deepEqual(await decryptAll(new Blob([cipher]), params, size), plain);
  }
  assert.equal(F.cipherSize(0), 16);
  assert.equal(F.RECORD_SIZE, 262144);
});

test('files use the documented nonce and AAD per record (checked with node:crypto)', async () => {
  const params = F.newFileKey(1000);
  const plain = pattern(2500, 9);
  const cipher = await encryptAll(plain, params);
  const nodeCrypto = require('node:crypto');
  const key = Buffer.from(E.fromB64u(params.key));
  const prefix = Buffer.from(E.fromB64u(params.noncePrefix));
  const out = [];
  for (let i = 0; i < 3; i++) {
    const rec = cipher.subarray(i * 1016, Math.min(cipher.length, (i + 1) * 1016));
    const iv = Buffer.concat([prefix, Buffer.from([0, 0, 0, i])]);
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.concat([Buffer.from('tealtalk-file-v1'), Buffer.from([0, 0, 0, i, i === 2 ? 1 : 0])]));
    d.setAuthTag(Buffer.from(rec.subarray(rec.length - 16)));
    out.push(d.update(Buffer.from(rec.subarray(0, rec.length - 16))), d.final());
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(out)), plain);
});

test('files fail on record swap, truncation, extension or a flipped bit', async () => {
  const rs = 1024;
  const params = F.newFileKey(rs);
  const size = 4 * rs + 100;
  const plain = pattern(size, 5);
  const cipher = await encryptAll(plain, params);
  const R = rs + 16;
  const rec = (i) => cipher.subarray(i * R, Math.min(cipher.length, (i + 1) * R));
  const bad = {
    swap: E.concat(rec(1), rec(0), rec(2), rec(3), rec(4)),
    'drop last record': cipher.subarray(0, 4 * R),
    'drop a middle record': E.concat(rec(0), rec(1), rec(3), rec(4)),
    'cut mid-record': cipher.subarray(0, cipher.length - 7),
    'extra bytes': E.concat(cipher, new Uint8Array(16)),
    'extra record': E.concat(cipher, rec(4)),
    'flipped bit': (() => {
      const c = cipher.slice();
      c[R + 5] ^= 1;
      return c;
    })(),
  };
  for (const [name, c] of Object.entries(bad)) {
    await assert.rejects(decryptAll(c, params, size), F.FileDecryptError, name);
  }
  // Truncation at a record boundary while lying about the size: the new last record
  // was encrypted as "not last", so it fails.
  await assert.rejects(decryptAll(cipher.subarray(0, 4 * R), params, 4 * rs), F.FileDecryptError);
  // A different key or nonce prefix fails.
  await assert.rejects(decryptAll(cipher, { ...params, key: F.newFileKey(rs).key }, size), F.FileDecryptError);
  await assert.rejects(decryptAll(cipher, { ...params, noncePrefix: F.newFileKey(rs).noncePrefix }, size), F.FileDecryptError);
  // Streaming: the decryptor notices a stream that stops early.
  const dec = new F.RecordDecryptor(params, size);
  await dec.push(cipher.subarray(0, 3 * R));
  assert.throws(() => dec.finish(), F.FileDecryptError);
});

test('resumed uploads re-encrypt byte-identically from any offset', async () => {
  const params = F.newFileKey(); // real 256 KiB records
  const size = 3 * F.RECORD_SIZE + 12345;
  const file = new Blob([pattern(size, 11)]);
  const enc = await F.createEncryptor(file, params);
  assert.equal(enc.size, size + 16 * 4);
  const full = await enc.read(0, enc.size);
  // Upload in 100 000-byte chunks (not aligned with records), "dropping" the
  // connection and resuming from arbitrary server offsets.
  const offsets = [0, 1, 262159, 262160, 262161, 500000, enc.size - 1];
  for (const start of offsets) {
    const fresh = await F.createEncryptor(file, params); // a new attempt after reload of the upload loop
    const parts = [];
    for (let at = start; at < fresh.size; at += 100000) parts.push(await fresh.read(at, Math.min(fresh.size, at + 100000)));
    assert.deepEqual(E.concat(...parts), full.subarray(start), `resume at ${start}`);
  }
  // Streamed decryption with odd chunk sizes
  const dec = new F.RecordDecryptor(params, size);
  const out = [];
  for (let at = 0; at < full.length; at += 77777) out.push(...(await dec.push(full.subarray(at, at + 77777))));
  dec.finish();
  assert.deepEqual(E.concat(...out), new Uint8Array(await file.arrayBuffer()));
});

// ---------------------------------------------------------------------------
// safety numbers

test('safety numbers: known answer for fixed key bytes', async () => {
  const sig = new Uint8Array(91).fill(0x11);
  const enc = new Uint8Array(91).fill(0x22);
  const digits = await S.fingerprintDigits('u_alice', sig, enc);
  assert.match(digits, /^\d{30}$/);
  assert.equal(digits, KAT_FINGERPRINT);
});

test('safety numbers are identical from both sides and change when a key changes', async () => {
  const a = await account('u_alice');
  const b = await account('u_bob');
  const ab = await S.safetyNumber({ userId: 'u_alice', bundle: a.bundle }, { userId: 'u_bob', bundle: b.bundle });
  const ba = await S.safetyNumber({ userId: 'u_bob', bundle: b.bundle }, { userId: 'u_alice', bundle: a.bundle });
  assert.equal(ab, ba);
  assert.match(ab, /^\d{60}$/);
  // The lower userId's digits come first.
  const sigA = E.fromB64u(a.bundle.sigPub);
  const encA = E.fromB64u(a.bundle.encPub);
  assert.equal(ab.slice(0, 30), await S.fingerprintDigits('u_alice', sigA, encA));
  const formatted = S.formatSafetyNumber(ab);
  assert.equal(formatted.split(' ').length, 12);
  assert.ok(formatted.split(' ').every((g) => /^\d{5}$/.test(g)));

  const bNew = await K.createAccountKeys('u_bob');
  const changed = await S.safetyNumber({ userId: 'u_alice', bundle: a.bundle }, { userId: 'u_bob', bundle: bNew.bundle });
  assert.notEqual(changed, ab);
  assert.equal(changed.slice(0, 30), ab.slice(0, 30)); // Alice's half is unchanged
});

// ---------------------------------------------------------------------------
// the service worker's copy of the receive path (push previews)

function loadServiceWorker() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const listeners = {};
  const sandbox = {
    self: { addEventListener: (type, fn) => (listeners[type] = fn), location: { origin: 'http://localhost' } },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    JSON,
    Promise,
    setTimeout,
    Response,
    caches: {
      open: async () => ({
        match: async (urlPath) => {
          const file = path.join(PUBLIC_DIR, ...urlPath.slice(1).split('/'));
          return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : undefined;
        },
        put: async () => {},
      }),
    },
    fetch: async () => new Response('', { status: 404 }),
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'sw.js' });
  return { sandbox, listeners };
}

test('service worker push preview: decrypts a real envelope, refuses tampered ones', async () => {
  const { sandbox } = loadServiceWorker();
  const preview = sandbox.self.__tealtalkPreview;
  assert.equal(typeof preview, 'function', 'sw.js exposes its preview function for tests');
  const bob = await account('u_bob');
  const alice = await account('u_alice');
  const store = {
    account: { ...bob.account },
    contacts: { u_alice: { userId: 'u_alice', keyId: alice.bundle.keyId, bundle: alice.bundle } },
  };
  const env = await sealFromAlice({ payload: { kind: 'message', body: 'see you at 6', attachments: [], replyTo: null } });
  const data = { conversationId: CTX.conversationId, senderId: CTX.senderId, clientId: CTX.clientId, e2ee: env };
  assert.equal(await preview(data, store), 'see you at 6');

  const photo = await sealFromAlice({
    payload: { kind: 'message', body: '', attachments: [{ id: 'a_1', kind: 'image', mime: 'image/jpeg' }], replyTo: null },
  });
  assert.equal(await preview({ ...data, e2ee: photo }, store), 'Photo');

  for (const bad of [
    { ...data, e2ee: { ...env, ct: flipB64u(env.ct) } },
    { ...data, clientId: 'other' },
    { ...data, conversationId: 'c_other' },
    { ...data, senderId: 'u_bob' },
    { ...data, e2ee: null },
  ]) {
    assert.equal(await preview(bad, store), null);
  }
  // Unknown sender key (not pinned on this device): no preview.
  assert.equal(await preview(data, { ...store, contacts: {} }), null);
  // Not for this device's key.
  const bobNew = await K.createAccountKeys('u_bob');
  assert.equal(await preview(data, { ...store, account: { ...bobNew.account } }), null);
});

test('the service worker lists every file under public/ and fingerprints them like scripts/fingerprint.js', async () => {
  const { sandbox, listeners } = loadServiceWorker();
  const listed = vm.runInContext('FILES', sandbox);
  const onDisk = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (e.isFile()) onDisk.push(`${rel}/${e.name}`);
    }
  })(PUBLIC_DIR, '');
  assert.deepEqual([...listed].sort(), onDisk.sort(), 'sw.js FILES must list exactly the files under public/');

  // The fingerprint the phone shows in Settings, from (here: fake) cached copies of the files.
  assert.equal(typeof listeners.message, 'function');
  const reply = await new Promise((resolve) => {
    const waits = [];
    listeners.message({ data: { type: 'fingerprint' }, ports: [{ postMessage: resolve }], waitUntil: (p) => waits.push(p) });
  });
  const script = path.join(__dirname, '..', 'scripts', 'fingerprint.js');
  if (fs.existsSync(script)) {
    assert.equal(reply.fingerprint, require(script).fingerprint(PUBLIC_DIR).fingerprint);
  } else {
    assert.match(reply.fingerprint, /^[0-9a-f]{64}$/);
  }
});

// Pinned once from the implementation and cross-checked independently.
const KAT_FINGERPRINT = '788285410179941507917204305431'; // cross-checked with Python's hashlib
