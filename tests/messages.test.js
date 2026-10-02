'use strict';

// Reactions, replies, edit and unsend with encrypted envelopes (docs/PROTOCOL.md, "Reactions,
// replies, edit, unsend", and docs/E2EE.md, "Server API changes").

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp,
  request,
  register,
  dm,
  send,
  postEncrypted,
  makeEnvelope,
  react,
  edit,
  textOf,
  uploadEncrypted,
  insertLegacyMessage,
  WsClient,
  fakeClock,
  RELOAD,
} = require('./helpers');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function fakeSubscription() {
  return {
    endpoint: `https://push.example.com/send/${crypto.randomUUID()}`,
    keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

describe('reactions, replies, edit, unsend', () => {
  let app;
  let clock;
  let pushes = [];
  let alice;
  let bob;
  let carol;
  let conv;

  const url = (c, m, suffix = '') => `/api/conversations/${c}/messages/${m}${suffix}`;
  const unreact = (who, m, c = conv.id) => request(app, 'DELETE', url(c, m, '/reaction'), { token: who.token });
  const unsend = (who, m, c = conv.id) => request(app, 'DELETE', url(c, m), { token: who.token });
  /** A reaction/edit request body for `kind`, addressed to every member of conv. */
  const actBody = async (who, kind, payload = {}, c = conv.id) => ({
    clientId: crypto.randomUUID(),
    e2ee: await makeEnvelope(app, who, c, { kind, payload }),
  });
  const listFor = async (who, c = conv.id) =>
    (await request(app, 'GET', `/api/conversations/${c}/messages?limit=100`, { token: who.token })).body.messages;
  const convFor = async (who, c = conv.id) => (await request(app, 'GET', `/api/conversations/${c}`, { token: who.token })).body.conversation;

  before(async () => {
    clock = fakeClock(Date.UTC(2026, 5, 1, 12));
    app = await startApp({
      now: clock,
      sendPush: (subscription, payload) => {
        pushes.push(JSON.parse(payload));
        return Promise.resolve({ statusCode: 201 });
      },
    });
    alice = await register(app, undefined, { displayName: 'Alice' });
    bob = await register(app, undefined, { displayName: 'Bob' });
    carol = await register(app, undefined, { displayName: 'Carol' });
    conv = await dm(app, alice, bob);
  });
  after(() => app.close());
  beforeEach(() => {
    pushes = [];
  });

  test('a new message has the v3 fields', async () => {
    const m = await send(app, alice, conv.id, 'hello');
    assert.equal(m.body, '');
    assert.equal(m.attachment, null);
    assert.deepEqual(m.attachments, []);
    assert.equal(m.e2ee.kind, 'message');
    assert.equal(m.e2eeClientId, m.clientId);
    assert.equal(textOf(m), 'hello');
    assert.equal(m.replyTo, null);
    assert.deepEqual(m.reactions, {});
    assert.deepEqual(m.reactionClientIds, {});
    assert.deepEqual(m.legacyReactions, {});
    assert.equal(m.editedAt, null);
    assert.equal(m.deletedAt, null);
    assert.equal(m.system, null);
    assert.equal(m.createdAt, clock());
  });

  test('reactions: encrypted, one per person, replace, remove, fan out as the same message', async () => {
    const m = await send(app, alice, conv.id, 'react to me');
    const kind = `reaction:${m.id}`;
    const ws = await WsClient.connect(app, alice.token);
    try {
      const heart = await actBody(bob, kind, { emoji: '❤️' });
      let res = await request(app, 'PUT', url(conv.id, m.id, '/reaction'), { token: bob.token, body: heart });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.message.id, m.id);
      assert.deepEqual(res.body.message.reactions, { [bob.user.id]: heart.e2ee });
      assert.deepEqual(res.body.message.reactionClientIds, { [bob.user.id]: heart.clientId });
      assert.deepEqual(res.body.message.legacyReactions, {});
      let ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.deepEqual(ev.message.reactions, { [bob.user.id]: heart.e2ee });
      assert.deepEqual(ev.message.e2ee, m.e2ee);

      // The same envelope again: no change, no event.
      res = await request(app, 'PUT', url(conv.id, m.id, '/reaction'), { token: bob.token, body: heart });
      assert.equal(res.status, 200);
      assert.ok(await ws.none('message', (f) => f.message.id === m.id));

      // A new reaction replaces my previous one.
      res = await react(app, bob, conv.id, m.id, '😂');
      assert.equal(textOf(res.body.message.reactions[bob.user.id]), '😂');
      assert.deepEqual(Object.keys(res.body.message.reactions), [bob.user.id]);
      ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.equal(textOf(ev.message.reactions[bob.user.id]), '😂');

      res = await react(app, alice, conv.id, m.id, '👍');
      assert.deepEqual(Object.keys(res.body.message.reactions).sort(), [alice.user.id, bob.user.id].sort());
      await ws.next('message', (f) => f.message.id === m.id);

      res = await unreact(bob, m.id);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.message.reactions), [alice.user.id]);
      assert.deepEqual(Object.keys(res.body.message.reactionClientIds), [alice.user.id]);
      await ws.next('message', (f) => f.message.id === m.id);
      res = await unreact(bob, m.id);
      assert.equal(res.status, 200);
      assert.ok(await ws.none('message', (f) => f.message.id === m.id));

      const listed = (await listFor(bob)).find((x) => x.id === m.id);
      assert.equal(textOf(listed.reactions[alice.user.id]), '👍');
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(m.id).n, 1);
      // A reaction is not a new message: no push.
      await app.push.idle();
      assert.equal(pushes.length, 0);
    } finally {
      await ws.close();
    }
  });

  test('reaction validation and access', async () => {
    const m = await send(app, bob, conv.id, 'x');
    const put = (who, body, c = conv.id, id = m.id) => request(app, 'PUT', url(c, id, '/reaction'), { token: who.token, body });
    // Plaintext reactions come from an old app.
    for (const body of [{ emoji: '👍' }, { clientId: 'r', emoji: '👍' }, {}, { clientId: 'r' }]) {
      const res = await put(alice, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: RELOAD });
    }
    // The kind must name this message.
    const other = await send(app, bob, conv.id, 'other');
    for (const kind of ['message', `edit:${m.id}`, `reaction:${other.id}`, 'reaction:', `reaction:${m.id} `]) {
      const res = await put(alice, await actBody(alice, kind));
      assert.equal(res.status, 400, kind);
    }
    const ok = await actBody(alice, `reaction:${m.id}`);
    for (const clientId of ['', 'x'.repeat(101), 42, null]) {
      assert.equal((await put(alice, { ...ok, clientId })).status, 400, String(clientId));
    }
    assert.equal((await put(alice, ok)).status, 200);
    assert.equal((await react(app, carol, conv.id, m.id, '👍')).status, 403);
    assert.equal((await unreact(carol, m.id)).status, 403);
    assert.equal((await put(alice, ok, conv.id, 999999)).status, 404);
    assert.equal((await put(alice, ok, conv.id, 'abc')).status, 404);
    assert.equal((await put(alice, ok, 'c_missing')).status, 404);
    // A message id from another conversation is not found through this one.
    const elsewhere = await dm(app, alice, carol);
    const otherMsg = await send(app, carol, elsewhere.id, 'elsewhere');
    assert.equal((await put(alice, await actBody(alice, `reaction:${otherMsg.id}`), conv.id, otherMsg.id)).status, 404);
    assert.equal((await react(app, bob, elsewhere.id, otherMsg.id, '👍')).status, 403);
    assert.equal((await request(app, 'PUT', url(conv.id, m.id, '/reaction'), { body: ok })).status, 401);
    assert.equal((await request(app, 'POST', url(conv.id, m.id, '/reaction'), { token: alice.token, body: ok })).status, 405);
  });

  test('reactions to legacy messages; legacy plaintext reactions show as legacyReactions', async () => {
    const legacy = insertLegacyMessage(app, { conversationId: conv.id, senderId: alice.user.id, body: 'from v2', createdAt: clock() });
    app.store.db.prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, '😂', ?)").run(legacy.id, bob.user.id, clock());
    app.store.db.prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, '😂', ?)").run(legacy.id, alice.user.id, clock());
    let listed = (await listFor(alice)).find((x) => x.id === legacy.id);
    assert.equal(listed.e2ee, null);
    assert.equal(listed.body, 'from v2');
    assert.deepEqual(listed.reactions, {});
    assert.deepEqual(listed.legacyReactions, { '😂': [bob.user.id, alice.user.id] });
    // An encrypted reaction replaces that person's legacy one.
    const res = await react(app, bob, conv.id, legacy.id, '❤️');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.message.reactions), [bob.user.id]);
    assert.deepEqual(res.body.message.legacyReactions, { '😂': [alice.user.id] });
    listed = (await listFor(bob)).find((x) => x.id === legacy.id);
    assert.equal(textOf(listed.reactions[bob.user.id]), '❤️');
    assert.deepEqual(listed.legacyReactions, { '😂': [alice.user.id] });
    // Legacy messages can't be edited with an envelope.
    const e = await edit(app, alice, conv.id, legacy.id, 'new');
    assert.equal(e.status, 400);
  });

  test('replies carry { id, senderId, deleted } and must be in the same conversation', async () => {
    const original = await send(app, alice, conv.id, 'the original');
    const reply = await send(app, bob, conv.id, 'ha', { replyToId: original.id });
    assert.deepEqual(reply.replyTo, { id: original.id, senderId: alice.user.id, deleted: false });
    assert.deepEqual((await listFor(alice)).find((x) => x.id === reply.id).replyTo, reply.replyTo);
    // Replying to a legacy message works too; a legacy reply keeps its old quote shape.
    const legacy = insertLegacyMessage(app, { conversationId: conv.id, senderId: bob.user.id, body: 'old text', createdAt: clock() });
    const toLegacy = await send(app, alice, conv.id, 'answer', { replyToId: legacy.id });
    assert.deepEqual(toLegacy.replyTo, { id: legacy.id, senderId: bob.user.id, deleted: false });
    const legacyReply = insertLegacyMessage(app, { conversationId: conv.id, senderId: bob.user.id, body: 're', replyToId: legacy.id, createdAt: clock() });
    assert.deepEqual(legacyReply.replyTo, { id: legacy.id, senderId: bob.user.id, body: 'old text', attachmentKind: null, deleted: false });

    const other = await dm(app, bob, carol);
    const elsewhere = await send(app, carol, other.id, 'secret');
    for (const replyToId of [elsewhere.id, 9999999, 0, -1, 'x', 1.5]) {
      const res = await postEncrypted(app, bob, conv.id, 'hi', { replyToId });
      assert.equal(res.status, 400, String(replyToId));
      assert.ok(!JSON.stringify(res.body).includes(elsewhere.e2ee.ct));
    }
  });

  test('edit: encrypted, sender only, text only, within 15 minutes', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const m = await send(app, alice, conv.id, 'teh plan');
      await ws.next('message', (f) => f.message.id === m.id);
      const reply = await send(app, bob, conv.id, 'which plan?', { replyToId: m.id });
      await ws.next('message', (f) => f.message.id === reply.id);

      clock.advance(5 * MIN);
      const body = await actBody(alice, `edit:${m.id}`, { body: 'the plan' });
      const res = await request(app, 'PATCH', url(conv.id, m.id), { token: alice.token, body });
      assert.equal(res.status, 200, res.text);
      const edited = res.body.message;
      assert.equal(edited.id, m.id);
      assert.deepEqual(edited.e2ee, body.e2ee);
      assert.equal(edited.e2eeClientId, body.clientId);
      assert.equal(edited.clientId, m.clientId);
      assert.equal(edited.body, '');
      assert.equal(edited.editedAt, clock());
      assert.equal(edited.createdAt, m.createdAt);
      const ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.deepEqual(ev.message, edited);
      // The reply's quote ({ id, senderId, deleted }) didn't change, so it isn't re-sent.
      assert.ok(await ws.none('message', (f) => f.message.id === reply.id));
      // The same edit again is a no-op.
      assert.equal((await request(app, 'PATCH', url(conv.id, m.id), { token: alice.token, body })).status, 200);
      assert.ok(await ws.none('message', (f) => f.message.id === m.id));

      assert.equal((await edit(app, bob, conv.id, m.id, 'hijack')).status, 403);
      assert.equal((await edit(app, carol, conv.id, m.id, 'hijack')).status, 403);
      const plain = await request(app, 'PATCH', url(conv.id, m.id), { token: alice.token, body: { body: 'plaintext' } });
      assert.equal(plain.status, 400);
      assert.deepEqual(plain.body, { error: RELOAD });
      for (const kind of ['message', `reaction:${m.id}`, `edit:${reply.id}`]) {
        assert.equal((await request(app, 'PATCH', url(conv.id, m.id), { token: alice.token, body: await actBody(alice, kind) })).status, 400, kind);
      }

      // Messages with files can't be edited (the edit payload has only text).
      const file = await uploadEncrypted(app, alice);
      const photoMsg = await send(app, alice, conv.id, 'caption', { attachmentIds: [file.id] });
      assert.equal((await edit(app, alice, conv.id, photoMsg.id, 'new caption')).status, 400);

      // Exactly 15 minutes is still fine, a moment later is not.
      const late = await send(app, alice, conv.id, 'late');
      clock.advance(15 * MIN);
      assert.equal((await edit(app, alice, conv.id, late.id, 'late!')).status, 200);
      clock.advance(1);
      const tooLate = await edit(app, alice, conv.id, late.id, 'late!!');
      assert.equal(tooLate.status, 409);
      assert.equal(textOf((await listFor(alice)).find((x) => x.id === late.id)), 'late!');
    } finally {
      await ws.close();
    }
  });

  test('unsend: sender only, within 24 hours, deletes all files, clears reactions, marks quotes deleted', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const video = await uploadEncrypted(app, alice);
      const thumb = await uploadEncrypted(app, alice);
      const m = await send(app, alice, conv.id, 'oops', { attachmentIds: [video.id, thumb.id] });
      await ws.next('message', (f) => f.message.id === m.id);
      await react(app, bob, conv.id, m.id, '😮');
      await ws.next('message', (f) => f.message.id === m.id);
      const reply = await send(app, bob, conv.id, 'what was that', { replyToId: m.id });
      await ws.next('message', (f) => f.message.id === reply.id);
      const files = [video.id, thumb.id].map((id) => path.join(app.dataDir, 'uploads', id));
      for (const f of files) assert.ok(fs.existsSync(f));
      assert.equal((await request(app, 'GET', `/api/attachments/${thumb.id}`, { token: bob.token })).status, 200);

      assert.equal((await unsend(bob, m.id)).status, 403);
      assert.equal((await unsend(carol, m.id)).status, 403);

      clock.advance(HOUR);
      const res = await unsend(alice, m.id);
      assert.equal(res.status, 200);
      const gone = res.body.message;
      assert.equal(gone.id, m.id);
      assert.equal(gone.body, '');
      assert.equal(gone.e2ee, null);
      assert.equal(gone.attachment, null);
      assert.deepEqual(gone.attachments, []);
      assert.deepEqual(gone.reactions, {});
      assert.deepEqual(gone.reactionClientIds, {});
      assert.equal(gone.replyTo, null);
      assert.equal(gone.deletedAt, clock());
      assert.equal(gone.senderId, alice.user.id);
      for (const f of files) assert.ok(!fs.existsSync(f), f);
      assert.equal(app.store.getAttachment(video.id), null);
      assert.equal(app.store.getAttachment(thumb.id), null);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ?').get(m.id).n, 0);
      for (const who of [alice, bob]) {
        assert.equal((await request(app, 'GET', `/api/attachments/${video.id}`, { token: who.token })).status, 404);
        assert.equal((await request(app, 'GET', `/api/attachments/${thumb.id}`, { token: who.token })).status, 404);
      }
      const ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.equal(ev.message.deletedAt, clock());
      assert.equal(ev.message.e2ee, null);
      const replyEv = await ws.next('message', (f) => f.message.id === reply.id);
      assert.deepEqual(replyEv.message.replyTo, { id: m.id, senderId: alice.user.id, deleted: true });
      const listed = await listFor(bob);
      assert.equal(listed.find((x) => x.id === m.id).deletedAt, clock());
      assert.equal(listed.find((x) => x.id === reply.id).replyTo.deleted, true);

      // Unsending again is harmless; nothing else can be done to it.
      assert.equal((await unsend(alice, m.id)).status, 200);
      assert.equal((await react(app, bob, conv.id, m.id, '👍')).status, 400);
      assert.equal((await unreact(bob, m.id)).status, 400);
      assert.equal((await edit(app, alice, conv.id, m.id, 'back')).status, 400);
      assert.equal((await postEncrypted(app, bob, conv.id, 'hm', { replyToId: m.id })).status, 400);

      // A reply can itself be unsent; its quote goes away.
      const r2 = await send(app, bob, conv.id, 'nvm', { replyToId: reply.id });
      const r2gone = (await unsend(bob, r2.id)).body.message;
      assert.equal(r2gone.replyTo, null);

      // Window: exactly 24 hours is fine, later is not.
      const a = await send(app, alice, conv.id, 'a');
      const b = await send(app, alice, conv.id, 'b');
      clock.advance(24 * HOUR);
      assert.equal((await unsend(alice, a.id)).status, 200);
      clock.advance(1);
      assert.equal((await unsend(alice, b.id)).status, 409);
      assert.equal(textOf((await listFor(alice)).find((x) => x.id === b.id)), 'b');
    } finally {
      await ws.close();
    }
  });

  test('only brand-new messages count as unread and trigger push', async () => {
    const dave = await register(app, undefined, { displayName: 'Dave' });
    await request(app, 'POST', '/api/push/subscribe', { token: dave.token, body: { subscription: fakeSubscription() } });
    const c = await dm(app, alice, dave);
    const m = await send(app, alice, c.id, 'one');
    await app.push.idle();
    assert.equal(pushes.length, 1);
    assert.equal((await convFor(dave, c.id)).unreadCount, 1);

    assert.equal((await edit(app, alice, c.id, m.id, 'one!')).status, 200);
    assert.equal((await react(app, alice, c.id, m.id, '🙏')).status, 200);
    assert.equal((await react(app, dave, c.id, m.id, '❤️')).status, 200);
    const m2 = await send(app, alice, c.id, 'two');
    await app.push.idle();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].messageId, m2.id);
    assert.equal(textOf(pushes[1].e2ee), 'two');
    const dv = await convFor(dave, c.id);
    assert.equal(dv.unreadCount, 2);
    assert.equal(dv.lastMessage.id, m2.id);
    assert.equal((await convFor(alice, c.id)).unreadCount, 0);

    // An unsent message no longer counts.
    await unsend(alice, m2.id, c.id);
    await app.push.idle();
    assert.equal(pushes.length, 2);
    assert.equal((await convFor(dave, c.id)).unreadCount, 1);
  });
});

describe('new routes: auth, membership and error hygiene', () => {
  let app;
  let alice;
  let bob;
  let carol;
  before(async () => {
    app = await startApp();
    alice = await register(app);
    bob = await register(app);
    carol = await register(app);
  });
  after(() => app.close());

  test('401 without a token, 403 for non-members, 404 for unknown conversations', async () => {
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id], title: 'G' } })).body
      .conversation;
    const m = await send(app, alice, g.id, 'hi');
    const routes = [
      ['PATCH', `/api/conversations/${g.id}`, { title: 'x' }],
      ['POST', `/api/conversations/${g.id}/members`, { userIds: [carol.user.id] }],
      ['DELETE', `/api/conversations/${g.id}/members/me`],
      ['PUT', `/api/conversations/${g.id}/messages/${m.id}/reaction`, { clientId: 'r', e2ee: await makeEnvelope(app, alice, g.id, { kind: `reaction:${m.id}` }) }],
      ['DELETE', `/api/conversations/${g.id}/messages/${m.id}/reaction`],
      ['PATCH', `/api/conversations/${g.id}/messages/${m.id}`, { clientId: 'e', e2ee: await makeEnvelope(app, alice, g.id, { kind: `edit:${m.id}` }) }],
      ['DELETE', `/api/conversations/${g.id}/messages/${m.id}`],
      ['POST', `/api/conversations/${g.id}/messages`, { clientId: 'r1', e2ee: await makeEnvelope(app, alice, g.id), replyToId: m.id }],
    ];
    for (const [method, p, body] of routes) {
      assert.equal((await request(app, method, p, { body })).status, 401, `${method} ${p} anon`);
      assert.equal((await request(app, method, p, { token: carol.token, body })).status, 403, `${method} ${p} non-member`);
      assert.equal((await request(app, method, p.replace(g.id, 'c_missing'), { token: carol.token, body })).status, 404, `${method} ${p} missing`);
    }
    // Nothing changed.
    const msgs = (await request(app, 'GET', `/api/conversations/${g.id}/messages`, { token: alice.token })).body.messages;
    assert.deepEqual(msgs.map((x) => [x.id, textOf(x), x.e2ee, x.reactions, x.editedAt]), [[m.id, 'hi', m.e2ee, {}, null]]);
    for (const [method, p] of [
      ['POST', '/api/uploads'],
      ['GET', '/api/uploads/up_x'],
      ['PUT', '/api/uploads/up_x'],
      ['DELETE', '/api/uploads/up_x'],
      ['POST', '/api/uploads/up_x/complete'],
    ]) {
      assert.equal((await request(app, method, p)).status, 401, `${method} ${p}`);
    }
  });

  test('bad JSON and oversized bodies on new routes: clean 400/413, no stack traces', async () => {
    const g = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id], title: 'H' } })).body
      .conversation;
    const m = await send(app, alice, g.id, 'hi');
    for (const [method, p] of [
      ['PUT', `/api/conversations/${g.id}/messages/${m.id}/reaction`],
      ['PATCH', `/api/conversations/${g.id}/messages/${m.id}`],
      ['POST', `/api/conversations/${g.id}/members`],
      ['POST', '/api/uploads'],
      ['POST', `/api/conversations/${g.id}/messages`],
      ['PUT', '/api/keys'],
    ]) {
      const bad = await request(app, method, p, { token: alice.token, body: '{"nope', headers: { 'Content-Type': 'application/json' } });
      assert.equal(bad.status, 400, p);
      assert.ok(!/at .*\.js/.test(bad.text), p);
      const big = await request(app, method, p, { token: alice.token, body: JSON.stringify({ x: 'y'.repeat(90 * 1024) }) });
      assert.equal(big.status, 413, p);
    }
  });
});
