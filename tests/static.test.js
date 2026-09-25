'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startApp, request } = require('./helpers');

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Sends a raw request line so the path is not normalized by a URL parser. */
function rawGet(app, target) {
  const { port } = new URL(app.url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString('latin1')));
    sock.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), head, body: rest.join('\r\n\r\n') });
    });
    sock.on('error', reject);
  });
}

describe('static files', () => {
  let app;
  let publicDir;
  let secretDir;
  before(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-static-'));
    publicDir = path.join(root, 'public');
    secretDir = root;
    fs.mkdirSync(path.join(publicDir, 'js'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>TealTalk</title>INDEX');
    fs.writeFileSync(path.join(publicDir, 'app.js'), 'export const x = 1;');
    fs.writeFileSync(path.join(publicDir, 'js', 'mod.js'), 'export const y = 2;');
    fs.writeFileSync(path.join(publicDir, 'sw.js'), 'self.addEventListener("push", () => {});');
    fs.writeFileSync(path.join(publicDir, 'style.css'), 'body{}');
    fs.writeFileSync(path.join(publicDir, 'manifest.webmanifest'), '{"name":"TealTalk"}');
    fs.writeFileSync(path.join(publicDir, 'icons', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(publicDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(publicDir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'TOPSECRET');
    app = await startApp({ publicDir });
  });
  after(async () => {
    await app.close();
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  test('serves files with correct MIME types', async () => {
    const cases = {
      '/': 'text/html; charset=utf-8',
      '/index.html': 'text/html; charset=utf-8',
      '/app.js': 'text/javascript; charset=utf-8',
      '/js/mod.js': 'text/javascript; charset=utf-8',
      '/style.css': 'text/css; charset=utf-8',
      '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
      '/icons/icon.svg': 'image/svg+xml',
      '/icons/icon-192.png': 'image/png',
    };
    for (const [p, type] of Object.entries(cases)) {
      const res = await fetch(app.url + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), type, p);
      await res.arrayBuffer();
    }
    const js = await fetch(app.url + '/app.js');
    assert.equal(await js.text(), 'export const x = 1;');
  });

  test('sw.js has no-cache and Service-Worker-Allowed', async () => {
    const res = await fetch(app.url + '/sw.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    await res.text();
  });

  test('conditional GET returns 304', async () => {
    const first = await fetch(app.url + '/app.js');
    const etag = first.headers.get('etag');
    await first.text();
    assert.ok(etag);
    const second = await fetch(app.url + '/app.js', { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
  });

  test('unknown non-API paths fall back to index.html', async () => {
    for (const p of ['/chats', '/c/c_123', '/some/deep/route?x=1']) {
      const res = await fetch(app.url + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(await res.text(), /INDEX/);
    }
    const api = await request(app, 'GET', '/api/does-not-exist');
    assert.equal(api.status, 404);
    assert.equal(typeof api.body.error, 'string');
  });

  test('path traversal and dotfiles are blocked', async () => {
    for (const target of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/js/..%2f..%2fsecret.txt',
      '/..\\secret.txt',
      '/%5c..%5csecret.txt',
      '/.env',
      '/%2eenv',
      '/%00',
      '/%E0%A4%A',
      '//etc/passwd',
    ]) {
      const res = await rawGet(app, target);
      assert.ok(!res.body.includes('TOPSECRET'), target);
      assert.ok(!res.body.includes('SECRET=1'), target);
      assert.ok(!res.body.includes('root:'), target);
      assert.ok([200, 400, 404].includes(res.status), `${target} -> ${res.status}`);
    }
    assert.equal((await rawGet(app, '/..%2fsecret.txt')).status, 404);
    assert.equal((await rawGet(app, '/.env')).status, 404);
  });

  test('non-GET on static paths is 405', async () => {
    const res = await fetch(app.url + '/index.html', { method: 'POST', body: 'x' });
    assert.equal(res.status, 405);
    await res.text();
  });

  test('security headers on every kind of response', async () => {
    const responses = [
      await fetch(app.url + '/'),
      await fetch(app.url + '/app.js'),
      await fetch(app.url + '/nowhere'),
      await fetch(app.url + '/api/health'),
      await fetch(app.url + '/api/me'),
      await fetch(app.url + '/api/nope'),
    ];
    for (const res of responses) {
      assert.equal(res.headers.get('content-security-policy'), EXPECTED_CSP, res.url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(res.headers.get('permissions-policy'));
      await res.arrayBuffer();
    }
  });

  test('plain GET /ws without upgrade is 426', async () => {
    const res = await request(app, 'GET', '/ws');
    assert.equal(res.status, 426);
  });
});

describe('static without index.html', () => {
  test('missing files are 404 when there is no index.html', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-empty-'));
    const app = await startApp({ publicDir: dir });
    try {
      const res = await fetch(app.url + '/anything');
      assert.equal(res.status, 404);
      await res.text();
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
