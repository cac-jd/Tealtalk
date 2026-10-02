'use strict';

// Resumable, chunked uploads (docs/PROTOCOL.md, "Uploads: full quality and resumable").

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startApp, request, register, dm, send, postEncrypted, sleep, MEDIA_HEADS, mediaFile, uploadOk, fakeClock, E2EE_MIME } = require('./helpers');

const CHUNK = 5 * 1024 * 1024;

function start(app, who, mime, size) {
  return request(app, 'POST', '/api/uploads', { token: who.token, body: { mime, size } });
}

function put(app, who, id, offset, bytes, headers = {}) {
  return request(app, 'PUT', `/api/uploads/${id}`, {
    token: who && who.token,
    raw: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), ...headers },
  });
}

function status(app, who, id) {
  return request(app, 'GET', `/api/uploads/${id}`, { token: who && who.token });
}

function complete(app, who, id, body = {}) {
  return request(app, 'POST', `/api/uploads/${id}/complete`, { token: who && who.token, body });
}

/** Starts a PUT that sends only `sent` of its declared bytes and keeps the connection open. */
function hangingPut(app, who, id, offset, declared, sent) {
  const url = new URL(app.url);
  const req = http.request({
    host: url.hostname,
    port: url.port,
    path: `/api/uploads/${id}`,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${who.token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': declared,
      'Upload-Offset': String(offset),
    },
  });
  req.on('error', () => {});
  req.write(sent);
  return req;
}

/** Waits until the server has taken in `sent` bytes on a hanging request (it streams them to disk). */
async function settle() {
  await sleep(100);
}

async function uploadAll(app, who, mime, bytes, chunkSize = 1000) {
  const started = await start(app, who, mime, bytes.length);
  assert.equal(started.status, 201, started.text);
  const id = started.body.uploadId;
  for (let off = 0; off < bytes.length; off += chunkSize) {
    const r = await put(app, who, id, off, bytes.subarray(off, off + chunkSize));
    assert.equal(r.status, 200, r.text);
  }
  return id;
}

describe('resumable uploads', () => {
  let app;
  let alice;
  let bob;
  let carol;
  const partPath = (id) => path.join(app.dataDir, 'uploads', `.part-${id}`);
  before(async () => {
    app = await startApp();
    alice = await register(app);
    bob = await register(app);
    carol = await register(app);
  });
  after(() => app.close());

  test('start, send chunks, check progress, complete, send and play', async () => {
    const bytes = mediaFile(MEDIA_HEADS.mp4, 3000);
    for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const started = await start(app, alice, 'video/mp4', bytes.length);
    assert.equal(started.status, 201);
    assert.match(started.body.uploadId, /^up_/);
    assert.deepEqual({ ...started.body, uploadId: 'x' }, { uploadId: 'x', chunkSize: CHUNK, received: 0 });
    const id = started.body.uploadId;
    assert.ok(fs.existsSync(partPath(id)));

    assert.deepEqual((await put(app, alice, id, 0, bytes.subarray(0, 1000))).body, { received: 1000 });
    assert.deepEqual((await status(app, alice, id)).body, { received: 1000, size: 3000 });

    // Not finished yet.
    const early = await complete(app, alice, id);
    assert.equal(early.status, 409);
    assert.equal(early.body.received, 1000);
    assert.equal(early.body.size, 3000);

    // Wrong offsets: 409 with where to resume from.
    for (const off of [0, 999, 2000]) {
      const wrong = await put(app, alice, id, off, bytes.subarray(off, off + 10));
      assert.equal(wrong.status, 409, String(off));
      assert.equal(wrong.body.received, 1000);
      assert.equal(typeof wrong.body.error, 'string');
    }
    assert.equal((await status(app, alice, id)).body.received, 1000);

    assert.equal((await put(app, alice, id, 1000, bytes.subarray(1000, 2500))).body.received, 2500);
    assert.equal((await put(app, alice, id, 2500, bytes.subarray(2500))).body.received, 3000);

    const done = await complete(app, alice, id, { width: 1280, height: 720, durationMs: 4200 });
    assert.equal(done.status, 201, done.text);
    const att = done.body.attachment;
    assert.match(att.id, /^a_/);
    assert.deepEqual(
      { ...att, id: 'x' },
      { id: 'x', mime: 'video/mp4', size: 3000, kind: 'video', width: 1280, height: 720, durationMs: 4200, thumbnailId: null, expired: false }
    );
    assert.ok(!fs.existsSync(partPath(id)));
    assert.deepEqual(fs.readFileSync(path.join(app.dataDir, 'uploads', att.id)), bytes);
    assert.equal((await status(app, alice, id)).status, 404);
    assert.equal((await complete(app, alice, id)).status, 404);

    // A plaintext video can't be sent any more (v3): only encrypted files.
    const c = await dm(app, alice, bob);
    assert.equal((await postEncrypted(app, alice, c.id, 'our trip', { attachmentIds: [att.id] })).status, 400);
  });

  test('encrypted files upload resumably with no magic-byte check, then send and play', async () => {
    const bytes = Buffer.alloc(3000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11) % 256; // starts with 0x00: no known format
    const id = await uploadAll(app, alice, E2EE_MIME, bytes);
    const done = await complete(app, alice, id, { width: 1280, height: 720, durationMs: 4200, thumbnailId: 'a_whatever' });
    assert.equal(done.status, 201, done.text);
    const att = done.body.attachment;
    assert.deepEqual(
      { ...att, id: 'x' },
      { id: 'x', mime: E2EE_MIME, size: 3000, kind: 'e2ee', width: null, height: null, durationMs: null, thumbnailId: null, expired: false }
    );
    const c = await dm(app, alice, bob);
    const msg = await send(app, alice, c.id, 'our trip', { attachmentIds: [att.id] });
    assert.deepEqual(msg.attachments, [{ id: att.id, size: 3000, expired: false }]);
    const res = await fetch(`${app.url}/api/attachments/${att.id}?token=${bob.token}`, { headers: { Range: 'bytes=2990-' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), E2EE_MIME);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(2990));
  });

  test('a dropped connection mid-chunk resumes from what the server has', async () => {
    const bytes = mediaFile(MEDIA_HEADS.m4a, 4000);
    for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
    const id = (await start(app, alice, 'audio/mp4', bytes.length)).body.uploadId;
    assert.equal((await put(app, alice, id, 0, bytes.subarray(0, 1500))).status, 200);

    // The phone loses signal halfway through the next chunk.
    const req = hangingPut(app, alice, id, 1500, 2500, bytes.subarray(1500, 2200));
    await settle();
    // While that chunk is still arriving another write at the same offset is refused.
    const concurrent = await put(app, alice, id, 1500, bytes.subarray(1500, 1600));
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.received, 1500);
    req.destroy();
    await settle();

    // The client asks where to resume, gets 409 for a stale offset, then resumes correctly.
    const where = await status(app, alice, id);
    assert.deepEqual(where.body, { received: 1500, size: 4000 });
    const stale = await put(app, alice, id, 2200, bytes.subarray(2200));
    assert.equal(stale.status, 409);
    const resumed = await put(app, alice, id, stale.body.received, bytes.subarray(stale.body.received));
    assert.deepEqual(resumed.body, { received: 4000 });
    const done = await complete(app, alice, id, { durationMs: 2500 });
    assert.equal(done.status, 201, done.text);
    assert.equal(done.body.attachment.kind, 'audio');
    assert.deepEqual(fs.readFileSync(path.join(app.dataDir, 'uploads', done.body.attachment.id)), bytes);
  });

  test('start validation: type, size and MAX_UPLOAD_MB', async () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'video/avi', '', 5, null]) {
      assert.equal((await start(app, alice, mime, 100)).status, 415, String(mime));
    }
    for (const size of [0, -1, 1.5, '100', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal((await start(app, alice, 'video/mp4', size)).status, 400, String(size));
    }
    const max = 250 * 1024 * 1024;
    const tooBig = await start(app, alice, 'video/mp4', max + 1);
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.body.error, /250 MB/);
    const exact = await start(app, carol, 'video/quicktime', max);
    assert.equal(exact.status, 201);
    await request(app, 'DELETE', `/api/uploads/${exact.body.uploadId}`, { token: carol.token });
    assert.equal((await request(app, 'POST', '/api/uploads', { body: { mime: 'video/mp4', size: 10 } })).status, 401);
  });

  test('chunk validation: offset header, chunk size, past the end, empty', async () => {
    const size = CHUNK + 100;
    const id = (await start(app, alice, 'video/mp4', size)).body.uploadId;
    assert.equal((await put(app, alice, id, 0, Buffer.alloc(10), { 'Upload-Offset': '' })).status, 400);
    assert.equal((await put(app, alice, id, 0, Buffer.alloc(10), { 'Upload-Offset': '-1' })).status, 400);
    assert.equal((await put(app, alice, id, 0, Buffer.alloc(10), { 'Upload-Offset': 'abc' })).status, 400);
    const noHeader = await request(app, 'PUT', `/api/uploads/${id}`, { token: alice.token, raw: Buffer.alloc(10) });
    assert.equal(noHeader.status, 400);
    assert.equal((await put(app, alice, id, 0, Buffer.alloc(0))).status, 400);
    // Bigger than chunkSize.
    const big = await put(app, alice, id, 0, mediaFile(MEDIA_HEADS.mp4, CHUNK + 1));
    assert.equal(big.status, 413);
    assert.equal((await status(app, alice, id)).body.received, 0);
    // Exactly chunkSize is fine.
    assert.equal((await put(app, alice, id, 0, mediaFile(MEDIA_HEADS.mp4, CHUNK))).body.received, CHUNK);
    // More than what is left.
    const past = await put(app, alice, id, CHUNK, Buffer.alloc(101));
    assert.equal(past.status, 400);
    assert.equal((await status(app, alice, id)).body.received, CHUNK);
    assert.equal((await put(app, alice, id, CHUNK, Buffer.alloc(100, 1))).body.received, size);
    // Nothing more can be written once complete in size.
    assert.equal((await put(app, alice, id, size, Buffer.alloc(1))).status, 400);
    assert.equal((await complete(app, alice, id)).status, 201);
  });

  test('a streamed chunk with no Content-Length is cut off at chunkSize', async () => {
    const id = (await start(app, alice, 'video/webm', CHUNK * 2)).body.uploadId;
    const url = new URL(app.url);
    const code = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: `/api/uploads/${id}`,
          method: 'PUT',
          headers: { Authorization: `Bearer ${alice.token}`, 'Upload-Offset': '0', 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? null : reject(err)));
      const piece = Buffer.alloc(1024 * 1024, 3);
      let n = 0;
      const pump = () => {
        while (n < 7) {
          n++;
          if (!req.write(piece)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    assert.equal(code, 413);
    await settle();
    assert.equal((await status(app, alice, id)).body.received, 0);
  });

  test('a file that is not what it claims is rejected at complete and deleted', async () => {
    const bytes = mediaFile(MEDIA_HEADS.png, 2000); // a PNG pretending to be a video
    const id = await uploadAll(app, alice, 'video/mp4', bytes);
    const res = await complete(app, alice, id);
    assert.equal(res.status, 415);
    assert.ok(!fs.existsSync(partPath(id)));
    assert.equal((await status(app, alice, id)).status, 404);

    const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>'.padEnd(500, ' '));
    const id2 = await uploadAll(app, alice, 'audio/mpeg', html);
    assert.equal((await complete(app, alice, id2)).status, 415);
  });

  test('bad metadata at complete is 400 and the upload can be completed again', async () => {
    const id = await uploadAll(app, alice, 'video/mp4', mediaFile(MEDIA_HEADS.mov, 1200));
    const bobsThumb = await uploadOk(app, bob, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
    for (const body of [{ width: 0 }, { height: '12x' }, { durationMs: -1 }, { thumbnailId: bobsThumb.id }, { thumbnailId: 7 }]) {
      assert.equal((await complete(app, alice, id, body)).status, 400, JSON.stringify(body));
    }
    const thumb = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
    const ok = await complete(app, alice, id, { thumbnailId: thumb.id, width: 1080, height: 1920 });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.attachment.thumbnailId, thumb.id);
  });

  test('only the uploader can touch an upload', async () => {
    const id = (await start(app, alice, 'video/mp4', 2000)).body.uploadId;
    assert.equal((await put(app, alice, id, 0, mediaFile(MEDIA_HEADS.mp4, 1000))).status, 200);
    assert.equal((await status(app, bob, id)).status, 403);
    assert.equal((await put(app, bob, id, 1000, Buffer.alloc(1000))).status, 403);
    assert.equal((await complete(app, bob, id)).status, 403);
    assert.equal((await request(app, 'DELETE', `/api/uploads/${id}`, { token: bob.token })).status, 403);
    assert.equal((await status(app, null, id)).status, 401);
    assert.equal((await put(app, null, id, 1000, Buffer.alloc(10))).status, 401);
    assert.equal((await status(app, alice, 'up_nope')).status, 404);
    assert.equal((await status(app, alice, '..%2F..%2Fetc')).status, 404);
    assert.equal((await status(app, alice, id)).body.received, 1000);
    assert.equal((await request(app, 'PATCH', `/api/uploads/${id}`, { token: alice.token })).status, 405);
  });

  test('cancel deletes the upload and its bytes', async () => {
    const id = (await start(app, alice, 'audio/ogg', 500)).body.uploadId;
    await put(app, alice, id, 0, mediaFile(MEDIA_HEADS.ogg, 200));
    assert.equal((await request(app, 'DELETE', `/api/uploads/${id}`, { token: alice.token })).status, 204);
    assert.ok(!fs.existsSync(partPath(id)));
    assert.equal((await status(app, alice, id)).status, 404);
  });

  test('at most 5 unfinished uploads per person: the oldest idle one makes room, busy ones never', async () => {
    const dave = await register(app);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await start(app, dave, 'video/mp4', 5000)).body.uploadId);
    const sixth = await start(app, dave, 'video/mp4', 5000);
    assert.equal(sixth.status, 201);
    assert.equal((await status(app, dave, ids[0])).status, 404);
    assert.ok(!fs.existsSync(partPath(ids[0])));
    for (const id of ids.slice(1)) assert.equal((await status(app, dave, id)).status, 200);
    assert.equal(app.store.countUploads(dave.user.id), 5);
    // Others are not affected by dave's uploads.
    assert.equal((await start(app, carol, 'video/mp4', 10)).status, 201);

    // With all five busy receiving a chunk, a sixth is refused.
    const open = [...ids.slice(1), sixth.body.uploadId];
    const hanging = open.map((id) => hangingPut(app, dave, id, 0, 3000, mediaFile(MEDIA_HEADS.mp4, 100)));
    await settle();
    const refused = await start(app, dave, 'video/mp4', 5000);
    assert.equal(refused.status, 429);
    for (const req of hanging) req.destroy();
    await settle();
    assert.equal((await start(app, dave, 'video/mp4', 5000)).status, 201);
  });
});

describe('resumable uploads: cleanup and restarts', () => {
  test('unfinished uploads are deleted after 24 hours', async () => {
    const clock = fakeClock();
    const app = await startApp({ now: clock });
    try {
      const alice = await register(app);
      const old = (await start(app, alice, 'video/mp4', 5000)).body.uploadId;
      await put(app, alice, old, 0, mediaFile(MEDIA_HEADS.mp4, 1000));
      clock.advance(23 * 60 * 60 * 1000);
      const newer = (await start(app, alice, 'video/mp4', 5000)).body.uploadId;
      assert.deepEqual(app.sweeper.sweep().abandoned, []);
      clock.advance(2 * 60 * 60 * 1000);
      assert.deepEqual(app.sweeper.sweep().abandoned, [old]);
      assert.equal((await status(app, alice, old)).status, 404);
      assert.ok(!fs.existsSync(path.join(app.dataDir, 'uploads', `.part-${old}`)));
      assert.equal((await status(app, alice, newer)).status, 200);
    } finally {
      await app.close();
    }
  });

  test('an upload survives a server restart; stray partial files are removed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-uploads-'));
    try {
      const bytes = mediaFile(MEDIA_HEADS.webm, 2500);
      const one = await startApp({ dataDir });
      const alice = await register(one);
      const id = (await start(one, alice, 'video/webm', bytes.length)).body.uploadId;
      await put(one, alice, id, 0, bytes.subarray(0, 1000));
      await one.close();
      const stray = path.join(dataDir, 'uploads', '.part-up_unknown');
      fs.writeFileSync(stray, 'junk');

      const two = await startApp({ dataDir });
      try {
        assert.ok(!fs.existsSync(stray));
        assert.deepEqual((await status(two, alice, id)).body, { received: 1000, size: 2500 });
        await put(two, alice, id, 1000, bytes.subarray(1000));
        const done = await complete(two, alice, id);
        assert.equal(done.status, 201);
        assert.deepEqual(fs.readFileSync(path.join(dataDir, 'uploads', done.body.attachment.id)), bytes);
      } finally {
        await two.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
