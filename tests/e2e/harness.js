'use strict';

// Shared pieces of the browser tests: a tiny check runner, polling, an in-script
// PNG, and page helpers that find things only through the data-testid contract
// in docs/PROTOCOL.md.

const path = require('node:path');
const zlib = require('node:zlib');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return require(path.join(root, 'playwright'));
  } catch {
    return require('playwright');
  }
}

const PASSWORD = 'teal-talk-e2e-pass';

// ---------------------------------------------------------------------------
// tiny harness

function createRunner() {
  const results = [];
  let aborted = false;

  async function check(name, fn, { critical = false } = {}) {
    if (aborted) {
      results.push({ name, ok: false, skipped: true });
      console.log(`SKIP  ${name}`);
      return;
    }
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.log(`FAIL  ${name}\n      ${String((err && err.message) || err).split('\n').join('\n      ')}`);
      if (critical) aborted = true;
    }
  }

  /** Prints the tally; true when every check passed. */
  function summary(origin) {
    const failed = results.filter((r) => !r.ok);
    const passed = results.length - failed.length;
    console.log(`\n${passed}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''} (origin ${origin})`);
    return failed.length === 0;
  }

  return { check, results, summary };
}

/** Runs `main` (resolving true/false) under a watchdog and exits with its result. */
function runMain(main, timeoutMs) {
  const watchdog = setTimeout(() => {
    console.log(`FAIL  e2e run exceeded ${timeoutMs / 1000}s`);
    process.exit(1);
  }, timeoutMs);
  main().then(
    (ok) => {
      clearTimeout(watchdog);
      process.exit(ok ? 0 : 1);
    },
    (err) => {
      clearTimeout(watchdog);
      console.log(`FAIL  e2e crashed: ${(err && err.stack) || err}`);
      process.exit(1);
    },
  );
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value. */
async function until(desc, fn, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) break;
    await sleep(100);
  }
  const detail = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`timed out waiting for ${desc} (last: ${detail})`);
}

// ---------------------------------------------------------------------------
// a small PNG, generated in-script (a sunset over the sea)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function sunsetPng(w = 320, h = 240) {
  const horizon = Math.round(h * 0.62);
  return makePng(w, h, (x, y) => {
    const sun = Math.hypot(x - w * 0.66, y - horizon + 6) < h * 0.15;
    const hill = y > horizon - 26 + 18 * Math.sin(x / 38) + 10 * Math.cos(x / 17) && x < w * 0.45;
    if (y < horizon) {
      if (sun) return [255, 244, 214];
      if (hill) return [19, 78, 74];
      return mix([253, 230, 138], [249, 115, 22], y / horizon);
    }
    const t = (y - horizon) / (h - horizon);
    const glint = Math.abs(x - w * 0.66) < 30 * (1 - t) && (y + Math.round(x / 7)) % 9 < 2;
    return glint ? [254, 215, 170] : mix([20, 184, 166], [15, 78, 74], t);
  });
}

// ---------------------------------------------------------------------------
// real media, made in-script: a JPEG photo with a GPS block, a WebM video

/** A full-size JPEG (a sunset over a lake) encoded by the browser's canvas. */
async function canvasJpeg(page, { width = 2400, height = 1600, quality = 0.9 } = {}) {
  const bytes = await page.evaluate(
    async ({ width: w, height: h, quality: q }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const horizon = h * 0.6;
      const sky = g.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, '#fde68a');
      sky.addColorStop(1, '#f97316');
      g.fillStyle = sky;
      g.fillRect(0, 0, w, horizon);
      g.fillStyle = '#fff4d6';
      g.beginPath();
      g.arc(w * 0.66, horizon - h * 0.02, h * 0.12, 0, Math.PI * 2);
      g.fill();
      for (const [shade, base, amp, f] of [['#1f6f68', 0.12, 0.1, 380], ['#134e4a', 0.05, 0.07, 170]]) {
        g.fillStyle = shade;
        g.beginPath();
        g.moveTo(0, horizon);
        for (let x = 0; x <= w; x += 8) g.lineTo(x, horizon - h * base - h * amp * Math.abs(Math.sin(x / f) + 0.4 * Math.cos(x / (f / 2.7))));
        g.lineTo(w, horizon);
        g.fill();
      }
      const sea = g.createLinearGradient(0, horizon, 0, h);
      sea.addColorStop(0, '#14b8a6');
      sea.addColorStop(1, '#0f4e4a');
      g.fillStyle = sea;
      g.fillRect(0, horizon, w, h - horizon);
      g.fillStyle = 'rgba(254, 215, 170, 0.8)';
      for (let y = horizon + 6; y < h; y += 14) {
        const half = (w * 0.05 * (h - y)) / (h - horizon);
        g.fillRect(w * 0.66 - half, y, half * 2, 4);
      }
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { width, height, quality },
  );
  return Buffer.from(bytes);
}

/**
 * Put an EXIF block right after the JPEG's SOI marker: Make, Model, Orientation and
 * a GPS IFD with latitude, longitude and altitude (big-endian, like an iPhone).
 * Returns { jpeg, stripped }: `stripped` is what the app must send, the same bytes
 * with only the GPS IFD (its entries, count and out-of-line values) zeroed.
 */
function withGpsExif(jpeg) {
  const tiff = Buffer.alloc(216);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    if (type === 3 && count === 1) tiff.writeUInt16BE(value, at + 8);
    else if (Buffer.isBuffer(value)) value.copy(tiff, at + 8);
    else tiff.writeUInt32BE(value, at + 8);
  };
  // IFD0 at 8: 4 entries, next IFD 0 -> ends at 62
  tiff.writeUInt16BE(4, 8);
  entry(10, 0x010f, 2, 9, 62); // Make -> "TealTalk"
  entry(22, 0x0110, 2, 10, 71); // Model -> "iPhone 13"
  entry(34, 0x0112, 3, 1, 1); // Orientation
  entry(46, 0x8825, 4, 1, 82); // GPS IFD pointer
  tiff.write('TealTalk\0', 62, 'ascii');
  tiff.write('iPhone 13\0', 71, 'ascii');
  // GPS IFD at 82: 6 entries (ends at 160), values 160..216
  tiff.writeUInt16BE(6, 82);
  entry(84, 0x0000, 1, 4, Buffer.from([2, 3, 0, 0])); // GPSVersionID
  entry(96, 0x0001, 2, 2, Buffer.from('N\0')); // GPSLatitudeRef
  entry(108, 0x0002, 5, 3, 160); // GPSLatitude
  entry(120, 0x0003, 2, 2, Buffer.from('W\0')); // GPSLongitudeRef
  entry(132, 0x0004, 5, 3, 184); // GPSLongitude
  entry(144, 0x0006, 5, 1, 208); // GPSAltitude
  [47, 1, 36, 1, 3150, 100].forEach((v, i) => tiff.writeUInt32BE(v, 160 + i * 4));
  [122, 1, 19, 1, 4420, 100].forEach((v, i) => tiff.writeUInt32BE(v, 184 + i * 4));
  [5230, 100].forEach((v, i) => tiff.writeUInt32BE(v, 208 + i * 4));

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  const out = Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
  const tiffAt = 2 + header.length + 6;
  const stripped = Buffer.from(out);
  stripped.fill(0, tiffAt + 82, tiffAt + 216); // GPS count + entries + next-IFD (0) + values
  return { jpeg: out, stripped };
}

/** A short VP8 WebM recorded from an animated canvas (Chromium can't decode H.264). */
async function recordWebm(page, { width = 480, height = 320, ms = 1200 } = {}) {
  const bytes = await page.evaluate(
    async ({ width: w, height: h, ms: duration }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const draw = (t) => {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0f766e');
        sky.addColorStop(1, '#f59e0b');
        g.fillStyle = sky;
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff4d6';
        g.beginPath();
        g.arc(w * (0.2 + 0.6 * t), h * 0.45, h * 0.12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#134e4a';
        g.fillRect(0, h * 0.7, w, h * 0.3);
      };
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const started = performance.now();
      draw(0);
      rec.start();
      await new Promise((resolve) => {
        const step = () => {
          const t = (performance.now() - started) / duration;
          draw(Math.min(1, t));
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const stopped = new Promise((resolve) => (rec.onstop = resolve));
      rec.stop();
      await stopped;
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    { width, height, ms },
  );
  return Buffer.from(bytes);
}

/** Reads an EBML variable-length integer at `p`: { length, value, unknown }. */
function ebmlVint(buf, p) {
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(buf[p] & mask)) {
    mask >>= 1;
    length++;
  }
  let value = buf[p] & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[p + i];
  return { length, value, unknown: value === 2 ** (7 * length) - 1 };
}

/**
 * Grow a WebM to at least `size` bytes without changing what plays: append an EBML
 * Void element at the end of the Segment and fix the Segment's size. Nothing moves,
 * so the SeekHead and Cues stay right.
 */
function padWebm(webm, size) {
  const idLen = (p) => (webm[p] & 0x80 ? 1 : webm[p] & 0x40 ? 2 : webm[p] & 0x20 ? 3 : 4);
  const header = ebmlVint(webm, 4);
  const seg = 4 + header.length + header.value; // the Segment element starts here
  if (webm.readUInt32BE(seg) !== 0x18538067) throw new Error('no WebM Segment where expected');
  const sizeAt = seg + idLen(seg);
  const segSize = ebmlVint(webm, sizeAt);
  if (!segSize.unknown && sizeAt + segSize.length + segSize.value !== webm.length) throw new Error('data after the WebM Segment');
  const payload = Math.max(0, size - webm.length - 9);
  const voidEl = Buffer.alloc(9 + payload);
  voidEl[0] = 0xec;
  voidEl[1] = 0x01; // 8-byte size
  voidEl.writeUIntBE(payload, 3, 6);
  const out = Buffer.concat([webm, voidEl]);
  if (!segSize.unknown) {
    const total = segSize.value + voidEl.length;
    if (segSize.length < 4 || total >= 2 ** (7 * segSize.length) - 1) throw new Error('WebM Segment size field too small');
    out[sizeAt] = 1 << (8 - segSize.length);
    out.writeUIntBE(total, sizeAt + segSize.length - 6, 6);
    for (let i = 1; i < segSize.length - 6; i++) out[sizeAt + i] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// devices: every request and console error is watched

/**
 * Returns `device(label, descriptor, extra)` that opens a watched context + page.
 * Requests to any host but the server land in `foreignRequests`; console errors
 * (except those `expectedError(text)` accepts) and page errors in `consoleErrors`.
 */
function deviceFactory({ browser, serverHost, foreignRequests, consoleErrors, expectedError = () => false }) {
  const strip = ({ defaultBrowserType, ...d }) => d; // eslint-disable-line no-unused-vars
  return async function device(label, descriptor, extra = {}) {
    const context = await browser.newContext({ ...strip(descriptor), ...extra });
    const watch = (url) => {
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return;
      let host;
      try {
        host = new URL(url).host;
      } catch {
        host = url;
      }
      if (host !== serverHost) foreignRequests.push(`${label}: ${url}`);
    };
    context.on('request', (req) => watch(req.url()));
    const page = await context.newPage();
    page.on('request', (req) => watch(req.url()));
    page.on('websocket', (ws) => watch(ws.url()));
    page.on('console', (msg) => {
      if (msg.type() !== 'error' || expectedError(msg.text(), msg)) return;
      const where = (msg.location() && msg.location().url) || '';
      consoleErrors.push(`${label}: ${msg.text()}${where && !msg.text().includes(where) ? ` (${where})` : ''}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`${label} pageerror: ${err.message}`));
    return { context, page };
  };
}

// ---------------------------------------------------------------------------
// page helpers (data-testid only)

const tid = (page, id) => page.getByTestId(id);

async function text(locator) {
  return ((await locator.textContent()) || '').trim();
}

function messagesWithBody(page, body) {
  return tid(page, 'message').filter({ has: page.getByTestId('message-body').getByText(body, { exact: true }) });
}

const RECOVERY_KEY_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/;

/**
 * The recovery-key screen after a new key was made (first setup, a reset or Start fresh):
 * read the key and confirm it was saved, re-typing its last group when the app asks for
 * that. Resolves to the key once the screen is gone (to the chat list, or back to Settings
 * after a reset from there).
 */
async function saveRecoveryKey(page) {
  const screen = tid(page, 'recovery-key-screen');
  await screen.waitFor();
  const key = await until('recovery key on screen', async () => {
    const shown = await text(tid(page, 'recovery-key-display'));
    return RECOVERY_KEY_FORMAT.test(shown) && shown;
  });
  const confirmInput = tid(page, 'recovery-confirm-input');
  if (!(await confirmInput.isVisible())) await tid(page, 'recovery-saved-button').click();
  // The confirm step may come with the key or only after "I've saved it".
  const next = await until('recovery key screen done or confirm step', async () => {
    if (await confirmInput.isVisible()) return 'confirm';
    if (await screen.isHidden()) return 'done';
    return null;
  });
  if (next === 'confirm') {
    await confirmInput.fill(key.split('-').pop());
    await tid(page, 'recovery-confirm-button').click();
    await screen.waitFor({ state: 'hidden' });
  }
  return key;
}

/** Create an account; resolves to its recovery key (8 groups of 4). */
async function register(page, url, username, displayName) {
  await page.goto(url);
  await tid(page, 'auth-screen').waitFor();
  await tid(page, 'auth-toggle').click();
  await tid(page, 'auth-username').fill(username);
  await tid(page, 'auth-displayname').fill(displayName);
  await tid(page, 'auth-password').fill(PASSWORD);
  await tid(page, 'auth-submit').click();
  const key = await saveRecoveryKey(page);
  await tid(page, 'chats-screen').waitFor();
  return key;
}

/**
 * Log in. On a device without this account's key the app asks for the recovery key
 * (`recoveryKey` must then be given); an account that never set up encryption gets a
 * new key, whose recovery key is saved. Resolves to the screen that came up first:
 * 'chats', 'recovery' or 'new-key'.
 */
async function login(page, username, { recoveryKey = null } = {}) {
  await tid(page, 'auth-screen').waitFor();
  await tid(page, 'auth-username').fill(username);
  await tid(page, 'auth-password').fill(PASSWORD);
  await tid(page, 'auth-submit').click();
  const first = await until('chat list or recovery screen', async () => {
    if (await tid(page, 'chats-screen').isVisible()) return 'chats';
    if (await tid(page, 'recovery-screen').isVisible()) return 'recovery';
    if (await tid(page, 'recovery-key-screen').isVisible()) return 'new-key';
    return null;
  }, 15000);
  if (first === 'recovery') {
    assert(recoveryKey, `${username} needs a recovery key on this device`);
    await enterRecoveryKey(page, recoveryKey);
    await tid(page, 'chats-screen').waitFor();
  } else if (first === 'new-key') {
    await saveRecoveryKey(page);
    await tid(page, 'chats-screen').waitFor();
  }
  return first;
}

async function enterRecoveryKey(page, recoveryKey) {
  await tid(page, 'recovery-input').fill(recoveryKey);
  await tid(page, 'recovery-submit').click();
}

/**
 * Settings -> Log out, accepting the "you'll need your recovery key" warning.
 * Resolves to the warning's text ('' if none was shown).
 */
async function logout(page) {
  let warning = '';
  const onDialog = (d) => {
    warning = d.message();
    d.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    // From a chat, go back to the list (a back tap may already be on its way).
    await until('chat list', async () => {
      if (await tid(page, 'chats-screen').isVisible()) return true;
      if (await tid(page, 'back-button').isVisible()) await tid(page, 'back-button').click({ timeout: 1000 }).catch(() => {});
      return false;
    });
    await tid(page, 'settings-button').click();
    await tid(page, 'settings-screen').waitFor();
    await tid(page, 'logout-button').click();
    await tid(page, 'auth-screen').waitFor();
  } finally {
    page.off('dialog', onDialog);
  }
  return warning;
}

/**
 * Send text messages as the user logged in on `page` without the composer: sealed by
 * the app's own encryption code (the same module instance, so the same keys) and
 * posted straight to the API, like another device of theirs. Resolves to the new ids.
 */
function postSealed(page, conversationId, bodies) {
  return page.evaluate(
    async ({ conversationId: convId, bodies: texts }) => {
      const { sendSealed } = await import('/js/e2ee.js');
      const { Api } = await import('/js/api.js');
      const { conversation } = await Api.conversation(convId);
      const recipientIds = conversation.members.map((m) => m.id);
      const ids = [];
      for (const body of texts) {
        const clientId = crypto.randomUUID();
        const { message } = await sendSealed({
          conversationId: convId,
          kind: 'message',
          payload: { kind: 'message', body, attachments: [], replyTo: null },
          clientId,
          recipientIds,
          post: (e2ee) => Api.sendMessage(convId, { clientId, e2ee }),
        });
        ids.push(message.id);
      }
      return ids;
    },
    { conversationId, bodies },
  );
}

/**
 * Init script (context.addInitScript): remembers every object URL the page makes, so a
 * test can read decrypted media (the CSP rightly forbids fetch() of blob: URLs) and count
 * the ones still alive. Decrypted media of the open chat legitimately stays alive, so leak
 * checks count only the URLs made after a mark: __liveObjectUrls(__objectUrlMark()).
 */
function trackObjectUrls() {
  const live = new Map(); // url -> creation sequence number
  const objects = new Map(); // url -> Blob, kept for reading even after revoke
  let seq = 0;
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    const url = create(obj);
    live.set(url, ++seq);
    objects.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    live.delete(url);
    return revoke(url);
  };
  window.__objectUrlMark = () => seq;
  window.__liveObjectUrls = (since = 0) => [...live.values()].filter((n) => n > since).length;
  window.__blobFor = (url) => objects.get(url) || null;
}

/** Bytes behind a blob: URL in the page (decrypted media), as a Buffer. Needs trackObjectUrls. */
async function blobBytes(page, url) {
  const bytes = await page.evaluate(async (u) => {
    const blob = window.__blobFor(u);
    if (!blob) throw new Error(`no Blob known for ${u}`);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, url);
  return Buffer.from(bytes);
}

/** { type, size, sha256 } of the Blob behind a blob: URL, hashed in the page (for big files). */
function blobInfo(page, url) {
  return page.evaluate(async (u) => {
    const blob = window.__blobFor(u);
    if (!blob) throw new Error(`no Blob known for ${u}`);
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return { type: blob.type, size: blob.size, sha256 };
  }, url);
}

function conversationItem(page, convId) {
  return page.locator(`[data-testid="conversation-item"][data-conversation-id="${convId}"]`);
}

async function openConversation(page, convId) {
  await conversationItem(page, convId).click();
  await tid(page, 'chat-screen').waitFor();
}

async function sendText(page, body) {
  await tid(page, 'message-input').fill(body);
  await tid(page, 'send-button').click();
}

async function statusOf(page, body) {
  const msg = messagesWithBody(page, body);
  if ((await msg.count()) !== 1) return null;
  return text(msg.getByTestId('message-status'));
}

async function waitStatus(page, body, expected, timeout = 10000) {
  await until(`"${body}" to be ${expected}`, async () => (await statusOf(page, body)) === expected, timeout);
}

async function countWithBody(page, body) {
  return messagesWithBody(page, body).count();
}

/** Background colour of the bubble inside a message element (first painted box). */
function bubbleColor(locator) {
  return locator.evaluate((el) => {
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
    }
    return null;
  });
}

function parseRgb(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
  return m ? m.slice(1, 4).map(Number) : null;
}

function isBlue(css) {
  const rgb = parseRgb(css);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (max === 0 || d / max < 0.25) return false; // grey-ish
  let hue;
  if (max === r) hue = 60 * (((g - b) / d) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  return hue >= 195 && hue <= 260;
}

/** Layout sanity: nothing wider than the viewport, key controls fully on screen. */
function layoutReport(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const doc = document.documentElement;
    const problems = [];
    if (doc.scrollWidth > vw + 1) problems.push(`page scrollWidth ${doc.scrollWidth} > ${vw}`);
    const visible = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    for (const el of document.querySelectorAll('[data-testid]')) {
      if (!visible(el)) continue;
      const id = el.getAttribute('data-testid');
      if (id === 'attach-input') continue; // visually hidden file input
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1) problems.push(`${id} spans x ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${vw})`);
    }
    for (const id of ['message-input', 'send-button', 'chat-title', 'back-button']) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > vh + 1) problems.push(`${id} is off screen vertically (${Math.round(r.top)}..${Math.round(r.bottom)}, viewport ${vh})`);
    }
    for (const img of document.querySelectorAll('[data-testid="message-image"]')) {
      const r = img.getBoundingClientRect();
      if (r.right > vw + 1) problems.push(`message-image overflows to x=${Math.round(r.right)}`);
    }
    return problems;
  });
}

module.exports = {
  PASSWORD,
  loadPlaywright,
  createRunner,
  runMain,
  assert,
  sleep,
  until,
  crc32,
  makePng,
  sunsetPng,
  canvasJpeg,
  withGpsExif,
  recordWebm,
  padWebm,
  deviceFactory,
  tid,
  text,
  messagesWithBody,
  RECOVERY_KEY_FORMAT,
  saveRecoveryKey,
  register,
  login,
  enterRecoveryKey,
  logout,
  postSealed,
  trackObjectUrls,
  blobBytes,
  blobInfo,
  conversationItem,
  openConversation,
  sendText,
  statusOf,
  waitStatus,
  countWithBody,
  bubbleColor,
  parseRgb,
  isBlue,
  layoutReport,
};
