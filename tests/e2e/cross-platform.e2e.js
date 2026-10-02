'use strict';

// Cross-platform browser test: an iPhone user (Maya) and an Android user (Jordan)
// chat through the real PWA, plus a third user (Sam) on a narrow 320px phone.
//
//   npm run test:e2e
//
// Needs Playwright with Chromium (iPhone and Android are emulated with device
// descriptors). Starts its own server on a free port with a fresh data dir, and
// locates UI elements only through the data-testid contract in docs/PROTOCOL.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server');
const {
  PASSWORD,
  loadPlaywright,
  createRunner,
  runMain,
  assert,
  sleep,
  until,
  sunsetPng,
  deviceFactory,
  tid,
  text,
  messagesWithBody,
  register,
  login,
  openConversation,
  sendText,
  statusOf,
  waitStatus,
  countWithBody,
  bubbleColor,
  parseRgb,
  isBlue,
  layoutReport,
} = require('./harness');

const OVERALL_TIMEOUT_MS = 180000;
// Report and route service-worker fetches too (Chromium). context.setOffline() does not
// cut the service worker's own network, so "offline" below also aborts its requests.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { check, summary } = createRunner();

// ---------------------------------------------------------------------------

async function main() {
  const { chromium, devices } = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-e2e-'));
  const serverErrors = [];
  const log = {
    log() {},
    info() {},
    warn() {},
    error: (...args) => serverErrors.push(args.join(' ')),
  };
  const app = await createApp({ dataDir, port: 0, log });
  const origin = new URL(app.url).origin;
  const serverHost = new URL(app.url).host;
  console.log(`TealTalk e2e against ${app.url}`);

  const foreignRequests = [];
  const consoleErrors = [];
  // Network failures are expected while a device is deliberately offline.
  const EXPECTED_OFFLINE = /net::ERR_INTERNET_DISCONNECTED/;

  const browser = await chromium.launch();
  const device = deviceFactory({
    browser,
    serverHost,
    foreignRequests,
    consoleErrors,
    expectedError: (msg) => EXPECTED_OFFLINE.test(msg),
  });

  const iphone = await device('iPhone', devices['iPhone 13']);
  const android = await device('Android', devices['Pixel 7']);
  let narrow = null;
  const maya = iphone.page;
  const jordan = android.page;

  // Lets a test hold one message POST: either before it reaches the server
  // ('request') or after the server handled it but before the app sees the reply ('response').
  let hold = null;
  await android.context.route('**/api/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST' || !hold) return route.continue();
    const h = hold;
    hold = null;
    h.seen();
    if (h.mode === 'request') {
      await h.gate;
      return route.continue();
    }
    const response = await route.fetch();
    h.handled();
    await h.gate;
    return route.fulfill({ response });
  });
  // Offline for real: page requests via setOffline, service worker requests via this route.
  // Registered last so it runs before the message-hold route above.
  let androidOffline = false;
  await android.context.route('**/*', (route) =>
    androidOffline ? route.abort('internetdisconnected') : route.fallback());
  async function setAndroidOffline(offline) {
    androidOffline = offline;
    await android.context.setOffline(offline);
  }

  // Lets a test hold every chat-list snapshot the iPhone fetches until released.
  let listHold = null;
  await iphone.context.route('**/api/conversations', async (route) => {
    const h = listHold;
    if (route.request().method() !== 'GET' || !h) return route.continue();
    const response = await route.fetch(); // server state *now*
    h.fetched++;
    await h.gate;
    return route.fulfill({ response });
  });

  function holdNextPost(mode) {
    let release;
    let seen;
    let handled;
    const h = {
      mode,
      gate: new Promise((r) => (release = r)),
      seenP: new Promise((r) => (seen = r)),
      handledP: new Promise((r) => (handled = r)),
    };
    h.seen = seen;
    h.handled = handled;
    h.release = release;
    hold = h;
    return h;
  }

  const png = sunsetPng();
  let dmId = null;
  let groupId = null;
  const msg1 = 'Hey Maya! Are we still on for Saturday?';
  const msg2 = 'I can bring the snacks 🍪';
  const reply = 'Yes! Meet at the trailhead at 9?';
  const offlineIncoming = 'Are you there?';
  const offlineQueued = 'Sorry, I was in a tunnel 🚇';
  const xssBody = '<img src=x onerror="window.__xss=1"><b>not bold</b>';
  const groupTitle = 'Hike <b>crew</b> & "friends"';

  try {
    await check('iPhone user and Android user can register', async () => {
      await Promise.all([register(maya, app.url, 'maya', 'Maya'), register(jordan, app.url, 'jordan', 'Jordan')]);
    }, { critical: true });

    await check('Android user starts a 1:1 with the iPhone user', async () => {
      await tid(jordan, 'new-chat-button').click();
      await tid(jordan, 'new-chat-screen').waitFor();
      await tid(jordan, 'user-search-input').fill('may');
      const hit = tid(jordan, 'user-result');
      await until('one search hit', async () => (await hit.count()) === 1);
      await hit.click();
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();
      await until('chat title Maya', async () => (await text(tid(jordan, 'chat-title'))) === 'Maya');
      dmId = decodeURIComponent(new URL(jordan.url()).hash.replace('#/c/', ''));
      assert(/^c_/.test(dmId), `unexpected conversation id in URL: ${jordan.url()}`);
    }, { critical: true });

    await check('the new chat appears on the iPhone in real time', async () => {
      await maya.locator(`[data-testid="conversation-item"][data-conversation-id="${dmId}"]`).waitFor({ timeout: 5000 });
    }, { critical: true });

    await check('status goes sending -> sent (Android)', async () => {
      const h = holdNextPost('request');
      await sendText(jordan, msg1);
      await h.seenP;
      await waitStatus(jordan, msg1, 'sending');
      const el = messagesWithBody(jordan, msg1);
      assert((await el.getAttribute('data-mine')) === 'true', 'my message should have data-mine=true');
      assert(await el.getAttribute('data-client-id'), 'pending message should carry data-client-id');
      h.release();
      await waitStatus(jordan, msg1, 'sent');
      assert(/^\d+$/.test((await el.getAttribute('data-message-id')) || ''), 'sent message should carry data-message-id');
    });

    await check('socket echo before the HTTP reply does not duplicate the bubble', async () => {
      const h = holdNextPost('response');
      await sendText(jordan, msg2);
      await h.handledP; // stored on the server and fanned out over the WebSocket
      await until('WebSocket echo resolves the pending bubble', async () => (await statusOf(jordan, msg2)) === 'sent');
      assert((await countWithBody(jordan, msg2)) === 1, 'duplicate bubble before HTTP reply');
      h.release();
      await sleep(400);
      assert((await countWithBody(jordan, msg2)) === 1, 'duplicate bubble after HTTP reply');
      assert((await tid(jordan, 'message').count()) === 2, 'expected exactly 2 messages on Android');
    });

    await check('unread badge on the iPhone chat list counts both messages', async () => {
      const badge = maya.locator(`[data-testid="conversation-item"][data-conversation-id="${dmId}"] [data-testid="unread-badge"]`);
      await until('badge 2', async () => (await badge.count()) === 1 && (await text(badge)) === '2');
      assert((await statusOf(jordan, msg1)) === 'sent', 'should stay sent until Maya opens the chat');
    });

    await check('iPhone opens the chat, messages arrived, sender sees read', async () => {
      await openConversation(maya, dmId);
      await until('2 messages on iPhone', async () => (await tid(maya, 'message').count()) === 2);
      assert((await countWithBody(maya, msg1)) === 1 && (await countWithBody(maya, msg2)) === 1, 'bodies on iPhone');
      assert((await messagesWithBody(maya, msg1).getAttribute('data-mine')) === 'false', 'theirs has data-mine=false');
      assert((await text(tid(maya, 'chat-title'))) === 'Jordan', 'chat title on iPhone');
      await waitStatus(jordan, msg1, 'read');
      await waitStatus(jordan, msg2, 'read');
    });

    await check('typing indicator shows on Android while the iPhone user types', async () => {
      assert(await tid(jordan, 'typing-indicator').isHidden(), 'typing indicator should start hidden');
      await tid(maya, 'message-input').pressSequentially('Yes!', { delay: 30 });
      await tid(jordan, 'typing-indicator').waitFor({ state: 'visible', timeout: 5000 });
      assert((await text(tid(jordan, 'typing-indicator'))).includes('Maya'), 'indicator names Maya');
    });

    await check('iPhone -> Android message arrives in real time and clears typing', async () => {
      await tid(maya, 'message-input').fill(reply);
      await tid(maya, 'send-button').click();
      await until('reply on Android', async () => (await countWithBody(jordan, reply)) === 1, 5000);
      await tid(jordan, 'typing-indicator').waitFor({ state: 'hidden', timeout: 3000 });
      await waitStatus(maya, reply, 'read'); // Jordan has the chat open
      assert((await countWithBody(maya, reply)) === 1, 'no duplicate on iPhone');
    });

    await check('bubble colours identical on both devices: mine teal, theirs grey, never blue', async () => {
      const mineIphone = await bubbleColor(messagesWithBody(maya, reply));
      const mineAndroid = await bubbleColor(messagesWithBody(jordan, msg1));
      const theirsIphone = await bubbleColor(messagesWithBody(maya, msg1));
      const theirsAndroid = await bubbleColor(messagesWithBody(jordan, reply));
      const all = { mineIphone, mineAndroid, theirsIphone, theirsAndroid };
      assert(mineIphone === mineAndroid, `my bubbles differ: ${JSON.stringify(all)}`);
      assert(theirsIphone === theirsAndroid, `their bubbles differ: ${JSON.stringify(all)}`);
      assert(mineIphone !== theirsIphone, 'mine and theirs should differ');
      const [r, g, b] = parseRgb(mineIphone);
      assert(g > r && g >= b - 10 && b > r, `my bubble is not teal: ${mineIphone}`);
      const grey = parseRgb(theirsIphone);
      assert(Math.max(...grey) - Math.min(...grey) < 24, `their bubble is not grey: ${theirsIphone}`);
      for (const [k, v] of Object.entries(all)) assert(!isBlue(v), `${k} is blue: ${v}`);
      // Every bubble on both phones is one of exactly these two colours.
      for (const page of [maya, jordan]) {
        for (const loc of await tid(page, 'message').all()) {
          const mine = (await loc.getAttribute('data-mine')) === 'true';
          const c = await bubbleColor(loc);
          assert(c === (mine ? mineIphone : theirsIphone), `unexpected bubble colour ${c}`);
        }
      }
    });

    await check('photo sent from the iPhone arrives and renders on Android', async () => {
      await tid(maya, 'attach-input').setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: png });
      const img = tid(jordan, 'message-image');
      await img.waitFor({ timeout: 8000 });
      await until('image decoded on Android', () => img.evaluate((el) => el.complete && el.naturalWidth > 0));
      const src = await img.getAttribute('src');
      assert(src && src.startsWith('/api/attachments/'), `unexpected image src ${src}`);
      const mine = tid(maya, 'message-image');
      await until('server copy shown on iPhone', () =>
        mine.evaluate((el) => el.complete && el.naturalWidth > 0 && el.getAttribute('src').startsWith('/api/attachments/')));
      assert((await tid(jordan, 'message-image').count()) === 1, 'exactly one image on Android');
      const photoMsg = tid(jordan, 'message').filter({ has: jordan.getByTestId('message-image') });
      assert((await photoMsg.getAttribute('data-mine')) === 'false', 'photo is theirs on Android');
    });

    await check('other users cannot read the attachment', async () => {
      const src = await tid(jordan, 'message-image').getAttribute('src');
      const id = src.split('?')[0].split('/').pop();
      const outsider = await fetch(`${app.url}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nosy', password: PASSWORD }),
      }).then((r) => r.json());
      const res = await fetch(`${app.url}/api/attachments/${id}?token=${encodeURIComponent(outsider.token)}`);
      assert(res.status === 403, `outsider got ${res.status}`);
      const anon = await fetch(`${app.url}/api/attachments/${id}`);
      assert(anon.status === 401, `anonymous got ${anon.status}`);
    });

    await check('narrow 320px phone: third user registers', async () => {
      narrow = await device('iPhone SE 320px', devices['iPhone SE']);
      await register(narrow.page, app.url, 'sam', 'Sam');
    }, { critical: true });
    const sam = narrow && narrow.page;

    await check('group chat: created from Android, appears for both others with an HTML-safe title', async () => {
      await tid(jordan, 'back-button').click();
      await tid(jordan, 'chats-screen').waitFor();
      await tid(jordan, 'new-chat-button').click();
      for (const q of ['maya', 'sam']) {
        await tid(jordan, 'user-search-input').fill(q);
        const hit = tid(jordan, 'user-result');
        await until(`search hit for ${q}`, async () =>
          (await hit.count()) === 1 && (await hit.textContent()).toLowerCase().includes(q));
        await hit.click();
      }
      await tid(jordan, 'group-title-input').fill(groupTitle);
      await tid(jordan, 'create-chat-button').click();
      await tid(jordan, 'chat-screen').waitFor();
      groupId = decodeURIComponent(new URL(jordan.url()).hash.replace('#/c/', ''));
      assert(groupId && groupId !== dmId, 'group should be a new conversation');
      await until('group title', async () => (await text(tid(jordan, 'chat-title'))) === groupTitle);
      for (const page of [maya, sam]) {
        if (page === maya) {
          await tid(maya, 'back-button').click();
          await tid(maya, 'chats-screen').waitFor();
        }
        const item = page.locator(`[data-testid="conversation-item"][data-conversation-id="${groupId}"]`);
        await item.waitFor({ timeout: 5000 });
        assert((await item.textContent()).includes(groupTitle), 'group title rendered as text in the list');
      }
    });

    await check('group messages show sender names; HTML in messages is inert', async () => {
      await openConversation(sam, groupId);
      await sendText(sam, "I'm in! 🥾");
      await openConversation(maya, groupId);
      await sendText(maya, xssBody);
      await until('both group messages on Android', async () => (await tid(jordan, 'message').count()) === 2);
      const fromSam = messagesWithBody(jordan, "I'm in! 🥾");
      const fromMaya = messagesWithBody(jordan, xssBody);
      assert((await fromSam.innerText()).includes('Sam'), 'Sam named on his group message');
      assert((await fromMaya.innerText()).includes('Maya'), 'Maya named on her group message');
      for (const page of [maya, jordan, sam]) {
        const body = messagesWithBody(page, xssBody).getByTestId('message-body');
        await body.waitFor({ timeout: 5000 });
        assert((await body.textContent()) === xssBody, 'body shown literally');
        assert((await body.locator('img, b').count()) === 0, 'no HTML elements created from the body');
        assert((await page.evaluate(() => window.__xss)) === undefined, 'onerror handler ran');
      }
      // My own group messages carry no sender name.
      assert(!(await messagesWithBody(maya, xssBody).innerText()).includes('Maya'), 'no name on my own group message');
    });

    await check('group status is read only once every other member has read', async () => {
      await tid(sam, 'back-button').click(); // so only Maya reads the next one
      await tid(sam, 'chats-screen').waitFor();
      const body = 'Leaving at 8, bring water';
      await sendText(jordan, body);
      await waitStatus(jordan, body, 'sent');
      await until('Maya got it', async () => (await countWithBody(maya, body)) === 1);
      await sleep(800);
      assert((await statusOf(jordan, body)) === 'sent', 'read by Maya only must still be sent');
      await openConversation(sam, groupId);
      await waitStatus(jordan, body, 'read');
    });

    await check('narrow 320px screen: no horizontal overflow in chat, list and new-chat screens', async () => {
      await tid(jordan, 'attach-input').setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: png });
      await sendText(jordan, 'Supercalifragilisticexpialidocious_trail_name_without_any_spaces_at_all_1234567890');
      const img = tid(sam, 'message-image');
      await img.waitFor({ timeout: 8000 });
      await until('image decoded at 320px', () => img.evaluate((el) => el.complete && el.naturalWidth > 0));
      await sleep(300);
      let problems = await layoutReport(sam);
      assert(!problems.length, `chat: ${problems.join('; ')}`);
      await tid(sam, 'message-input').focus();
      await tid(sam, 'back-button').click();
      await tid(sam, 'chats-screen').waitFor();
      problems = await layoutReport(sam);
      assert(!problems.length, `list: ${problems.join('; ')}`);
      await tid(sam, 'new-chat-button').click();
      await tid(sam, 'user-search-input').fill('j');
      await tid(sam, 'user-result').first().waitFor();
      await tid(sam, 'user-result').first().click();
      await tid(sam, 'group-title-input').fill('A rather long group name here');
      problems = await layoutReport(sam);
      assert(!problems.length, `new chat: ${problems.join('; ')}`);
    });

    await check('catching up a busy group after a long time offline leaves no hole in the history', async () => {
      await tid(sam, 'new-chat-back').click();
      await tid(sam, 'chats-screen').waitFor();
      const token = await jordan.evaluate(() => localStorage.getItem('tt.token'));
      const post = (body) =>
        fetch(`${app.url}/api/conversations/${groupId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ clientId: `bulk-${body}`, body }),
        }).then((r) => assert(r.status === 201, `bulk send ${r.status}`));
      await narrow.context.setOffline(true);
      await until('Sam offline', async () => (await text(tid(sam, 'connection-status'))) === 'Offline', 5000);
      for (let i = 1; i <= 60; i++) await post(`Photo dump ${i} of 60`);
      await narrow.context.setOffline(false);
      await tid(sam, 'connection-status').waitFor({ state: 'hidden', timeout: 10000 });
      await post('Anyone still awake?'); // arrives live, before Sam opens the group
      const badge = sam.locator(`[data-testid="conversation-item"][data-conversation-id="${groupId}"] [data-testid="unread-badge"]`);
      await until('unread badge for the catch-up', async () => Number(await text(badge)) >= 61);
      await openConversation(sam, groupId);
      await until('newest message shown', async () => (await countWithBody(sam, 'Anyone still awake?')) === 1);
      await sleep(500);
      const shown = (await tid(sam, 'message').evaluateAll((els) => els.map((el) => Number(el.dataset.messageId))))
        .filter(Boolean);
      const all = app.store.listMessages(groupId, Number.MAX_SAFE_INTEGER, 1000).map((m) => m.id);
      const expected = all.slice(all.indexOf(shown[0]));
      assert(JSON.stringify(shown) === JSON.stringify(expected),
        `history has a hole: showing ${shown.length} messages from id ${shown[0]}, server has ${expected.length} from there`);
      await tid(sam, 'back-button').click();
    });

    await check('offline Android queues a message; after reconnect it is delivered exactly once', async () => {
      await tid(jordan, 'back-button').click();
      await openConversation(jordan, dmId);
      await tid(maya, 'back-button').click();
      await openConversation(maya, dmId);
      await until('service worker controls the Android page', () =>
        jordan.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)));
      // Opening a non-HTML file in a tab must not replace the cached app shell.
      const tab = await android.context.newPage();
      await tab.goto(`${app.url}/icons/icon-192.png`);
      await sleep(300);
      await tab.close();

      await setAndroidOffline(true);
      await until('Offline banner', async () => (await text(tid(jordan, 'connection-status'))) === 'Offline', 5000);
      await sendText(maya, offlineIncoming);
      await sendText(jordan, offlineQueued);
      await waitStatus(jordan, offlineQueued, 'sending');
      await sleep(1500); // retries while offline must not produce anything
      assert((await countWithBody(maya, offlineQueued)) === 0, 'delivered while offline?');

      // Relaunch while offline: the app shell comes from the service worker and the outbox survives.
      const relaunch = await jordan.reload();
      assert(relaunch && relaunch.fromServiceWorker(), 'offline relaunch was not served by the service worker');
      const type = relaunch.headers()['content-type'] || '';
      assert(type.startsWith('text/html'), `offline app shell is ${type}, not the app`);
      await tid(jordan, 'chat-screen').waitFor({ timeout: 8000 });
      await waitStatus(jordan, offlineQueued, 'sending');
      assert((await countWithBody(jordan, offlineIncoming)) === 0, 'cannot have the incoming message yet');

      await setAndroidOffline(false);
      await until('queued message on iPhone', async () => (await countWithBody(maya, offlineQueued)) === 1, 15000);
      await until('missed message caught up on Android', async () => (await countWithBody(jordan, offlineIncoming)) === 1, 15000);
      await waitStatus(jordan, offlineQueued, 'read', 10000);
      await tid(jordan, 'connection-status').waitFor({ state: 'hidden', timeout: 10000 });
      await sleep(1500);
      for (const [page, label] of [[maya, 'iPhone'], [jordan, 'Android']]) {
        assert((await countWithBody(page, offlineQueued)) === 1, `queued message duplicated on ${label}`);
        assert((await countWithBody(page, offlineIncoming)) === 1, `incoming message duplicated on ${label}`);
      }
      const stored = app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE body = ?').get(offlineQueued).n;
      assert(stored === 1, `server stored the queued message ${stored} times`);
    });

    await check('a stale chat-list snapshot does not wipe a newer unread badge', async () => {
      await tid(maya, 'back-button').click();
      await tid(maya, 'chats-screen').waitFor();
      listHold = { fetched: 0 };
      let release;
      listHold.gate = new Promise((r) => (release = r));
      await maya.reload(); // refreshes the list twice: on start and when the socket opens
      await tid(maya, 'chats-screen').waitFor();
      await until('socket connected', async () => (await tid(maya, 'connection-status').isHidden()) && listHold.fetched >= 1);
      await sleep(300);
      const body = 'Did you see the sunset pic?';
      await sendText(jordan, body);
      const badge = maya.locator(`[data-testid="conversation-item"][data-conversation-id="${dmId}"] [data-testid="unread-badge"]`);
      await until('badge 1 from the live message', async () => (await badge.count()) === 1 && (await text(badge)) === '1');
      listHold = null;
      release();
      for (let i = 0; i < 12; i++) {
        await sleep(50);
        assert((await badge.count()) === 1 && (await text(badge)) === '1', 'older snapshot reset the unread badge');
      }
      await openConversation(maya, dmId);
      await waitStatus(jordan, body, 'read');
    });

    await check('reload keeps the session and the history (iPhone)', async () => {
      const before = await tid(maya, 'message').count();
      await maya.reload();
      await tid(maya, 'chat-screen').waitFor();
      await until('history restored', async () => (await tid(maya, 'message').count()) === before);
      assert((await tid(maya, 'message-image').count()) === 1, 'photo still there');
      await until('photo loads after reload', () =>
        tid(maya, 'message-image').evaluate((el) => el.complete && el.naturalWidth > 0));
      for (const body of [msg1, msg2, reply, offlineIncoming, offlineQueued]) {
        assert((await countWithBody(maya, body)) === 1, `"${body}" once after reload`);
      }
      assert((await statusOf(maya, reply)) === 'read', 'status survives reload');
      // Opening a chat lands on the newest message even though a photo above it loads late.
      await sleep(300);
      const inView = await tid(maya, 'message').last().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const composer = document.querySelector('[data-testid="message-input"]').getBoundingClientRect();
        return r.height > 0 && r.bottom <= composer.top + 1;
      });
      assert(inView, 'newest message is not scrolled into view after the photo loaded');
    });

    await check('iPhone notch and home indicator: header and composer stay inside the safe area', async () => {
      const cdp = await iphone.context.newCDPSession(maya);
      const setInsets = (top, bottom) =>
        cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, bottom, left: 0, right: 0 } });
      try {
        await setInsets(47, 34);
      } catch {
        console.log('      (this Chromium cannot emulate safe-area insets; skipped)');
        return;
      }
      try {
        await sleep(200);
        const box = await maya.evaluate(() => {
          const r = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
          return { title: r('chat-title').top, back: r('back-button').top, input: r('message-input').bottom, send: r('send-button').bottom, vh: innerHeight };
        });
        assert(box.title >= 47 && box.back >= 47, `header under the notch: ${JSON.stringify(box)}`);
        assert(box.input <= box.vh - 34 && box.send <= box.vh - 34, `composer under the home indicator: ${JSON.stringify(box)}`);
      } finally {
        await setInsets(0, 0).catch(() => {});
        await cdp.detach().catch(() => {});
      }
    });

    await check('opening the on-screen keyboard keeps the newest message above the composer (iPhone)', async () => {
      const newestInView = () =>
        tid(maya, 'message').last().evaluate((el) => {
          const r = el.getBoundingClientRect();
          const composer = document.querySelector('[data-testid="message-input"]').getBoundingClientRect();
          return r.height > 0 && r.bottom <= composer.top + 1 && composer.bottom <= window.innerHeight + 1;
        });
      assert(await newestInView(), 'newest message not in view before the keyboard opens');
      const size = maya.viewportSize();
      await tid(maya, 'message-input').focus();
      await maya.setViewportSize({ width: size.width, height: size.height - 300 }); // keyboard up
      try {
        await until('newest message still in view', newestInView, 3000);
      } finally {
        await maya.setViewportSize(size);
      }
    });

    await check('logout clears the session; the next user on the device sees nothing of it', async () => {
      await tid(jordan, 'message-input').fill('draft only Jordan should ever see');
      await tid(jordan, 'back-button').click();
      await tid(jordan, 'settings-button').click();
      await tid(jordan, 'settings-screen').waitFor();
      await tid(jordan, 'logout-button').click();
      await tid(jordan, 'auth-screen').waitFor();
      const leftovers = await jordan.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tt.')));
      assert(leftovers.length === 0, `localStorage still has ${leftovers.join(', ')}`);
      assert(await tid(jordan, 'chats-screen').isHidden(), 'chat list hidden after logout');
      // Maya signs in on the same Android phone (no reload): her own messages are now "mine".
      await login(jordan, 'maya');
      await openConversation(jordan, dmId);
      await until('history for Maya on Android', async () => (await countWithBody(jordan, reply)) === 1);
      assert((await messagesWithBody(jordan, reply).getAttribute('data-mine')) === 'true', 'Maya owns her message on a second device');
      assert((await messagesWithBody(jordan, msg1).getAttribute('data-mine')) === 'false', "Jordan's message is not Maya's");
      assert((await tid(jordan, 'message-input').inputValue()) === '', "previous user's draft leaked into the composer");
      await tid(jordan, 'back-button').click();
      await tid(jordan, 'settings-button').click();
      await tid(jordan, 'logout-button').click();
      await tid(jordan, 'auth-screen').waitFor();
      await jordan.reload();
      await tid(jordan, 'auth-screen').waitFor();
      assert(await tid(jordan, 'chats-screen').isHidden(), 'still logged out after reload');
    });

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
