'use strict';

// Envelope validation on the server (docs/E2EE.md, "Envelope validation on the server"): shape and
// size, kind vs route, senderKeyId, exact recipients, current keys, the exact 409 bodies,
// plaintext rejection and the attachmentIds rules, for messages, edits and reactions.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  startApp,
  request,
  register,
  putKeys,
  dm,
  send,
  postEncrypted,
  makeEnvelope,
  uploadEncrypted,
  uploadOk,
  WsClient,
  E2EE_MIME,
  RELOAD,
} = require('./helpers');
const { envelope, randomB64u, nonCanonical } = require('./e2ee-helpers');

describe('encrypted messages: envelope validation', () => {
  let app;
  let alice;
  let bob;
  let carol;
  let conv;
  const post = (who, body, c = conv.id) => request(app, 'POST', `/api/conversations/${c}/messages`, { token: who.token, body });
  /** A valid message envelope from alice to alice and bob, with overrides. */
  const env = (over = {}) => ({
    ...envelope({
      senderKeyId: alice.keys.keyId,
      recipients: { [alice.user.id]: alice.keys.keyId, [bob.user.id]: bob.keys.keyId },
    }),
    ...over,
  });
  const expect400 = async (e2ee, label, extra = {}) => {
    const res = await post(alice, { clientId: crypto.randomUUID(), e2ee, ...extra });
    assert.equal(res.status, 400, `${label}: ${res.status} ${res.text}`);
    assert.ok(!/at .*\.js/.test(res.text));
    return res;
  };

  before(async () => {
    app = await startApp();
    alice = await register(app);
    bob = await register(app);
    carol = await register(app);
    conv = await dm(app, alice, bob);
  });
  after(() => app.close());

  test('a valid envelope is stored and delivered exactly as sent', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const e2ee = env();
      const clientId = crypto.randomUUID();
      const res = await post(alice, { clientId, e2ee });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.body.message.e2ee, e2ee);
      assert.equal(res.body.message.body, '');
      const ev = await ws.next('message', (f) => f.message.id === res.body.message.id);
      assert.deepEqual(ev.message.e2ee, e2ee);
      const stored = app.store.db.prepare('SELECT body, e2ee, e2ee_client_id FROM messages WHERE id = ?').get(res.body.message.id);
      assert.deepEqual(JSON.parse(stored.e2ee), e2ee);
      assert.equal(stored.body, '');
      assert.equal(stored.e2ee_client_id, clientId);
      // A clientId inside the envelope is tolerated when it matches the request's.
      const withId = crypto.randomUUID();
      assert.equal((await post(alice, { clientId: withId, e2ee: env({ clientId: withId }) })).status, 201);
      await expect400(env({ clientId: 'other' }), 'clientId inside differs');
    } finally {
      await ws.close();
    }
  });

  test('plaintext from an old app is refused with the reload message', async () => {
    const e2ee = env();
    for (const body of [
      { clientId: 'p1', body: 'hello' },
      { clientId: 'p2', body: 'hello', e2ee },
      { clientId: 'p3', attachmentId: 'a_x' },
      { clientId: 'p4', attachmentId: 'a_x', e2ee },
      { clientId: 'p5' },
      { clientId: 'p6', e2ee: null },
      {},
    ]) {
      const res = await post(alice, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.deepEqual(res.body, { error: RELOAD });
    }
    // An empty body next to an envelope is fine (encrypted messages have body "").
    assert.equal((await post(alice, { clientId: crypto.randomUUID(), body: '', e2ee })).status, 201);
    // Nothing plaintext was stored.
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body <> '' OR e2ee IS NULL").get().n, 0);
  });

  test('shape: every field present, nothing extra, sane base64url lengths, kind matches', async () => {
    for (const field of ['v', 'kind', 'senderKeyId', 'eph', 'iv', 'ct', 'keys', 'sig']) {
      const e = env();
      delete e[field];
      await expect400(e, `missing ${field}`);
      await expect400({ ...env(), [field]: null }, `null ${field}`);
    }
    await expect400({ ...env(), extra: 'x' }, 'extra field');
    await expect400('envelope', 'string');
    await expect400([env()], 'array');
    await expect400(env({ v: 2 }), 'v 2');
    await expect400(env({ v: '1' }), 'v "1"');
    for (const kind of ['edit:1', 'reaction:1', 'Message', 'message ', '']) await expect400(env({ kind }), `kind ${kind}`);
    await expect400(env({ senderKeyId: alice.keys.keyId.slice(1) }), 'senderKeyId 42 chars');
    await expect400(env({ senderKeyId: `${alice.keys.keyId}=` }), 'senderKeyId padded');
    await expect400(env({ iv: randomB64u(11) }), 'iv 11 bytes');
    await expect400(env({ iv: randomB64u(13) }), 'iv 13 bytes');
    await expect400(env({ iv: `${randomB64u(12)}==` }), 'iv padded');
    await expect400(env({ iv: Buffer.alloc(12, 0xff).toString('base64') }), 'iv standard base64');
    await expect400(env({ ct: randomB64u(15) }), 'ct shorter than a GCM tag');
    await expect400(env({ ct: 'a' }), 'ct impossible length');
    await expect400(env({ sig: randomB64u(63) }), 'sig 63 bytes');
    await expect400(env({ sig: randomB64u(70) }), 'sig DER-sized');
    const e = env();
    await expect400({ ...e, sig: nonCanonical(e.sig) }, 'sig non-canonical base64url');
    await expect400({ ...e, ct: nonCanonical(randomB64u(100)) }, 'ct non-canonical base64url');
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
    await expect400(env({ eph: p384.toString('base64url') }), 'eph P-384');
    await expect400(env({ eph: randomB64u(91) }), 'eph junk');
    // keys entries.
    const keys = (entries) => env({ keys: entries });
    const w = () => randomB64u(60);
    await expect400(keys({}), 'no recipients');
    await expect400(keys([]), 'keys array');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: { k: bob.keys.keyId } }), 'entry without w');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: { k: bob.keys.keyId, w: w(), x: 1 } }), 'entry extra');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: { k: 'short', w: w() } }), 'k short');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: { k: bob.keys.keyId, w: randomB64u(59) } }), 'w 59');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: { k: bob.keys.keyId, w: randomB64u(61) } }), 'w 61');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, [bob.user.id]: 'x' }), 'entry string');
    await expect400(keys({ [alice.user.id]: { k: alice.keys.keyId, w: w() }, 'bad id!': { k: bob.keys.keyId, w: w() } }), 'bad recipient id');
    const many = {};
    for (let i = 0; i < 258; i++) many[`u_${i}`] = { k: alice.keys.keyId, w: w() };
    await expect400(keys(many), 'more recipients than a group can have');
  });

  test('envelope JSON is limited to 64 KB', async () => {
    // Pad ct so the envelope JSON is exactly 65536 bytes; one more byte is refused.
    const sized = (target) => {
      for (let pad = 0; pad < 4; pad++) {
        const clientId = crypto.randomUUID().slice(0, 8 + pad);
        const e = env({ clientId, ct: '' });
        const room = target - Buffer.byteLength(JSON.stringify(e));
        if (room % 4 !== 1) {
          const ct = randomB64u(Math.floor((room * 3) / 4));
          if (ct.length === room) return { clientId, e2ee: { ...e, ct } };
        }
      }
      throw new Error('could not size the envelope');
    };
    const fits = sized(65536);
    assert.equal(Buffer.byteLength(JSON.stringify(fits.e2ee)), 65536);
    const ok = await post(alice, fits);
    assert.equal(ok.status, 201, ok.text);
    const over = sized(65537);
    assert.equal(Buffer.byteLength(JSON.stringify(over.e2ee)), 65537);
    const res = await post(alice, over);
    assert.equal(res.status, 413);
    // Bodies past the request limit are cut off before parsing.
    const huge = await post(alice, { clientId: 'h', e2ee: env({ ct: randomB64u(90 * 1024) }) });
    assert.equal(huge.status, 413);
  });

  test('senderKeyId must be my current key: 409 { error: "keys_changed" }', async () => {
    const dave = await register(app);
    const c = await dm(app, dave, bob);
    const old = dave.keys;
    await putKeys(app, dave);
    const e2ee = envelope({ senderKeyId: old.keyId, recipients: { [dave.user.id]: dave.keys.keyId, [bob.user.id]: bob.keys.keyId } });
    const res = await post(dave, { clientId: crypto.randomUUID(), e2ee }, c.id);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'keys_changed' });
    // It is checked before anything else (here: wrong recipients too).
    const both = envelope({ senderKeyId: old.keyId, recipients: { [dave.user.id]: dave.keys.keyId } });
    assert.deepEqual((await post(dave, { clientId: crypto.randomUUID(), e2ee: both }, c.id)).body, { error: 'keys_changed' });
    // A sender with no keys at all gets the same answer.
    const keyless = await register(app, undefined, {}, { keys: false });
    const c2 = await dm(app, keyless, bob);
    const fake = 'A'.repeat(43);
    const res2 = await post(keyless, { clientId: 'k', e2ee: envelope({ senderKeyId: fake, recipients: { [keyless.user.id]: fake, [bob.user.id]: bob.keys.keyId } }) }, c2.id);
    assert.equal(res2.status, 409);
    assert.deepEqual(res2.body, { error: 'keys_changed' });
  });

  test('recipients must be exactly the members: 409 { error: "members_changed", members }', async () => {
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id, carol.user.id], title: 'Three' } }))
      .body.conversation;
    const members = [alice.user.id, bob.user.id, carol.user.id];
    const k = { [alice.user.id]: alice.keys.keyId, [bob.user.id]: bob.keys.keyId, [carol.user.id]: carol.keys.keyId };
    const outsider = await register(app);
    const cases = {
      'missing a member': { [alice.user.id]: k[alice.user.id], [bob.user.id]: k[bob.user.id] },
      'missing myself': { [bob.user.id]: k[bob.user.id], [carol.user.id]: k[carol.user.id] },
      'an extra outsider': { ...k, [outsider.user.id]: outsider.keys.keyId },
      'an outsider instead of a member': { [alice.user.id]: k[alice.user.id], [bob.user.id]: k[bob.user.id], [outsider.user.id]: outsider.keys.keyId },
      'an unknown id': { ...k, u_nobody: alice.keys.keyId },
    };
    for (const [label, recipients] of Object.entries(cases)) {
      const res = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients }) }, g.id);
      assert.equal(res.status, 409, label);
      assert.deepEqual(res.body, { error: 'members_changed', members }, label);
    }
    assert.equal((await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: k }) }, g.id)).status, 201);
    // After someone joins, new messages must include them.
    const dave = await register(app);
    await request(app, 'POST', `/api/conversations/${g.id}/members`, { token: bob.token, body: { userIds: [dave.user.id] } });
    const stale = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: k }) }, g.id);
    assert.deepEqual(stale.body, { error: 'members_changed', members: [...members, dave.user.id] });
    // And after someone leaves, they must be left out.
    await request(app, 'DELETE', `/api/conversations/${g.id}/members/me`, { token: carol.token });
    const gone = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: { ...k, [dave.user.id]: dave.keys.keyId } }) }, g.id);
    assert.deepEqual(gone.body, { error: 'members_changed', members: [alice.user.id, bob.user.id, dave.user.id] });
    assert.equal((await send(app, alice, g.id, 'now right')).e2ee.kind, 'message');
  });

  test('members without keys: 409 { error: "missing_keys", missing }', async () => {
    const x = await register(app, undefined, {}, { keys: false });
    const y = await register(app, undefined, {}, { keys: false });
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [x.user.id, bob.user.id, y.user.id], title: 'Keys' } }))
      .body.conversation;
    const fake = 'B'.repeat(43);
    const recipients = { [alice.user.id]: alice.keys.keyId, [x.user.id]: fake, [bob.user.id]: bob.keys.keyId, [y.user.id]: fake };
    const res = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients }) }, g.id);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'missing_keys', missing: [x.user.id, y.user.id] });
    await putKeys(app, x);
    const res2 = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients }) }, g.id);
    assert.deepEqual(res2.body, { error: 'missing_keys', missing: [y.user.id] });
    await putKeys(app, y);
    assert.equal((await send(app, alice, g.id, 'everyone has keys')).id > 0, true);
  });

  test('each k must be that member\'s current key: 409 { error: "keys_changed", keys }', async () => {
    const p = await register(app);
    const q = await register(app);
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [p.user.id, q.user.id], title: 'Rotate' } }))
      .body.conversation;
    const oldP = p.keys.keyId;
    const oldQ = q.keys.keyId;
    await putKeys(app, p);
    const recipients = { [alice.user.id]: alice.keys.keyId, [p.user.id]: oldP, [q.user.id]: oldQ };
    const res = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients }) }, g.id);
    assert.equal(res.status, 409);
    // Only the member whose key changed is listed, with the full current bundle.
    assert.deepEqual(res.body, { error: 'keys_changed', keys: { [p.user.id]: p.keys.bundle } });
    await putKeys(app, q);
    const res2 = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients }) }, g.id);
    assert.deepEqual(res2.body, { error: 'keys_changed', keys: { [p.user.id]: p.keys.bundle, [q.user.id]: q.keys.bundle } });
    // A made-up keyId for myself is also a stale key.
    const mine = { ...recipients, [alice.user.id]: 'C'.repeat(43), [p.user.id]: p.keys.keyId, [q.user.id]: q.keys.keyId };
    const res3 = await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: mine }) }, g.id);
    assert.deepEqual(res3.body, { error: 'keys_changed', keys: { [alice.user.id]: alice.keys.bundle } });
    const fixed = { [alice.user.id]: alice.keys.keyId, [p.user.id]: p.keys.keyId, [q.user.id]: q.keys.keyId };
    assert.equal((await post(alice, { clientId: crypto.randomUUID(), e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: fixed }) }, g.id)).status, 201);
  });

  test('a rejected message stores nothing and reaches nobody', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const before = app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      const bad = envelope({ senderKeyId: alice.keys.keyId, recipients: { [alice.user.id]: alice.keys.keyId } });
      assert.equal((await post(alice, { clientId: crypto.randomUUID(), e2ee: bad })).status, 409);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
      assert.ok(await ws.none('message'));
    } finally {
      await ws.close();
    }
  });

  test('attachmentIds: up to 20 of my own unattached encrypted uploads', async () => {
    const files = [];
    for (let i = 0; i < 21; i++) files.push(await uploadEncrypted(app, alice, crypto.randomBytes(20 + i)));
    const ids = files.map((f) => f.id);
    const attach = (attachmentIds, who = alice) => postEncrypted(app, who, conv.id, '', { attachmentIds });

    assert.equal((await attach(ids)).status, 400); // 21
    for (const bad of ['a_x', {}, [1], [null], ['../etc'], [ids[0], ids[0]]]) {
      assert.equal((await attach(bad)).status, 400, JSON.stringify(bad));
    }
    const bobsFile = await uploadEncrypted(app, bob);
    assert.match((await attach([bobsFile.id])).body.error, /not found/i);
    assert.match((await attach(['a_doesnotexist'])).body.error, /not found/i);
    const plain = await uploadOk(app, alice);
    assert.match((await attach([plain.id])).body.error, /encrypted/);

    const sent = await attach(ids.slice(0, 20));
    assert.equal(sent.status, 201, sent.text);
    assert.deepEqual(
      sent.body.message.attachments,
      files.slice(0, 20).map((f) => ({ id: f.id, size: f.size, expired: false }))
    );
    // Each file goes with one message only.
    assert.match((await attach([ids[3]])).body.error, /already sent/);
    assert.match((await attach([ids[20], ids[3]])).body.error, /already sent/);
    assert.equal((await attach([ids[20]])).status, 201);
    assert.equal((await attach([])).status, 201);
    assert.equal((await postEncrypted(app, alice, conv.id, '', { attachmentIds: null })).status, 201);
    // Bob can read them now; a non-member still can't.
    assert.equal((await request(app, 'GET', `/api/attachments/${ids[7]}`, { token: bob.token })).status, 200);
    assert.equal((await request(app, 'GET', `/api/attachments/${ids[7]}`, { token: carol.token })).status, 403);
    assert.equal(app.store.getAttachment(ids[7]).mime, E2EE_MIME);
  });

  test('edits and reactions are validated like messages, against who can see the target', async () => {
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id], title: 'Later' } })).body
      .conversation;
    const m = await send(app, alice, g.id, 'before carol');
    await request(app, 'POST', `/api/conversations/${g.id}/members`, { token: alice.token, body: { userIds: [carol.user.id] } });
    const seeing = [alice.user.id, bob.user.id];
    const all = { [alice.user.id]: alice.keys.keyId, [bob.user.id]: bob.keys.keyId, [carol.user.id]: carol.keys.keyId };
    const routes = {
      edit: (body) => request(app, 'PATCH', `/api/conversations/${g.id}/messages/${m.id}`, { token: alice.token, body }),
      reaction: (body) => request(app, 'PUT', `/api/conversations/${g.id}/messages/${m.id}/reaction`, { token: alice.token, body }),
    };
    for (const [action, call] of Object.entries(routes)) {
      const kind = `${action}:${m.id}`;
      const mk = (recipients, over = {}) => ({ clientId: crypto.randomUUID(), e2ee: { ...envelope({ kind, senderKeyId: alice.keys.keyId, recipients }), ...over } });
      // Carol joined after the message: she must not be a recipient.
      let res = await call(mk(all));
      assert.equal(res.status, 409, action);
      assert.deepEqual(res.body, { error: 'members_changed', members: seeing });
      const right = { [alice.user.id]: alice.keys.keyId, [bob.user.id]: bob.keys.keyId };
      // Shape and kind.
      assert.equal((await call(mk(right, { iv: randomB64u(5) }))).status, 400, action);
      assert.equal((await call(mk(right, { kind: 'message' }))).status, 400, action);
      assert.equal((await call(mk(right, { kind: `${action}:${m.id + 1}` }))).status, 400, action);
      assert.equal((await call({ e2ee: mk(right).e2ee })).status, 400, `${action} without clientId`);
      // Stale keys.
      res = await call(mk({ ...right, [bob.user.id]: 'D'.repeat(43) }));
      assert.deepEqual(res.body, { error: 'keys_changed', keys: { [bob.user.id]: bob.keys.bundle } });
      res = await call(mk(right, { senderKeyId: 'E'.repeat(43) }));
      assert.deepEqual(res.body, { error: 'keys_changed' });
      // And the real thing.
      const ok = mk(right);
      res = await call(ok);
      assert.equal(res.status, 200, `${action}: ${res.text}`);
      if (action === 'edit') {
        assert.deepEqual(res.body.message.e2ee, ok.e2ee);
        assert.equal(res.body.message.e2eeClientId, ok.clientId);
        assert.ok(res.body.message.editedAt);
      } else {
        assert.deepEqual(res.body.message.reactions[alice.user.id], ok.e2ee);
        assert.equal(res.body.message.reactionClientIds[alice.user.id], ok.clientId);
      }
    }
    // A message sent after carol joined is addressed to all three, edits and reactions too.
    const m2 = await send(app, alice, g.id, 'after carol');
    const r = await request(app, 'PUT', `/api/conversations/${g.id}/messages/${m2.id}/reaction`, {
      token: carol.token,
      body: { clientId: 'r', e2ee: await makeEnvelope(app, carol, g.id, { kind: `reaction:${m2.id}`, audience: [alice.user.id, bob.user.id] }) },
    });
    assert.deepEqual(r.body, { error: 'members_changed', members: [alice.user.id, bob.user.id, carol.user.id] });
    // Plaintext edits and reactions get the reload message.
    for (const [method, suffix, body] of [
      ['PATCH', '', { body: 'x' }],
      ['PATCH', '', { clientId: 'x', body: 'x', e2ee: (await makeEnvelope(app, alice, g.id, { kind: `edit:${m2.id}` })) }],
      ['PUT', '/reaction', { emoji: '👍' }],
      ['PUT', '/reaction', { clientId: 'x' }],
    ]) {
      const res = await request(app, method, `/api/conversations/${g.id}/messages/${m2.id}${suffix}`, { token: alice.token, body });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: RELOAD });
    }
  });
});
