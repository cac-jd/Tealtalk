'use strict';

// Photos, videos and voice messages: accepted types and magic-byte checks, metadata, thumbnails,
// HTTP Range requests and the MEDIA_RETENTION_DAYS sweep.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp,
  request,
  register,
  dm,
  send,
  sleep,
  PNG_BYTES,
  MEDIA_HEADS,
  mediaFile,
  uploadSmall,
  uploadOk,
  fakeClock,
} = require('./helpers');
const { sniff, matchesKind, parseRange, kindOf } = require('../server/media');

const DAY = 24 * 60 * 60 * 1000;

describe('media: magic numbers and ranges (pure)', () => {
  test('every accepted format is recognized, junk is not', () => {
    const expect = {
      jpeg: 'image',
      png: 'image',
      gif87: 'image',
      gif89: 'image',
      webp: 'image',
      mp4: 'video',
      mov: 'video',
      m4a: 'audio',
      webm: 'video',
      ogg: 'audio',
      id3: 'audio',
      mp3: 'audio',
      aac: 'audio',
      aacCrc: 'audio',
    };
    for (const [name, kind] of Object.entries(expect)) {
      assert.ok(matchesKind(MEDIA_HEADS[name], kind), name);
    }
    // MP4/MOV and WebM containers carry both video and audio.
    for (const name of ['mp4', 'mov', 'm4a', 'webm']) {
      assert.ok(matchesKind(MEDIA_HEADS[name], 'video') && matchesKind(MEDIA_HEADS[name], 'audio'), name);
      assert.ok(!matchesKind(MEDIA_HEADS[name], 'image'), name);
    }
    for (const name of ['jpeg', 'png', 'gif89', 'webp']) {
      assert.ok(!matchesKind(MEDIA_HEADS[name], 'video') && !matchesKind(MEDIA_HEADS[name], 'audio'), name);
    }
    for (const name of ['ogg', 'id3', 'mp3', 'aac']) {
      assert.ok(!matchesKind(MEDIA_HEADS[name], 'video') && !matchesKind(MEDIA_HEADS[name], 'image'), name);
    }
    const junk = [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]), // truncated JPEG
      Buffer.from('<html><script>alert(1)</script>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), // WAV is RIFF but not WEBP
      Buffer.from('PK\x03\x04', 'latin1'),
      Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from([0, 1, 2, 3])]), // non-text brand
      Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypisom')]), // box size 0
      Buffer.from([0xff, 0xe8, 0x00, 0x00]), // MPEG sync with reserved version
      Buffer.from([0xff, 0xe0, 0x00, 0x00]), // reserved layer
    ];
    for (const buf of junk) assert.equal(sniff(buf), null, buf.toString('latin1'));
  });

  test('declared types map onto kinds', () => {
    assert.equal(kindOf('image/JPEG'), 'image');
    assert.equal(kindOf('video/quicktime'), 'video');
    assert.equal(kindOf('audio/webm;codecs=opus'), 'audio');
    assert.equal(kindOf('audio/mp4'), 'audio');
    for (const bad of ['image/svg+xml', 'text/html', 'video/x-msvideo', 'audio/wav', 'image/heic', '', undefined]) {
      assert.equal(kindOf(bad), null, String(bad));
    }
  });

  test('parseRange edge cases', () => {
    const size = 1000;
    assert.equal(parseRange(undefined, size), null);
    assert.deepEqual(parseRange('bytes=0-99', size), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=0-0', size), { start: 0, end: 0 });
    assert.deepEqual(parseRange('bytes=900-', size), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', size), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=990-5000', size), { start: 990, end: 999 });
    assert.deepEqual(parseRange('bytes=999-999', size), { start: 999, end: 999 });
    assert.deepEqual(parseRange('bytes=1000-', size), { unsatisfiable: true });
    assert.deepEqual(parseRange('bytes=1000-2000', size), { unsatisfiable: true });
    assert.deepEqual(parseRange('bytes=-0', size), { unsatisfiable: true });
    assert.deepEqual(parseRange('bytes=9999999999999999-', size), { unsatisfiable: true });
    // Ignored (serve the whole file): inverted, multiple ranges, other units, garbage.
    for (const h of ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-5', 'bytes=', 'bytes=-', 'bytes=a-b', 'bytes 0-5']) {
      assert.equal(parseRange(h, size), null, h);
    }
  });
});

describe('media: single-request uploads', () => {
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

  test('each accepted type uploads with the right kind', async () => {
    const cases = [
      ['image/jpeg', 'jpeg', 'image'],
      ['image/png', 'png', 'image'],
      ['image/gif', 'gif87', 'image'],
      ['image/gif', 'gif89', 'image'],
      ['image/webp', 'webp', 'image'],
      ['video/mp4', 'mp4', 'video'],
      ['video/quicktime', 'mov', 'video'],
      ['video/webm', 'webm', 'video'],
      ['audio/mp4', 'm4a', 'audio'],
      ['audio/mp4', 'mp4', 'audio'],
      ['audio/aac', 'aac', 'audio'],
      ['audio/aac', 'aacCrc', 'audio'],
      ['audio/mpeg', 'id3', 'audio'],
      ['audio/mpeg', 'mp3', 'audio'],
      ['audio/webm', 'webm', 'audio'],
      ['audio/ogg', 'ogg', 'audio'],
      ['audio/webm;codecs=opus', 'webm', 'audio'],
    ];
    for (const [mime, head, kind] of cases) {
      const res = await uploadSmall(app, alice, mediaFile(MEDIA_HEADS[head], 300), mime);
      assert.equal(res.status, 201, `${mime} ${head}: ${res.text}`);
      assert.equal(res.body.attachment.kind, kind);
      assert.equal(res.body.attachment.mime, mime.split(';')[0]);
      assert.equal(res.body.attachment.size, 300);
      assert.equal(res.body.attachment.expired, false);
    }
  });

  test('content that does not match the declared family is 415 and leaves nothing behind', async () => {
    const before = fs.readdirSync(path.join(app.dataDir, 'uploads')).length;
    const cases = [
      ['image/png', Buffer.from('<html><script>alert(1)</script></html>')],
      ['image/jpeg', mediaFile(MEDIA_HEADS.mp4)],
      ['image/gif', mediaFile(MEDIA_HEADS.webm)],
      ['video/mp4', mediaFile(MEDIA_HEADS.jpeg)],
      ['video/webm', mediaFile(MEDIA_HEADS.ogg)],
      ['video/quicktime', mediaFile(MEDIA_HEADS.mp3)],
      ['audio/mpeg', mediaFile(MEDIA_HEADS.png)],
      ['audio/ogg', Buffer.alloc(100, 0)],
      ['audio/mp4', Buffer.from('%PDF-1.7 not audio')],
    ];
    for (const [mime, bytes] of cases) {
      const res = await uploadSmall(app, alice, bytes, mime);
      assert.equal(res.status, 415, `${mime}: ${res.text}`);
      assert.match(res.body.error, /isn't the type/);
    }
    assert.equal(fs.readdirSync(path.join(app.dataDir, 'uploads')).length, before);
  });

  test('metadata from the query string, validated per kind', async () => {
    const photo = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg', '?width=4032&height=3024&durationMs=5');
    assert.equal(photo.width, 4032);
    assert.equal(photo.height, 3024);
    assert.equal(photo.durationMs, null); // photos have no duration
    const video = await uploadOk(
      app,
      alice,
      mediaFile(MEDIA_HEADS.mp4),
      'video/mp4',
      `?width=1920&height=1080&durationMs=12000&thumbnailId=${photo.id}`
    );
    assert.deepEqual(
      [video.kind, video.width, video.height, video.durationMs, video.thumbnailId],
      ['video', 1920, 1080, 12000, photo.id]
    );
    const voice = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.m4a), 'audio/mp4', '?durationMs=3400&width=10');
    assert.deepEqual([voice.kind, voice.width, voice.height, voice.durationMs, voice.thumbnailId], ['audio', null, null, 3400, null]);

    const bobsPhoto = await uploadOk(app, bob);
    const bad = [
      ['image/png', '?width=0'],
      ['image/png', '?width=-5'],
      ['image/png', '?height=1.5'],
      ['image/png', '?height=100001'],
      ['video/mp4', '?durationMs=abc'],
      ['video/mp4', `?thumbnailId=${bobsPhoto.id}`], // someone else's
      ['video/mp4', `?thumbnailId=${video.id}`], // not a photo
      ['video/mp4', '?thumbnailId=a_missing'],
      ['video/mp4', '?thumbnailId=../../etc'],
      ['audio/mp4', `?thumbnailId=${photo.id}`], // voice messages have no thumbnail
    ];
    for (const [mime, query] of bad) {
      const head = mime === 'image/png' ? MEDIA_HEADS.png : mime === 'video/mp4' ? MEDIA_HEADS.mp4 : MEDIA_HEADS.m4a;
      const res = await uploadSmall(app, alice, mediaFile(head), mime, query);
      assert.equal(res.status, 400, `${mime} ${query}`);
    }
  });

  test('small uploads stop at MAX_UPLOAD_MB when it is below 10 MB', async () => {
    const small = await startApp({ maxUploadMb: 0.001 }); // 1048 bytes
    try {
      const me = await register(small);
      assert.equal((await uploadSmall(small, me, mediaFile(MEDIA_HEADS.png, 1048), 'image/png')).status, 201);
      assert.equal((await uploadSmall(small, me, mediaFile(MEDIA_HEADS.png, 1049), 'image/png')).status, 413);
    } finally {
      await small.close();
    }
  });

  test('a thumbnail follows the permissions of the attachment that uses it', async () => {
    const c = await dm(app, alice, bob);
    const thumb = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
    const video = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.mp4), 'video/mp4', `?thumbnailId=${thumb.id}`);
    const get = (who, id) => request(app, 'GET', `/api/attachments/${id}`, { token: who.token });
    assert.equal((await get(alice, thumb.id)).status, 200);
    assert.equal((await get(bob, thumb.id)).status, 403);
    assert.equal((await get(bob, video.id)).status, 403);

    const msg = await send(app, alice, c.id, '', { attachmentId: video.id });
    assert.equal(msg.attachment.thumbnailId, thumb.id);
    assert.equal(msg.attachment.kind, 'video');
    const bobThumb = await get(bob, thumb.id);
    assert.equal(bobThumb.status, 200);
    assert.equal(bobThumb.headers.get('content-type'), 'image/jpeg');
    assert.equal((await get(bob, video.id)).status, 200);
    assert.equal((await get(carol, thumb.id)).status, 403);
    assert.equal((await get(carol, video.id)).status, 403);

    // A file can only be sent once.
    const again = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
      token: alice.token,
      body: { clientId: 'reuse-1', attachmentId: video.id },
    });
    assert.equal(again.status, 400);
  });

  test('media is served with its stored type and nosniff; push preview names the kind', async () => {
    const c = await dm(app, alice, carol);
    const voice = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.webm), 'audio/webm');
    await send(app, alice, c.id, '', { attachmentId: voice.id });
    const res = await request(app, 'GET', `/api/attachments/${voice.id}?token=${carol.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const { preview } = require('../server/push');
    assert.equal(preview('', { kind: 'video' }), 'Video');
    assert.equal(preview('', { kind: 'audio' }), 'Voice message');
    assert.equal(preview('', { kind: 'image' }), 'Photo');
    assert.equal(preview('caption', { kind: 'video' }), 'caption');
  });
});

describe('media: HTTP Range requests', () => {
  let app;
  let alice;
  let bob;
  let carol;
  let att;
  let bytes;
  const get = (token, headers = {}, method = 'GET') =>
    fetch(`${app.url}/api/attachments/${att.id}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers } });

  before(async () => {
    app = await startApp();
    alice = await register(app);
    bob = await register(app);
    carol = await register(app);
    bytes = mediaFile(MEDIA_HEADS.mp4, 1000);
    for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251;
    att = await uploadOk(app, alice, bytes, 'video/mp4');
    const c = await dm(app, alice, bob);
    await send(app, alice, c.id, '', { attachmentId: att.id });
  });
  after(() => app.close());

  test('full response advertises ranges', async () => {
    const res = await get(bob.token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-length'), '1000');
    assert.equal(res.headers.get('etag'), `"${att.id}"`);
    assert.ok(res.headers.get('last-modified'));
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  });

  test('single ranges give 206 with the right bytes', async () => {
    const cases = [
      ['bytes=0-99', 0, 99],
      ['bytes=0-1', 0, 1], // what Safari asks first
      ['bytes=900-', 900, 999],
      ['bytes=-100', 900, 999],
      ['bytes=990-5000', 990, 999],
      ['bytes=999-999', 999, 999],
      ['bytes=-5000', 0, 999],
    ];
    for (const [range, start, end] of cases) {
      const res = await get(bob.token, { Range: range });
      assert.equal(res.status, 206, range);
      assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/1000`, range);
      assert.equal(res.headers.get('content-length'), String(end - start + 1), range);
      assert.equal(res.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(start, end + 1), range);
    }
  });

  test('unsatisfiable ranges are 416 with the size', async () => {
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0']) {
      const res = await get(bob.token, { Range: range });
      assert.equal(res.status, 416, range);
      assert.equal(res.headers.get('content-range'), 'bytes */1000');
      assert.deepEqual(await res.json(), { error: 'Range not satisfiable' });
    }
  });

  test('ignored ranges serve the whole file', async () => {
    for (const range of ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-5', 'bytes=x-y']) {
      const res = await get(bob.token, { Range: range });
      assert.equal(res.status, 200, range);
      assert.equal((await res.arrayBuffer()).byteLength, 1000);
    }
  });

  test('If-Range, If-None-Match and HEAD', async () => {
    const etag = `"${att.id}"`;
    let res = await get(bob.token, { Range: 'bytes=0-9', 'If-Range': etag });
    assert.equal(res.status, 206);
    await res.arrayBuffer();
    res = await get(bob.token, { Range: 'bytes=0-9', 'If-Range': '"something-else"' });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    res = await get(bob.token, { 'If-None-Match': etag });
    assert.equal(res.status, 304);
    res = await get(bob.token, { Range: 'bytes=10-19' }, 'HEAD');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-length'), '10');
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  test('permissions come before ranges', async () => {
    assert.equal((await get(carol.token, { Range: 'bytes=0-1' })).status, 403);
    const anon = await fetch(`${app.url}/api/attachments/${att.id}`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(anon.status, 401);
    // ?token= still works for <video src>.
    const viaQuery = await fetch(`${app.url}/api/attachments/${att.id}?token=${bob.token}`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(viaQuery.status, 206);
  });
});

describe('media: MEDIA_RETENTION_DAYS sweep', () => {
  test('old files are deleted, messages keep an expired attachment', async () => {
    const clock = fakeClock(Date.UTC(2026, 0, 1));
    const app = await startApp({ now: clock, mediaRetentionDays: 30, sweepIntervalMs: 60 * 60 * 1000 });
    try {
      const alice = await register(app);
      const bob = await register(app);
      const c = await dm(app, alice, bob);
      const thumb = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.jpeg), 'image/jpeg');
      const oldVideo = await uploadOk(app, alice, mediaFile(MEDIA_HEADS.mp4), 'video/mp4', `?thumbnailId=${thumb.id}`);
      const unsent = await uploadOk(app, alice); // uploaded but never posted
      const oldMsg = await send(app, alice, c.id, 'old', { attachmentId: oldVideo.id });

      clock.advance(29 * DAY);
      const fresh = await uploadOk(app, alice);
      const freshMsg = await send(app, alice, c.id, '', { attachmentId: fresh.id });
      assert.deepEqual(app.sweeper.sweep().expired, []);

      clock.advance(2 * DAY); // the first uploads are now 31 days old, `fresh` 2 days
      const { expired } = app.sweeper.sweep();
      assert.deepEqual(expired.sort(), [thumb.id, oldVideo.id, unsent.id].sort());
      const uploads = path.join(app.dataDir, 'uploads');
      for (const id of expired) assert.ok(!fs.existsSync(path.join(uploads, id)), id);
      assert.ok(fs.existsSync(path.join(uploads, fresh.id)));

      const list = (await request(app, 'GET', `/api/conversations/${c.id}/messages`, { token: bob.token })).body.messages;
      const old = list.find((m) => m.id === oldMsg.id);
      assert.equal(old.body, 'old');
      assert.equal(old.attachment.id, oldVideo.id);
      assert.equal(old.attachment.expired, true);
      assert.equal(old.attachment.kind, 'video');
      assert.equal(list.find((m) => m.id === freshMsg.id).attachment.expired, false);

      const gone = await request(app, 'GET', `/api/attachments/${oldVideo.id}`, { token: bob.token });
      assert.equal(gone.status, 410);
      assert.equal((await request(app, 'GET', `/api/attachments/${thumb.id}`, { token: bob.token })).status, 410);
      assert.equal((await request(app, 'GET', `/api/attachments/${fresh.id}`, { token: bob.token })).status, 200);
      // Strangers still get 403, not a hint that it expired.
      const carol = await register(app);
      assert.equal((await request(app, 'GET', `/api/attachments/${oldVideo.id}`, { token: carol.token })).status, 403);
      // An expired upload can't be sent.
      const post = await request(app, 'POST', `/api/conversations/${c.id}/messages`, {
        token: alice.token,
        body: { clientId: 'late', attachmentId: unsent.id },
      });
      assert.equal(post.status, 400);
      // Sweeping again finds nothing new.
      assert.deepEqual(app.sweeper.sweep().expired, []);
    } finally {
      await app.close();
    }
  });

  test('0 keeps media forever', async () => {
    const clock = fakeClock();
    const app = await startApp({ now: clock, mediaRetentionDays: 0 });
    try {
      const alice = await register(app);
      const att = await uploadOk(app, alice);
      clock.advance(3650 * DAY);
      assert.deepEqual(app.sweeper.sweep().expired, []);
      assert.equal((await request(app, 'GET', `/api/attachments/${att.id}`, { token: alice.token })).status, 200);
    } finally {
      await app.close();
    }
  });

  test('the sweep runs on its own every sweepIntervalMs', async () => {
    const clock = fakeClock();
    const app = await startApp({ now: clock, mediaRetentionDays: 1, sweepIntervalMs: 20 });
    try {
      const alice = await register(app);
      const att = await uploadOk(app, alice);
      const file = path.join(app.dataDir, 'uploads', att.id);
      await sleep(80);
      assert.ok(fs.existsSync(file));
      clock.advance(2 * DAY);
      for (let i = 0; i < 50 && fs.existsSync(file); i++) await sleep(20);
      assert.ok(!fs.existsSync(file));
      assert.equal(app.store.getAttachment(att.id).expired, 1);
    } finally {
      await app.close();
    }
  });

  test('MEDIA_RETENTION_DAYS and MAX_UPLOAD_MB are read from the environment', async () => {
    const saved = { r: process.env.MEDIA_RETENTION_DAYS, m: process.env.MAX_UPLOAD_MB };
    process.env.MEDIA_RETENTION_DAYS = '7';
    process.env.MAX_UPLOAD_MB = '1';
    const clock = fakeClock();
    let app;
    try {
      app = await startApp({ now: clock, mediaRetentionDays: undefined, maxUploadMb: undefined });
      const alice = await register(app);
      const tooBig = await request(app, 'POST', '/api/uploads', { token: alice.token, body: { mime: 'video/mp4', size: 1024 * 1024 + 1 } });
      assert.equal(tooBig.status, 413);
      const ok = await request(app, 'POST', '/api/uploads', { token: alice.token, body: { mime: 'video/mp4', size: 1024 * 1024 } });
      assert.equal(ok.status, 201);
      const att = await uploadOk(app, alice, PNG_BYTES);
      clock.advance(6 * DAY);
      assert.deepEqual(app.sweeper.sweep().expired, []);
      clock.advance(2 * DAY);
      assert.deepEqual(app.sweeper.sweep().expired, [att.id]);
    } finally {
      if (app) await app.close();
      for (const [k, v] of [['MEDIA_RETENTION_DAYS', saved.r], ['MAX_UPLOAD_MB', saved.m]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
