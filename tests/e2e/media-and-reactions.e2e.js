'use strict';

// Full-quality messaging (v2) between an iPhone user (Maya, iPhone 13) and an
// Android user (Jordan, Pixel 7), plus Sam on a narrow 320px phone for groups:
// full-resolution photos, big videos, voice messages, reactions, replies, edit,
// unsend and group management, with identical styling on both phones.
//
//   npm run test:e2e        (runs cross-platform.e2e.js, this file, then encryption.e2e.js)
//
// Needs Playwright with Chromium. Starts its own server on a free port with a
// fresh data dir and finds UI elements only through the data-testid contract in
// docs/PROTOCOL.md. Media is made in-script: a JPEG with a GPS block, and a WebM
// video (Playwright's Chromium can't decode H.264), padded past the 10 MB mark.
// Everything is end-to-end encrypted (docs/E2EE.md): the server only ever has
// application/vnd.tealtalk.e2ee bytes, so full quality is checked on the
// decrypted blob: in the page that received it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../../server');
const {
  loadPlaywright,
  createRunner,
  runMain,
  assert,
  sleep,
  until,
  canvasJpeg,
  withGpsExif,
  recordWebm,
  padWebm,
  deviceFactory,
  tid,
  text,
  messagesWithBody,
  register,
  postSealed,
  trackObjectUrls,
  blobBytes,
  blobInfo,
  conversationItem,
  openConversation,
  sendText,
  countWithBody,
  bubbleColor,
  parseRgb,
  isBlue,
  layoutReport,
} = require('./harness');

const OVERALL_TIMEOUT_MS = 180000;
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { check, summary } = createRunner();

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const E2EE_MIME = 'application/vnd.tealtalk.e2ee';
/** Encrypted size of a file: 16 bytes of tag per 256 KiB record (docs/E2EE.md "Files"). */
const cipherSize = (size) => size + 16 * Math.max(1, Math.ceil(size / (256 * 1024)));

// ---------------------------------------------------------------------------
// page helpers (data-testid only)

function messageById(page, id) {
  return page.locator(`[data-testid="message"][data-message-id="${id}"]`);
}

async function messageId(locator) {
  const id = await locator.getAttribute('data-message-id');
  assert(/^\d+$/.test(id || ''), `message has no server id yet (${id})`);
  return Number(id);
}

/** The chips under a message as sorted "emoji+count" strings, e.g. ["❤️2", "😂1"]. */
async function chips(msg) {
  const all = await msg.getByTestId('reaction-chip').evaluateAll((els) => els.map((el) => el.textContent.trim()));
  return all.sort();
}

async function waitChips(page, msg, expected, label) {
  const want = [...expected].sort();
  await until(`${label}: chips ${JSON.stringify(want)}`, async () => JSON.stringify(await chips(msg)) === JSON.stringify(want), 8000)
    .catch(async (err) => {
      throw new Error(`${err.message}; now ${JSON.stringify(await chips(msg))}`);
    });
}

/** A real touch long-press (touchstart, hold, touchend) in the middle of `target`. */
async function longPress(page, target) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert(box, 'nothing to long-press');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Open the message menu: long-press on a touch phone, right-click otherwise. */
async function openMenu(page, msg, how) {
  const target = msg.getByTestId('message-body');
  if (how === 'long-press') await longPress(page, (await target.textContent()) ? target : msg.getByTestId('message-image'));
  else await target.click({ button: 'right' });
  await tid(page, 'message-menu').waitFor({ state: 'visible', timeout: 3000 });
}

async function react(page, msg, emoji, how) {
  await openMenu(page, msg, how);
  await tid(page, 'message-menu').locator(`[data-testid="reaction-option"][data-emoji="${emoji}"]`).click();
  await tid(page, 'message-menu').waitFor({ state: 'hidden', timeout: 3000 });
}

async function menuAction(page, msg, action, how) {
  await openMenu(page, msg, how);
  await tid(page, action).click();
  await tid(page, 'message-menu').waitFor({ state: 'hidden', timeout: 3000 });
}

/** A message element's box fully inside the visible part of the list. */
function inView(msg) {
  return msg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const composer = document.querySelector('[data-testid="message-input"]').getBoundingClientRect();
    const header = document.querySelector('[data-testid="chat-title"]').getBoundingClientRect();
    return r.height > 0 && r.top >= header.bottom - 1 && r.bottom <= composer.top + 1;
  });
}

function decoded(img) {
  return img.evaluate((el) => el.complete && el.naturalWidth > 0);
}

/** WCAG contrast ratio of two CSS colours. */
function contrast(a, b) {
  const lum = (css) => {
    const [r, g, bl] = parseRgb(css).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------------------

async function main() {
  const { chromium, devices } = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-e2e-media-'));
  const serverErrors = [];
  const log = { log() {}, info() {}, warn() {}, error: (...args) => serverErrors.push(args.join(' ')) };
  const app = await createApp({ dataDir, port: 0, log });
  const origin = new URL(app.url).origin;
  const serverHost = new URL(app.url).host;
  console.log(`TealTalk media e2e against ${app.url}`);

  const foreignRequests = [];
  const consoleErrors = [];
  // Requests this test breaks on purpose; Chromium logs their failure to the console.
  const brokenOnPurpose = new Set();
  const expectedError = (message, msg) => {
    const url = (msg.location() && msg.location().url) || '';
    return [...brokenOnPurpose].some((u) => message.includes(u) || url === u);
  };

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const device = deviceFactory({ browser, serverHost, foreignRequests, consoleErrors, expectedError });
  const iphone = await device('iPhone', devices['iPhone 13'], { permissions: ['microphone'] });
  const android = await device('Android', devices['Pixel 7']);
  const narrow = await device('iPhone SE 320px', devices['iPhone SE']);
  await iphone.context.addInitScript(trackObjectUrls);
  await android.context.addInitScript(trackObjectUrls);
  const maya = iphone.page;
  const jordan = android.page;
  const sam = narrow.page;
  for (const page of [maya, jordan, sam]) {
    page.on('dialog', (d) => d.accept());
    page.setDefaultTimeout(10000);
  }

  const tokenOf = (page) => page.evaluate(() => localStorage.getItem('tt.token'));
  const get = async (page, urlPath) => fetch(new URL(urlPath, app.url), { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });

  // Android upload plumbing: hold or drop chunk PUTs, hold the create call, count everything.
  const up = { creates: 0, statusGets: 0, puts: [], deletes: 0, holdPut: null, dropPut: null, holdCreate: null };
  await android.context.route(
    (url) => url.pathname.startsWith('/api/uploads'),
    async (route) => {
      const req = route.request();
      const method = req.method();
      const { pathname } = new URL(req.url());
      if (method === 'POST' && pathname === '/api/uploads') {
        up.creates++;
        const h = up.holdCreate;
        if (!h) return route.continue();
        up.holdCreate = null;
        const response = await route.fetch();
        h.handled();
        await h.gate;
        return route.fulfill({ response });
      }
      if (method === 'GET') up.statusGets++;
      if (method === 'DELETE') up.deletes++;
      if (method === 'PUT') {
        const n = up.puts.push(Number(req.headers()['upload-offset'])) - 1;
        const h = up.holdPut;
        if (h) {
          up.holdPut = null;
          h.seen();
          await h.gate;
        }
        if (up.dropPut === n) {
          brokenOnPurpose.add(req.url());
          return route.abort('connectionreset');
        }
      }
      return route.continue();
    },
  );

  // iPhone: hold the reply to one reaction or edit until released (the server has handled it).
  let actionHold = null;
  await iphone.context.route(
    (url) => /^\/api\/conversations\/[^/]+\/messages\/\d+(\/reaction)?$/.test(url.pathname),
    async (route) => {
      const h = actionHold;
      if (!h || route.request().method() !== h.method) return route.continue();
      actionHold = null;
      const response = await route.fetch();
      h.handled();
      await h.gate;
      return route.fulfill({ response });
    },
  );
  // iPhone: hold one page of chat history after the server produced it.
  let pageHold = null;
  await iphone.context.route(
    (url) => /^\/api\/conversations\/[^/]+\/messages$/.test(url.pathname),
    async (route) => {
      const h = pageHold;
      if (!h || route.request().method() !== 'GET') return route.continue();
      pageHold = null;
      const response = await route.fetch();
      h.handled();
      await h.gate;
      return route.fulfill({ response });
    },
  );
  function gate(extra = {}) {
    const g = { ...extra };
    g.gate = new Promise((r) => (g.release = r));
    g.seenP = new Promise((r) => (g.seen = r));
    g.handledP = new Promise((r) => (g.handled = r));
    return g;
  }

  // Media responses the iPhone gets (to see the 206 for the video).
  const iphoneMedia = [];
  maya.on('response', (res) => {
    if (new URL(res.url()).pathname.startsWith('/api/attachments/')) {
      iphoneMedia.push({ url: res.url(), status: res.status(), range: res.request().headers().range || null, headers: res.headers() });
    }
  });

  let dmId = null;
  let groupId = null;
  let photo = null; // { jpeg, stripped }
  let photoMsgId = null;
  let photoUrls = null; // { thumb, full } blob: URLs of the decrypted thumbnail and original on Android
  let photoIds = null; // [original, thumbnail] attachment ids on the server
  let video = null;
  let videoId = null;

  try {
    // ------------------------------------------------------------------ setup
    await check('iPhone, Android and 320px users register; Android starts a chat with the iPhone', async () => {
      const keys = await Promise.all([
        register(maya, app.url, 'maya', 'Maya'),
        register(jordan, app.url, 'jordan', 'Jordan'),
        register(sam, app.url, 'sam', 'Sam'),
      ]);
      assert(new Set(keys).size === 3, 'recovery keys are not unique');
      await tid(jordan, 'new-chat-button').click();
      await tid(jordan, 'user-search-input').fill('maya');
      await until('one search hit', async () => (await tid(jordan, 'user-result').count()) === 1);
      await tid(jordan, 'user-result').click();
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();
      dmId = decodeURIComponent(new URL(jordan.url()).hash.replace('#/c/', ''));
      assert(/^c_/.test(dmId), `unexpected conversation id: ${jordan.url()}`);
      await conversationItem(maya, dmId).waitFor({ timeout: 5000 });
      await openConversation(maya, dmId);
    }, { critical: true });

    // ------------------------------------------------------------------ photo
    await check('iPhone photo arrives at full size: same byte length, same bytes except the zeroed GPS block (after decrypting)', async () => {
      const scratch = await browser.newPage();
      try {
        photo = withGpsExif(await canvasJpeg(scratch, { width: 2400, height: 1600 }));
      } finally {
        await scratch.close();
      }
      assert(!photo.jpeg.equals(photo.stripped), 'test photo has no GPS bytes to remove');
      await tid(maya, 'attach-input').setInputFiles({ name: 'IMG_0420.JPG', mimeType: 'image/jpeg', buffer: photo.jpeg });
      const img = tid(jordan, 'message-image');
      await img.waitFor({ timeout: 10000 });
      await until('photo thumbnail decoded on Android', () => decoded(img));
      const msg = tid(jordan, 'message').filter({ has: jordan.getByTestId('message-image') });
      photoMsgId = await messageId(msg);
      assert((await msg.getAttribute('data-mine')) === 'false', 'photo is theirs on Android');

      await img.click();
      const viewerImg = tid(jordan, 'image-viewer').locator('img');
      await viewerImg.waitFor({ timeout: 5000 });
      const thumbSrc = await img.getAttribute('src');
      await until('original loaded in the viewer', () =>
        viewerImg.evaluate((el, t) => el.getAttribute('src') !== t && el.complete && el.naturalWidth > 0, thumbSrc), 10000);
      photoUrls = { thumb: thumbSrc, full: await viewerImg.getAttribute('src') };
      assert(photoUrls.full.startsWith('blob:') && photoUrls.thumb.startsWith('blob:'), `not decrypted data: ${JSON.stringify(photoUrls)}`);
      const got = await blobBytes(jordan, photoUrls.full);
      assert(got.length === photo.jpeg.length, `byte length ${got.length} != sent ${photo.jpeg.length}`);
      let firstDiff = -1;
      for (let i = 0; i < got.length && firstDiff < 0; i++) if (got[i] !== photo.stripped[i]) firstDiff = i;
      assert(firstDiff < 0, `bytes differ from the original-minus-GPS at offset ${firstDiff}`);
      // The server has the original and its thumbnail, encrypted.
      photoIds = app.store.messageAttachmentIds(photoMsgId);
      assert(photoIds.length === 2, `expected the photo and its thumbnail on the server, got ${photoIds.length}`);
      const res = await get(jordan, `/api/attachments/${photoIds[0]}`);
      const stored = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200 && res.headers.get('content-type') === E2EE_MIME, `original: ${res.status} ${res.headers.get('content-type')}`);
      assert(stored.length === cipherSize(photo.jpeg.length), `stored ${stored.length} bytes, expected ${cipherSize(photo.jpeg.length)}`);
      assert(!stored.includes(photo.stripped.subarray(4096, 4160)), 'the server copy contains plaintext photo bytes');
    });

    await check('the bubble shows a small thumbnail on both phones; image-viewer shows the full-resolution original', async () => {
      assert(photoUrls, 'no photo');
      assert(photoUrls.thumb !== photoUrls.full, 'bubble loads the original, not a thumbnail');
      const viewerImg = tid(jordan, 'image-viewer').locator('img');
      const full = await viewerImg.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
      assert(full[0] === 2400 && full[1] === 1600, `viewer shows ${full.join('x')}, not 2400x1600`);
      await tid(jordan, 'image-viewer-close').click();
      await tid(jordan, 'image-viewer').waitFor({ state: 'hidden' });
      await until('Android bubble keeps the decrypted thumbnail', async () =>
        (await decoded(tid(jordan, 'message-image'))) && (await tid(jordan, 'message-image').getAttribute('src')) === photoUrls.thumb);
      for (const [page, label] of [[jordan, 'Android'], [maya, 'iPhone']]) {
        const img = tid(page, 'message-image');
        await until(`thumbnail on ${label}`, async () => (await decoded(img)) && (await img.getAttribute('src')).startsWith('blob:'));
        const [w, h] = await img.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
        assert(Math.max(w, h) <= 480 && w > 0, `${label} bubble image is ${w}x${h}, not a thumbnail`);
      }
      // The iPhone's own viewer also opens the original.
      await tid(maya, 'message-image').click();
      const mine = tid(maya, 'image-viewer').locator('img');
      await until('iPhone viewer original', () => mine.evaluate((el) => el.complete && el.naturalWidth === 2400), 10000);
      await tid(maya, 'image-viewer-close').click();
    });

    // ------------------------------------------------------------------ video
    await check('a >10 MB video from Android uploads in chunks with upload-progress showing', async () => {
      const scratch = await browser.newPage();
      try {
        video = padWebm(await recordWebm(scratch), 11 * 1024 * 1024 + 12345);
      } finally {
        await scratch.close();
      }
      assert(video.length > 10 * 1024 * 1024, `video is only ${video.length} bytes`);
      const hold = gate();
      up.holdPut = hold;
      up.dropPut = 1; // the second chunk's connection drops (next check)
      await tid(jordan, 'attach-input').setInputFiles({ name: 'trail.webm', mimeType: 'video/webm', buffer: video });
      await hold.seenP;
      const progress = tid(jordan, 'upload-progress');
      await progress.waitFor({ state: 'visible', timeout: 5000 });
      const value = Number(await progress.getAttribute('value'));
      assert(value >= 0 && value < 100, `progress ${value}`);
      assert((await tid(jordan, 'upload-cancel').count()) === 1, 'no cancel button while uploading');
      hold.release();
      await tid(maya, 'message-video').waitFor({ timeout: 20000 });
      await progress.waitFor({ state: 'detached', timeout: 10000 });
      const chunks = Math.ceil(video.length / (5 * 1024 * 1024));
      assert(up.creates === 1, `${up.creates} uploads started for one video`);
      assert(up.puts.length === chunks + 1, `expected ${chunks} chunks + 1 resend, saw PUT offsets ${up.puts.join(', ')}`);
    });

    await check('after a dropped chunk the upload resumes where it stopped; the decrypted video is byte-identical', async () => {
      assert(up.statusGets >= 1, 'did not ask the server how far it got');
      const chunk = 5 * 1024 * 1024;
      assert(JSON.stringify(up.puts) === JSON.stringify([0, chunk, chunk, 2 * chunk]),
        `PUT offsets ${up.puts.join(', ')} (expected a resend of the dropped chunk only)`);
      const msg = tid(maya, 'message').filter({ has: maya.getByTestId('message-video') });
      [videoId] = app.store.messageAttachmentIds(await messageId(msg));
      const res = await get(jordan, `/api/attachments/${videoId}`);
      const stored = Buffer.from(await res.arrayBuffer());
      assert(res.headers.get('content-type') === E2EE_MIME, `stored as ${res.headers.get('content-type')}`);
      assert(stored.length === cipherSize(video.length), `stored ${stored.length} bytes, expected ${cipherSize(video.length)}`);
      assert(!stored.includes(video.subarray(0, 64)), 'the server copy starts like the plaintext video');
      // What the iPhone decrypted is exactly what Android sent.
      const src = await tid(maya, 'message-video').getAttribute('src');
      assert(src && src.startsWith('blob:'), `video src is not decrypted data: ${src}`);
      const got = await blobInfo(maya, src);
      assert(got.type === 'video/webm', `decrypted video type ${got.type}`);
      assert(got.size === video.length && got.sha256 === sha(video), `decrypted ${got.size} bytes differ from the ${video.length} sent`);
      const left = app.store.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n;
      assert(left === 0, `${left} unfinished uploads left on the server`);
    });

    await check('the video plays inline on the iPhone, downloaded once in full and decrypted', async () => {
      const v = tid(maya, 'message-video');
      assert((await v.getAttribute('playsinline')) !== null, 'video lacks playsinline');
      assert(await v.evaluate((el) => el.controls), 'video lacks controls');
      await v.evaluate((el) => {
        el.muted = true;
        el.loop = true;
        el.__playingSince = Date.now(); // marks this exact element
        return el.play();
      });
      await until('video playing', () => v.evaluate((el) => el.currentTime > 0.2 && el.videoWidth > 0), 10000);
      // Regression: the chat re-render after a new message used to rebuild the decrypted
      // player, which stopped the video.
      const chat = 'Nice clip! 🎬';
      await sendText(jordan, chat);
      await until('message during playback', async () => (await countWithBody(maya, chat)) === 1);
      await sleep(300);
      const still = await v.evaluate((el) => ({ same: !!el.__playingSince, paused: el.paused }));
      assert(still.same && !still.paused, `video interrupted by a new message: ${JSON.stringify(still)}`);
      await v.evaluate((el) => el.pause());
      // Range streaming of encrypted video is a later improvement (docs/E2EE.md): one full download.
      const fetched = iphoneMedia.filter((r) => r.url.includes(videoId));
      assert(fetched.length === 1 && fetched[0].status === 200 && !fetched[0].range,
        `video downloads: ${JSON.stringify(fetched.map((r) => [r.status, r.range]))}`);
      assert(Number(fetched[0].headers['content-length']) === cipherSize(video.length), `Content-Length ${fetched[0].headers['content-length']}`);
      assert(await v.getAttribute('poster'), 'video has no poster thumbnail');
      // Android's own copy is a player too.
      await tid(jordan, 'message-video').waitFor();
    });

    await check('cancelling an upload (even while the server is still creating it) leaves nothing behind', async () => {
      const mark = await jordan.evaluate(() => window.__objectUrlMark());
      const messagesBefore = await tid(maya, 'message').count();
      // 1) Cancel while the upload is being created on the server.
      const create = gate();
      up.holdCreate = create;
      await tid(jordan, 'attach-input').setInputFiles({ name: 'second.webm', mimeType: 'video/webm', buffer: video });
      await create.handledP; // the server has the upload now; the app hasn't heard yet
      await tid(jordan, 'upload-cancel').click();
      create.release();
      await tid(jordan, 'upload-progress').waitFor({ state: 'detached', timeout: 5000 });
      // 2) Cancel in the middle of a chunk.
      const put = gate();
      up.holdPut = put;
      await tid(jordan, 'attach-input').setInputFiles({ name: 'third.webm', mimeType: 'video/webm', buffer: video });
      await put.seenP;
      await tid(jordan, 'upload-cancel').click();
      put.release();
      await tid(jordan, 'upload-progress').waitFor({ state: 'detached', timeout: 5000 });
      await until('server dropped both cancelled uploads', () =>
        app.store.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n === 0, 8000);
      await sleep(300);
      assert((await tid(maya, 'message').count()) === messagesBefore, 'a cancelled video reached the iPhone');
      assert((await tid(jordan, 'message-video').count()) === 1, 'cancelled video bubble still on Android');
      const leaked = await jordan.evaluate((m) => window.__liveObjectUrls(m), mark);
      assert(leaked === 0, `${leaked} object URLs leaked by cancelled uploads`);
    });

    // ------------------------------------------------------------------ voice
    await check('voice message recorded on the iPhone arrives on Android as message-audio and loads', async () => {
      await tid(maya, 'record-button').click();
      await tid(maya, 'record-send').waitFor({ state: 'visible', timeout: 5000 });
      await sleep(1600);
      await tid(maya, 'record-send').click();
      const audio = tid(jordan, 'message-audio');
      await audio.waitFor({ timeout: 10000 });
      const msg = tid(jordan, 'message').filter({ has: jordan.getByTestId('message-audio') });
      assert((await msg.getAttribute('data-mine')) === 'false', 'voice message is theirs on Android');
      const el = audio.locator('audio');
      await until('voice message metadata on Android', () => el.evaluate((a) => a.readyState >= 1 && !a.error), 8000);
      const src = await el.getAttribute('src');
      assert(src && src.startsWith('blob:'), `voice message src is not decrypted data: ${src}`);
      const { type, size } = await blobInfo(jordan, src);
      assert(/^audio\/(mp4|webm|ogg|aac|mpeg)$/.test(type) && size > 0, `voice message decrypted as ${type} (${size} bytes)`);
      const [voiceId] = app.store.messageAttachmentIds(await messageId(msg));
      const res = await get(jordan, `/api/attachments/${voiceId}`);
      await res.arrayBuffer();
      assert(res.headers.get('content-type') === E2EE_MIME, `voice message stored as ${res.headers.get('content-type')}`);
      assert(/[1-9]/.test(await text(audio)), `no duration shown: "${await text(audio)}"`);
      const mine = tid(maya, 'message').filter({ has: maya.getByTestId('message-audio') });
      await until('iPhone shows its own sent voice message', async () =>
        /^\d+$/.test((await mine.getAttribute('data-message-id')) || '') &&
        (await mine.getByTestId('message-audio').locator('audio').getAttribute('src') || '').startsWith('blob:'));
    });

    // ------------------------------------------------------------------ reactions
    const j1 = 'That view is unreal 😍';
    await check('reactions: long-press on iPhone, right-click on Android; counts, change and removal sync live', async () => {
      await sendText(jordan, j1);
      await until('text on iPhone', async () => (await countWithBody(maya, j1)) === 1);
      const onMaya = messagesWithBody(maya, j1);
      const onJordan = messagesWithBody(jordan, j1);
      await until('server id on Android', async () => /^\d+$/.test((await onJordan.getAttribute('data-message-id')) || ''));

      await react(maya, onMaya, '❤️', 'long-press');
      await waitChips(maya, onMaya, ['❤️1'], 'iPhone');
      await waitChips(jordan, onJordan, ['❤️1'], 'Android');
      assert((await onMaya.locator('[data-testid="reaction-chip"][data-emoji="❤️"]').getAttribute('aria-pressed')) === 'true', 'my chip not marked');

      await react(jordan, onJordan, '😂', 'right-click');
      await waitChips(jordan, onJordan, ['❤️1', '😂1'], 'Android');
      await waitChips(maya, onMaya, ['❤️1', '😂1'], 'iPhone');

      // One reaction per person: Jordan switching to ❤️ replaces his 😂.
      await react(jordan, onJordan, '❤️', 'right-click');
      await waitChips(jordan, onJordan, ['❤️2'], 'Android');
      await waitChips(maya, onMaya, ['❤️2'], 'iPhone');

      // Tapping my own chip removes my reaction.
      await onMaya.locator('[data-testid="reaction-chip"][data-emoji="❤️"]').click();
      await waitChips(maya, onMaya, ['❤️1'], 'iPhone');
      await waitChips(jordan, onJordan, ['❤️1'], 'Android');
      assert((await onMaya.locator('[data-testid="reaction-chip"]').getAttribute('aria-pressed')) === 'false', 'chip still marked mine');
    });

    await check('a reaction reply that arrives after a newer live update does not undo it', async () => {
      const body = 'Race you to the top 🏃';
      await sendText(jordan, body);
      await until('race message on iPhone', async () => (await countWithBody(maya, body)) === 1);
      const onMaya = messagesWithBody(maya, body);
      const onJordan = messagesWithBody(jordan, body);
      const hold = gate({ method: 'PUT' });
      actionHold = hold;
      await react(maya, onMaya, '👍', 'long-press');
      await hold.handledP; // the server stored 👍; the iPhone hasn't heard back yet
      await until('Android sees 👍', async () => JSON.stringify(await chips(onJordan)) === JSON.stringify(['👍1']));
      await react(jordan, onJordan, '😮', 'right-click');
      await waitChips(maya, onMaya, ['👍1', '😮1'], 'iPhone (live)');
      hold.release();
      await sleep(600);
      await waitChips(maya, onMaya, ['👍1', '😮1'], 'iPhone after the late reply');
      await waitChips(jordan, onJordan, ['👍1', '😮1'], 'Android');
    });

    await check('a history page fetched before a live reaction arrived does not undo it', async () => {
      const body = 'Race you to the top 🏃';
      await tid(maya, 'back-button').click();
      await tid(maya, 'chats-screen').waitFor();
      const hold = gate();
      pageHold = hold;
      await openConversation(maya, dmId);
      await hold.handledP; // the page is computed (👍 😮); the iPhone hasn't got it yet
      await react(jordan, messagesWithBody(jordan, body), '😢', 'right-click');
      await waitChips(maya, messagesWithBody(maya, body), ['👍1', '😢1'], 'iPhone (live)');
      hold.release();
      await sleep(600);
      await waitChips(maya, messagesWithBody(maya, body), ['👍1', '😢1'], 'iPhone after the stale page');
    });

    // ------------------------------------------------------------------ reply
    const original = 'Meet at the north trailhead at 7?';
    const answer = 'Yes! 7 works, I’ll bring coffee ☕';
    await check('reply: quote shows on both phones and tapping it scrolls to the original', async () => {
      await sendText(maya, original);
      await until('original on Android', async () => (await countWithBody(jordan, original)) === 1);
      // From Jordan's other device: sealed with his key, straight to the API.
      await postSealed(jordan, dmId, Array.from({ length: 14 }, (_, i) => `Packing list item ${i + 1}`));
      await until('fillers on both', async () =>
        (await countWithBody(maya, 'Packing list item 14')) === 1 && (await countWithBody(jordan, 'Packing list item 14')) === 1);
      const originalId = await messageId(messagesWithBody(jordan, original));

      await menuAction(jordan, messagesWithBody(jordan, original), 'menu-reply', 'right-click');
      await tid(jordan, 'reply-preview').waitFor({ state: 'visible' });
      assert((await text(tid(jordan, 'reply-preview'))).includes(original), 'reply bar does not show the original');
      await sendText(jordan, answer);
      await tid(jordan, 'reply-preview').waitFor({ state: 'hidden' });
      for (const [page, label] of [[jordan, 'Android'], [maya, 'iPhone']]) {
        const quote = messagesWithBody(page, answer).getByTestId('message-reply-quote');
        await quote.waitFor({ timeout: 5000 });
        assert((await text(quote)).includes(original), `${label} quote: ${await text(quote)}`);
      }
      const target = messageById(maya, originalId);
      await until('iPhone at the newest message', async () => inView(messagesWithBody(maya, answer)));
      assert(!(await inView(target)), 'original already in view; the jump proves nothing');
      await messagesWithBody(maya, answer).getByTestId('message-reply-quote').click();
      await until('original scrolled into view', () => inView(target), 5000);
      assert(await target.evaluate((el) => el === document.activeElement), 'original not focused after the jump');
    });

    // ------------------------------------------------------------------ edit
    const edited = 'Meet at the north trailhead at 7:30?';
    await check('edit: new text and message-edited on both phones; the reply quote follows', async () => {
      const onMaya = messagesWithBody(maya, original);
      await menuAction(maya, onMaya, 'menu-edit', 'long-press');
      await tid(maya, 'edit-bar').waitFor({ state: 'visible' });
      assert((await tid(maya, 'message-input').inputValue()) === original, 'composer not filled with the message');
      await tid(maya, 'message-input').fill(edited);
      await tid(maya, 'send-button').click();
      await tid(maya, 'edit-bar').waitFor({ state: 'hidden' });
      for (const [page, label] of [[maya, 'iPhone'], [jordan, 'Android']]) {
        await until(`edited text on ${label}`, async () => (await countWithBody(page, edited)) === 1);
        assert((await countWithBody(page, original)) === 0, `${label} still shows the old text`);
        await messagesWithBody(page, edited).getByTestId('message-edited').waitFor({ timeout: 5000 });
        const quote = messagesWithBody(page, answer).getByTestId('message-reply-quote');
        await until(`${label} quote updated`, async () => (await text(quote)).includes(edited));
      }
    });

    await check('an edit reply that arrives after a newer live reaction does not undo the reaction', async () => {
      const body = 'Parking is $5, bring cash';
      const fixed = 'Parking is $5, bring cash or card';
      await sendText(maya, body);
      await until('on Android', async () => (await countWithBody(jordan, body)) === 1);
      await until('iPhone has the server copy', async () => /^\d+$/.test((await messagesWithBody(maya, body).getAttribute('data-message-id')) || ''));
      const hold = gate({ method: 'PATCH' });
      actionHold = hold;
      await menuAction(maya, messagesWithBody(maya, body), 'menu-edit', 'long-press');
      await tid(maya, 'message-input').fill(fixed);
      await tid(maya, 'send-button').click();
      await hold.handledP;
      await until('edit on Android', async () => (await countWithBody(jordan, fixed)) === 1);
      await react(jordan, messagesWithBody(jordan, fixed), '🙏', 'right-click');
      await waitChips(maya, messagesWithBody(maya, fixed), ['🙏1'], 'iPhone (live)');
      hold.release();
      await sleep(600);
      assert((await countWithBody(maya, fixed)) === 1, 'edited text lost on the iPhone');
      await waitChips(maya, messagesWithBody(maya, fixed), ['🙏1'], 'iPhone after the late reply');
      await messagesWithBody(maya, fixed).getByTestId('message-edited').waitFor();
    });

    await check('reactions, edits and unsent messages never leave an unread badge', async () => {
      const third = 'Meet at the north trailhead at 7:10?';
      try {
        await tid(jordan, 'back-button').click();
        await tid(jordan, 'chats-screen').waitFor();
        const badge = conversationItem(jordan, dmId).getByTestId('unread-badge');
        // The server can't read edits: "stored" means the message's envelope was replaced.
        const envelopeOf = (id) => app.store.db.prepare('SELECT e2ee_client_id AS c FROM messages WHERE id = ?').get(id).c;
        const editedId = await messageId(messagesWithBody(maya, edited));
        let envelope = envelopeOf(editedId);
        await react(maya, messagesWithBody(maya, j1), '😂', 'long-press');
        await menuAction(maya, messagesWithBody(maya, edited), 'menu-edit', 'long-press');
        const again = 'Meet at the north trailhead at 7:15?';
        await tid(maya, 'message-input').fill(again);
        await tid(maya, 'send-button').click();
        await until('edit stored', () => envelopeOf(editedId) !== envelope);
        envelope = envelopeOf(editedId);
        await sleep(700);
        assert((await badge.count()) === 0, 'unread badge after a reaction and an edit');
        // Same again on a freshly opened app, where the chat's history isn't loaded.
        await jordan.reload();
        await tid(jordan, 'chats-screen').waitFor();
        await tid(jordan, 'connection-status').waitFor({ state: 'hidden' });
        await conversationItem(jordan, dmId).waitFor();
        await sleep(300);
        await react(maya, messagesWithBody(maya, j1), '😮', 'long-press');
        await menuAction(maya, messagesWithBody(maya, again), 'menu-edit', 'long-press');
        await tid(maya, 'message-input').fill(third);
        await tid(maya, 'send-button').click();
        await until('edit stored', () => envelopeOf(editedId) !== envelope);
        await sleep(700);
        assert((await badge.count()) === 0, 'unread badge after a reaction and an edit to history not loaded yet');
        // A message sent and then unsent before Jordan saw it no longer counts.
        const oops = 'oops, wrong chat';
        await sendText(maya, oops);
        await until('badge 1 for a new message', async () => (await badge.count()) === 1 && (await text(badge)) === '1');
        await until('oops has a server id', async () => /^\d+$/.test((await messagesWithBody(maya, oops).getAttribute('data-message-id')) || ''));
        const oopsId = await messageId(messagesWithBody(maya, oops));
        await menuAction(maya, messagesWithBody(maya, oops), 'menu-unsend', 'long-press');
        await until('badge gone after unsend', async () => (await badge.count()) === 0, 5000);
        const row = app.store.db.prepare('SELECT deleted_at, e2ee FROM messages WHERE id = ?').get(oopsId);
        assert(row.deleted_at && !row.e2ee, 'unsend did not reach the server (or kept the envelope)');
      } finally {
        // Back in the chat whatever happened, so the checks after this one start from there.
        if (await tid(jordan, 'chat-screen').isHidden()) await openConversation(jordan, dmId);
      }
      await until('Android caught up', async () => (await countWithBody(jordan, third)) === 1);
    });

    // ------------------------------------------------------------------ unsend
    await check('unsend: message-unsent on both phones, and the photo and its thumbnail then 404', async () => {
      assert(photoMsgId && photoIds, 'no photo to unsend');
      const onMaya = messageById(maya, photoMsgId);
      await longPress(maya, onMaya.getByTestId('message-image'));
      await tid(maya, 'message-menu').waitFor({ state: 'visible' });
      await tid(maya, 'menu-unsend').click();
      for (const [page, label] of [[maya, 'iPhone'], [jordan, 'Android']]) {
        const msg = messageById(page, photoMsgId);
        await msg.getByTestId('message-unsent').waitFor({ timeout: 5000 });
        assert((await msg.getByTestId('message-image').count()) === 0, `${label} still shows the photo`);
      }
      assert((await tid(jordan, 'message-image').count()) === 0, 'a photo is still on Android');
      for (const id of photoIds) {
        const res = await get(jordan, `/api/attachments/${id}`);
        await res.arrayBuffer();
        assert(res.status === 404, `${id} -> ${res.status} after unsend`);
      }
    });

    await check('no duplicate bubbles: every message once on each phone, the same as the server', async () => {
      const server = app.store.db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? AND system_type IS NULL ORDER BY id')
        .all(dmId)
        .map((r) => r.id);
      for (const [page, label] of [[maya, 'iPhone'], [jordan, 'Android']]) {
        await until(`${label} shows every message`, async () =>
          (await tid(page, 'message').count()) === server.length, 5000).catch(() => {});
        const ids = await tid(page, 'message').evaluateAll((els) => els.map((el) => el.dataset.messageId || `pending:${el.dataset.clientId}`));
        const shown = ids.map(Number);
        assert(JSON.stringify(shown) === JSON.stringify(server), `${label} shows ${ids.join(',')} but the server has ${server.join(',')}`);
      }
    });

    // ------------------------------------------------------------------ colours
    async function colourReport(pages) {
      const seen = { mine: new Set(), theirs: new Set() };
      for (const page of pages) {
        for (const loc of await tid(page, 'message').all()) {
          if (await loc.getByTestId('message-unsent').count()) continue; // quieter version of the same colour
          const mine = (await loc.getAttribute('data-mine')) === 'true';
          seen[mine ? 'mine' : 'theirs'].add(await bubbleColor(loc));
        }
      }
      return { mine: [...seen.mine], theirs: [...seen.theirs] };
    }

    await check('bubble colours: mine teal and theirs grey on both phones, media bubbles included; never blue', async () => {
      const c = await colourReport([maya, jordan]);
      assert(c.mine.length === 1 && c.theirs.length === 1, `bubbles differ between phones or kinds: ${JSON.stringify(c)}`);
      const [r, g, b] = parseRgb(c.mine[0]);
      assert(g > r && g >= b - 10 && b > r, `my bubble is not teal: ${c.mine[0]}`);
      const grey = parseRgb(c.theirs[0]);
      assert(Math.max(...grey) - Math.min(...grey) < 24, `their bubble is not grey: ${c.theirs[0]}`);
      for (const page of [maya, jordan]) {
        const accents = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="reaction-chip"], [data-testid="message-reply-quote"], [data-testid="message-audio"]')]
            .flatMap((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderColor, getComputedStyle(el).color]));
        for (const v of [...c.mine, ...c.theirs, ...accents]) assert(!isBlue(v), `blue on screen: ${v}`);
      }
    });

    await check('dark mode: same teal/grey on both phones and readable reaction chips', async () => {
      await Promise.all([maya.emulateMedia({ colorScheme: 'dark' }), jordan.emulateMedia({ colorScheme: 'dark' })]);
      try {
        const c = await colourReport([maya, jordan]);
        assert(c.mine.length === 1 && c.theirs.length === 1, `dark bubbles differ: ${JSON.stringify(c)}`);
        const [r, g, b] = parseRgb(c.mine[0]);
        assert(g > r && b > r, `dark: my bubble is not teal: ${c.mine[0]}`);
        for (const v of [...c.mine, ...c.theirs]) assert(!isBlue(v), `dark: blue bubble ${v}`);
        for (const page of [maya, jordan]) {
          const all = await page.evaluate(() => {
            const bgOf = (el) => {
              for (let n = el; n; n = n.parentElement) {
                const c = getComputedStyle(n).backgroundColor;
                if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
              }
              return getComputedStyle(document.body).backgroundColor;
            };
            return [...document.querySelectorAll('[data-testid="reaction-chip"]')].map((chip) => ({
              label: chip.textContent,
              mine: chip.getAttribute('aria-pressed') === 'true',
              fg: getComputedStyle(chip.querySelector('.reaction-count') || chip).color,
              bg: bgOf(chip),
              border: getComputedStyle(chip).borderTopColor,
              around: bgOf(chip.parentElement.parentElement),
            }));
          });
          assert(all.length >= 3, `only ${all.length} reaction chips to look at`);
          for (const chip of all) {
            const text = contrast(chip.fg, chip.bg);
            assert(text >= 4.5, `chip ${chip.label} text contrast ${text.toFixed(2)} (${chip.fg} on ${chip.bg})`);
            const edge = Math.max(contrast(chip.border, chip.around), contrast(chip.bg, chip.around));
            assert(edge >= (chip.mine ? 3 : 1.3), `chip ${chip.label} hard to see: edge contrast ${edge.toFixed(2)} (${JSON.stringify(chip)})`);
            assert(!isBlue(chip.bg) && !isBlue(chip.border), `blue chip ${JSON.stringify(chip)}`);
          }
        }
      } finally {
        await Promise.all([maya.emulateMedia({ colorScheme: 'light' }), jordan.emulateMedia({ colorScheme: 'light' })]);
      }
    });

    // ------------------------------------------------------------------ groups
    await check('group: Android creates it, adds the 320px user; "added" line on all three and no unread badge for it', async () => {
      await tid(jordan, 'back-button').click();
      await tid(jordan, 'new-chat-button').click();
      await tid(jordan, 'user-search-input').fill('maya');
      await until('maya hit', async () => (await tid(jordan, 'user-result').count()) === 1);
      await tid(jordan, 'user-result').click();
      await tid(jordan, 'group-title-input').fill('Trail crew');
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();
      groupId = decodeURIComponent(new URL(jordan.url()).hash.replace('#/c/', ''));
      await until('group title', async () => (await text(tid(jordan, 'chat-title'))) === 'Trail crew');
      await sendText(jordan, 'Group for Saturday 🥾');
      await tid(maya, 'back-button').click();
      await conversationItem(maya, groupId).waitFor({ timeout: 5000 });
      await openConversation(maya, groupId);

      await tid(jordan, 'group-info-button').click();
      await tid(jordan, 'group-info-screen').waitFor();
      await tid(jordan, 'add-members-button').click();
      await tid(jordan, 'new-chat-screen').waitFor();
      await tid(jordan, 'user-search-input').fill('sam');
      await until('sam hit', async () => (await tid(jordan, 'user-result').count()) === 1);
      await tid(jordan, 'user-result').click();
      assert((await text(tid(jordan, 'create-chat-button'))).includes('Add'), 'button does not say Add to group');
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();

      for (const [page, label, line] of [[jordan, 'Android', 'You added Sam'], [maya, 'iPhone', 'Jordan added Sam']]) {
        await until(`${label}: "${line}"`, async () =>
          (await tid(page, 'system-message').allTextContents()).some((t) => t.trim() === line));
      }
      const item = conversationItem(sam, groupId);
      await item.waitFor({ timeout: 5000 });
      await sleep(700);
      assert((await item.getByTestId('unread-badge').count()) === 0, 'Sam has an unread badge for the "added" line');
      await openConversation(sam, groupId);
      await until('Sam sees "Jordan added you"', async () =>
        (await tid(sam, 'system-message').allTextContents()).some((t) => t.trim() === 'Jordan added you'));
      assert((await countWithBody(sam, 'Group for Saturday 🥾')) === 0, 'Sam sees history from before he joined');
      assert((await tid(sam, 'message').count()) === 0, 'system lines rendered as messages');
    });

    await check('group rename from the iPhone: line and new title on every phone; still no unread badge', async () => {
      await tid(sam, 'back-button').click();
      await tid(sam, 'chats-screen').waitFor();
      await tid(maya, 'group-info-button').click();
      await tid(maya, 'group-info-screen').waitFor();
      await tid(maya, 'rename-button').click();
      await tid(maya, 'rename-input').fill('Saturday summit ⛰️');
      await tid(maya, 'rename-save-button').click();
      await tid(maya, 'group-info-back').click();
      await tid(maya, 'chat-screen').waitFor();
      const line = (who) => `${who} named the group “Saturday summit ⛰️”`;
      for (const [page, label, who] of [[maya, 'iPhone', 'You'], [jordan, 'Android', 'Maya']]) {
        await until(`${label} rename line`, async () =>
          (await tid(page, 'system-message').allTextContents()).some((t) => t.trim() === line(who)));
        await until(`${label} title`, async () => (await text(tid(page, 'chat-title'))) === 'Saturday summit ⛰️');
      }
      const item = conversationItem(sam, groupId);
      await until('Sam list shows the new name', async () => (await text(item)).includes('Saturday summit ⛰️'));
      await sleep(500);
      assert((await item.getByTestId('unread-badge').count()) === 0, 'rename line counted as unread');
      await sendText(jordan, 'Welcome Sam! 👋');
      await until('badge 1 for a real message', async () =>
        (await item.getByTestId('unread-badge').count()) === 1 && (await text(item.getByTestId('unread-badge'))) === '1');
      await openConversation(sam, groupId);
      await until('Sam sees the rename line', async () =>
        (await tid(sam, 'system-message').allTextContents()).some((t) => t.trim() === line('Maya')));
    });

    await check('320px phone: the message menu and the reply bar fit on screen', async () => {
      const long = 'Could someone with a bigger car pick me up at the station around 6:40? Happy to pay for fuel ⛽';
      await sendText(jordan, long);
      const msg = messagesWithBody(sam, long);
      await msg.waitFor({ timeout: 5000 });
      await longPress(sam, msg.getByTestId('message-body'));
      const menu = tid(sam, 'message-menu');
      await menu.waitFor({ state: 'visible', timeout: 3000 });
      const fits = await sam.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const vh = innerHeight;
        const out = [];
        const menuEl = document.querySelector('[data-testid="message-menu"]');
        for (const el of [menuEl, ...menuEl.querySelectorAll('button')]) {
          const r = el.getBoundingClientRect();
          if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh) {
            out.push(`${el.dataset.testid || el.textContent} at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
          }
        }
        return out;
      });
      assert(!fits.length, `menu off screen at 320px: ${fits.join('; ')}`);
      assert((await menu.getByTestId('reaction-option').count()) === 6, 'not all six quick reactions');
      let problems = await layoutReport(sam);
      assert(!problems.length, `with menu: ${problems.join('; ')}`);
      await tid(sam, 'menu-reply').click();
      await tid(sam, 'reply-preview').waitFor({ state: 'visible' });
      await tid(sam, 'message-input').fill('I can! Text me when you land');
      problems = await layoutReport(sam);
      assert(!problems.length, `with reply bar: ${problems.join('; ')}`);
      const box = await sam.evaluate(() => {
        const r = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
        return { preview: r('reply-preview'), cancel: r('reply-cancel'), input: r('message-input'), send: r('send-button'), vw: innerWidth, vh: innerHeight };
      });
      assert(box.preview.bottom <= box.input.top + 1, 'reply bar overlaps the composer');
      assert(box.cancel.right <= box.vw && box.cancel.width >= 24, `reply-cancel squeezed: ${JSON.stringify(box.cancel)}`);
      assert(box.send.bottom <= box.vh && box.send.right <= box.vw, 'send button off screen');
      await tid(sam, 'send-button').click();
      const reply = messagesWithBody(sam, 'I can! Text me when you land');
      await reply.getByTestId('message-reply-quote').waitFor({ timeout: 5000 });
      problems = await layoutReport(sam);
      assert(!problems.length, `after the reply: ${problems.join('; ')}`);
    });

    await check("leaving: the 320px user's list loses the group; the others see \"Sam left the group\"", async () => {
      await tid(sam, 'group-info-button').click();
      await tid(sam, 'group-info-screen').waitFor();
      await tid(sam, 'leave-group-button').click();
      await tid(sam, 'chats-screen').waitFor({ timeout: 5000 });
      await until('group gone from Sam list', async () => (await conversationItem(sam, groupId).count()) === 0);
      assert((await conversationItem(sam, dmId).count()) === 0, 'Sam never had the DM');
      for (const [page, label] of [[maya, 'iPhone'], [jordan, 'Android']]) {
        await until(`${label}: "Sam left the group"`, async () =>
          (await tid(page, 'system-message').allTextContents()).some((t) => t.trim() === 'Sam left the group'));
      }
      await sam.reload();
      await tid(sam, 'chats-screen').waitFor();
      await sleep(500);
      assert((await conversationItem(sam, groupId).count()) === 0, 'group back in Sam list after reload');
      const res = await get(sam, `/api/conversations/${groupId}/messages`);
      await res.arrayBuffer();
      assert(res.status === 403, `left member can still read the group: ${res.status}`);
    });

    // ------------------------------------------------------------------ guards
    await check('no request ever left the local server', async () => {
      assert(!foreignRequests.length, foreignRequests.slice(0, 5).join('\n'));
    });

    await check('no console errors, page errors or server errors', async () => {
      const all = [...consoleErrors, ...serverErrors.map((e) => `server: ${e}`)];
      assert(!all.length, all.slice(0, 8).join('\n'));
    });
  } finally {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return summary(origin);
}

runMain(main, OVERALL_TIMEOUT_MS);
