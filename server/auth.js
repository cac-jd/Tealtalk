'use strict';

const crypto = require('node:crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns { salt, hash } as base64 strings. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return { salt: salt.toString('base64'), hash: key.toString('base64') };
}

async function verifyPassword(password, saltB64, hashB64) {
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'));
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

// Used to spend the same scrypt time on unknown usernames as on real ones.
const DUMMY_SALT = crypto.randomBytes(16).toString('base64');
const DUMMY_HASH = crypto.randomBytes(KEY_LEN).toString('base64');

async function burnPasswordCheck(password) {
  await verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
  return false;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** Token from `Authorization: Bearer <token>`, or null. */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{1,512})\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** Fixed-window-ish sliding log limiter: at most `max` hits per `windowMs` per key. */
class RateLimiter {
  constructor({ max = 20, windowMs = 10 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60 * 1000));
    this.sweeper.unref();
  }

  hit(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length >= this.max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    return { ok: true, retryAfter: 0 };
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      while (list.length && list[0] <= cutoff) list.shift();
      if (!list.length) this.hits.delete(key);
    }
  }

  close() {
    clearInterval(this.sweeper);
    this.hits.clear();
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  hashToken,
  newToken,
  bearerToken,
  RateLimiter,
};
