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
const { MediaSweeper } = require('./media');

const DEFAULT_PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** A non-negative number from an option or env string, else `fallback` (with a warning if it was garbage). */
function positiveNumber(value, fallback, name, log) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) {
    log.warn(`${name} must be a number >= 0; using ${fallback}`);
    return fallback;
  }
  return n;
}

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
 * @param {string|null} [options.signupCode] required on register when set. Omitted: SIGNUP_CODE from the environment.
 * @param {number} [options.maxUploadMb] largest photo/video/voice file. Omitted: MAX_UPLOAD_MB (default 250).
 * @param {number} [options.mediaRetentionDays] delete media older than this (0 = keep forever).
 *                                      Omitted: MEDIA_RETENTION_DAYS (default 0).
 * @param {number} [options.sweepIntervalMs] how often expired media and abandoned uploads are cleaned (default 1 hour)
 * @param {() => number} [options.now]  clock in ms (tests); defaults to Date.now
 * @returns {Promise<{url:string, port:number, close:() => Promise<void>}>}
 */
async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
  const port = options.port ?? 3000;
  const host = options.host || '127.0.0.1';
  const log = options.log || console;
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(dataDir, 'tealtalk.db'));
  // Remove half-written single-request uploads from a previous run, and resumable-upload files
  // whose upload no longer exists.
  for (const name of fs.readdirSync(uploadsDir)) {
    const orphanPart = name.startsWith('.part-') && !store.getUpload(name.slice('.part-'.length));
    if (name.startsWith('.tmp-') || orphanPart) fs.rmSync(path.join(uploadsDir, name), { force: true });
  }
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
  // Publishing a new key: at most 5 per user per day (docs/E2EE.md).
  const keysRateLimiter = new RateLimiter(options.keysRateLimit || { max: 5, windowMs: 24 * 60 * 60 * 1000 });
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const rawSignupCode = options.signupCode === undefined ? process.env.SIGNUP_CODE : options.signupCode;
  const signupCode = typeof rawSignupCode === 'string' && rawSignupCode.trim() ? rawSignupCode.trim() : null;
  const maxUploadMb = positiveNumber(options.maxUploadMb ?? process.env.MAX_UPLOAD_MB, 250, 'MAX_UPLOAD_MB', log) || 250;
  const retentionDays = positiveNumber(
    options.mediaRetentionDays ?? process.env.MEDIA_RETENTION_DAYS,
    0,
    'MEDIA_RETENTION_DAYS',
    log
  );
  log.info(signupCode ? 'Signup requires a signup code' : 'Signup is open to anyone (set SIGNUP_CODE to require a code)');
  log.info(
    retentionDays > 0
      ? `Photos, videos and voice messages are deleted from the server after ${retentionDays} days`
      : 'Photos, videos and voice messages are kept forever (set MEDIA_RETENTION_DAYS to limit storage)'
  );
  const sweeper = new MediaSweeper({
    store,
    uploadsDir,
    retentionDays,
    intervalMs: options.sweepIntervalMs || 60 * 60 * 1000,
    now,
    log,
  });
  // The first sweep runs right after start, then every sweepIntervalMs.
  setImmediate(() => sweeper.sweep());
  const handler = createHttpHandler({
    store,
    hub,
    push,
    signupCode,
    staticHandler: createStaticHandler(options.publicDir || DEFAULT_PUBLIC_DIR),
    uploadsDir,
    rateLimiter,
    keysRateLimiter,
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === '1',
    maxUploadBytes: Math.floor(maxUploadMb * 1024 * 1024),
    now,
    log,
  });

  const server = http.createServer(handler);
  server.headersTimeout = 30000;
  // Long enough for a 10 MB photo or a 5 MB upload chunk on a slow phone connection.
  server.requestTimeout = 300000;
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
    sweeper.close();
    await hub.close();
    rateLimiter.close();
    keysRateLimiter.close();
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
    sweeper,
    close() {
      if (!closing) {
        closing = (async () => {
          push.close();
          sweeper.close();
          rateLimiter.close();
          keysRateLimiter.close();
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
