'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startApp, request, register, dm, send, postEncrypted, uploadEncrypted, E2EE_MIME, PNG_BYTES } = require('./helpers');

function upload(app, token, bytes, type = 'image/png') {
  return request(app, 'POST', '/api/attachments', { token, raw: bytes, headers: { 'Content-Type': type } });
}

/** `head` followed by filler bytes up to `size`. */
function padded(head, size) {
  const buf = Buffer.alloc(size, 1);
  head.copy(buf);
  return buf;
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
    const exact = await upload(app, alice.token, padded(PNG_BYTES, 10 * 1024 * 1024));
    assert.equal(exact.status, 201);
    const tooBig = await upload(app, alice.token, padded(PNG_BYTES, 10 * 1024 * 1024 + 1));
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

  test('encrypted files: opaque bytes accepted without a magic-byte check, served as uploaded', async () => {
    const junk = Buffer.from('<html><script>alert(1)</script></html>'); // would fail any sniffing
    const res = await upload(app, alice.token, junk, E2EE_MIME);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(
      { ...res.body.attachment, id: 'x' },
      { id: 'x', mime: E2EE_MIME, size: junk.length, kind: 'e2ee', width: null, height: null, durationMs: null, thumbnailId: null, expired: false }
    );
    // Metadata is never stored for encrypted files (it lives in the encrypted payload).
    const withParams = await upload(app, alice.token, junk, `${E2EE_MIME}; charset=binary`);
    assert.equal(withParams.status, 201);
    const q = await request(app, 'POST', '/api/attachments?width=10&height=20&durationMs=5', {
      token: alice.token,
      raw: junk,
      headers: { 'Content-Type': E2EE_MIME },
    });
    assert.deepEqual([q.body.attachment.width, q.body.attachment.height, q.body.attachment.durationMs], [null, null, null]);
    const got = await fetch(`${app.url}/api/attachments/${res.body.attachment.id}?token=${alice.token}`);
    assert.equal(got.headers.get('content-type'), E2EE_MIME);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), junk);
    // Plaintext types are still sniffed.
    assert.equal((await upload(app, alice.token, junk, 'image/png')).status, 415);
  });

  test('encrypted message files and read permissions', async () => {
    const att = await uploadEncrypted(app, alice);
    const thumb = await uploadEncrypted(app, alice);
    const c = await dm(app, alice, bob);

    // Before it is posted only the uploader can read it.
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=${alice.token}`)).status, 200);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=${bob.token}`)).status, 403);

    // Someone else cannot post my file.
    const stolen = await postEncrypted(app, bob, c.id, '', { attachmentIds: [att.id] });
    assert.equal(stolen.status, 400);

    const msg = await send(app, alice, c.id, '', { attachmentIds: [att.id, thumb.id] });
    assert.equal(msg.body, '');
    assert.equal(msg.attachment, null);
    assert.deepEqual(msg.attachments, [
      { id: att.id, size: att.size, expired: false },
      { id: thumb.id, size: thumb.size, expired: false },
    ]);

    for (const id of [att.id, thumb.id]) {
      const res = await fetch(`${app.url}/api/attachments/${id}?token=${encodeURIComponent(bob.token)}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), E2EE_MIME);
      assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(app.dataDir, 'uploads', id)));
    }

    // Bearer header also works.
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}`, { token: bob.token })).status, 200);
    // Non-members cannot read it, anonymous is 401, unknown is 404.
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=${carol.token}`)).status, 403);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}`)).status, 401);
    assert.equal((await request(app, 'GET', `/api/attachments/${att.id}?token=bogus`)).status, 401);
    assert.equal((await request(app, 'GET', `/api/attachments/a_missing?token=${bob.token}`)).status, 404);

    // Message list carries the files.
    const list = await request(app, 'GET', `/api/conversations/${c.id}/messages`, { token: bob.token });
    assert.deepEqual(list.body.messages.at(-1).attachments, msg.attachments);
  });
});
