'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startApp, request, register, dm, send, postEncrypted, makeEnvelope, uploadEncrypted, WsClient } = require('./helpers');
const { pushPayload, MAX_PUSH_PAYLOAD_BYTES } = require('../server/push');

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
    assert.deepEqual(sent[0].payload, {
      conversationId: g.id,
      messageId: msg.id,
      senderId: a.user.id,
      clientId: msg.clientId,
      title: 'Alice A',
      e2ee: msg.e2ee,
    });
    assert.ok(!('body' in sent[0].payload));
    assert.deepEqual(sent[0].subscription.keys, subB1.endpoint === sent[0].endpoint ? subB1.keys : subB2.keys);
    assert.ok(msg.id);
    await cSocket.close();
  });

  test('group title is used; the envelope is included only while the payload stays <= 3000 bytes', async () => {
    const a = await register(app);
    const b = await register(app);
    const sub = fakeSubscription('b');
    await request(app, 'POST', '/api/push/subscribe', { token: b.token, body: { subscription: sub } });
    const g = (
      await request(app, 'POST', '/api/conversations', { token: a.token, body: { memberIds: [b.user.id], title: 'Family' } })
    ).body.conversation;
    const file = await uploadEncrypted(app, a);
    const small = await send(app, a, g.id, 'z'.repeat(500), { attachmentIds: [file.id] });
    await app.push.idle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.title, 'Family');
    assert.deepEqual(sent[0].payload.e2ee, small.e2ee);
    assert.ok(!('attachments' in sent[0].payload));

    // A big envelope (a long message, many recipients) is left out; the app shows "New message".
    sent = [];
    const e2ee = await makeEnvelope(app, a, g.id);
    e2ee.ct = crypto.randomBytes(3000).toString('base64url');
    const res = await request(app, 'POST', `/api/conversations/${g.id}/messages`, { token: a.token, body: { clientId: crypto.randomUUID(), e2ee } });
    assert.equal(res.status, 201);
    await app.push.idle();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload, {
      conversationId: g.id,
      messageId: res.body.message.id,
      senderId: a.user.id,
      clientId: res.body.message.clientId,
      title: 'Family',
    });
  });

  test('push payload size boundary: exactly 3000 bytes keeps the envelope, 3001 drops it', () => {
    assert.equal(MAX_PUSH_PAYLOAD_BYTES, 3000);
    const message = (ct) => ({
      id: 7,
      conversationId: 'c_x',
      senderId: 'u_x',
      clientId: 'k',
      e2ee: { v: 1, kind: 'message', senderKeyId: 'K'.repeat(43), eph: 'e', iv: 'i', ct, keys: {}, sig: 's' },
    });
    const sizeWith = (n) => Buffer.byteLength(JSON.stringify({ conversationId: 'c_x', messageId: 7, senderId: 'u_x', clientId: 'k', title: 'Zoë', e2ee: message('A'.repeat(n)).e2ee }));
    const n = 3000 - sizeWith(0);
    assert.equal(sizeWith(n), 3000);
    const fits = JSON.parse(pushPayload(message('A'.repeat(n)), 'Zoë'));
    assert.equal(fits.e2ee.ct.length, n);
    assert.equal(Buffer.byteLength(pushPayload(message('A'.repeat(n)), 'Zoë')), 3000);
    const over = JSON.parse(pushPayload(message('A'.repeat(n + 1)), 'Zoë'));
    assert.deepEqual(over, { conversationId: 'c_x', messageId: 7, senderId: 'u_x', clientId: 'k', title: 'Zoë' });
    // Multi-byte titles count in bytes, not characters.
    const emojiTitle = JSON.parse(pushPayload(message('A'.repeat(n - 1)), 'Zoë😀'));
    assert.equal(emojiTitle.e2ee, undefined);
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
    const res = await postEncrypted(app, a, c.id, 'hi');
    assert.equal(res.status, 201);
    await app.push.idle();
    assert.equal(sent.length, 2);
    const left = app.store.pushSubscriptionsFor(b.user.id).map((s) => s.endpoint);
    assert.deepEqual(left, [flaky.endpoint]);

    // A synchronously throwing sender is also contained.
    respond = () => {
      throw new Error('boom');
    };
    const res2 = await postEncrypted(app, a, c.id, 'again');
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
