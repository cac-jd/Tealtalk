'use strict';

// Key directory (docs/E2EE.md, "Server API changes"): PUT /api/keys validation, GET /api/keys/me,
// GET /api/keys?userIds=, GET /api/keys/:userId?keyId=, kept key history and the `keys` WS event.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, request, register, putKeys, dm, WsClient, fakeClock } = require('./helpers');
const { makeKeys, sign, b64u, sha256, randomB64u, nonCanonical } = require('./e2ee-helpers');
const { computeKeyId } = require('../server/e2ee');

const DAY = 24 * 60 * 60 * 1000;

describe('key directory', () => {
  let app;
  let clock;
  let logged = [];
  const capture = (...args) => logged.push(args.map(String).join(' '));
  const put = (who, body) => request(app, 'PUT', '/api/keys', { token: who.token, body });

  before(async () => {
    clock = fakeClock(Date.UTC(2026, 8, 1));
    app = await startApp({ now: clock, log: { log: capture, info: capture, warn: capture, error: capture } });
  });
  after(() => app.close());

  test('a valid bundle is stored; GET /api/keys/me returns it with the backup', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    assert.deepEqual((await request(app, 'GET', '/api/keys/me', { token: alice.token })).body, { bundle: null, backup: null });
    const k = await makeKeys(alice.user.id, { createdAt: clock() });
    const res = await put(alice, { bundle: k.bundle, backup: k.backup });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { bundle: k.bundle });
    assert.equal(k.bundle.keyId.length, 43);
    // The server's keyId formula matches WebCrypto's.
    assert.equal(computeKeyId(Buffer.from(k.bundle.sigPub, 'base64url'), Buffer.from(k.bundle.encPub, 'base64url')), k.keyId);
    const me = await request(app, 'GET', '/api/keys/me', { token: alice.token });
    assert.deepEqual(me.body, { bundle: k.bundle, backup: k.backup });
    assert.equal((await request(app, 'GET', '/api/keys/me')).status, 401);
    assert.equal((await request(app, 'PUT', '/api/keys', { body: { bundle: k.bundle, backup: k.backup } })).status, 401);
    assert.equal((await request(app, 'POST', '/api/keys', { token: alice.token, body: {} })).status, 405);
    assert.equal((await request(app, 'PUT', '/api/keys/me', { token: alice.token, body: {} })).status, 405);
  });

  test('bundle validation: curve, keyId, selfSig, user, createdAt, shape', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const bob = await register(app, undefined, {}, { keys: false });
    const good = await makeKeys(alice.user.id, { createdAt: clock() });
    const expect400 = async (bundle, backup = { ...good.backup, keyId: bundle && bundle.keyId }, label) => {
      const res = await put(alice, { bundle, backup });
      assert.equal(res.status, 400, `${label}: ${res.text}`);
      assert.equal(typeof res.body.error, 'string');
      assert.ok(!/at .*\.js/.test(res.text), label);
    };

    /** A bundle for alice with these spki keys, a correct keyId and a correct selfSig by `signer`. */
    const bundleWith = async (encPub, sigPub, signer = good.sigPair.privateKey, createdAt = clock(), userId = alice.user.id) => {
      const keyId = b64u(await sha256([0x01], sigPub, encPub));
      const selfSig = b64u(await sign(signer, `tealtalk-keys-v1|${userId}|${keyId}|${createdAt}`));
      return { v: 1, encPub: b64u(encPub), sigPub: b64u(sigPub), keyId, createdAt, selfSig };
    };
    const enc = Buffer.from(good.bundle.encPub, 'base64url');
    const sig = Buffer.from(good.bundle.sigPub, 'base64url');

    // Sanity: bundleWith() produces an accepted bundle from the good keys.
    const rebuilt = await bundleWith(enc, sig);
    assert.equal((await put(alice, { bundle: rebuilt, backup: good.backup })).status, 200);

    // Wrong curve: P-384 for either key (keyId and selfSig are otherwise correct).
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const p384Spki = p384.publicKey.export({ type: 'spki', format: 'der' });
    await expect400(await bundleWith(p384Spki, sig), undefined, 'P-384 encPub');
    const p384SigPriv = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      p384.privateKey.export({ type: 'pkcs8', format: 'der' }),
      { name: 'ECDSA', namedCurve: 'P-384' },
      false,
      ['sign']
    );
    await expect400(await bundleWith(enc, p384Spki, p384SigPriv), undefined, 'P-384 sigPub');
    // Other key types and garbage.
    const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' });
    await expect400(await bundleWith(ed, sig), undefined, 'ed25519 encPub');
    await expect400(await bundleWith(rsa, sig), undefined, 'rsa encPub');
    await expect400(await bundleWith(Buffer.from('not a key'), sig), undefined, 'junk encPub');
    await expect400(await bundleWith(enc.subarray(0, 60), sig), undefined, 'truncated encPub');

    // keyId must recompute (each of these is otherwise correctly self-signed over the bad keyId).
    const signedWithKeyId = async (keyId) => {
      const createdAt = clock();
      const selfSig = b64u(await sign(good.sigPair.privateKey, `tealtalk-keys-v1|${alice.user.id}|${keyId}|${createdAt}`));
      return { ...good.bundle, keyId, createdAt, selfSig };
    };
    await expect400(await signedWithKeyId(randomB64u(32)), undefined, 'random keyId');
    const swapped = b64u(await sha256([0x01], enc, sig)); // encPub and sigPub in the wrong order
    await expect400(await signedWithKeyId(swapped), undefined, 'keyId with keys swapped');
    await expect400(await signedWithKeyId(b64u(await sha256(sig, enc))), undefined, 'keyId without the 0x01 prefix');
    await expect400(await signedWithKeyId(good.keyId.slice(0, 42)), undefined, 'short keyId');

    // selfSig must verify for this user, over exactly the documented string.
    const flipped = Buffer.from(good.bundle.selfSig, 'base64url');
    flipped[10] ^= 1;
    await expect400({ ...good.bundle, selfSig: b64u(flipped) }, good.backup, 'flipped selfSig');
    await expect400({ ...good.bundle, selfSig: randomB64u(64) }, good.backup, 'random selfSig');
    const otherSigner = await makeKeys(alice.user.id, { createdAt: clock() });
    await expect400(await bundleWith(enc, sig, otherSigner.sigPair.privateKey), undefined, 'signed by another key');
    const bobsBundle = await makeKeys(bob.user.id, { createdAt: clock() });
    await expect400(bobsBundle.bundle, bobsBundle.backup, "another user's bundle");
    const forBob = await makeKeys(alice.user.id, { createdAt: clock(), signAs: bob.user.id });
    await expect400(forBob.bundle, forBob.backup, 'selfSig names another user');
    const der = crypto.sign('sha256', Buffer.from(`tealtalk-keys-v1|${alice.user.id}|${good.keyId}|${good.bundle.createdAt}`), {
      key: crypto.createPrivateKey({ key: Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', good.sigPair.privateKey)), format: 'der', type: 'pkcs8' }),
    });
    await expect400({ ...good.bundle, selfSig: b64u(der) }, good.backup, 'DER (not raw r||s) selfSig');
    const otherTime = await bundleWith(enc, sig, good.sigPair.privateKey, clock());
    await expect400({ ...otherTime, createdAt: clock() + 1 }, undefined, 'createdAt not the signed one');

    // createdAt within a day of the server's clock (both directions, inclusive), and newer than the
    // current key. An account with no key yet may publish an older key (a device re-publishing its
    // key after the server lost it), but never one dated more than a day ahead.
    const carol = await register(app, undefined, {}, { keys: false });
    for (const [offset, status] of [
      [DAY + 1, 400],
      [-30 * DAY, 200], // no current key yet
      [-DAY - 1, 400],
      [-DAY, 200],
      [DAY + 1, 400],
      [DAY, 200],
      [0, 409], // older than the current key: a rollback
    ]) {
      const k = await makeKeys(carol.user.id, { createdAt: clock() + offset });
      const res = await put(carol, { bundle: k.bundle, backup: k.backup });
      assert.equal(res.status, status, `createdAt offset ${offset}: ${res.text}`);
      if (status === 409) assert.equal(res.body.error, 'key_rollback');
    }
    await expect400({ ...good.bundle, createdAt: String(good.bundle.createdAt) }, good.backup, 'createdAt as string');

    // Shape.
    await expect400(null, good.backup, 'null bundle');
    await expect400([good.bundle], good.backup, 'array bundle');
    await expect400({ ...good.bundle, v: 2 }, good.backup, 'v 2');
    await expect400({ ...good.bundle, extra: 1 }, good.backup, 'extra field');
    for (const field of ['v', 'encPub', 'sigPub', 'keyId', 'createdAt', 'selfSig']) {
      const b = { ...good.bundle };
      delete b[field];
      await expect400(b, good.backup, `missing ${field}`);
    }
    await expect400({ ...good.bundle, encPub: `${good.bundle.encPub}==` }, good.backup, 'padded b64u');
    await expect400({ ...good.bundle, encPub: Buffer.from(good.bundle.encPub, 'base64url').toString('base64') }, good.backup, 'standard base64');
    // The same signature bytes in a non-canonical encoding are refused too.
    await expect400({ ...good.bundle, selfSig: nonCanonical(good.bundle.selfSig) }, good.backup, 'non-canonical selfSig');
    // Nothing was stored by any of the rejected attempts beyond the accepted ones.
    const me = (await request(app, 'GET', '/api/keys/me', { token: alice.token })).body.bundle;
    assert.ok(me && me.keyId !== bobsBundle.keyId && me.keyId !== forBob.keyId);
  });

  test('backup validation: shape, keyId, size <= 4 KB', async () => {
    const alice = await register(app, undefined, {}, { keys: false });
    const k = await makeKeys(alice.user.id, { createdAt: clock() });
    const bad = [
      undefined,
      null,
      'x',
      { ...k.backup, keyId: randomB64u(32) },
      { ...k.backup, v: 2 },
      { ...k.backup, iv: randomB64u(11) },
      { ...k.backup, iv: randomB64u(13) },
      { ...k.backup, ct: '' },
      { ...k.backup, ct: 'not base64url!' },
      { ...k.backup, extra: true },
      { v: 1, keyId: k.keyId, iv: k.backup.iv },
    ];
    for (const backup of bad) {
      const res = await put(alice, { bundle: k.bundle, backup });
      assert.equal(res.status, 400, JSON.stringify(backup));
    }
    // 4096 bytes of backup JSON is the limit.
    const overhead = JSON.stringify({ v: 1, keyId: k.keyId, iv: k.backup.iv, ct: '' }).length;
    let ctChars = 4096 - overhead;
    while (ctChars % 4 === 1) ctChars--; // a valid unpadded base64url length
    const fits = { ...k.backup, ct: randomB64u(Math.floor((ctChars * 3) / 4)) };
    assert.ok(JSON.stringify(fits).length <= 4096 && JSON.stringify(fits).length > 4090);
    assert.equal((await put(alice, { bundle: k.bundle, backup: fits })).status, 200);
    const tooBig = { ...k.backup, ct: randomB64u(3100) };
    assert.ok(JSON.stringify(tooBig).length > 4096);
    assert.equal((await put(alice, { bundle: k.bundle, backup: tooBig })).status, 400);
    assert.deepEqual((await request(app, 'GET', '/api/keys/me', { token: alice.token })).body.backup, fits);
  });

  test('old bundles are kept: GET /api/keys/:userId?keyId= finds any key the user ever had', async () => {
    const alice = await register(app);
    const bob = await register(app);
    const first = alice.keys;
    clock.advance(1000);
    const second = await putKeys(app, alice);
    assert.notEqual(first.keyId, second.keyId);
    const get = (path, who = bob) => request(app, 'GET', path, { token: who.token });

    assert.deepEqual((await get(`/api/keys/${alice.user.id}?keyId=${first.keyId}`)).body, { bundle: first.bundle });
    assert.deepEqual((await get(`/api/keys/${alice.user.id}?keyId=${second.keyId}`)).body, { bundle: second.bundle });
    assert.deepEqual((await get(`/api/keys/${alice.user.id}`)).body, { bundle: second.bundle });
    assert.deepEqual((await get(`/api/keys?userIds=${alice.user.id}`)).body, { keys: { [alice.user.id]: second.bundle } });
    assert.deepEqual((await get('/api/keys/me', alice)).body, { bundle: second.bundle, backup: second.backup });

    // Someone else's keyId is not found under my id; unknown ids are 404, malformed ones 400.
    assert.equal((await get(`/api/keys/${bob.user.id}?keyId=${first.keyId}`)).status, 404);
    assert.equal((await get(`/api/keys/${alice.user.id}?keyId=${randomB64u(32)}`)).status, 404);
    assert.equal((await get(`/api/keys/u_nobody?keyId=${first.keyId}`)).status, 404);
    assert.equal((await get(`/api/keys/u_nobody`)).status, 404);
    assert.equal((await get(`/api/keys/${alice.user.id}?keyId=short`)).status, 400);
    assert.equal((await get(`/api/keys/${encodeURIComponent('../etc')}`)).status, 404);
    assert.equal((await request(app, 'GET', `/api/keys/${alice.user.id}`)).status, 401);
    const noKeys = await register(app, undefined, {}, { keys: false });
    assert.equal((await get(`/api/keys/${noKeys.user.id}`)).status, 404);

    // Going back to an earlier key is refused (rollback protection); the current key stays.
    const back = await request(app, 'PUT', '/api/keys', { token: alice.token, body: { bundle: first.bundle, backup: first.backup } });
    assert.equal(back.status, 409);
    assert.deepEqual(back.body, { error: 'key_rollback' });
    assert.deepEqual((await get(`/api/keys/${alice.user.id}`)).body, { bundle: second.bundle });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM key_bundles WHERE user_id = ?').get(alice.user.id).n, 2);
  });

  test('GET /api/keys?userIds=: current bundles, null for unknown or keyless, at most 100', async () => {
    const alice = await register(app);
    const bob = await register(app);
    const stranger = await register(app); // shares no conversation with alice, but can be searched
    const keyless = await register(app, undefined, {}, { keys: false });
    await dm(app, alice, bob);
    const get = (qs, who = alice) => request(app, 'GET', `/api/keys${qs}`, { token: who.token });

    const res = await get(`?userIds=${[alice, bob, stranger, keyless].map((u) => u.user.id).join(',')},u_nobody,${bob.user.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      keys: {
        [alice.user.id]: alice.keys.bundle,
        [bob.user.id]: bob.keys.bundle,
        [stranger.user.id]: stranger.keys.bundle,
        [keyless.user.id]: null,
        u_nobody: null,
      },
    });
    // Whitespace and empty items are ignored; __proto__ is just an unknown id.
    assert.deepEqual((await get(`?userIds=${encodeURIComponent(` ${bob.user.id} ,,__proto__`)}`)).body, {
      keys: JSON.parse(`{"${bob.user.id}": ${JSON.stringify(bob.keys.bundle)}, "__proto__": null}`),
    });
    assert.deepEqual((await get('?userIds=')).body, { keys: {} });
    const hundred = Array.from({ length: 100 }, (_, i) => `u_x${i}`);
    assert.equal((await get(`?userIds=${hundred.join(',')}`)).status, 200);
    assert.equal((await get(`?userIds=${[...hundred, 'u_x100'].join(',')}`)).status, 400);
    assert.equal((await get(`?userIds=${[...hundred, 'u_x0'].join(',')}`)).status, 200); // duplicates count once
    assert.equal((await get('')).status, 400);
    assert.equal((await get(`?userIds=${encodeURIComponent('u_a,../b')}`)).status, 400);
    assert.equal((await request(app, 'GET', `/api/keys?userIds=${bob.user.id}`)).status, 401);
  });

  test('keys WS event: to everyone sharing a conversation and my own sockets, not strangers', async () => {
    const alice = await register(app);
    const bob = await register(app);
    const carol = await register(app);
    const stranger = await register(app);
    await dm(app, alice, bob);
    await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id, carol.user.id], title: 'G' } });
    const sockets = {
      a1: await WsClient.connect(app, alice.token),
      a2: await WsClient.connect(app, alice.token),
      b: await WsClient.connect(app, bob.token),
      c: await WsClient.connect(app, carol.token),
      s: await WsClient.connect(app, stranger.token),
    };
    try {
      clock.advance(1);
      const k = await putKeys(app, alice);
      for (const name of ['a1', 'a2', 'b', 'c']) {
        const ev = await sockets[name].next('keys');
        assert.deepEqual(ev, { type: 'keys', userId: alice.user.id, bundle: k.bundle }, name);
      }
      assert.ok(await sockets.s.none('keys'));
      // Publishing the same bundle again changes nothing and announces nothing.
      assert.equal((await request(app, 'PUT', '/api/keys', { token: alice.token, body: { bundle: k.bundle, backup: k.backup } })).status, 200);
      assert.ok(await sockets.b.none('keys'));
      // A rejected bundle announces nothing either.
      const bad = await makeKeys(bob.user.id, { createdAt: clock() });
      assert.equal((await request(app, 'PUT', '/api/keys', { token: alice.token, body: { bundle: bad.bundle, backup: bad.backup } })).status, 400);
      assert.ok(await sockets.a1.none('keys'));
    } finally {
      for (const ws of Object.values(sockets)) await ws.close();
    }
  });

  test('bundles, backups and envelopes never reach the log', async () => {
    const alice = await register(app);
    const bob = await register(app);
    const c = await dm(app, alice, bob);
    const { send } = require('./helpers');
    const m = await send(app, alice, c.id, 'secret words');
    const text = logged.join('\n');
    for (const needle of [alice.keys.backup.ct, alice.keys.bundle.selfSig, m.e2ee.ct, m.e2ee.sig]) {
      assert.ok(!text.includes(needle));
    }
  });
});
