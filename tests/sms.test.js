'use strict';

// Texting phone numbers via Twilio (docs/PROTOCOL.md, "Text messages to any phone number").
// A local fake Twilio API server stands in for api.twilio.com (sms.apiBase points at it) and
// also serves the MMS media that incoming webhooks reference.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { startApp, request, register, dm, send, uniqueName, WsClient, PNG_BYTES, quietLog } = require('./helpers');
const {
  normalizePhone,
  normalizeInboundSender,
  formatPhone,
  resolveSmsConfig,
  smsOptionsFromEnv,
  mapTwilioStatus,
  smsErrorMessage,
} = require('../server/sms');
const { SCHEMA_VERSION } = require('../server/db');

const SID = 'AC_FAKE_TEST_ACCOUNT';
const TOKEN = 'test-auth-token-0123456789abcdef';
const PUBLIC_URL = 'https://tealtalk.example.com';
const CHRIS_NUMBER = '+15550001111';
const MAYA_NUMBER = '+15550002222';
const GHOST_NUMBER = '+15550003333'; // mapped to a username nobody registered

// Twilio's documented algorithm, written independently of server/sms.js: take the full URL,
// append each POST parameter's name and value sorted by name, HMAC-SHA1 with the auth token, base64.
function twilioSign(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function webhook(app, pathname, params, { signature, token = TOKEN, url } = {}) {
  const sig = signature !== undefined ? signature : twilioSign(token, url || PUBLIC_URL + pathname, params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sig !== null) headers['X-Twilio-Signature'] = sig;
  return request(app, 'POST', pathname, { raw: new URLSearchParams(params).toString(), headers });
}

const smsSid = (prefix = 'SM') => prefix + crypto.randomBytes(16).toString('hex');

function inboundParams(extra = {}) {
  return {
    ToCountry: 'US',
    SmsMessageSid: extra.MessageSid || smsSid(),
    NumMedia: '0',
    SmsSid: extra.MessageSid || smsSid(),
    SmsStatus: 'received',
    Body: 'Hello from a flip phone',
    To: CHRIS_NUMBER,
    From: '+15557654321',
    MessageSid: smsSid(),
    AccountSid: SID,
    ApiVersion: '2010-04-01',
    ...extra,
  };
}

function fakeSubscription(name) {
  return {
    endpoint: `https://push.example.com/send/${name}-${crypto.randomUUID()}`,
    keys: {
      p256dh: crypto.randomBytes(65).toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

/** A tiny stand-in for api.twilio.com. */
function startFakeTwilio() {
  const fake = {
    sent: [], // { auth, params } per Messages.json POST
    mediaRequests: [], // { path, auth }
    // Per-request behaviour for Messages.json; default accepts and returns a new sid.
    respond: null,
    dropNext: 0, // destroy the socket for this many Messages.json requests (network error)
    media: new Map(), // name -> { type, body }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || null;
      const m = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        if (fake.dropNext > 0) {
          fake.dropNext -= 1;
          fake.sent.push({ auth, params: null, dropped: true });
          req.socket.destroy();
          return;
        }
        const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        const entry = { auth, params, accountSid: decodeURIComponent(m[1]), contentType: req.headers['content-type'] };
        fake.sent.push(entry);
        const out = fake.respond ? fake.respond(entry) : null;
        const status = out ? out.status : 201;
        const body = out ? out.body : { sid: smsSid(), status: 'queued', to: params.To, from: params.From };
        entry.sid = body.sid;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      // Twilio media: needs Basic auth, then redirects to a "CDN" that doesn't.
      const media = /^\/2010-04-01\/Accounts\/[^/]+\/Messages\/[^/]+\/Media\/([^/]+)$/.exec(url.pathname);
      if (media) {
        fake.mediaRequests.push({ path: url.pathname, auth });
        const expected = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`;
        if (auth !== expected) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(302, { Location: `/cdn/${media[1]}` });
        res.end();
        return;
      }
      const cdn = /^\/cdn\/([^/]+)$/.exec(url.pathname);
      if (cdn && fake.media.has(cdn[1])) {
        fake.mediaRequests.push({ path: url.pathname, auth });
        const { type, body } = fake.media.get(cdn[1]);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.url = `http://127.0.0.1:${server.address().port}`;
      fake.mediaUrl = (name) => `${fake.url}/2010-04-01/Accounts/${SID}/Messages/${smsSid('MM')}/Media/${name}`;
      fake.close = () =>
        new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections();
        });
      fake.reset = () => {
        fake.sent = [];
        fake.mediaRequests = [];
        fake.respond = null;
        fake.dropNext = 0;
      };
      resolve(fake);
    });
  });
}

function smsOptions(fake, extra = {}) {
  return {
    accountSid: SID,
    authToken: TOKEN,
    numbers: { [CHRIS_NUMBER]: 'sms_chris', [MAYA_NUMBER]: 'sms_maya', [GHOST_NUMBER]: 'sms_ghost' },
    publicUrl: PUBLIC_URL,
    apiBase: fake.url,
    defaultCountryCode: '1',
    retryDelaysMs: [10, 20],
    ...extra,
  };
}

/** Fetches a signed media URL (made for PUBLIC_URL) from the test app instead. */
function fetchFromApp(app, publicUrl) {
  return fetch(app.url + publicUrl.slice(PUBLIC_URL.length));
}

// ---------------------------------------------------------------------------------------

describe('sms: pure helpers', () => {
  test('phone normalization', () => {
    const ok = [
      ['(555) 123-4567', '+15551234567'],
      ['555.123.4567', '+15551234567'],
      ['555-123-4567', '+15551234567'],
      ['1 555 123 4567', '+15551234567'],
      ['15551234567', '+15551234567'],
      ['+1 (555) 123-4567', '+15551234567'],
      ['  +15551234567  ', '+15551234567'],
      ['+44 7700 900123', '+447700900123'],
      ['0044 7700 900123', '+447700900123'],
      ['+61 412 345 678', '+61412345678'],
    ];
    for (const [input, want] of ok) assert.equal(normalizePhone(input, '1'), want, input);
    const bad = ['', '   ', '123', '555-1234', '+1 555 123 456', '+1 055 123 4567', '555123456789', 'call me', '+1555abc4567',
      '+0123456789', '+1234567890123456', null, 42, '5551234567 ext 9'];
    for (const input of bad) assert.equal(normalizePhone(input, '1'), null, String(input));
    // Other default country codes drop a national trunk 0.
    assert.equal(normalizePhone('07700 900123', '44'), '+447700900123');
    // Without a default country code a + is required.
    assert.equal(normalizePhone('5551234567', ''), null);
    assert.equal(normalizePhone('+15551234567', ''), '+15551234567');
    // Inbound senders: E.164 or short codes.
    assert.equal(normalizeInboundSender('+15551234567'), '+15551234567');
    assert.equal(normalizeInboundSender('72345'), '72345');
    assert.equal(normalizeInboundSender('898287'), '898287');
    assert.equal(normalizeInboundSender('5551234567'), null);
    assert.equal(normalizeInboundSender('ACME'), null);
    assert.equal(formatPhone('+15551234567'), '(555) 123-4567');
    assert.equal(formatPhone('+447700900123'), '+447700900123');
  });

  test('config: enabled only with sid, token, numbers and public URL', () => {
    const full = { accountSid: SID, authToken: TOKEN, numbers: `${CHRIS_NUMBER}=Chris, ${MAYA_NUMBER}=maya`, publicUrl: 'https://x.example.com/' };
    const on = resolveSmsConfig(full);
    assert.equal(on.enabled, true);
    assert.equal(on.publicUrl, 'https://x.example.com');
    assert.equal(on.apiBase, 'https://api.twilio.com');
    assert.equal(on.byUser.get('chris'), CHRIS_NUMBER);
    assert.equal(on.numbers.get(MAYA_NUMBER), 'maya');
    for (const key of ['accountSid', 'authToken', 'numbers', 'publicUrl']) {
      const off = resolveSmsConfig({ ...full, [key]: '' });
      assert.equal(off.enabled, false, key);
      assert.equal(off.missing.length, 1);
    }
    assert.equal(resolveSmsConfig(null).enabled, false);
    assert.equal(resolveSmsConfig({ ...full, numbers: 'garbage' }).enabled, false);
    assert.equal(resolveSmsConfig({ ...full, publicUrl: 'ftp://x' }).enabled, false);
    const env = smsOptionsFromEnv({
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      SMS_NUMBERS: `${CHRIS_NUMBER}=chris`,
      PUBLIC_URL: 'https://tealtalk.up.example.app',
      SMS_DEFAULT_COUNTRY_CODE: '44',
    });
    const fromEnv = resolveSmsConfig(env);
    assert.equal(fromEnv.enabled, true);
    assert.equal(fromEnv.defaultCountryCode, '44');
  });

  test('status mapping and error text', () => {
    for (const s of ['queued', 'accepted', 'sending']) assert.equal(mapTwilioStatus(s), 'queued');
    assert.equal(mapTwilioStatus('sent'), 'sent');
    assert.equal(mapTwilioStatus('delivered'), 'delivered');
    assert.equal(mapTwilioStatus('failed'), 'failed');
    assert.equal(mapTwilioStatus('undelivered'), 'failed');
    assert.equal(mapTwilioStatus('toString'), null);
    assert.equal(smsErrorMessage('21610'), 'This number has opted out (they replied STOP)');
    for (const c of ['30003', '30005', '30006']) assert.equal(smsErrorMessage(c), "Couldn't be delivered to this number");
    assert.equal(smsErrorMessage('99999', 'Something odd'), 'Something odd');
    assert.match(smsErrorMessage('99999'), /99999/);
  });
});

describe('sms: disabled by default', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('/api/me reports sms off, SMS routes refuse', async () => {
    const a = await register(app);
    const me = await request(app, 'GET', '/api/me', { token: a.token });
    assert.deepEqual(me.body.sms, { enabled: false, number: null });
    const create = await request(app, 'POST', '/api/sms/conversations', { token: a.token, body: { phone: '5551234567' } });
    assert.equal(create.status, 403);
    const hook = await webhook(app, '/api/sms/twilio', inboundParams());
    assert.equal(hook.status, 404);
    assert.equal((await webhook(app, '/api/sms/twilio/status', { MessageSid: smsSid(), MessageStatus: 'sent' })).status, 404);
    assert.equal((await request(app, 'GET', '/api/sms/media/a_x?exp=1&sig=x')).status, 404);
    // Registration needs no signup code.
    assert.equal((await request(app, 'POST', '/api/register', { body: { username: uniqueName(), password: 'correct horse battery' } })).status, 201);
  });

  test('startup log says SMS is off without leaking anything', async () => {
    const lines = [];
    const log = { ...quietLog, info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
    const other = await startApp({ log, sms: { accountSid: SID, authToken: TOKEN, numbers: `${CHRIS_NUMBER}=chris` } });
    await other.close();
    const text = lines.join('\n');
    assert.match(text, /SMS texting is off/);
    assert.match(text, /PUBLIC_URL/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
  });
});

describe('sms: enabled', () => {
  let fake;
  let app;
  let chris;
  let maya;
  let plain;
  let pushes = [];
  let logLines = [];

  before(async () => {
    fake = await startFakeTwilio();
    const log = { ...quietLog, info: (...a) => logLines.push(a.join(' ')) };
    app = await startApp({
      sms: smsOptions(fake),
      log,
      sendPush: (subscription, payload) => {
        pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
        return Promise.resolve({ statusCode: 201 });
      },
    });
    chris = await register(app, 'sms_chris', { displayName: 'Chris' });
    maya = await register(app, 'sms_maya', { displayName: 'Maya' });
    plain = await register(app, uniqueName('plain'));
  });
  after(async () => {
    await app.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.reset();
    pushes = [];
  });

  async function smsConversation(user, phone, title) {
    const res = await request(app, 'POST', '/api/sms/conversations', { token: user.token, body: { phone, title } });
    assert.ok(res.status === 201 || res.status === 200, res.text);
    return res.body.conversation;
  }

  async function sendAndSettle(user, convId, body, extra) {
    const message = await send(app, user, convId, body, extra);
    await app.sms.idle();
    return message;
  }

  test('startup log names the texting users, never secrets', () => {
    const text = logLines.join('\n');
    assert.match(text, /SMS texting is on/);
    assert.match(text, /sms_chris \+15550001111/);
    assert.match(text, /sms_ghost \+15550003333 \(no account yet\)/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
    assert.doesNotMatch(text, new RegExp(SID));
  });

  test('/api/me sms flag is per user', async () => {
    const c = await request(app, 'GET', '/api/me', { token: chris.token });
    assert.deepEqual(c.body.sms, { enabled: true, number: CHRIS_NUMBER });
    assert.deepEqual(c.body.user, chris.user);
    const p = await request(app, 'GET', '/api/me', { token: plain.token });
    assert.deepEqual(p.body.sms, { enabled: false, number: null });
  });

  test('create SMS conversation: shape, dedupe, 403 without a number, 400 bad number', async () => {
    const ws = await WsClient.connect(app, chris.token);
    try {
      const res = await request(app, 'POST', '/api/sms/conversations', {
        token: chris.token,
        body: { phone: '(555) 201-0001', title: '  Mom  ' },
      });
      assert.equal(res.status, 201);
      const conv = res.body.conversation;
      assert.deepEqual(conv.sms, { phone: '+15552010001' });
      assert.equal(conv.title, 'Mom');
      assert.equal(conv.isGroup, false);
      assert.deepEqual(conv.members, [chris.user]);
      assert.equal(conv.lastMessage, null);
      const ev = await ws.next('conversation', (f) => f.conversation.id === conv.id);
      assert.deepEqual(ev.conversation, conv);

      const again = await request(app, 'POST', '/api/sms/conversations', { token: chris.token, body: { phone: '+1 555 201 0001' } });
      assert.equal(again.status, 200);
      assert.equal(again.body.conversation.id, conv.id);
      assert.equal(again.body.conversation.title, 'Mom');

      // Another texting user gets their own conversation with the same number.
      const mayas = await request(app, 'POST', '/api/sms/conversations', { token: maya.token, body: { phone: '5552010001' } });
      assert.equal(mayas.status, 201);
      assert.notEqual(mayas.body.conversation.id, conv.id);
      assert.deepEqual(mayas.body.conversation.members, [maya.user]);

      const denied = await request(app, 'POST', '/api/sms/conversations', { token: plain.token, body: { phone: '5552010001' } });
      assert.equal(denied.status, 403);
      assert.equal((await request(app, 'POST', '/api/sms/conversations', { body: { phone: '5552010001' } })).status, 401);
      for (const phone of ['12', 'hello', '', null, 5552010001, '555-201-000']) {
        const bad = await request(app, 'POST', '/api/sms/conversations', { token: chris.token, body: { phone } });
        assert.equal(bad.status, 400, String(phone));
        assert.ok(bad.body.error);
      }
      const own = await request(app, 'POST', '/api/sms/conversations', { token: chris.token, body: { phone: CHRIS_NUMBER } });
      assert.equal(own.status, 400);
      const longTitle = await request(app, 'POST', '/api/sms/conversations', {
        token: chris.token,
        body: { phone: '5552010002', title: 'x'.repeat(81) },
      });
      assert.equal(longTitle.status, 400);

      // Only the owner is a member.
      const peek = await request(app, 'GET', `/api/conversations/${conv.id}`, { token: maya.token });
      assert.equal(peek.status, 403);
      const post = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: maya.token,
        body: { clientId: crypto.randomUUID(), body: 'sneaky' },
      });
      assert.equal(post.status, 403);
      assert.equal(fake.sent.length, 0);
    } finally {
      await ws.close();
    }
  });

  test('outbound text: form fields, Basic auth, StatusCallback, WS fan-out', async () => {
    const conv = await smsConversation(chris, '5552020001');
    const ws = await WsClient.connect(app, chris.token);
    try {
      const res = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: chris.token,
        body: { clientId: 'c-out-1', body: '  Running late, 10 min  ' },
      });
      assert.equal(res.status, 201);
      const msg = res.body.message;
      assert.equal(msg.senderId, chris.user.id);
      assert.equal(msg.body, 'Running late, 10 min');
      assert.deepEqual(msg.sms, { status: 'queued', error: null });
      const ev = await ws.next('message', (f) => f.message.id === msg.id);
      assert.deepEqual(ev.message, msg);
      await app.sms.idle();

      assert.equal(fake.sent.length, 1);
      const call = fake.sent[0];
      assert.equal(call.accountSid, SID);
      assert.equal(call.auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
      assert.match(call.contentType, /application\/x-www-form-urlencoded/);
      assert.deepEqual(call.params, {
        From: CHRIS_NUMBER,
        To: '+15552020001',
        Body: 'Running late, 10 min',
        StatusCallback: `${PUBLIC_URL}/api/sms/twilio/status`,
      });

      // Idempotent retry does not text twice.
      const retry = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: chris.token,
        body: { clientId: 'c-out-1', body: 'Running late, 10 min' },
      });
      assert.equal(retry.status, 200);
      await app.sms.idle();
      assert.equal(fake.sent.length, 1);

      // Too long for a text.
      const long = await request(app, 'POST', `/api/conversations/${conv.id}/messages`, {
        token: chris.token,
        body: { clientId: crypto.randomUUID(), body: 'x'.repeat(1601) },
      });
      assert.equal(long.status, 400);
      assert.equal(fake.sent.length, 1);
    } finally {
      await ws.close();
    }
  });

  test('outbound photo: signed MediaUrl works for Twilio, fails when tampered or expired', async () => {
    const conv = await smsConversation(chris, '5552030001');
    const up = await request(app, 'POST', '/api/attachments', {
      token: chris.token,
      raw: PNG_BYTES,
      headers: { 'Content-Type': 'image/png' },
    });
    const att = up.body.attachment;

    // Before the photo is on an outgoing text, even a validly signed link serves nothing.
    const early = new URL(app.sms.mediaUrl(att.id));
    assert.equal((await fetchFromApp(app, early.href)).status, 404);

    const msg = await sendAndSettle(chris, conv.id, '', { attachmentId: att.id });
    assert.equal(msg.body, '');
    assert.equal(fake.sent.length, 1);
    const { params } = fake.sent[0];
    assert.equal(params.Body, undefined);
    assert.ok(params.MediaUrl.startsWith(`${PUBLIC_URL}/api/sms/media/${att.id}?`), params.MediaUrl);
    const mediaUrl = new URL(params.MediaUrl);
    const exp = Number(mediaUrl.searchParams.get('exp'));
    const nowS = Math.floor(Date.now() / 1000);
    assert.ok(exp > nowS + 3500 && exp <= nowS + 3600, 'expires in about an hour');

    // Twilio (no login) can fetch it.
    const ok = await fetchFromApp(app, params.MediaUrl);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG_BYTES);

    const tamper = (fn) => {
      const u = new URL(params.MediaUrl);
      fn(u.searchParams, u);
      return u.href;
    };
    const sig = mediaUrl.searchParams.get('sig');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const bad = [
      tamper((q) => q.set('sig', flipped)),
      tamper((q) => q.set('exp', String(exp + 1))),
      tamper((q) => q.delete('sig')),
      tamper((q) => q.delete('exp')),
      tamper((q) => q.set('sig', sig + 'x')),
    ];
    for (const href of bad) assert.equal((await fetchFromApp(app, href)).status, 403, href);

    // Correctly signed but expired, or with an expiry too far in the future.
    const signWith = (id, e) => crypto.createHmac('sha256', TOKEN).update(`${id}.${e}`).digest('base64url');
    const expired = nowS - 5;
    assert.equal((await fetch(`${app.url}/api/sms/media/${att.id}?exp=${expired}&sig=${signWith(att.id, expired)}`)).status, 403);
    const tooLate = nowS + 30 * 24 * 3600;
    assert.equal((await fetch(`${app.url}/api/sms/media/${att.id}?exp=${tooLate}&sig=${signWith(att.id, tooLate)}`)).status, 403);
    // A link for a different attachment id doesn't transfer.
    const otherId = 'a_' + 'x'.repeat(16);
    assert.equal((await fetch(`${app.url}/api/sms/media/${otherId}?exp=${exp}&sig=${sig}`)).status, 403);

    // A validly signed link only ever serves photos sent on an outgoing text: not DM photos...
    const dmConv = await dm(app, chris, maya);
    const up2 = await request(app, 'POST', '/api/attachments', { token: maya.token, raw: PNG_BYTES, headers: { 'Content-Type': 'image/png' } });
    await send(app, maya, dmConv.id, '', { attachmentId: up2.body.attachment.id });
    assert.equal((await fetchFromApp(app, app.sms.mediaUrl(up2.body.attachment.id))).status, 404);
  });

  test('status callbacks move status forward, and to failed with readable error', async () => {
    const conv = await smsConversation(chris, '5552040001');
    const m1 = await sendAndSettle(chris, conv.id, 'first');
    const sid1 = fake.sent[0].sid;
    const ws = await WsClient.connect(app, chris.token);
    try {
      const status = (params, opts) => webhook(app, '/api/sms/twilio/status', { AccountSid: SID, ...params }, opts);

      const sent = await status({ MessageSid: sid1, MessageStatus: 'sent' });
      assert.equal(sent.status, 200);
      assert.match(sent.headers.get('content-type'), /text\/xml/);
      let ev = await ws.next('message', (f) => f.message.id === m1.id);
      assert.deepEqual(ev.message.sms, { status: 'sent', error: null });
      assert.equal(ev.message.body, 'first');

      // Backwards is ignored.
      await status({ MessageSid: sid1, MessageStatus: 'sending' });
      assert.ok(await ws.none('message', (f) => f.message.id === m1.id));

      await status({ MessageSid: sid1, MessageStatus: 'delivered' });
      ev = await ws.next('message', (f) => f.message.id === m1.id);
      assert.deepEqual(ev.message.sms, { status: 'delivered', error: null });

      // Bad signature changes nothing.
      const forged = await status({ MessageSid: sid1, MessageStatus: 'failed', ErrorCode: '30003' }, { signature: 'bm9wZQ==' });
      assert.equal(forged.status, 403);

      const m2 = await sendAndSettle(chris, conv.id, 'second');
      await ws.next('message', (f) => f.message.id === m2.id);
      const sid2 = fake.sent[1].sid;
      await status({ MessageSid: sid2, MessageStatus: 'failed', ErrorCode: '21610' });
      ev = await ws.next('message', (f) => f.message.id === m2.id);
      assert.deepEqual(ev.message.sms, { status: 'failed', error: 'This number has opted out (they replied STOP)' });
      // Failed is final.
      await status({ MessageSid: sid2, MessageStatus: 'delivered' });
      assert.ok(await ws.none('message', (f) => f.message.id === m2.id));

      const m3 = await sendAndSettle(chris, conv.id, 'third');
      await status({ MessageSid: fake.sent[2].sid, MessageStatus: 'undelivered', ErrorCode: '30005' });
      await status({ MessageSid: smsSid(), MessageStatus: 'delivered' }); // unknown sid: ignored
      const list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
      const byId = Object.fromEntries(list.body.messages.map((m) => [m.id, m]));
      assert.deepEqual(byId[m1.id].sms, { status: 'delivered', error: null });
      assert.equal(byId[m2.id].sms.status, 'failed');
      assert.deepEqual(byId[m3.id].sms, { status: 'failed', error: "Couldn't be delivered to this number" });
    } finally {
      await ws.close();
    }
  });

  test('a status callback that beats the Twilio API response is applied once the sid is known', async () => {
    const conv = await smsConversation(chris, '5552040002');
    const sid = smsSid();
    fake.respond = () => ({ status: 201, body: { sid, status: 'queued' } });
    // The callback arrives first, then Twilio's answer to the send.
    const res = await webhook(app, '/api/sms/twilio/status', { AccountSid: SID, MessageSid: sid, MessageStatus: 'delivered' });
    assert.equal(res.status, 200);
    const m = await sendAndSettle(chris, conv.id, 'quick');
    const list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    assert.deepEqual(list.body.messages.find((x) => x.id === m.id).sms, { status: 'delivered', error: null });
  });

  test('Twilio error response marks the text failed with its message', async () => {
    const conv = await smsConversation(chris, '5552050001');
    fake.respond = () => ({
      status: 400,
      body: { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 },
    });
    const m = await sendAndSettle(chris, conv.id, 'hello?');
    const list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    assert.deepEqual(list.body.messages.find((x) => x.id === m.id).sms, { status: 'failed', error: "That isn't a valid phone number" });
    fake.respond = () => ({ status: 400, body: { code: 12345, message: 'Some new Twilio problem', status: 400 } });
    const m2 = await sendAndSettle(chris, conv.id, 'again');
    const list2 = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    assert.deepEqual(list2.body.messages.find((x) => x.id === m2.id).sms, { status: 'failed', error: 'Some new Twilio problem' });
  });

  test('network failure retries twice, then fails', async () => {
    const conv = await smsConversation(chris, '5552060001');
    fake.dropNext = 2;
    const m = await sendAndSettle(chris, conv.id, 'third time lucky');
    assert.equal(fake.sent.length, 3);
    assert.deepEqual(fake.sent.map((s) => !!s.dropped), [true, true, false]);
    let list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    assert.deepEqual(list.body.messages.find((x) => x.id === m.id).sms, { status: 'queued', error: null });

    fake.reset();
    fake.dropNext = 3;
    const m2 = await sendAndSettle(chris, conv.id, 'no luck');
    assert.equal(fake.sent.length, 3);
    list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    const failed = list.body.messages.find((x) => x.id === m2.id).sms;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Try again/);
  });

  test('incoming text: valid signature creates conversation + message, fans out, downloads media', async () => {
    fake.media.set('photo1', { type: 'image/png', body: PNG_BYTES });
    fake.media.set('photo2', { type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    const ws = await WsClient.connect(app, chris.token);
    try {
      const from = '+15557010001';
      const params = inboundParams({
        From: from,
        Body: 'Pics from the trip',
        NumMedia: '2',
        MediaUrl0: fake.mediaUrl('photo1'),
        MediaContentType0: 'image/png',
        MediaUrl1: fake.mediaUrl('photo2'),
        MediaContentType1: 'image/jpeg',
      });
      const res = await webhook(app, '/api/sms/twilio', params);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/xml/);
      assert.match(res.text, /<Response><\/Response>/);

      const convEv = await ws.next('conversation', (f) => f.conversation.sms && f.conversation.sms.phone === from);
      const conv = convEv.conversation;
      assert.equal(conv.title, null);
      assert.deepEqual(conv.members, [chris.user]);
      const e1 = await ws.next('message', (f) => f.message.conversationId === conv.id);
      const e2 = await ws.next('message', (f) => f.message.conversationId === conv.id);
      const [m1, m2] = [e1.message, e2.message].sort((a, b) => a.id - b.id);
      assert.equal(m1.senderId, null);
      assert.equal(m1.body, 'Pics from the trip');
      assert.deepEqual(m1.sms, { status: 'received', error: null });
      assert.equal(m1.attachment.mime, 'image/png');
      assert.equal(m1.attachment.size, PNG_BYTES.length);
      assert.equal(m2.senderId, null);
      assert.equal(m2.body, '');
      assert.equal(m2.attachment.mime, 'image/jpeg');

      // Media was fetched with Basic auth from Twilio, and not sent to the redirect target.
      const apiHits = fake.mediaRequests.filter((r) => r.path.includes('/Media/'));
      assert.equal(apiHits.length, 2);
      for (const hit of apiHits) assert.equal(hit.auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
      assert.equal(fake.mediaRequests.filter((r) => r.path.startsWith('/cdn/')).length, 2);

      // The owner can view the photo; nobody else can.
      const img = await fetch(`${app.url}/api/attachments/${m1.attachment.id}?token=${chris.token}`);
      assert.equal(img.status, 200);
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG_BYTES);
      assert.equal((await fetch(`${app.url}/api/attachments/${m1.attachment.id}?token=${maya.token}`)).status, 403);
      // ...and received photos are never served through the Twilio media link.
      assert.equal((await fetchFromApp(app, app.sms.mediaUrl(m1.attachment.id))).status, 404);

      // Unread counts include texts from the outside number.
      const got = await request(app, 'GET', `/api/conversations/${conv.id}`, { token: chris.token });
      assert.equal(got.body.conversation.unreadCount, 2);
      assert.equal(got.body.conversation.lastMessage.id, m2.id);

      // Replying goes to the same conversation and number.
      await sendAndSettle(chris, conv.id, 'Nice!');
      assert.equal(fake.sent.at(-1).params.To, from);
    } finally {
      await ws.close();
    }
  });

  test('incoming text: push titled with the contact name or formatted number; odd media is noted', async () => {
    const sub = fakeSubscription('maya');
    assert.equal((await request(app, 'POST', '/api/push/subscribe', { token: maya.token, body: { subscription: sub } })).status, 204);
    fake.media.set('vcard', { type: 'text/vcard', body: Buffer.from('BEGIN:VCARD') });
    const from = '+15557020001';
    const res = await webhook(app, '/api/sms/twilio', inboundParams({ To: MAYA_NUMBER, From: from, Body: 'Hey Maya' }));
    assert.equal(res.status, 200);
    await app.push.idle();
    assert.equal(pushes.length, 1);
    const convId = pushes[0].payload.conversationId;
    assert.deepEqual(pushes[0].payload, { title: '(555) 702-0001', body: 'Hey Maya', conversationId: convId });

    const rename = await request(app, 'PATCH', `/api/conversations/${convId}`, { token: maya.token, body: { title: 'Dentist' } });
    assert.equal(rename.status, 200);
    pushes = [];
    await webhook(app, '/api/sms/twilio', inboundParams({
      To: MAYA_NUMBER,
      From: from,
      Body: '',
      NumMedia: '1',
      MediaUrl0: fake.mediaUrl('vcard'),
      MediaContentType0: 'text/vcard',
    }));
    await app.push.idle();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].payload.title, 'Dentist');
    const list = await request(app, 'GET', `/api/conversations/${convId}/messages`, { token: maya.token });
    const last = list.body.messages.at(-1);
    assert.equal(last.attachment, null);
    assert.match(last.body, /attachment TealTalk can't show/);
    // Non-image media was never downloaded.
    assert.equal(fake.mediaRequests.length, 0);
  });

  test('incoming webhook with a bad or missing signature is rejected', async () => {
    const before = (await request(app, 'GET', '/api/conversations', { token: chris.token })).body.conversations.length;
    const params = inboundParams({ From: '+15557030001' });
    const cases = [
      { signature: null },
      { signature: '' },
      { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      { token: 'wrong-token' },
      { url: 'https://evil.example.com/api/sms/twilio' },
      { url: `${PUBLIC_URL}/api/sms/twilio/status` },
    ];
    for (const opts of cases) {
      const res = await webhook(app, '/api/sms/twilio', params, opts);
      assert.equal(res.status, 403, JSON.stringify(opts));
    }
    // Signed over different parameters than were sent.
    const sig = twilioSign(TOKEN, `${PUBLIC_URL}/api/sms/twilio`, params);
    const res = await webhook(app, '/api/sms/twilio', { ...params, Body: 'tampered' }, { signature: sig });
    assert.equal(res.status, 403);
    // A JSON body is not a Twilio webhook.
    const json = await request(app, 'POST', '/api/sms/twilio', { body: params, headers: { 'X-Twilio-Signature': sig } });
    assert.ok(json.status === 403 || json.status === 415);
    const after = (await request(app, 'GET', '/api/conversations', { token: chris.token })).body.conversations.length;
    assert.equal(after, before);
  });

  test('unknown To number and users without accounts are ignored safely (no users created)', async () => {
    const from = '+15557040001';
    const unknown = await webhook(app, '/api/sms/twilio', inboundParams({ To: '+15559999999', From: from }));
    assert.equal(unknown.status, 200);
    const ghost = await webhook(app, '/api/sms/twilio', inboundParams({ To: GHOST_NUMBER, From: from }));
    assert.equal(ghost.status, 200);
    assert.equal(app.store.usernameExists('sms_ghost'), false);
    const junk = await webhook(app, '/api/sms/twilio', { To: 'nonsense', From: 'x', Body: 'x' });
    assert.equal(junk.status, 200);
    for (const u of [chris, maya]) {
      const convs = (await request(app, 'GET', '/api/conversations', { token: u.token })).body.conversations;
      assert.ok(!convs.some((c) => c.sms && c.sms.phone === from));
    }
  });

  test('duplicate MessageSid is ignored', async () => {
    const params = inboundParams({ From: '+15557050001', Body: 'only once' });
    assert.equal((await webhook(app, '/api/sms/twilio', params)).status, 200);
    assert.equal((await webhook(app, '/api/sms/twilio', params)).status, 200);
    const convs = (await request(app, 'GET', '/api/conversations', { token: chris.token })).body.conversations;
    const conv = convs.find((c) => c.sms && c.sms.phone === '+15557050001');
    const list = await request(app, 'GET', `/api/conversations/${conv.id}/messages`, { token: chris.token });
    assert.deepEqual(list.body.messages.map((m) => m.body), ['only once']);
    // Short-code senders are kept as digits and reuse their conversation.
    await webhook(app, '/api/sms/twilio', inboundParams({ From: '72345', Body: 'Your code is 1234' }));
    await webhook(app, '/api/sms/twilio', inboundParams({ From: '72345', Body: 'Your code is 5678' }));
    const convs2 = (await request(app, 'GET', '/api/conversations', { token: chris.token })).body.conversations;
    const shorts = convs2.filter((c) => c.sms && c.sms.phone === '72345');
    assert.equal(shorts.length, 1);
    assert.equal(shorts[0].lastMessage.body, 'Your code is 5678');
  });

  test('rename via PATCH: SMS contacts and groups, not 1:1 chats', async () => {
    const conv = await smsConversation(chris, '5552070001');
    const ws = await WsClient.connect(app, chris.token);
    try {
      const res = await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: chris.token, body: { title: '  Plumber ' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation.title, 'Plumber');
      const ev = await ws.next('conversation', (f) => f.conversation.id === conv.id);
      assert.equal(ev.conversation.title, 'Plumber');
      for (const title of [null, '']) {
        const cleared = await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: chris.token, body: { title: 'x' } });
        assert.equal(cleared.status, 200);
        const c2 = await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: chris.token, body: { title } });
        assert.equal(c2.status, 200);
        assert.equal(c2.body.conversation.title, null);
      }
      assert.equal((await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: chris.token, body: { title: 'x'.repeat(81) } })).status, 400);
      assert.equal((await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: chris.token, body: { title: 5 } })).status, 400);
      assert.equal((await request(app, 'PATCH', `/api/conversations/${conv.id}`, { token: maya.token, body: { title: 'Mine' } })).status, 403);
      assert.equal((await request(app, 'PATCH', `/api/conversations/c_nope`, { token: chris.token, body: { title: 'x' } })).status, 404);

      const group = (await request(app, 'POST', '/api/conversations', { token: chris.token, body: { memberIds: [maya.user.id, plain.user.id] } })).body.conversation;
      const g = await request(app, 'PATCH', `/api/conversations/${group.id}`, { token: plain.token, body: { title: 'Book club' } });
      assert.equal(g.status, 200);
      assert.equal(g.body.conversation.title, 'Book club');
      assert.equal((await request(app, 'PATCH', `/api/conversations/${group.id}`, { token: plain.token, body: { title: '' } })).status, 400);

      const oneToOne = await dm(app, chris, maya);
      assert.equal((await request(app, 'PATCH', `/api/conversations/${oneToOne.id}`, { token: chris.token, body: { title: 'x' } })).status, 400);
    } finally {
      await ws.close();
    }
  });
});

describe('sms: losing a number', () => {
  test('a user whose number was removed can no longer text from old conversations', async () => {
    const fake = await startFakeTwilio();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-sms-'));
    try {
      const one = await startApp({ dataDir, sms: smsOptions(fake) });
      const chris = await register(one, 'sms_chris');
      const conv = (await request(one, 'POST', '/api/sms/conversations', { token: chris.token, body: { phone: '5552080001' } })).body.conversation;
      await one.close();
      const two = await startApp({ dataDir, sms: smsOptions(fake, { numbers: { [MAYA_NUMBER]: 'sms_maya' } }) });
      try {
        const me = await request(two, 'GET', '/api/me', { token: chris.token });
        assert.deepEqual(me.body.sms, { enabled: false, number: null });
        const res = await request(two, 'POST', `/api/conversations/${conv.id}/messages`, {
          token: chris.token,
          body: { clientId: crypto.randomUUID(), body: 'hello' },
        });
        assert.equal(res.status, 403);
        // The conversation itself is still readable.
        assert.equal((await request(two, 'GET', `/api/conversations/${conv.id}`, { token: chris.token })).status, 200);
        await two.sms.idle();
        assert.equal(fake.sent.length, 0);
      } finally {
        await two.close();
      }
    } finally {
      await fake.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('signup code', () => {
  let app;
  before(async () => {
    app = await startApp({ signupCode: 'teal-2026' });
  });
  after(() => app.close());

  test('register requires the right code', async () => {
    const base = { username: uniqueName('code'), password: 'correct horse battery' };
    for (const signupCode of [undefined, '', 'nope', 'TEAL-2026', 42]) {
      const res = await request(app, 'POST', '/api/register', { body: { ...base, signupCode } });
      assert.equal(res.status, 403, String(signupCode));
      assert.deepEqual(res.body, { error: "That signup code isn't right." });
    }
    assert.equal(app.store.usernameExists(base.username), false);
    const ok = await request(app, 'POST', '/api/register', { body: { ...base, signupCode: ' teal-2026 ' } });
    assert.equal(ok.status, 201);
    // Login never needs it.
    const login = await request(app, 'POST', '/api/login', { body: base });
    assert.equal(login.status, 200);
  });
});

describe('database migration from the pre-SMS schema', () => {
  // The CREATE statements of server/db.js before SMS support (git show HEAD~1:server/db.js).
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  is_group   INTEGER NOT NULL,
  dm_key     TEXT UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  read_up_to      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  client_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  attachment_id   TEXT REFERENCES attachments(id),
  created_at      INTEGER NOT NULL,
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_attachment ON messages(attachment_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
`;

  test('an existing data dir upgrades cleanly and keeps its data', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-migrate-'));
    try {
      const file = path.join(dataDir, 'tealtalk.db');
      const old = new DatabaseSync(file);
      old.exec('PRAGMA journal_mode = WAL');
      old.exec('PRAGMA foreign_keys = ON');
      old.exec(OLD_SCHEMA);
      const t = 1790000000000;
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const insUser = old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
      insUser.run('u_alice', 'alice', 'Alice', 'salt', 'hash', t);
      insUser.run('u_bob', 'bob', 'Bob', 'salt', 'hash', t);
      old.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash, 'u_alice', t);
      old.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?)').run('c_dm', null, 0, 'u_alice:u_bob', 'u_alice', t, t + 30);
      old.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run('c_dm', 'u_alice', 0, 2);
      old.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run('c_dm', 'u_bob', 1, 0);
      old.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run('a_pic', 'u_bob', 'image/png', PNG_BYTES.length, t);
      fs.mkdirSync(path.join(dataDir, 'uploads'));
      fs.writeFileSync(path.join(dataDir, 'uploads', 'a_pic'), PNG_BYTES);
      const insMsg = old.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
      insMsg.run(1, 'c_dm', 'u_alice', 'k1', 'hi bob', null, t + 10);
      insMsg.run(2, 'c_dm', 'u_bob', 'k2', 'hi alice', null, t + 20);
      insMsg.run(3, 'c_dm', 'u_bob', 'k3', '', 'a_pic', t + 30);
      // Ids issued and later gone still must never be reused.
      insMsg.run(9, 'c_dm', 'u_bob', 'k9', 'deleted later', null, t + 31);
      old.prepare('DELETE FROM messages WHERE id = 9').run();
      old.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?)').run('https://push.example.com/x', 'u_alice', 'p'.repeat(20), 'a'.repeat(10), t);
      assert.equal(old.prepare('PRAGMA user_version').get().user_version, 0);
      old.close();

      const app = await startApp({ dataDir });
      try {
        const db = app.store.db;
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        const senderCol = db.prepare('PRAGMA table_info(messages)').all().find((c) => c.name === 'sender_id');
        assert.equal(senderCol.notnull, 0);
        const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
        assert.ok(convCols.includes('sms_phone') && convCols.includes('sms_owner_id'));
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_v2'").get() === undefined);

        const alice = { token, user: { id: 'u_alice', username: 'alice', displayName: 'Alice' } };
        const me = await request(app, 'GET', '/api/me', { token });
        assert.equal(me.status, 200);
        assert.deepEqual(me.body.user, alice.user);
        const conv = (await request(app, 'GET', '/api/conversations/c_dm', { token })).body.conversation;
        assert.equal(conv.sms, null);
        assert.equal(conv.unreadCount, 1);
        assert.deepEqual(conv.readUpTo, { u_alice: 2, u_bob: 0 });
        const msgs = (await request(app, 'GET', '/api/conversations/c_dm/messages', { token })).body.messages;
        assert.deepEqual(
          msgs.map((m) => [m.id, m.senderId, m.clientId, m.body, m.attachment && m.attachment.id, m.createdAt, m.sms]),
          [
            [1, 'u_alice', 'k1', 'hi bob', null, t + 10, null],
            [2, 'u_bob', 'k2', 'hi alice', null, t + 20, null],
            [3, 'u_bob', 'k3', '', 'a_pic', t + 30, null],
          ]
        );
        const img = await fetch(`${app.url}/api/attachments/a_pic?token=${token}`);
        assert.equal(img.status, 200);
        // Idempotent retries still match on (sender, clientId).
        const retry = await request(app, 'POST', '/api/conversations/c_dm/messages', { token, body: { clientId: 'k1', body: 'hi bob' } });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.message.id, 1);
        const fresh = await send(app, alice, 'c_dm', 'after the upgrade');
        assert.ok(fresh.id > 9, `new id ${fresh.id} continues after the old sequence`);
        assert.equal(app.store.pushSubscriptionsFor('u_alice').length, 1);
      } finally {
        await app.close(true);
      }

      // Opening again is a no-op.
      const again = await startApp({ dataDir });
      try {
        assert.equal(again.store.schemaVersion, SCHEMA_VERSION);
        const msgs = (await request(again, 'GET', '/api/conversations/c_dm/messages', { token })).body.messages;
        assert.equal(msgs.length, 4);
      } finally {
        await again.close(true);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a fresh database starts at the current schema version', async () => {
    const app = await startApp();
    try {
      assert.equal(app.store.schemaVersion, SCHEMA_VERSION);
      const senderCol = app.store.db.prepare('PRAGMA table_info(messages)').all().find((c) => c.name === 'sender_id');
      assert.equal(senderCol.notnull, 0);
    } finally {
      await app.close();
    }
  });
});

