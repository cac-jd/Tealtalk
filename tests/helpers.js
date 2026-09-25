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

module.exports = { startApp, request, register, dm, send, uniqueName, WsClient, sleep, PNG_BYTES, quietLog };
