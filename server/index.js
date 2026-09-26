'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('./db');
const { Hub } = require('./ws');
const { PushService, loadVapidKeys } = require('./push');
const { createStaticHandler } = require('./static');
const { createHttpHandler } = require('./http');
const { RateLimiter } = require('./auth');
const { SmsService, resolveSmsConfig, smsOptionsFromEnv } = require('./sms');

const DEFAULT_PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Starts TealTalk.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]    where the database, uploads and VAPID keys live (default ./data)
 * @param {number} [options.port]       0 picks a free port (default 3000)
 * @param {string} [options.host]       bind address (default 127.0.0.1)
 * @param {string} [options.publicDir]  static client root (default ../public)
 * @param {{max:number, windowMs:number}} [options.rateLimit]  login/register limit per IP
 * @param {number} [options.heartbeatMs] WebSocket ping interval
 * @param {Function} [options.sendPush]  (subscription, payloadString) => Promise; replaces web-push (tests)
 * @param {string} [options.vapidSubject]
 * @param {boolean} [options.trustProxy] use the last X-Forwarded-For hop as the client IP
 * @param {object} [options.log]        console-like logger
 * @param {object|null} [options.sms]   texting via Twilio: { accountSid, authToken, numbers: { "+1555...": "username" }
 *                                      (or the SMS_NUMBERS string), publicUrl, apiBase?, defaultCountryCode?, retryDelaysMs? }.
 *                                      Omitted: read from the environment. null: off.
 * @param {string|null} [options.signupCode] required on register when set. Omitted: SIGNUP_CODE from the environment.
 * @returns {Promise<{url:string, port:number, close:() => Promise<void>}>}
 */
async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
  const port = options.port ?? 3000;
  const host = options.host || '127.0.0.1';
  const log = options.log || console;
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  // Remove half-written uploads from a previous run.
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name.startsWith('.tmp-')) fs.rmSync(path.join(uploadsDir, name), { force: true });
  }

  const store = new Store(path.join(dataDir, 'tealtalk.db'));
  const vapid = loadVapidKeys(dataDir);
  const hub = new Hub({ store, heartbeatMs: options.heartbeatMs || 30000, log });
  const push = new PushService({
    store,
    hub,
    vapid,
    subject: options.vapidSubject || process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
    sendPush: options.sendPush,
    log,
  });
  const rateLimiter = new RateLimiter(options.rateLimit || { max: 20, windowMs: 10 * 60 * 1000 });
  const smsConfig = resolveSmsConfig(options.sms === undefined ? smsOptionsFromEnv(process.env) : options.sms);
  const sms = new SmsService({ config: smsConfig, store, hub, push, uploadsDir, log });
  const rawSignupCode = options.signupCode === undefined ? process.env.SIGNUP_CODE : options.signupCode;
  const signupCode = typeof rawSignupCode === 'string' && rawSignupCode.trim() ? rawSignupCode.trim() : null;
  for (const problem of smsConfig.problems) log.warn(`SMS config: ${problem}`);
  log.info(sms.describe());
  log.info(signupCode ? 'Signup requires a signup code' : 'Signup is open to anyone (set SIGNUP_CODE to require a code)');
  const handler = createHttpHandler({
    store,
    hub,
    push,
    sms,
    signupCode,
    staticHandler: createStaticHandler(options.publicDir || DEFAULT_PUBLIC_DIR),
    uploadsDir,
    rateLimiter,
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === '1',
    log,
  });

  const server = http.createServer(handler);
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    sms.close();
    await hub.close();
    rateLimiter.close();
    store.close();
    throw err;
  }

  const actualPort = server.address().port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  let closing = null;

  return {
    url: `http://${urlHost}:${actualPort}`,
    port: actualPort,
    // Exposed for tests and embedding; not part of the protocol.
    store,
    hub,
    push,
    sms,
    close() {
      if (!closing) {
        closing = (async () => {
          push.close();
          sms.close();
          rateLimiter.close();
          await hub.close();
          await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
          store.close();
        })();
      }
      return closing;
    },
  };
}

module.exports = { createApp };

if (require.main === module) {
  createApp({
    dataDir: process.env.DATA_DIR || './data',
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
  })
    .then((app) => {
      console.log(`TealTalk listening on ${process.env.HOST || '0.0.0.0'}:${app.port} (${app.url})`);
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        app.close().then(
          () => process.exit(0),
          () => process.exit(1)
        );
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      console.error('Failed to start TealTalk:', err && err.message);
      process.exit(1);
    });
}
