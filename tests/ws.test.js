'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startApp, request, register, dm, send, WsClient, sleep } = require('./helpers');

describe('websocket', () => {
  let app;
  const sockets = [];
  const connect = async (who) => {
    const ws = await WsClient.connect(app, who.token);
    sockets.push(ws);
    return ws;
  };
  before(async () => {
    app = await startApp();
  });
  after(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await app.close();
  });

  test('hello carries the user', async () => {
    const a = await register(app);
    const ws = WsClient.open(app, a.token);
    sockets.push(ws);
    const hello = await ws.next('hello');
    assert.deepEqual(hello.user, a.user);
  });

  test('bad or missing token closes with 4401', async () => {
    for (const token of ['bogus', '']) {
      const ws = WsClient.open(app, token);
      const closed = await ws.waitClose();
      assert.equal(closed.code, 4401);
    }
  });

  test('other paths are not upgraded', async () => {
    const a = await register(app);
    const ws = new WebSocket(`${app.url.replace('http', 'ws')}/nope?token=${a.token}`);
    const err = await new Promise((resolve) => {
      ws.on('error', resolve);
      ws.on('open', () => resolve(null));
    });
    assert.ok(err);
  });

  test('ping gets pong', async () => {
    const a = await register(app);
    const ws = await connect(a);
    ws.send({ type: 'ping' });
    await ws.next('pong');
    // Junk frames are ignored, socket stays usable.
    ws.ws.send('not json');
    ws.send({ type: 'unknown' });
    ws.send({ type: 'ping' });
    await ws.next('pong');
  });

  test('messages fan out to every member socket, including all of the sender devices', async () => {
    const a = await register(app);
    const b = await register(app);
    const c = await register(app);
    const outsider = await register(app);
    const g = (
      await request(app, 'POST', '/api/conversations', {
        token: a.token,
        body: { memberIds: [b.user.id, c.user.id], title: 'Crew' },
      })
    ).body.conversation;
    const a1 = await connect(a);
    const a2 = await connect(a);
    const b1 = await connect(b);
    const c1 = await connect(c);
    const o1 = await connect(outsider);

    const msg = await send(app, a, g.id, 'hey all');
    for (const ws of [a1, a2, b1, c1]) {
      const ev = await ws.next('message', (f) => f.message.id === msg.id);
      assert.deepEqual(ev.message, msg);
    }
    assert.ok(await o1.none('message'));
  });

  test('conversation events go to every member shaped for them', async () => {
    const a = await register(app);
    const b = await register(app);
    const c = await register(app);
    const a1 = await connect(a);
    const b1 = await connect(b);
    const c1 = await connect(c);
    const res = await request(app, 'POST', '/api/conversations', { token: a.token, body: { memberIds: [b.user.id] } });
    const conv = res.body.conversation;
    const evA = await a1.next('conversation', (f) => f.conversation.id === conv.id);
    const evB = await b1.next('conversation', (f) => f.conversation.id === conv.id);
    assert.deepEqual(evA.conversation, conv);
    assert.equal(evB.conversation.id, conv.id);
    assert.ok(await c1.none('conversation'));

    // Dedup (200) does not re-announce.
    await request(app, 'POST', '/api/conversations', { token: b.token, body: { memberIds: [a.user.id] } });
    assert.ok(await a1.none('conversation', (f) => f.conversation.id === conv.id));

    // unreadCount is per member.
    await send(app, a, conv.id, 'x');
    await b1.next('message');
    await request(app, 'PATCH', '/api/me', { token: a.token, body: { displayName: 'Renamed' } });
    const upd = await b1.next('conversation', (f) => f.conversation.members.some((m) => m.displayName === 'Renamed'));
    assert.equal(upd.conversation.unreadCount, 1);
    const updA = await a1.next('conversation', (f) => f.conversation.members.some((m) => m.displayName === 'Renamed'));
    assert.equal(updA.conversation.unreadCount, 0);
  });

  test('typing is forwarded to other members only, and only for members', async () => {
    const a = await register(app);
    const b = await register(app);
    const outsider = await register(app);
    const conv = await dm(app, a, b);
    const a1 = await connect(a);
    const a2 = await connect(a);
    const b1 = await connect(b);
    const o1 = await connect(outsider);
    a1.send({ type: 'typing', conversationId: conv.id });
    const ev = await b1.next('typing');
    assert.deepEqual(ev, { type: 'typing', conversationId: conv.id, userId: a.user.id });
    assert.ok(await a2.none('typing'));
    assert.ok(await a1.none('typing', () => true, 0));
    // Outsider cannot type into it.
    o1.send({ type: 'typing', conversationId: conv.id });
    assert.ok(await b1.none('typing', (f) => f.userId === outsider.user.id));
    assert.ok(await o1.none('typing', () => true, 0));
  });

  test('read events go to all members', async () => {
    const a = await register(app);
    const b = await register(app);
    const conv = await dm(app, a, b);
    const m = await send(app, a, conv.id, 'read me');
    const a1 = await connect(a);
    const b1 = await connect(b);
    await request(app, 'POST', `/api/conversations/${conv.id}/read`, { token: b.token, body: { messageId: m.id } });
    for (const ws of [a1, b1]) {
      const ev = await ws.next('read');
      assert.deepEqual(ev, { type: 'read', conversationId: conv.id, userId: b.user.id, messageId: m.id });
    }
    // A no-op (not forward) read is not broadcast.
    await request(app, 'POST', `/api/conversations/${conv.id}/read`, { token: b.token, body: { messageId: m.id } });
    assert.ok(await a1.none('read'));
  });

  test('presence: online on first socket, offline when the last closes, only to contacts', async () => {
    const a = await register(app);
    const b = await register(app);
    const stranger = await register(app);
    await dm(app, a, b);
    const b1 = await connect(b);
    const s1 = await connect(stranger);

    const a1 = await connect(a);
    const on = await b1.next('presence', (f) => f.userId === a.user.id);
    assert.equal(on.online, true);
    // The new socket learns that b is already online.
    const already = await a1.next('presence', (f) => f.userId === b.user.id);
    assert.equal(already.online, true);

    const a2 = await connect(a);
    assert.ok(await b1.none('presence', (f) => f.userId === a.user.id));
    await a1.close();
    assert.ok(await b1.none('presence', (f) => f.userId === a.user.id));
    await a2.close();
    const off = await b1.next('presence', (f) => f.userId === a.user.id);
    assert.equal(off.online, false);
    assert.ok(await s1.none('presence', () => true, 0));
  });

  test('logout closes that session sockets with 4401', async () => {
    const a = await register(app);
    const ws = await connect(a);
    await request(app, 'POST', '/api/logout', { token: a.token });
    const closed = await ws.waitClose();
    assert.equal(closed.code, 4401);
  });

  test('heartbeat terminates dead sockets', async () => {
    const hbApp = await startApp({ heartbeatMs: 100 });
    try {
      const a = await register(hbApp);
      const b = await register(hbApp);
      await dm(hbApp, a, b);
      const b1 = await WsClient.connect(hbApp, b.token);
      // A client that never answers pings: ws answers pings automatically, so disable that.
      const raw = new WebSocket(`${hbApp.url.replace('http', 'ws')}/ws?token=${a.token}`, { autoPong: false });
      await new Promise((r) => raw.on('open', r));
      await b1.next('presence', (f) => f.userId === a.user.id && f.online);
      assert.equal(hbApp.hub.isOnline(a.user.id), true);
      await b1.next('presence', (f) => f.userId === a.user.id && !f.online, 2000);
      assert.equal(hbApp.hub.isOnline(a.user.id), false);
      raw.terminate();
      await b1.close();
    } finally {
      await hbApp.close();
    }
  });

  test('close() shuts down open sockets', async () => {
    const tmp = await startApp();
    const a = await register(tmp);
    const ws = await WsClient.connect(tmp, a.token);
    await tmp.close();
    await ws.waitClose();
    await sleep(10);
  });
});
