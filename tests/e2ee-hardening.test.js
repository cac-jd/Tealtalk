'use strict';

// Server-side fixes from the security review (docs/E2EE.md "Server API changes"):
//   C2  an old keyId can't become current again (rollback), createdAt must move forward
//   P5  at most 5 key changes per user per 24 hours
//   P8  clientIds are 1-64 of [A-Za-z0-9_-] (they go into the '|'-joined AAD)
//   P9  bundle keys (and envelope eph) are uncompressed P-256 spki, exactly 91 bytes
//   P10 MAX_UPLOAD_MB applies to the real file: encrypted uploads may add their GCM tags

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, request, register, dm, fakeClock, makeEnvelope, send } = require('./helpers');
const { makeKeys, sign, b64u, sha256 } = require('./e2ee-helpers');

const DAY = 24 * 60 * 60 * 1000;
const E2EE_MIME = 'application/vnd.tealtalk.e2ee';

describe('e2ee hardening', () => {
  let app;
  let clock;
  const put = (who, k) => request(app, 'PUT', '/api/keys', { token: who.token, body: { bundle: k.bundle, backup: k.backup } });

  before(async () => {
    clock = fakeClock(Date.UTC(2026, 8, 1));
    app = await startApp({ now: clock });
  });
  after(() => app.close());

  test('C2: re-publishing an old keyId (even freshly re-signed) is a 409 key_rollback', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const uid = alice.user.id;
    const old = await makeKeys(uid, { createdAt: clock() });
    assert.equal((await put(alice, old)).status, 200);
    clock.advance(DAY / 2);
    const fresh = await makeKeys(uid, { createdAt: clock() });
    assert.equal((await put(alice, fresh)).status, 200);
    // Someone with the old phone's key and a session re-signs the old key with a new date.
    const createdAt = clock();
    const selfSig = b64u(await sign(old.sigPair.privateKey, `tealtalk-keys-v1|${uid}|${old.keyId}|${createdAt}`));
    const res = await request(app, 'PUT', '/api/keys', { token: alice.token, body: { bundle: { ...old.bundle, createdAt, selfSig }, backup: old.backup } });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'key_rollback' });
    // The exact old bundle too.
    assert.equal((await put(alice, old)).status, 409);
    const bob = await register(app);
    const keys = (await request(app, 'GET', `/api/keys?userIds=${uid}`, { token: bob.token })).body.keys;
    assert.equal(keys[uid].keyId, fresh.keyId, 'contacts still get the new key');
    assert.equal((await request(app, 'GET', '/api/keys/me', { token: alice.token })).body.bundle.keyId, fresh.keyId);
    // The current keyId again: a no-op 200.
    const again = await put(alice, fresh);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { bundle: fresh.bundle });
  });

  test('C2: a new key must be dated after the current one', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const uid = alice.user.id;
    const current = await makeKeys(uid, { createdAt: clock() });
    assert.equal((await put(alice, current)).status, 200);
    const sameTime = await makeKeys(uid, { createdAt: clock() });
    assert.deepEqual((await put(alice, sameTime)).body, { error: 'key_rollback' });
    const earlier = await makeKeys(uid, { createdAt: clock() - 1000 });
    assert.equal((await put(alice, earlier)).status, 409);
    const later = await makeKeys(uid, { createdAt: clock() + 1 });
    assert.equal((await put(alice, later)).status, 200);
  });

  test('P5: at most 5 key changes per user per 24 hours', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const bob = await register(app, undefined, {}, { keys: false });
    let last;
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      last = await makeKeys(alice.user.id, { createdAt: clock() });
      assert.equal((await put(alice, last)).status, 200, `change ${i + 1}`);
    }
    clock.advance(1000);
    const sixth = await makeKeys(alice.user.id, { createdAt: clock() });
    const res = await put(alice, sixth);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    // Re-sending the current key isn't a change; other users aren't affected.
    assert.equal((await put(alice, last)).status, 200);
    assert.equal((await put(bob, await makeKeys(bob.user.id, { createdAt: clock() }))).status, 200);
    // A day later it works again.
    clock.advance(DAY);
    const later = await makeKeys(alice.user.id, { createdAt: clock() });
    assert.equal((await put(alice, later)).status, 200);
  });

  test('P8: clientIds with "|" or other characters are refused for messages, edits and reactions', async () => {
    const alice = await register(app);
    const bob = await register(app);
    const c = await dm(app, alice, bob);
    const m = await send(app, alice, c.id, 'hi');
    const base = `/api/conversations/${c.id}/messages`;
    for (const clientId of ['a|b', 'a b', 'x'.repeat(65), 'é', '', 42]) {
      const msg = await request(app, 'POST', base, { token: alice.token, body: { clientId, e2ee: await makeEnvelope(app, alice, c.id) } });
      assert.equal(msg.status, 400, `message ${clientId}`);
      const edit = await request(app, 'PATCH', `${base}/${m.id}`, {
        token: alice.token,
        body: { clientId, e2ee: await makeEnvelope(app, alice, c.id, { kind: `edit:${m.id}`, payload: { body: 'x' } }) },
      });
      assert.equal(edit.status, 400, `edit ${clientId}`);
      const react = await request(app, 'PUT', `${base}/${m.id}/reaction`, {
        token: bob.token,
        body: { clientId, e2ee: await makeEnvelope(app, bob, c.id, { kind: `reaction:${m.id}`, payload: { emoji: 'x' } }) },
      });
      assert.equal(react.status, 400, `reaction ${clientId}`);
    }
    const ok = await request(app, 'POST', base, { token: alice.token, body: { clientId: `A-z_9${'x'.repeat(59)}`, e2ee: await makeEnvelope(app, alice, c.id) } });
    assert.equal(ok.status, 201);
  });

  test('P9: bundle keys must be uncompressed P-256 spki (91 bytes)', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const good = await makeKeys(alice.user.id, { createdAt: clock() });
    const enc = Buffer.from(good.bundle.encPub, 'base64url');
    const sig = Buffer.from(good.bundle.sigPub, 'base64url');
    assert.equal(enc.length, 91);
    // The same P-256 point, compressed: a valid key, but not the documented encoding.
    const compress = (spki) => {
      const x = spki.subarray(27, 59);
      const yOdd = spki[90] & 1;
      const head = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
      return Buffer.concat([head, Buffer.from([yOdd ? 3 : 2]), x]);
    };
    const encC = compress(enc);
    assert.equal(crypto.createPublicKey({ key: encC, format: 'der', type: 'spki' }).asymmetricKeyDetails.namedCurve, 'prime256v1');
    const bundleWith = async (encPub, sigPub) => {
      const createdAt = clock();
      const keyId = b64u(await sha256([0x01], sigPub, encPub));
      const selfSig = b64u(await sign(good.sigPair.privateKey, `tealtalk-keys-v1|${alice.user.id}|${keyId}|${createdAt}`));
      return { v: 1, encPub: b64u(encPub), sigPub: b64u(sigPub), keyId, createdAt, selfSig };
    };
    for (const [label, bundle] of [
      ['compressed encPub', await bundleWith(encC, sig)],
      ['compressed sigPub', await bundleWith(enc, compress(sig))],
      ['padded encPub', await bundleWith(Buffer.concat([enc, Buffer.alloc(1)]), sig)],
    ]) {
      const res = await request(app, 'PUT', '/api/keys', { token: alice.token, body: { bundle, backup: { ...good.backup, keyId: bundle.keyId } } });
      assert.equal(res.status, 400, label);
    }
    assert.equal((await put(alice, good)).status, 200);
    // Envelopes: a compressed eph is refused too.
    const bob = await register(app);
    const c = await dm(app, alice, bob);
    const e2ee = await makeEnvelope(app, alice, c.id);
    const res = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: alice.token,
      body: { clientId: crypto.randomUUID(), e2ee: { ...e2ee, eph: b64u(compress(Buffer.from(e2ee.eph, 'base64url'))) } },
    });
    assert.equal(res.status, 400);
  });
});

describe('P10: upload limits count the real file', () => {
  let app;
  const MAX = 1024 * 1024; // MAX_UPLOAD_MB = 1
  const TAGS = 16 * Math.ceil(MAX / (256 * 1024));
  before(async () => {
    app = await startApp({ maxUploadMb: 1 });
  });
  after(() => app.close());

  test('an encrypted file of MAX_UPLOAD_MB plaintext fits; one byte more does not', async () => {
    const alice = await register(app);
    const start = (mime, size) => request(app, 'POST', '/api/uploads', { token: alice.token, body: { mime, size } });
    assert.equal((await start(E2EE_MIME, MAX + TAGS)).status, 201);
    assert.equal((await start(E2EE_MIME, MAX + TAGS + 1)).status, 413);
    assert.equal((await start('video/mp4', MAX)).status, 201);
    assert.equal((await start('video/mp4', MAX + 1)).status, 413);
    // Single-request uploads too (here MAX is below the 10 MB single-request limit).
    const small = (bytes) => request(app, 'POST', '/api/attachments', { token: alice.token, raw: bytes, headers: { 'Content-Type': E2EE_MIME } });
    assert.equal((await small(crypto.randomBytes(MAX + TAGS))).status, 201);
    assert.equal((await small(crypto.randomBytes(MAX + TAGS + 1))).status, 413);
  });
});
