'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startApp, request, register, dm, send, PNG_BYTES } = require('./helpers');

function upload(app, token, bytes, type = 'image/png') {
  return request(app, 'POST', '/api/attachments', { token, raw: bytes, headers: { 'Content-Type': type } });
}

describe('attachments', () => {
  let app;
  let alice;
  let bob;
  let carol;
  before(async () => {
    app = await startApp();
    alice = await register(app, 'alice');
    bob = await register(app, 'bob');
    carol = await register(app, 'carol');
  });
  after(() => app.close());

  test('upload returns 201 and stores the file in DATA_DIR/uploads', async () => {
    const res = await upload(app, alice.token, PNG_BYTES);
    assert.equal(res.status, 201);
    const a = res.body.attachment;
    assert.match(a.id, /^a_/);
    assert.equal(a.mime, 'image/png');
    assert.equal(a.size, PNG_BYTES.length);
    assert.ok(fs.existsSync(path.join(app.dataDir, 'uploads', a.id)));
    const jpeg = await upload(app, alice.token, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
    assert.equal(jpeg.status, 201);
    assert.equal(jpeg.body.attachment.mime, 'image/jpeg');
  });

  test('upload requires auth, an allowed type, a body, and <= 10 MB', async () => {
    assert.equal((await upload(app, null, PNG_BYTES)).status, 401);
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', 'image/pngx']) {
      assert.equal((await upload(app, alice.token, PNG_BYTES, type)).status, 415, type);
    }
    assert.equal((await upload(app, alice.token, Buffer.alloc(0))).status, 400);
    const exact = await upload(app, alice.token, Buffer.alloc(10 * 1024 * 1024, 1));
    assert.equal(exact.status, 201);
    const tooBig = await upload(app, alice.token, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    assert.equal(tooBig.status, 413);
    // No leftover temp files.
    const leftovers = fs.readdirSync(path.join(app.dataDir, 'uploads')).filter((n) => n.startsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('streamed (chunked) upload over the limit is cut off with 413', async () => {
    const url = new URL(app.url);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: '/api/attachments',
          method: 'POST',
          headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'image/webp', 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? null : reject(err)));
      const chunk = Buffer.alloc(1024 * 1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < 12) {
          sent++;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    assert.equal(status, 413);
    const leftovers = fs.readdirSync(path.join(app.dataDir, 'uploads')).filter((n) => n.startsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('attachment messages and read permissions', async () => {
    const att = (await upload(app, alice.token, PNG_BYTES)).body.attachment;
    const c = await dm(app, alice, bob);

    // Before it is posted only the uploader can read it.
    const own = await request(app, 'GET', `/api/attachments/${att.id}?token=${alice.token}`);
    assert.equal(own.status, 200);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=${bob.token}`)).status, 403);

    // Someone else cannot post my attachment.
    const stolen = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: bob.token,
      body: { clientId: 'steal-1', attachmentId: att.id },
    });
    assert.equal(stolen.status, 400);

    const msg = await send(app, alice, c.id, '', { attachmentId: att.id });
    assert.equal(msg.body, '');
    assert.deepEqual(msg.attachment, { id: att.id, mime: 'image/png', size: PNG_BYTES.length });

    const res = await fetch(`${app.url}/api/attachments/${att.id}?token=${encodeURIComponent(bob.token)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_BYTES);

    // Bearer header also works.
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}`, { token: bob.token })).status, 200);
    // Non-members cannot read it, anonymous is 401, unknown is 404.
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=${carol.token}`)).status, 403);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}`)).status, 401);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=bogus`)).status, 401);
    assert.equal((await request(app, 'GET', `/api/attachments/a_missing?token=${bob.token}`)).status, 404);

    // Message list carries the attachment.
    const list = await request(app, 'GET', `/api/conversations/${c.id}/messages`, { token: bob.token });
    assert.deepEqual(list.body.messages.at(-1).attachment, msg.attachment);
  });

  test('push preview says Photo for image-only messages', () => {
    const { preview } = require('../server/push');
    assert.equal(preview('', true), 'Photo');
    assert.equal(preview('look', true), 'look');
    const long = preview('x'.repeat(300), false);
    assert.equal(Array.from(long).length, 100);
  });
});
