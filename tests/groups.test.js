'use strict';

// Group management and system messages (docs/PROTOCOL.md, "Groups").

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, request, register, send, postEncrypted, makeEnvelope, react, edit, textOf, uploadEncrypted, WsClient } = require('./helpers');

describe('groups: rename, add, leave, system messages', () => {
  let app;
  let pushes = [];
  let alice;
  let bob;
  let carol;
  let dave;

  const group = async (owner, others, title) =>
    (await request(app, 'POST', '/api/conversations', { token: owner.token, body: { memberIds: others.map((o) => o.user.id), title } })).body
      .conversation;
  const rename = (who, id, title) => request(app, 'PATCH', `/api/conversations/${id}`, { token: who.token, body: { title } });
  const add = (who, id, users) =>
    request(app, 'POST', `/api/conversations/${id}/members`, { token: who.token, body: { userIds: users.map((u) => (u.user ? u.user.id : u)) } });
  const leave = (who, id) => request(app, 'DELETE', `/api/conversations/${id}/members/me`, { token: who.token });
  const list = async (who, id, qs = '') => request(app, 'GET', `/api/conversations/${id}/messages${qs}`, { token: who.token });
  const convFor = async (who, id) => (await request(app, 'GET', `/api/conversations/${id}`, { token: who.token })).body.conversation;
  const post = (who, id, { body = '', ...extra } = {}) => postEncrypted(app, who, id, body, extra);

  before(async () => {
    app = await startApp({
      sendPush: (sub, payload) => {
        pushes.push(JSON.parse(payload));
        return Promise.resolve({ statusCode: 201 });
      },
    });
    alice = await register(app, undefined, { displayName: 'Alice' });
    bob = await register(app, undefined, { displayName: 'Bob' });
    carol = await register(app, undefined, { displayName: 'Carol' });
    dave = await register(app, undefined, { displayName: 'Dave' });
    const sub = () => ({
      endpoint: `https://push.example.com/${crypto.randomUUID()}`,
      keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    });
    for (const u of [alice, bob, carol, dave]) {
      await request(app, 'POST', '/api/push/subscribe', { token: u.token, body: { subscription: sub() } });
    }
  });
  after(() => app.close());

  test('rename adds a renamed system message; groups only', async () => {
    const g = await group(alice, [bob], 'Hikers');
    const ws = await WsClient.connect(app, bob.token);
    try {
      pushes = [];
      const res = await rename(alice, g.id, '  Weekend hikers ');
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation.title, 'Weekend hikers');
      const convEv = await ws.next('conversation', (f) => f.conversation.id === g.id);
      assert.equal(convEv.conversation.title, 'Weekend hikers');
      const msgEv = await ws.next('message', (f) => f.message.conversationId === g.id);
      const sys = msgEv.message;
      assert.equal(sys.senderId, alice.user.id);
      assert.equal(sys.body, '');
      assert.equal(sys.attachment, null);
      assert.deepEqual(sys.system, { type: 'renamed', userIds: [], title: 'Weekend hikers' });
      assert.deepEqual((await list(bob, g.id)).body.messages.map((m) => m.id), [sys.id]);

      // System lines don't count as unread and don't push.
      const bobView = await convFor(bob, g.id);
      assert.equal(bobView.unreadCount, 0);
      assert.equal(bobView.lastMessage.id, sys.id);
      await app.push.idle();
      assert.equal(pushes.length, 0);

      // Same name: no new line.
      assert.equal((await rename(bob, g.id, 'Weekend hikers')).status, 200);
      assert.equal((await list(bob, g.id)).body.messages.length, 1);

      for (const title of ['', '   ', null, 5, 'x'.repeat(81)]) {
        assert.equal((await rename(alice, g.id, title)).status, 400, JSON.stringify(title));
      }
      assert.equal((await request(app, 'PATCH', `/api/conversations/${g.id}`, { token: alice.token, body: {} })).status, 400);
      assert.equal((await rename(carol, g.id, 'Mine')).status, 403);
      assert.equal((await rename(alice, 'c_missing', 'x')).status, 404);
      const oneToOne = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [bob.user.id] } })).body
        .conversation;
      assert.equal((await rename(alice, oneToOne.id, 'Us')).status, 400);

      // System messages can't be reacted to, replied to, edited or unsent.
      const base = `/api/conversations/${g.id}/messages/${sys.id}`;
      assert.equal((await react(app, bob, g.id, sys.id, '👍')).status, 400);
      assert.equal((await post(bob, g.id, { body: 'hi', replyToId: sys.id })).status, 400);
      assert.equal((await edit(app, alice, g.id, sys.id, 'x')).status, 400);
      assert.equal((await request(app, 'DELETE', base, { token: alice.token })).status, 400);
    } finally {
      await ws.close();
    }
  });

  test('added members see history only from when they joined', async () => {
    const g = await group(alice, [bob], 'Book club');
    const photo = await uploadEncrypted(app, alice);
    const video = await uploadEncrypted(app, alice);
    const before1 = await send(app, alice, g.id, 'before carol joined');
    const before2 = await send(app, alice, g.id, '', { attachmentIds: [video.id, photo.id] });
    const aliceWs = await WsClient.connect(app, alice.token);
    const carolWs = await WsClient.connect(app, carol.token);
    try {
      pushes = [];
      const res = await add(bob, g.id, [carol, carol, bob]);
      assert.equal(res.status, 200);
      const members = res.body.conversation.members.map((m) => m.id);
      assert.deepEqual(members, [alice.user.id, bob.user.id, carol.user.id]);

      // Everyone, including the newcomer, gets the conversation and the system line.
      const carolConvEv = await carolWs.next('conversation', (f) => f.conversation.id === g.id);
      assert.equal(carolConvEv.conversation.members.length, 3);
      assert.equal(carolConvEv.conversation.unreadCount, 0);
      const aliceConvEv = await aliceWs.next('conversation', (f) => f.conversation.id === g.id);
      assert.equal(aliceConvEv.conversation.members.length, 3);
      const sys = (await carolWs.next('message', (f) => f.message.conversationId === g.id)).message;
      assert.deepEqual(sys.system, { type: 'member_added', userIds: [carol.user.id], title: null });
      assert.equal(sys.senderId, bob.user.id);
      assert.equal((await aliceWs.next('message', (f) => f.message.id === sys.id)).message.id, sys.id);
      // Presence: carol learns alice is online and vice versa.
      await carolWs.next('presence', (f) => f.userId === alice.user.id && f.online);
      await aliceWs.next('presence', (f) => f.userId === carol.user.id && f.online);

      // Carol's view starts at the system line.
      const carolList = (await list(carol, g.id)).body.messages;
      assert.deepEqual(carolList.map((m) => m.id), [sys.id]);
      assert.deepEqual((await list(carol, g.id, `?before=${sys.id}`)).body.messages, []);
      let carolConv = await convFor(carol, g.id);
      assert.equal(carolConv.lastMessage.id, sys.id);
      assert.equal(carolConv.unreadCount, 0);
      const listed = (await request(app, 'GET', '/api/conversations', { token: carol.token })).body.conversations.find((c) => c.id === g.id);
      assert.equal(listed.lastMessage.id, sys.id);
      // Alice and Bob still see everything.
      assert.deepEqual((await list(alice, g.id)).body.messages.map((m) => m.id), [before1.id, before2.id, sys.id]);

      // Older messages are out of reach for Carol in every way.
      for (const id of [video.id, photo.id]) {
        assert.equal((await request(app, 'GET', `/api/attachments/${id}`, { token: carol.token })).status, 403, id);
        assert.equal((await request(app, 'GET', `/api/attachments/${id}`, { token: alice.token })).status, 200, id);
      }
      const base = `/api/conversations/${g.id}/messages/${before1.id}`;
      assert.equal((await react(app, carol, g.id, before1.id, '👍')).status, 404);
      assert.equal((await post(carol, g.id, { body: 'quote', replyToId: before1.id })).status, 400);
      assert.equal((await request(app, 'POST', `/api/conversations/${g.id}/read`, { token: carol.token, body: { messageId: before1.id } })).status, 400);
      // Changes to old messages are not sent to her either.
      // Reactions to it are addressed to the members who can see it: not Carol.
      const everyone = await request(app, 'PUT', `${base}/reaction`, {
        token: bob.token,
        body: { clientId: crypto.randomUUID(), e2ee: await makeEnvelope(app, bob, g.id, { kind: `reaction:${before1.id}` }) },
      });
      assert.equal(everyone.status, 409);
      assert.deepEqual(everyone.body, { error: 'members_changed', members: [alice.user.id, bob.user.id] });
      assert.equal((await react(app, bob, g.id, before1.id, '❤️')).status, 200);
      const reacted = await aliceWs.next('message', (f) => f.message.id === before1.id);
      assert.deepEqual(Object.keys(reacted.message.reactions), [bob.user.id]);
      assert.deepEqual(Object.keys(reacted.message.reactions[bob.user.id].keys).sort(), [alice.user.id, bob.user.id].sort());
      assert.ok(await carolWs.none('message', (f) => f.message.id === before1.id));

      // New messages reach her normally and count as unread.
      const after1 = await send(app, alice, g.id, 'welcome carol');
      await carolWs.next('message', (f) => f.message.id === after1.id);
      carolConv = await convFor(carol, g.id);
      assert.equal(carolConv.unreadCount, 1);
      assert.equal(carolConv.lastMessage.id, after1.id);
      assert.equal((await post(carol, g.id, { body: 'thanks', replyToId: after1.id })).status, 201);
      assert.equal((await react(app, carol, g.id, sys.id, '👍')).status, 400);
      // The newcomer's own messages and reactions to new messages include everyone.
      assert.equal((await react(app, carol, g.id, after1.id, '🙏')).status, 200);
      // No push for the system line; alice and bob got pushes only if offline (bob is offline).
      await app.push.idle();
      assert.deepEqual(
        pushes.map((p) => textOf(p.e2ee)),
        ['welcome carol', 'thanks']
      );
    } finally {
      await aliceWs.close();
      await carolWs.close();
    }
  });

  test('add members validation', async () => {
    const g = await group(alice, [bob], 'Validation');
    assert.equal((await add(alice, g.id, [])).status, 400);
    assert.equal((await add(alice, g.id, ['u_missing'])).status, 400);
    assert.equal((await add(alice, g.id, [42])).status, 400);
    assert.equal((await request(app, 'POST', `/api/conversations/${g.id}/members`, { token: alice.token, body: { userIds: 'x' } })).status, 400);
    assert.equal((await add(carol, g.id, [dave])).status, 403);
    assert.equal((await add(alice, 'c_missing', [dave])).status, 404);
    const oneToOne = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [dave.user.id] } })).body
      .conversation;
    assert.equal((await add(alice, oneToOne.id, [carol])).status, 400);
    assert.equal((await add(alice, g.id, [alice])).status, 400); // nobody to add
    // Adding someone already there changes nothing (safe to retry).
    const same = await add(alice, g.id, [bob, alice]);
    assert.equal(same.status, 200);
    assert.equal(same.body.conversation.members.length, 2);
    assert.deepEqual((await list(alice, g.id)).body.messages, []);
  });

  test('leave: conversation_removed for me, member_left for the others', async () => {
    const g = await group(alice, [bob, carol], 'Leaving');
    await send(app, alice, g.id, 'hi all');
    const carolWs = await WsClient.connect(app, carol.token);
    const aliceWs = await WsClient.connect(app, alice.token);
    try {
      const res = await leave(carol, g.id);
      assert.equal(res.status, 204);
      const removed = await carolWs.next('conversation_removed');
      assert.deepEqual(removed, { type: 'conversation_removed', conversationId: g.id });
      const convEv = await aliceWs.next('conversation', (f) => f.conversation.id === g.id);
      assert.deepEqual(convEv.conversation.members.map((m) => m.id), [alice.user.id, bob.user.id]);
      const sys = (await aliceWs.next('message', (f) => f.message.conversationId === g.id)).message;
      assert.equal(sys.senderId, carol.user.id);
      assert.deepEqual(sys.system, { type: 'member_left', userIds: [carol.user.id], title: null });
      assert.ok(await carolWs.none('message', (f) => f.message.id === sys.id));

      const mine = (await request(app, 'GET', '/api/conversations', { token: carol.token })).body.conversations;
      assert.ok(!mine.some((c) => c.id === g.id));
      assert.equal((await request(app, 'GET', `/api/conversations/${g.id}`, { token: carol.token })).status, 403);
      assert.equal((await post(carol, g.id, { body: 'still here?' })).status, 403);
      assert.equal((await leave(carol, g.id)).status, 403);
      // Messages after she left don't reach her.
      const later = await send(app, bob, g.id, 'bye carol');
      assert.ok(await carolWs.none('message', (f) => f.message.id === later.id));

      // Rejoining starts a fresh window of history.
      await add(alice, g.id, [carol]);
      const carolList = (await list(carol, g.id)).body.messages;
      assert.equal(carolList.length, 1);
      assert.equal(carolList[0].system.type, 'member_added');

      const oneToOne = (await request(app, 'POST', '/api/conversations', { token: alice.token, body: { memberIds: [carol.user.id] } })).body
        .conversation;
      assert.equal((await leave(alice, oneToOne.id)).status, 400);
      assert.equal((await leave(dave, g.id)).status, 403);
      assert.equal((await request(app, 'DELETE', `/api/conversations/${g.id}/members/${bob.user.id}`, { token: alice.token })).status, 404);
    } finally {
      await carolWs.close();
      await aliceWs.close();
    }
  });
});
