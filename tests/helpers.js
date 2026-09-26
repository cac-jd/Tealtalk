'use strict';

// Shared helpers for the server integration tests (not a test file itself).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createApp } = require('../server');

const quietLog = { log() {}, info() {}, warn() {}, error() {} };

async function startApp(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-test-'));
  const app = await createApp({
    port: 0,
    rateLimit: { max: 10000, windowMs: 60000 },
    log: quietLog,
    // Hermetic by default: ignore SIGNUP_CODE, MAX_UPLOAD_MB and MEDIA_RETENTION_DAYS from the environment.
    signupCode: null,
    maxUploadMb: 250,
    mediaRetentionDays: 0,
    ...opts,
    dataDir,
  });
  app.dataDir = dataDir;
  const close = app.close;
  app.close = async (keepData = false) => {
    await close();
    if (!keepData && !opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return app;
}

async function request(app, method, urlPath, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  const res = await fetch(app.url + urlPath, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  if (text && (res.headers.get('content-type') || '').includes('application/json')) json = JSON.parse(text);
  return { status: res.status, body: json, text, headers: res.headers };
}

let counter = 0;
function uniqueName(prefix = 'user') {
  counter += 1;
  return `${prefix}_${process.pid % 1000}_${counter}`.slice(0, 24);
}

async function register(app, username = uniqueName(), extra = {}) {
  const res = await request(app, 'POST', '/api/register', {
    body: { username, password: 'correct horse battery', ...extra },
  });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${res.text}`);
  return { token: res.body.token, user: res.body.user };
}

async function dm(app, a, b) {
  const res = await request(app, 'POST', '/api/conversations', { token: a.token, body: { memberIds: [b.user.id] } });
  return res.body.conversation;
}

async function send(app, who, conversationId, body, extra = {}) {
  const res = await request(app, 'POST', `/api/conversations/${conversationId}/messages`, {
    token: who.token,
    body: { clientId: crypto.randomUUID(), body, ...extra },
  });
  if (res.status !== 201) throw new Error(`send failed ${res.status} ${res.text}`);
  return res.body.message;
}

/** A WebSocket client that buffers frames so tests can await specific events. */
class WsClient {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
    this.closeWaiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.frames.push(msg);
      this.flush();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.closeWaiters) w(this.closed);
      this.closeWaiters = [];
    });
    ws.on('error', () => {});
  }

  static open(app, token) {
    const ws = new WebSocket(`${app.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const client = new WsClient(ws);
    return client;
  }

  /** Opens a socket and waits for `hello`. */
  static async connect(app, token) {
    const client = WsClient.open(app, token);
    await client.next('hello');
    return client;
  }

  flush() {
    for (const w of [...this.waiters]) {
      const idx = this.frames.findIndex(w.match);
      if (idx !== -1) {
        const [frame] = this.frames.splice(idx, 1);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(frame);
      }
    }
  }

  /** Resolves with the next (buffered or future) frame of this type matching the predicate. */
  next(type, pred = () => true, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const w = {
        match: (f) => f.type === type && pred(f),
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${type}; buffered: ${JSON.stringify(this.frames)}`));
        }, timeout),
      };
      this.waiters.push(w);
      this.flush();
    });
  }

  /** Asserts no frame of this type (matching pred) arrives within `ms`. Returns true if none arrived. */
  async none(type, pred = () => true, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    return !this.frames.some((f) => f.type === type && pred(f));
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitClose(timeout = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for close')), timeout);
      this.closeWaiters.push((c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
  }

  async close() {
    if (this.closed) return;
    const done = this.waitClose().catch(() => {});
    this.ws.close();
    await done;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Smallest valid-ish image payloads for upload tests.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// The first bytes of each accepted format (what the server's magic-number check looks at).
const MEDIA_HEADS = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: PNG_BYTES.subarray(0, 16),
  gif87: Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1'),
  gif89: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41')]),
  mov: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.from([0, 0, 2, 0]), Buffer.from('qt  ')]),
  m4a: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypM4A '), Buffer.from([0, 0, 0, 0]), Buffer.from('M4A mp42isom')]),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]),
  ogg: Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0, 0, 0, 0, 0, 0, 0])]),
  id3: Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0])]),
  mp3: Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]),
  aac: Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]),
  aacCrc: Buffer.from([0xff, 0xf9, 0x50, 0x80, 0x02, 0x1f, 0xfc]),
};

/** A fake media file: `head` then filler bytes, `size` bytes long in total. */
function mediaFile(head, size = 256) {
  const buf = Buffer.alloc(Math.max(size, head.length), 0x5a);
  head.copy(buf);
  return buf;
}

/** Uploads a small file in one request; returns the response. */
function uploadSmall(app, who, bytes, mime, query = '') {
  return request(app, 'POST', `/api/attachments${query}`, {
    token: who.token,
    raw: bytes,
    headers: { 'Content-Type': mime },
  });
}

/** Uploads and returns the attachment, failing loudly otherwise. */
async function uploadOk(app, who, bytes = PNG_BYTES, mime = 'image/png', query = '') {
  const res = await uploadSmall(app, who, bytes, mime, query);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${res.text}`);
  return res.body.attachment;
}

/** A controllable clock for createApp({ now }). */
function fakeClock(start = Date.now()) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  now.set = (value) => {
    t = value;
  };
  return now;
}

module.exports = {
  startApp,
  request,
  register,
  dm,
  send,
  uniqueName,
  WsClient,
  sleep,
  PNG_BYTES,
  MEDIA_HEADS,
  mediaFile,
  uploadSmall,
  uploadOk,
  fakeClock,
  quietLog,
};
