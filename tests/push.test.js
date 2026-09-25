'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startApp, request, register, dm, send, WsClient, PNG_BYTES } = require('./helpers');

function fakeSubscription(name) {
  return {
    endpoint: `https://push.example.com/send/${name}-${crypto.randomUUID()}`,
    expirationTime: null,
    keys: {
      p256dh: crypto.randomBytes(65).toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

describe('push notifications', () => {
  let app;
  let sent = [];
  let respond = async () => ({ statusCode: 201 });
  before(async () => {
    app = await startApp({
      sendPush: (subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, subscription, payload: JSON.parse(payload) });
        return respond(subscription);
      },
    });
  });
  after(() => app.close());
  beforeEach(() => {
    sent = [];
    respond = async () => ({ statusCode: 201 });
  });

  test('public key is served and persisted across restarts', async () => {
    const res = await request(app, 'GET', '/api/push/public-key');
    assert.equal(res.status, 200);
    assert.match(res.body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-vapid-'));
    try {
      const one = await startApp({ dataDir });
      const k1 = (await request(one, 'GET', '/api/push/public-key')).body.publicKey;
      await one.close();
      const two = await startApp({ dataDir });
      const k2 = (await request(two, 'GET', '/api/push/public-key')).body.publicKey;
      await two.close();
      assert.equal(k1, k2);
      assert.ok(fs.existsSync(path.join(dataDir, 'vapid.json')));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('subscribe validation', async () => {
    const a = await register(app);
    assert.equal((await request(app, 'POST', '/api/push/subscribe', { body: { subscription: fakeSubscription('x') } })).status, 401);
    const bad = [
      {},
      { subscription: null },
      { subscription: { endpoint: 'https://push.example.com/x' } },
      { subscription: { ...fakeSubscription('x'), endpoint: 'http://push.example.com/x' } },
      { subscription: { ...fakeSubscription('x'), endpoint: 'https://127.0.0.1/x' } },
      { subscription: { ...fakeSubscription('x'), endpoint: 'https://localhost/x' } },
      { subscription: { ...fakeSubscription('x'), endpoint: 'not a url' } },
      { subscription: { ...fakeSubscription('x'), keys: { p256dh: 'short', auth: 'x' } } },
    ];
    for (const body of bad) {
      const res = await request(app, 'POST', '/api/push/subscribe', { token: a.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const ok = await request(app, 'POST', '/api/push/subscribe', { token: a.token, body: { subscription: fakeSubscription('ok') } });
    assert.equal(ok.status, 204);
  });

  test('offline members get a push, online members and the sender do not', async () => {
    const a = await register(app, undefined, { displayName: 'Alice A' });
    const b = await register(app);
    const c = await register(app);
    const subA = fakeSubscription('a');
    const subB1 = fakeSubscription('b1');
    const subB2 = fakeSubscription('b2');
    const subC = fakeSubscription('c');
    for (const [who, sub] of [[a, subA], [b, subB1], [b, subB2], [c, subC]]) {
      assert.equal((await request(app, 'POST', '/api/push/subscribe', { token: who.token, body: { subscription: sub } })).status, 204);
    }
    const g = (
      await request(app, 'POST', '/api/conversations', { token: a.token, body: { memberIds: [b.user.id, c.user.id] } })
    ).body.conversation;
    const cSocket = await WsClient.connect(app, c.token); // c is online -> no push

    const msg = await send(app, a, g.id, 'Hello there');
    await app.push.idle();
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), [subB1.endpoint, subB2.endpoint].sort());
    assert.deepEqual(sent[0].payload, { title: 'Alice A', body: 'Hello there', conversationId: g.id });
    assert.deepEqual(sent[0].subscription.keys, subB1.endpoint === sent[0].endpoint ? subB1.keys : subB2.keys);
    assert.ok(msg.id);
    await cSocket.close();
  });

  test('group title is used, long text truncated, photo preview', async () => {
    const a = await register(app);
    const b = await register(app);
    const sub = fakeSubscription('b');
    await request(app, 'POST', '/api/push/subscribe', { token: b.token, body: { subscription: sub } });
    const g = (
      await request(app, 'POST', '/api/conversations', { token: a.token, body: { memberIds: [b.user.id], title: 'Family' } })
    ).body.conversation;
    await send(app, a, g.id, 'z'.repeat(500));
    await app.push.idle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.title, 'Family');
    assert.ok(sent[0].payload.body.length <= 100);

    sent = [];
    const att = (
      await request(app, 'POST', '/api/attachments', { token: a.token, raw: PNG_BYTES, headers: { 'Content-Type': 'image/png' } })
    ).body.attachment;
    await send(app, a, g.id, '', { attachmentId: att.id });
    await app.push.idle();
    assert.equal(sent[0].payload.body, 'Photo');
  });

  test('404/410 subscriptions are deleted; other failures keep them and never fail the POST', async () => {
    const a = await register(app);
    const b = await register(app);
    const gone = fakeSubscription('gone');
    const flaky = fakeSubscription('flaky');
    for (const sub of [gone, flaky]) {
      await request(app, 'POST', '/api/push/subscribe', { token: b.token, body: { subscription: sub } });
    }
    respond = async (s) => {
      const err = new Error('push failed');
      err.statusCode = s.endpoint === gone.endpoint ? 410 : 500;
      throw err;
    };
    const c = await dm(app, a, b);
    const res = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: a.token,
      body: { clientId: crypto.randomUUID(), body: 'hi' },
    });
    assert.equal(res.status, 201);
    await app.push.idle();
    assert.equal(sent.length, 2);
    const left = app.store.pushSubscriptionsFor(b.user.id).map((s) => s.endpoint);
    assert.deepEqual(left, [flaky.endpoint]);

    // A synchronously throwing sender is also contained.
    respond = () => {
      throw new Error('boom');
    };
    const res2 = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: a.token,
      body: { clientId: crypto.randomUUID(), body: 'again' },
    });
    assert.equal(res2.status, 201);
    await app.push.idle();
  });

  test('unsubscribe removes only my subscription', async () => {
    const a = await register(app);
    const b = await register(app);
    const sub = fakeSubscription('mine');
    await request(app, 'POST', '/api/push/subscribe', { token: b.token, body: { subscription: sub } });
    // Someone else cannot remove it.
    assert.equal((await request(app, 'POST', '/api/push/unsubscribe', { token: a.token, body: { endpoint: sub.endpoint } })).status, 204);
    assert.equal(app.store.pushSubscriptionsFor(b.user.id).length, 1);
    assert.equal((await request(app, 'POST', '/api/push/unsubscribe', { token: b.token, body: {} })).status, 400);
    assert.equal((await request(app, 'POST', '/api/push/unsubscribe', { token: b.token, body: { endpoint: sub.endpoint } })).status, 204);
    assert.equal(app.store.pushSubscriptionsFor(b.user.id).length, 0);
    const c = await dm(app, a, b);
    await send(app, a, c.id, 'nobody hears this');
    await app.push.idle();
    assert.equal(sent.length, 0);
  });
});
