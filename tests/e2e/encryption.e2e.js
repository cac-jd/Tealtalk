'use strict';

// End-to-end encryption (v3, docs/E2EE.md) between an iPhone user (Maya, iPhone 13)
// and an Android user (Jordan, Pixel 7), through the real PWA:
//  - after texts, emoji reactions, an edit, a photo, a video and a voice message, the
//    server's SQLite files and every uploaded file contain none of the plaintext;
//  - safety numbers match on both phones and change when a key is reset; a verified
//    contact's change shows a notice, drops the badge and asks before sending;
//  - a new device needs the recovery key (typos like lowercase and O/l are fine),
//    "Start fresh" leaves old messages locked, logout wipes the keys;
//  - a member who hasn't set up keys yet gets the message once they do;
//  - Settings shows the same app fingerprint as `npm run fingerprint`.
// Push previews are decrypted by the service worker, which a browser test can't drive:
// tests/crypto.test.js covers that code.
//
//   npm run test:e2e        (runs after cross-platform.e2e.js and media-and-reactions.e2e.js)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../../server');
const {
  PASSWORD,
  loadPlaywright,
  createRunner,
  runMain,
  assert,
  sleep,
  until,
  canvasJpeg,
  withGpsExif,
  recordWebm,
  deviceFactory,
  tid,
  text,
  messagesWithBody,
  saveRecoveryKey,
  register,
  login,
  enterRecoveryKey,
  logout,
  trackObjectUrls,
  blobBytes,
  conversationItem,
  openConversation,
  sendText,
  countWithBody,
  waitStatus,
} = require('./harness');

const OVERALL_TIMEOUT_MS = 240000;
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { check, summary } = createRunner();

// ---------------------------------------------------------------------------
// helpers

/** The chips under a message as sorted "emoji+count" strings. */
async function chips(msg) {
  return (await msg.getByTestId('reaction-chip').evaluateAll((els) => els.map((el) => el.textContent.trim()))).sort();
}

async function react(page, msg, emoji) {
  await msg.getByTestId('message-body').click({ button: 'right' });
  await tid(page, 'message-menu').waitFor({ state: 'visible', timeout: 3000 });
  await tid(page, 'message-menu').locator(`[data-testid="reaction-option"][data-emoji="${emoji}"]`).click();
  await tid(page, 'message-menu').waitFor({ state: 'hidden', timeout: 3000 });
}

async function messageId(locator) {
  const id = await locator.getAttribute('data-message-id');
  assert(/^\d+$/.test(id || ''), `message has no server id yet (${id})`);
  return Number(id);
}

function messageById(page, id) {
  return page.locator(`[data-testid="message"][data-message-id="${id}"]`);
}

function decoded(img) {
  return img.evaluate((el) => el.complete && el.naturalWidth > 0);
}

/** The 60 safety-number digits shown for the 1:1 chat that's open, then back to the chat. */
async function safetyDigits(page) {
  await tid(page, 'verify-safety-button').click();
  await tid(page, 'safety-screen').waitFor();
  const digits = await until('safety number', async () => {
    const d = (await text(tid(page, 'safety-number'))).replace(/\D/g, '');
    return d.length === 60 && d;
  });
  return digits;
}

async function leaveSafety(page) {
  await tid(page, 'safety-back').click();
  await tid(page, 'chat-screen').waitFor();
}

/** Fill in the login form and submit it (whatever screen comes next). */
async function submitLogin(page, username) {
  await tid(page, 'auth-screen').waitFor();
  await tid(page, 'auth-username').fill(username);
  await tid(page, 'auth-password').fill(PASSWORD);
  await tid(page, 'auth-submit').click();
}

/** Settings -> Reset key (confirm) -> the new recovery key is saved. Resolves to it. */
async function resetKey(page) {
  if (await tid(page, 'chats-screen').isHidden()) {
    await tid(page, 'back-button').click();
    await tid(page, 'chats-screen').waitFor();
  }
  await tid(page, 'settings-button').click();
  await tid(page, 'settings-screen').waitFor();
  await tid(page, 'reset-keys-button').click(); // confirm() accepted
  const key = await saveRecoveryKey(page);
  if (await tid(page, 'settings-screen').isVisible()) await tid(page, 'settings-back').click();
  await tid(page, 'chats-screen').waitFor();
  return key;
}

/** Records in an IndexedDB store of the key database ('account' or 'contacts'). */
function keyStoreCount(page, store) {
  return page.evaluate(
    (name) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('tealtalk-keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(name)) {
            db.close();
            resolve(0);
            return;
          }
          const req = db.transaction(name, 'readonly').objectStore(name).count();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  );
}

/** Concatenated bytes of the SQLite database (+ -wal, -shm) and of every uploaded file. */
function serverBytes(dataDir) {
  const files = [];
  for (const name of fs.readdirSync(dataDir)) {
    if (/^tealtalk\.db(-wal|-shm)?$/.test(name)) files.push(path.join(dataDir, name));
  }
  const uploads = path.join(dataDir, 'uploads');
  for (const name of fs.readdirSync(uploads)) {
    const p = path.join(uploads, name);
    if (fs.statSync(p).isFile()) files.push(p);
  }
  return files.map((f) => ({ file: path.relative(dataDir, f), bytes: fs.readFileSync(f) }));
}

/** Names of the `needles` ({ label, bytes }) found anywhere in the server's files. */
function plaintextFound(dataDir, needles) {
  const found = [];
  const files = serverBytes(dataDir);
  assert(files.some((f) => f.file === 'tealtalk.db'), 'no database file to scan');
  for (const { label, bytes } of needles) {
    for (const f of files) if (f.bytes.includes(bytes)) found.push(`${label} in ${f.file}`);
  }
  return { found, files: files.length, bytes: files.reduce((n, f) => n + f.bytes.length, 0) };
}

/** A few distinctive 48-byte windows from the middle of a file (not headers or padding). */
function windows(label, buf, n = 3) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const at = Math.floor((buf.length * i) / (n + 1));
    out.push({ label: `${label} bytes @${at}`, bytes: buf.subarray(at, at + 48) });
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const { chromium, devices } = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-e2e-e2ee-'));
  const serverErrors = [];
  const log = { log() {}, info() {}, warn() {}, error: (...args) => serverErrors.push(args.join(' ')) };
  const app = await createApp({ dataDir, port: 0, log });
  const origin = new URL(app.url).origin;
  const serverHost = new URL(app.url).host;
  console.log(`TealTalk encryption e2e against ${app.url}`);

  const foreignRequests = [];
  const consoleErrors = [];
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const device = deviceFactory({ browser, serverHost, foreignRequests, consoleErrors });
  const dialogs = [];
  async function phone(label, descriptor, extra) {
    const d = await device(label, descriptor, extra);
    await d.context.addInitScript(trackObjectUrls);
    d.page.on('dialog', (dlg) => {
      dialogs.push({ label, message: dlg.message() });
      dlg.accept().catch(() => {});
    });
    d.page.setDefaultTimeout(10000);
    return d;
  }

  const iphone = await phone('iPhone', devices['iPhone 13'], { permissions: ['microphone'] });
  const android = await phone('Android', devices['Pixel 7']);
  const maya = iphone.page;
  const jordan = android.page;

  const keys = {};
  let dmId = null;
  let samDmId = null;
  let samPhone = null;
  let digitsBefore = null;
  let anywayId = null;

  // Everything that must never reach the server in readable form.
  const secrets = {
    jordanHello: 'Encrypted hello from Jordan: kumquat-orbit-5521',
    mayaPlan: 'Secret plan: meet at Larkspur Pier 🦩 at six',
    original: 'Original wording: cobalt-lantern-8842',
    edited: 'Edited wording: saffron-glacier-3317',
    anyway: 'Sent after the key change: vermilion-quartz-6610',
    waiting: 'Hi Sam, this waited for your key: obsidian-meadow-2093',
    afterFresh: 'Welcome back on your new phone: tangerine-harbor-7754',
  };
  const emoji = ['❤️', '😂', '🙏', '🦩'];
  const media = []; // { label, bytes } windows of the photo, its thumbnail, the video and the voice message
  const needles = () => [
    ...Object.entries(secrets).map(([k, v]) => ({ label: `text "${k}"`, bytes: Buffer.from(v, 'utf8') })),
    // Distinctive pieces of the texts too, in case a client trims or re-wraps them.
    ...Object.values(secrets).map((v) => ({ label: `token ${v.split(' ').pop()}`, bytes: Buffer.from(v.split(':').pop().trim(), 'utf8') })),
    ...emoji.map((e) => ({ label: `emoji ${e}`, bytes: Buffer.from(e, 'utf8') })),
    ...media,
  ];

  try {
    // ------------------------------------------------------------------ setup
    await check('iPhone and Android users register; each sees a recovery key once and confirms it', async () => {
      [keys.maya, keys.jordan] = await Promise.all([
        register(maya, app.url, 'maya', 'Maya'),
        register(jordan, app.url, 'jordan', 'Jordan'),
      ]);
      assert(keys.maya !== keys.jordan, 'same recovery key for two accounts');
      // The new-device check types 0 as "o" and 1 as "l": make sure Maya's key has one of them.
      for (let i = 0; i < 10 && !/[01]/.test(keys.maya); i++) keys.maya = await resetKey(maya);
      assert(/[01]/.test(keys.maya), `no 0 or 1 in ten recovery keys (${keys.maya})`);
      for (const page of [maya, jordan]) assert((await keyStoreCount(page, 'account')) === 1, 'no key stored on the device');
    }, { critical: true });

    await check('Android starts a 1:1; texts both ways, reactions and an edit arrive decrypted', async () => {
      await tid(jordan, 'new-chat-button').click();
      await tid(jordan, 'user-search-input').fill('maya');
      await until('one search hit', async () => (await tid(jordan, 'user-result').count()) === 1);
      await tid(jordan, 'user-result').click();
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();
      dmId = decodeURIComponent(new URL(jordan.url()).hash.replace('#/c/', ''));
      await conversationItem(maya, dmId).waitFor({ timeout: 5000 });
      await openConversation(maya, dmId);

      await sendText(jordan, secrets.jordanHello);
      await sendText(maya, secrets.mayaPlan);
      await sendText(maya, secrets.original);
      for (const page of [maya, jordan]) {
        for (const body of [secrets.jordanHello, secrets.mayaPlan, secrets.original]) {
          await until(`"${body}" decrypted`, async () => (await countWithBody(page, body)) === 1);
        }
      }
      await waitStatus(maya, secrets.original, 'read');

      await react(maya, messagesWithBody(maya, secrets.jordanHello), '❤️');
      await react(jordan, messagesWithBody(jordan, secrets.mayaPlan), '😂');
      await until('😂 on the iPhone', async () => JSON.stringify(await chips(messagesWithBody(maya, secrets.mayaPlan))) === '["😂1"]');
      await react(jordan, messagesWithBody(jordan, secrets.mayaPlan), '🙏'); // replaces 😂
      for (const page of [maya, jordan]) {
        await until('reactions decrypted', async () =>
          JSON.stringify(await chips(messagesWithBody(page, secrets.jordanHello))) === '["❤️1"]' &&
          JSON.stringify(await chips(messagesWithBody(page, secrets.mayaPlan))) === '["🙏1"]');
      }

      await messagesWithBody(maya, secrets.original).getByTestId('message-body').click({ button: 'right' });
      await tid(maya, 'menu-edit').click();
      await tid(maya, 'message-input').fill(secrets.edited);
      await tid(maya, 'send-button').click();
      for (const page of [maya, jordan]) {
        await until('edit decrypted', async () => (await countWithBody(page, secrets.edited)) === 1 && (await countWithBody(page, secrets.original)) === 0);
        await messagesWithBody(page, secrets.edited).getByTestId('message-edited').waitFor();
      }
    }, { critical: true });

    await check('a photo (with GPS), a video and a voice message arrive and decrypt on the other phone', async () => {
      const scratch = await browser.newPage();
      let photo;
      let video;
      try {
        photo = withGpsExif(await canvasJpeg(scratch, { width: 1600, height: 1200 }));
        video = await recordWebm(scratch, { width: 480, height: 320, ms: 1500 });
      } finally {
        await scratch.close();
      }
      media.push(...windows('photo', photo.stripped), ...windows('video', video));

      // Photo from the iPhone: Android decrypts the thumbnail and the original.
      await tid(maya, 'attach-input').setInputFiles({ name: 'IMG_0007.JPG', mimeType: 'image/jpeg', buffer: photo.jpeg });
      const img = tid(jordan, 'message-image');
      await img.waitFor({ timeout: 10000 });
      await until('thumbnail decoded on Android', () => decoded(img));
      const thumb = await blobBytes(jordan, await img.getAttribute('src'));
      media.push(...windows('photo thumbnail', thumb));
      await img.click();
      const viewer = tid(jordan, 'image-viewer').locator('img');
      await until('original decrypted', () => viewer.evaluate((el) => el.naturalWidth === 1600 && el.complete), 10000);
      const original = await blobBytes(jordan, await viewer.getAttribute('src'));
      assert(original.equals(photo.stripped), 'decrypted photo differs from what was sent (minus GPS)');
      await tid(jordan, 'image-viewer-close').click();

      // Video from Android: the iPhone downloads, decrypts and plays it.
      await tid(jordan, 'attach-input').setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: video });
      const v = tid(maya, 'message-video');
      await v.waitFor({ timeout: 15000 });
      const got = await blobBytes(maya, await v.getAttribute('src'));
      assert(got.equals(video), 'decrypted video differs from what was sent');

      // Voice message from the iPhone.
      await tid(maya, 'record-button').click();
      await tid(maya, 'record-send').waitFor({ state: 'visible', timeout: 5000 });
      await sleep(1500);
      await tid(maya, 'record-send').click();
      const audio = tid(jordan, 'message-audio').locator('audio');
      await until('voice message decrypted on Android', async () => ((await audio.getAttribute('src')) || '').startsWith('blob:'), 10000);
      const voice = await blobBytes(jordan, await audio.getAttribute('src'));
      assert(voice.length > 1000, `voice message is only ${voice.length} bytes`);
      media.push(...windows('voice', voice));
    }, { critical: true });

    await check('the server stores no plaintext: no text, emoji, photo, video or voice bytes in SQLite or uploads', async () => {
      // Sanity: the scan does find what's there (the users' public display names).
      const control = plaintextFound(dataDir, [{ label: 'username', bytes: Buffer.from('jordan') }]);
      assert(control.found.length > 0, 'the scan cannot even find a username: is it reading the right files?');
      const { found, files, bytes } = plaintextFound(dataDir, needles());
      assert(files >= 5 && bytes > 100000, `only ${files} files / ${bytes} bytes scanned`);
      assert(!found.length, `plaintext on the server: ${found.join('; ')}`);
      const types = app.store.db.prepare('SELECT DISTINCT mime FROM attachments').all().map((r) => r.mime);
      assert(JSON.stringify(types) === '["application/vnd.tealtalk.e2ee"]', `attachment types on the server: ${types}`);
    });

    // ------------------------------------------------------------------ safety numbers
    await check('safety numbers: 60 digits, identical on both phones', async () => {
      const [a, b] = [await safetyDigits(maya), await safetyDigits(jordan)];
      assert(a === b, `iPhone ${a} != Android ${b}`);
      digitsBefore = a;
      await leaveSafety(jordan);
    });

    await check('verified, then the other side resets its key: notice, badge gone, new number on both phones', async () => {
      assert(await tid(maya, 'safety-screen').isVisible(), 'iPhone not on the safety screen');
      await tid(maya, 'mark-verified-button').click();
      await tid(maya, 'unmark-verified-button').waitFor();
      await leaveSafety(maya);
      await tid(maya, 'verified-badge').waitFor({ state: 'visible' });
      assert((await tid(maya, 'safety-change-notice').count()) === 0, 'a notice before anything changed');

      keys.jordan = await resetKey(jordan);
      await openConversation(jordan, dmId);
      await tid(maya, 'safety-change-notice').waitFor({ timeout: 10000 });
      assert((await text(tid(maya, 'safety-change-notice'))).includes('Jordan'), 'the notice does not name Jordan');
      await until('verified badge removed', async () => (await tid(maya, 'verified-badge').count()) === 0);

      const [a, b] = [await safetyDigits(maya), await safetyDigits(jordan)];
      assert(a === b, `after the reset: iPhone ${a} != Android ${b}`);
      assert(a !== digitsBefore, 'the safety number did not change with the key');
      assert(await tid(maya, 'mark-verified-button').isVisible(), 'still shown as verified on the safety screen');
      await leaveSafety(maya);
      await leaveSafety(jordan);
    });

    await check('sending to a changed verified contact asks first; "Send anyway" delivers it', async () => {
      await sendText(maya, secrets.anyway);
      await tid(maya, 'safety-interstitial').waitFor({ state: 'visible', timeout: 10000 });
      const waiting = messagesWithBody(maya, secrets.anyway).getByTestId('message-waiting');
      await waiting.waitFor();
      await sleep(500);
      assert((await countWithBody(jordan, secrets.anyway)) === 0, 'delivered before Maya confirmed');
      await tid(maya, 'safety-send-anyway').click();
      await tid(maya, 'safety-interstitial').waitFor({ state: 'hidden' });
      await until('delivered to the new key', async () => (await countWithBody(jordan, secrets.anyway)) === 1, 10000);
      await waitStatus(maya, secrets.anyway, 'read');
      assert((await waiting.count()) === 0, 'still marked as waiting');
      anywayId = await messageId(messagesWithBody(jordan, secrets.anyway));
    });

    // ------------------------------------------------------------------ new device
    await check('new iPhone: wrong recovery key is refused; the right one, typed sloppily, unlocks the history', async () => {
      const fresh = await phone('iPhone (new)', devices['iPhone 13']);
      try {
        const page = fresh.page;
        await page.goto(app.url);
        await submitLogin(page, 'maya');
        await tid(page, 'recovery-screen').waitFor({ timeout: 15000 });
        await enterRecoveryKey(page, keys.jordan); // a real recovery key, just not Maya's
        await tid(page, 'recovery-error').waitFor({ state: 'visible' });
        assert((await text(tid(page, 'recovery-error'))).length > 10, 'empty recovery error');
        assert(await tid(page, 'chats-screen').isHidden(), 'got in with the wrong key');
        // Lowercase, O for 0, l for 1, spaces instead of dashes.
        const sloppy = keys.maya.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/-/g, ' ');
        assert(sloppy.toUpperCase() !== keys.maya.replace(/-/g, ' '), 'nothing sloppy about it');
        await enterRecoveryKey(page, sloppy);
        await tid(page, 'chats-screen').waitFor({ timeout: 15000 });
        await openConversation(page, dmId);
        for (const body of [secrets.jordanHello, secrets.mayaPlan, secrets.edited, secrets.anyway]) {
          await until(`"${body}" readable on the new iPhone`, async () => (await countWithBody(page, body)) === 1, 10000);
        }
        assert((await messagesWithBody(page, secrets.mayaPlan).getAttribute('data-mine')) === 'true', 'own message not mine');
        await until('photo decrypted on the new iPhone', () => decoded(tid(page, 'message-image')), 10000);
        assert((await tid(page, 'message-undecryptable').count()) === 0, 'something stayed locked');
      } finally {
        await fresh.context.close();
      }
    });

    // ------------------------------------------------------------------ waiting for keys
    await check('a member without keys: "Waiting for Sam" until Sam opens TealTalk, then it is delivered', async () => {
      // Sam signed up but hasn't opened the encrypted app yet (no keys published).
      const res = await fetch(`${app.url}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sam', password: PASSWORD, displayName: 'Sam' }),
      });
      assert(res.status === 201, `register sam: ${res.status}`);
      await tid(maya, 'back-button').click();
      await tid(maya, 'new-chat-button').click();
      await tid(maya, 'user-search-input').fill('sam');
      await until('sam hit', async () => (await tid(maya, 'user-result').count()) === 1);
      await tid(maya, 'user-result').click();
      await tid(maya, 'create-chat-button').click();
      await tid(maya, 'chat-screen').waitFor();
      samDmId = decodeURIComponent(new URL(maya.url()).hash.replace('#/c/', ''));
      await sendText(maya, secrets.waiting);
      const waiting = messagesWithBody(maya, secrets.waiting).getByTestId('message-waiting');
      await waiting.waitFor({ timeout: 10000 });
      assert((await text(waiting)).includes('Waiting for Sam'), `waiting text: "${await text(waiting)}"`);
      assert((await text(messagesWithBody(maya, secrets.waiting).getByTestId('message-status'))) === 'sending', 'not still sending');

      samPhone = await phone('Android (Sam)', devices['Pixel 7']);
      await samPhone.page.goto(app.url);
      assert((await login(samPhone.page, 'sam')) === 'new-key', 'Sam was not set up with a new key');
      await until('delivered once Sam has a key', async () => (await waiting.count()) === 0, 15000);
      await openConversation(samPhone.page, samDmId);
      await until('Sam reads it', async () => (await countWithBody(samPhone.page, secrets.waiting)) === 1, 10000);
      await waitStatus(maya, secrets.waiting, 'read');
      await samPhone.context.close();
      samPhone = null;
    });

    // ------------------------------------------------------------------ logout
    await check('logout warns, wipes the private keys from IndexedDB, and logging back in asks for the recovery key', async () => {
      dialogs.length = 0;
      await tid(maya, 'back-button').click();
      await tid(maya, 'settings-button').click();
      await tid(maya, 'settings-screen').waitFor();
      // A chat-list update lands just before the tap (it schedules a cache write).
      await maya.evaluate(async () => {
        const store = await import('/js/store.js');
        store.setConversations([...store.state.conversations.values()]);
      });
      await tid(maya, 'logout-button').click(); // the confirm() is accepted
      await tid(maya, 'auth-screen').waitFor();
      const warning = dialogs.map((d) => d.message).join('\n');
      assert(/recovery key/i.test(warning), `no recovery-key warning: "${warning}"`);
      // Regression: the auth screen used to stay in "Create account" mode after logging out.
      assert(await tid(maya, 'auth-displayname').isHidden(), 'auth screen still in "Create account" mode after logout');
      assert((await keyStoreCount(maya, 'account')) === 0, 'private keys still stored after logout');
      // Regression: that cache write used to land after the logout and leave the list behind.
      await sleep(500);
      const left = await maya.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tt.')));
      assert(!left.length, `left in localStorage after logout: ${left.join(', ')}`);
      assert((await login(maya, 'maya', { recoveryKey: keys.maya })) === 'recovery', 'no recovery key asked after logout');
      assert((await keyStoreCount(maya, 'account')) === 1, 'key not stored again after recovery');
      await openConversation(maya, dmId);
      await until('history readable again', async () => (await countWithBody(maya, secrets.anyway)) === 1, 10000);
    });

    // ------------------------------------------------------------------ start fresh
    await check('"Start fresh" on a new login: old messages show message-undecryptable; the iPhone sees the change', async () => {
      const noticesBefore = await tid(maya, 'safety-change-notice').count();
      await logout(jordan);
      await submitLogin(jordan, 'jordan');
      await tid(jordan, 'recovery-screen').waitFor({ timeout: 15000 });
      await tid(jordan, 'recovery-reset-button').click(); // confirm() accepted
      keys.jordan = await saveRecoveryKey(jordan);
      await tid(jordan, 'chats-screen').waitFor();
      await openConversation(jordan, dmId);
      const old = messageById(jordan, anywayId);
      await old.getByTestId('message-undecryptable').waitFor({ timeout: 10000 });
      assert((await countWithBody(jordan, secrets.anyway)) === 0, 'old message readable after starting fresh');
      await until('another safety-change notice on the iPhone', async () =>
        (await tid(maya, 'safety-change-notice').count()) > noticesBefore, 10000);
      // New messages work with the new key, both ways.
      await sendText(maya, secrets.afterFresh);
      await until('new message readable with the new key', async () => (await countWithBody(jordan, secrets.afterFresh)) === 1, 10000);
    });

    // ------------------------------------------------------------------ fingerprint
    await check('Settings shows the same app fingerprint as `npm run fingerprint`', async () => {
      const expected = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'fingerprint.js')]).toString().trim();
      assert(/^[0-9a-f]{64}$/.test(expected), `fingerprint script printed ${expected}`);
      await tid(maya, 'back-button').click();
      await tid(maya, 'settings-button').click();
      await tid(maya, 'settings-screen').waitFor();
      const shown = await until('fingerprint computed', async () => {
        const t = await text(tid(maya, 'app-fingerprint'));
        return /^[0-9a-f]{64}$/.test(t) && t;
      }, 30000);
      assert(shown === expected, `Settings shows ${shown}, npm run fingerprint says ${expected}`);
      await tid(maya, 'settings-back').click();
    });

    await check('after everything, still no plaintext anywhere on the server', async () => {
      const { found } = plaintextFound(dataDir, needles());
      assert(!found.length, `plaintext on the server: ${found.join('; ')}`);
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
