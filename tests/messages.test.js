'use strict';

// Reactions, replies, edit and unsend (docs/PROTOCOL.md, "Reactions, replies, edit, unsend").

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, request, register, dm, send, WsClient, MEDIA_HEADS, mediaFile, uploadOk, fakeClock } = require('./helpers');

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
  const react = (who, m, emoji, c = conv.id) => request(app, 'PUT', url(c, m, '/reaction'), { token: who.token, body: { emoji } });
  const unreact = (who, m, c = conv.id) => request(app, 'DELETE', url(c, m, '/reaction'), { token: who.token });
  const edit = (who, m, body, c = conv.id) => request(app, 'PATCH', url(c, m), { token: who.token, body: { body } });
  const unsend = (who, m, c = conv.id) => request(app, 'DELETE', url(c, m), { token: who.token });
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

  test('a new message has the v2 fields', async () => {
    const m = await send(app, alice, conv.id, 'hello');
    assert.equal(m.replyTo, null);
    assert.deepEqual(m.reactions, {});
    assert.equal(m.editedAt, null);
    assert.equal(m.deletedAt, null);
    assert.equal(m.system, null);
    assert.equal(m.createdAt, clock());
  });

  test('reactions: one per person, replace, remove, fan out as the same message', async () => {
    const m = await send(app, alice, conv.id, 'react to me');
    const ws = await WsClient.connect(app, alice.token);
    try {
      let res = await react(bob, m.id, '❤️');
      assert.equal(res.status, 200);
      assert.equal(res.body.message.id, m.id);
      assert.deepEqual(res.body.message.reactions, { '❤️': [bob.user.id] });
      let ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.deepEqual(ev.message.reactions, { '❤️': [bob.user.id] });
      assert.equal(ev.message.body, 'react to me');

      res = await react(bob, m.id, '😂');
      assert.deepEqual(res.body.message.reactions, { '😂': [bob.user.id] });
      ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.deepEqual(ev.message.reactions, { '😂': [bob.user.id] });

      res = await react(alice, m.id, '😂');
      assert.deepEqual(res.body.message.reactions, { '😂': [bob.user.id, alice.user.id] });
      await ws.next('message', (f) => f.message.id === m.id);
      res = await react(alice, m.id, '👍');
      assert.deepEqual(res.body.message.reactions, { '😂': [bob.user.id], '👍': [alice.user.id] });
      await ws.next('message', (f) => f.message.id === m.id);

      // Same reaction again: no change, no event.
      res = await react(alice, m.id, '👍');
      assert.equal(res.status, 200);
      assert.ok(await ws.none('message', (f) => f.message.id === m.id));

      res = await unreact(bob, m.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.message.reactions, { '👍': [alice.user.id] });
      await ws.next('message', (f) => f.message.id === m.id);
      res = await unreact(bob, m.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.message.reactions, { '👍': [alice.user.id] });

      const listed = (await listFor(bob)).find((x) => x.id === m.id);
      assert.deepEqual(listed.reactions, { '👍': [alice.user.id] });
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(m.id).n, 1);
    } finally {
      await ws.close();
    }
  });

  test('reaction validation and access', async () => {
    const m = await send(app, bob, conv.id, 'x');
    for (const emoji of ['👍', '🇺🇸', '1️⃣', '👍🏽', '❤️', '🏳️‍🌈']) {
      assert.equal((await react(alice, m.id, emoji)).status, 200, emoji);
    }
    const family = '👨‍👩‍👧‍👦'; // one emoji, but 25 bytes
    for (const emoji of ['', 'a', 'ab', '❤️❤️', '👍 ', ' ', '\u0000', '<script>', family, 42, null, ['👍']]) {
      assert.equal((await react(alice, m.id, emoji)).status, 400, JSON.stringify(emoji));
    }
    assert.equal((await react(carol, m.id, '👍')).status, 403);
    assert.equal((await unreact(carol, m.id)).status, 403);
    assert.equal((await react(alice, 999999, '👍')).status, 404);
    assert.equal((await react(alice, 'abc', '👍')).status, 404);
    assert.equal((await react(alice, m.id, '👍', 'c_missing')).status, 404);
    // A message id from another conversation is not found through this one.
    const other = await dm(app, alice, carol);
    const otherMsg = await send(app, carol, other.id, 'elsewhere');
    assert.equal((await react(alice, otherMsg.id, '👍')).status, 404);
    assert.equal((await react(bob, otherMsg.id, '👍', other.id)).status, 403);
    assert.equal((await request(app, 'PUT', url(conv.id, m.id, '/reaction'), { body: { emoji: '👍' } })).status, 401);
    assert.equal((await request(app, 'POST', url(conv.id, m.id, '/reaction'), { token: alice.token, body: { emoji: '👍' } })).status, 405);
  });

  test('replies quote the original (first 200 chars) and must be in the same conversation', async () => {
    const long = '😀'.repeat(250);
    const original = await send(app, alice, conv.id, long);
    const reply = await send(app, bob, conv.id, 'ha', { replyToId: original.id });
    assert.deepEqual(reply.replyTo, {
      id: original.id,
      senderId: alice.user.id,
      body: '😀'.repeat(200),
      attachmentKind: null,
      deleted: false,
    });
    const photo = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
    const photoMsg = await send(app, alice, conv.id, '', { attachmentId: photo.id });
    const reply2 = await send(app, bob, conv.id, 'nice', { replyToId: photoMsg.id });
    assert.deepEqual(reply2.replyTo, { id: photoMsg.id, senderId: alice.user.id, body: '', attachmentKind: 'image', deleted: false });
    assert.deepEqual((await listFor(alice)).find((x) => x.id === reply2.id).replyTo, reply2.replyTo);

    const other = await dm(app, bob, carol);
    const elsewhere = await send(app, carol, other.id, 'secret');
    for (const replyToId of [elsewhere.id, 9999999, 0, -1, 'x', 1.5]) {
      const res = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: bob.token,
        body: { clientId: crypto.randomUUID(), body: 'hi', replyToId },
      });
      assert.equal(res.status, 400, String(replyToId));
      assert.ok(!JSON.stringify(res.body).includes('secret'));
    }
  });

  test('edit: sender only, text only, within 15 minutes; replies follow', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const m = await send(app, alice, conv.id, 'teh plan');
      await ws.next('message', (f) => f.message.id === m.id);
      const reply = await send(app, bob, conv.id, 'which plan?', { replyToId: m.id });
      await ws.next('message', (f) => f.message.id === reply.id);

      clock.advance(5 * MIN);
      const res = await edit(alice, m.id, '  the plan  ');
      assert.equal(res.status, 200);
      assert.equal(res.body.message.id, m.id);
      assert.equal(res.body.message.body, 'the plan');
      assert.equal(res.body.message.editedAt, clock());
      assert.equal(res.body.message.createdAt, m.createdAt);
      const ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.equal(ev.message.body, 'the plan');
      assert.equal(ev.message.editedAt, clock());
      // The reply's quote shows the new text and is re-sent too.
      const replyEv = await ws.next('message', (f) => f.message.id === reply.id);
      assert.equal(replyEv.message.replyTo.body, 'the plan');

      assert.equal((await edit(bob, m.id, 'hijack')).status, 403);
      assert.equal((await edit(carol, m.id, 'hijack')).status, 403);
      for (const body of ['', '   ', 'x'.repeat(4001), 42, null]) {
        assert.equal((await edit(alice, m.id, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await edit(alice, m.id, 'y'.repeat(4000))).status, 200);
      const unchanged = await edit(alice, m.id, 'y'.repeat(4000));
      assert.equal(unchanged.status, 200);

      const photo = await uploadOk(app, alice);
      const photoMsg = await send(app, alice, conv.id, 'caption', { attachmentId: photo.id });
      assert.equal((await edit(alice, photoMsg.id, 'new caption')).status, 400);

      // Exactly 15 minutes is still fine, a moment later is not.
      const late = await send(app, alice, conv.id, 'late');
      clock.advance(15 * MIN);
      assert.equal((await edit(alice, late.id, 'late!')).status, 200);
      clock.advance(1);
      const tooLate = await edit(alice, late.id, 'late!!');
      assert.equal(tooLate.status, 409);
      assert.equal((await listFor(alice)).find((x) => x.id === late.id).body, 'late!');
    } finally {
      await ws.close();
    }
  });

  test('unsend: sender only, within 24 hours, deletes files, clears reactions, marks quotes deleted', async () => {
    const ws = await WsClient.connect(app, bob.token);
    try {
      const thumb = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
      const video = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.mp4), 'video/mp4', `?thumbnailId=${thumb.id}`);
      const m = await send(app, alice, conv.id, 'oops', { attachmentId: video.id });
      await ws.next('message', (f) => f.message.id === m.id);
      await react(bob, m.id, '😮');
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
      assert.equal(gone.attachment, null);
      assert.deepEqual(gone.reactions, {});
      assert.equal(gone.replyTo, null);
      assert.equal(gone.deletedAt, clock());
      assert.equal(gone.senderId, alice.user.id);
      for (const f of files) assert.ok(!fs.existsSync(f), f);
      assert.equal(app.store.getAttachment(video.id), null);
      assert.equal(app.store.getAttachment(thumb.id), null);
      for (const who of [alice, bob]) {
        assert.equal((await request(app, 'GET', `/api/attachments/${video.id}`, { token: who.token })).status, 404);
        assert.equal((await request(app, 'GET', `/api/attachments/${thumb.id}`, { token: who.token })).status, 404);
      }
      const ev = await ws.next('message', (f) => f.message.id === m.id);
      assert.equal(ev.message.deletedAt, clock());
      assert.equal(ev.message.attachment, null);
      const replyEv = await ws.next('message', (f) => f.message.id === reply.id);
      assert.deepEqual(replyEv.message.replyTo, { id: m.id, senderId: alice.user.id, body: '', attachmentKind: null, deleted: true });
      const listed = await listFor(bob);
      assert.equal(listed.find((x) => x.id === m.id).deletedAt, clock());
      assert.equal(listed.find((x) => x.id === reply.id).replyTo.deleted, true);

      // Unsending again is harmless; nothing else can be done to it.
      assert.equal((await unsend(alice, m.id)).status, 200);
      assert.equal((await react(bob, m.id, '👍')).status, 400);
      assert.equal((await unreact(bob, m.id)).status, 400);
      assert.equal((await edit(alice, m.id, 'back')).status, 400);
      const replyToGone = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: bob.token,
        body: { clientId: crypto.randomUUID(), body: 'hm', replyToId: m.id },
      });
      assert.equal(replyToGone.status, 400);

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
      assert.equal((await listFor(alice)).find((x) => x.id === b.id).body, 'b');
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

    await edit(alice, m.id, 'one!', c.id);
    await react(alice, m.id, '🙏', c.id);
    await react(dave, m.id, '❤️', c.id);
    const m2 = await send(app, alice, c.id, 'two');
    await app.push.idle();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].body, 'two');
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
      ['PUT', `/api/conversations/${g.id}/messages/${m.id}/reaction`, { emoji: '👍' }],
      ['DELETE', `/api/conversations/${g.id}/messages/${m.id}/reaction`],
      ['PATCH', `/api/conversations/${g.id}/messages/${m.id}`, { body: 'x' }],
      ['DELETE', `/api/conversations/${g.id}/messages/${m.id}`],
      ['POST', `/api/conversations/${g.id}/messages`, { clientId: 'r1', body: 'x', replyToId: m.id }],
    ];
    for (const [method, p, body] of routes) {
      assert.equal((await request(app, method, p, { body })).status, 401, `${method} ${p} anon`);
      assert.equal((await request(app, method, p, { token: carol.token, body })).status, 403, `${method} ${p} non-member`);
      assert.equal((await request(app, method, p.replace(g.id, 'c_missing'), { token: carol.token, body })).status, 404, `${method} ${p} missing`);
    }
    // Nothing changed.
    const msgs = (await request(app, 'GET', `/api/conversations/${g.id}/messages`, { token: alice.token })).body.messages;
    assert.deepEqual(msgs.map((x) => [x.id, x.body, x.reactions]), [[m.id, 'hi', {}]]);
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
    ]) {
      const bad = await request(app, method, p, { token: alice.token, body: '{"nope', headers: { 'Content-Type': 'application/json' } });
      assert.equal(bad.status, 400, p);
      assert.ok(!/at .*\.js/.test(bad.text), p);
      const big = await request(app, method, p, { token: alice.token, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) });
      assert.equal(big.status, 413, p);
    }
  });
});
