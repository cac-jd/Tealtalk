'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, request, register, dm, send, makeEnvelope, textOf, RELOAD } = require('./helpers');

describe('conversations and messages', () => {
  let app;
  let alice;
  let bob;
  let carol;
  let dave;
  before(async () => {
    app = await startApp();
    alice = await register(app, 'alice', { displayName: 'Alice' });
    bob = await register(app, 'bob', { displayName: 'Bob' });
    carol = await register(app, 'carol', { displayName: 'Carol' });
    dave = await register(app, 'dave', { displayName: 'Dave' });
  });
  after(() => app.close());

  test('creating a 1:1 is deduplicated in both directions', async () => {
    const first = await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id] } });
    assert.equal(first.status, 201);
    const c = first.body.conversation;
    assert.match(c.id, /^c_/);
    assert.equal(c.isGroup, false);
    assert.equal(c.title, null);
    assert.deepEqual(c.members.map((m) => m.id), [alice.user.id, bob.user.id]);
    assert.equal(c.lastMessage, null);
    assert.equal(c.unreadCount, 0);
    assert.deepEqual(c.readUpTo, { [alice.user.id]: 0, [bob.user.id]: 0 });
    assert.equal(c.updatedAt, c.createdAt);

    const again = await request(app, 'POST', '/api/conversations', {
      token: alice.token,
      body: { memberIds: [bob.user.id, alice.user.id, bob.user.id] },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.conversation.id, c.id);
    const reverse = await request(app, 'POST', '/api/conversations', { token: bob.token, body: { memberIds: [alice.user.id] } });
    assert.equal(reverse.status, 200);
    assert.equal(reverse.body.conversation.id, c.id);
  });

  test('groups: titled 1:1 or 2+ others make a new group every time', async () => {
    const g = await request(app, 'POST', '/api/conversations', {
      token: alice.token,
      body: { memberIds: [bob.user.id, carol.user.id], title: '  Hikers  ' },
    });
    assert.equal(g.status, 201);
    assert.equal(g.body.conversation.isGroup, true);
    assert.equal(g.body.conversation.title, 'Hikers');
    assert.equal(g.body.conversation.members.length, 3);
    const g2 = await request(app, 'POST', '/api/conversations', {
      token: alice.token,
      body: { memberIds: [bob.user.id, carol.user.id] },
    });
    assert.equal(g2.status, 201);
    assert.notEqual(g2.body.conversation.id, g.body.conversation.id);
    assert.equal(g2.body.conversation.title, null);
    assert.equal(g2.body.conversation.isGroup, true);
    const titled = await request(app, 'POST', '/api/conversations', {
      token: alice.token,
      body: { memberIds: [dave.user.id], title: 'Project' },
    });
    assert.equal(titled.status, 201);
    assert.equal(titled.body.conversation.isGroup, true);
  });

  test('create conversation validation', async () => {
    const cases = [
      {},
      { memberIds: 'x' },
      { memberIds: [] },
      { memberIds: [alice.user.id] },
      { memberIds: ['u_doesnotexist'] },
      { memberIds: [123] },
      { memberIds: [bob.user.id], title: 5 },
      { memberIds: [bob.user.id], title: 'x'.repeat(81) },
    ];
    for (const body of cases) {
      const res = await request(app, 'POST', '/api/conversations', { token: alice.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await request(app, 'POST', '/api/conversations', { body: { memberIds: [bob.user.id] } })).status, 401);
  });

  test('non-members get 403, unknown ids 404', async () => {
    const c = await dm(app, alice, bob);
    for (const [method, path, body] of [
      ['GET', `/api/conversations/${c.id}`],
      ['GET', `/api/conversations/${c.id}/messages`],
      ['POST', `/api/conversations/${c.id}/messages`, { clientId: 'x', body: 'hi' }],
      ['POST', `/api/conversations/${c.id}/read`, { messageId: 1 }],
    ]) {
      const res = await request(app, method, path, { token: carol.token, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      const missing = await request(app, method, path.replace(c.id, 'c_missing'), { token: carol.token, body });
      assert.equal(missing.status, 404, `${method} ${path} missing`);
      const anon = await request(app, method, path, { body });
      assert.equal(anon.status, 401);
    }
    const ok = await request(app, 'GET', `/api/conversations/${c.id}`, { token: bob.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.conversation.id, c.id);
  });

  test('post and list messages, shapes and validation', async () => {
    const c = await dm(app, alice, carol);
    const clientId = crypto.randomUUID();
    const e2ee = await makeEnvelope(app, alice, c.id, { payload: { body: 'hello carol' } });
    const res = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: alice.token,
      body: { clientId, e2ee },
    });
    assert.equal(res.status, 201, res.text);
    const m = res.body.message;
    assert.equal(typeof m.id, 'number');
    assert.equal(m.conversationId, c.id);
    assert.equal(m.senderId, alice.user.id);
    assert.equal(m.clientId, clientId);
    assert.equal(m.body, '');
    assert.equal(m.attachment, null);
    assert.deepEqual(m.attachments, []);
    assert.deepEqual(m.e2ee, e2ee);
    assert.equal(m.e2eeClientId, clientId);
    assert.equal(textOf(m), 'hello carol');
    assert.ok(Math.abs(m.createdAt - Date.now()) < 5000);

    const good = await makeEnvelope(app, alice, c.id);
    const bad = [
      { clientId: '', e2ee: good },
      { clientId: 'x'.repeat(101), e2ee: good },
      { e2ee: good },
      { clientId: crypto.randomUUID(), e2ee: { ...good, kind: 'edit:1' } },
      { clientId: crypto.randomUUID(), e2ee: 'nope' },
      { clientId: crypto.randomUUID(), e2ee: good, attachmentIds: ['a_nope'] },
    ];
    for (const body of bad) {
      const r = await request(app, 'POST', `/api/conversations/${c.id}/messages`, { token: alice.token, body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    }
    // Old plaintext clients are told to reload.
    for (const body of [{}, { clientId: crypto.randomUUID() }, { clientId: crypto.randomUUID(), body: 'hi' }, { clientId: 'x', body: '', attachmentId: 'a_1' }]) {
      const r = await request(app, 'POST', `/api/conversations/${c.id}/messages`, { token: alice.token, body });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: RELOAD });
    }
    const second = await send(app, alice, c.id, 'y'.repeat(4000));

    const list = await request(app, 'GET', `/api/conversations/${c.id}/messages`, { token: carol.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.messages.map((x) => x.id), [m.id, second.id]);
    assert.deepEqual(list.body.messages[0], m);

    const conv = await request(app, 'GET', `/api/conversations/${c.id}`, { token: carol.token });
    assert.equal(conv.body.conversation.lastMessage.id, second.id);
    assert.deepEqual(conv.body.conversation.lastMessage.e2ee, second.e2ee);
    assert.equal(conv.body.conversation.updatedAt, second.createdAt);
  });

  test('clientId makes retries idempotent', async () => {
    const c = await dm(app, bob, dave);
    const clientId = crypto.randomUUID();
    const post = async (who) =>
      request(app, 'POST', `/api/conversations/${c.id}/messages`, {
        token: who.token,
        body: { clientId, e2ee: await makeEnvelope(app, who, c.id, { payload: { body: 'once' } }) },
      });
    const one = await post(bob);
    const two = await post(bob);
    assert.equal(one.status, 201);
    assert.equal(two.status, 200);
    assert.deepEqual(two.body.message, one.body.message);
    // Same clientId from a different sender is a different message.
    const other = await post(dave);
    assert.equal(other.status, 201);
    const list = await request(app, 'GET', `/api/conversations/${c.id}/messages`, { token: bob.token });
    assert.equal(list.body.messages.length, 2);
  });

  test('paging with before and limit', async () => {
    const g = (
      await request(app, 'POST', '/api/conversations', {
        token: alice.token,
        body: { memberIds: [bob.user.id, dave.user.id], title: 'Paging' },
      })
    ).body.conversation;
    const ids = [];
    for (let i = 0; i < 120; i++) ids.push((await send(app, i % 2 ? bob : alice, g.id, `msg ${i}`)).id);

    const page1 = await request(app, 'GET', `/api/conversations/${g.id}/messages`, { token: dave.token });
    assert.equal(page1.body.messages.length, 50);
    assert.deepEqual(page1.body.messages.map((m) => m.id), ids.slice(70));

    const page2 = await request(app, 'GET', `/api/conversations/${g.id}/messages?before=${ids[70]}&limit=100`, {
      token: dave.token,
    });
    assert.deepEqual(page2.body.messages.map((m) => m.id), ids.slice(0, 70));

    const capped = await request(app, 'GET', `/api/conversations/${g.id}/messages?limit=1000`, { token: dave.token });
    assert.equal(capped.body.messages.length, 100);
    const small = await request(app, 'GET', `/api/conversations/${g.id}/messages?limit=3&before=${ids[10]}`, {
      token: dave.token,
    });
    assert.deepEqual(small.body.messages.map((m) => m.id), ids.slice(7, 10));
    const none = await request(app, 'GET', `/api/conversations/${g.id}/messages?before=${ids[0]}`, { token: dave.token });
    assert.deepEqual(none.body.messages, []);

    for (const qs of ['before=abc', 'limit=0', 'limit=-1', 'before=1.5']) {
      const r = await request(app, 'GET', `/api/conversations/${g.id}/messages?${qs}`, { token: dave.token });
      assert.equal(r.status, 400, qs);
    }
  });

  test('conversation list sorted by updatedAt desc with unread counts', async () => {
    const erin = await register(app, 'erin');
    const frank = await register(app, 'frank');
    const gina = await register(app, 'gina');
    const c1 = await dm(app, erin, frank);
    const c2 = await dm(app, erin, gina);
    await send(app, frank, c1.id, 'one');
    await new Promise((r) => setTimeout(r, 5));
    await send(app, gina, c2.id, 'two');
    await send(app, gina, c2.id, 'three');
    await send(app, erin, c2.id, 'mine does not count');

    const list = await request(app, 'GET', '/api/conversations', { token: erin.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.conversations.map((c) => c.id), [c2.id, c1.id]);
    assert.equal(list.body.conversations[0].unreadCount, 2);
    assert.equal(list.body.conversations[1].unreadCount, 1);
    assert.equal(textOf(list.body.conversations[0].lastMessage), 'mine does not count');

    await new Promise((r) => setTimeout(r, 5));
    await send(app, frank, c1.id, 'bump');
    const after2 = await request(app, 'GET', '/api/conversations', { token: erin.token });
    assert.deepEqual(after2.body.conversations.map((c) => c.id), [c1.id, c2.id]);
    // Other users only see their own conversations.
    const frankList = await request(app, 'GET', '/api/conversations', { token: frank.token });
    assert.deepEqual(frankList.body.conversations.map((c) => c.id), [c1.id]);
  });

  test('read receipts only move forward and drive unreadCount', async () => {
    const hank = await register(app, 'hank');
    const ivy = await register(app, 'ivy');
    const c = await dm(app, hank, ivy);
    const m1 = await send(app, hank, c.id, 'a');
    const m2 = await send(app, hank, c.id, 'b');
    const m3 = await send(app, hank, c.id, 'c');
    const get = async () => (await request(app, 'GET', `/api/conversations/${c.id}`, { token: ivy.token })).body.conversation;
    assert.equal((await get()).unreadCount, 3);

    const r = await request(app, 'POST', `/api/conversations/${c.id}/read`, { token: ivy.token, body: { messageId: m2.id } });
    assert.equal(r.status, 204);
    let conv = await get();
    assert.equal(conv.unreadCount, 1);
    assert.equal(conv.readUpTo[ivy.user.id], m2.id);
    assert.equal(conv.readUpTo[hank.user.id], 0);

    // Going backwards is a no-op.
    assert.equal(
      (await request(app, 'POST', `/api/conversations/${c.id}/read`, { token: ivy.token, body: { messageId: m1.id } })).status,
      204
    );
    conv = await get();
    assert.equal(conv.readUpTo[ivy.user.id], m2.id);
    assert.equal(conv.unreadCount, 1);

    await request(app, 'POST', `/api/conversations/${c.id}/read`, { token: ivy.token, body: { messageId: m3.id } });
    assert.equal((await get()).unreadCount, 0);
    // Hank sees Ivy's read position.
    const hankView = (await request(app, 'GET', `/api/conversations/${c.id}`, { token: hank.token })).body.conversation;
    assert.equal(hankView.readUpTo[ivy.user.id], m3.id);
    assert.equal(hankView.unreadCount, 0);

    for (const body of [{}, { messageId: 'x' }, { messageId: -1 }, { messageId: 999999 }]) {
      const res = await request(app, 'POST', `/api/conversations/${c.id}/read`, { token: ivy.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // A message from another conversation cannot be used.
    const other = await dm(app, hank, alice);
    const foreign = await send(app, hank, other.id, 'x');
    const res = await request(app, 'POST', `/api/conversations/${c.id}/read`, { token: ivy.token, body: { messageId: foreign.id } });
    assert.equal(res.status, 400);
  });

  test('a clientId reused in another conversation is rejected', async () => {
    const c1 = await dm(app, carol, dave);
    const c2 = await dm(app, carol, bob);
    const clientId = crypto.randomUUID();
    await send(app, carol, c1.id, 'x', { clientId });
    const res = await request(app, 'POST', `/api/conversations/${c2.id}/messages`, {
      token: carol.token,
      body: { clientId, e2ee: await makeEnvelope(app, carol, c2.id) },
    });
    assert.equal(res.status, 409);
  });
});
