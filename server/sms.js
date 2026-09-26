'use strict';

// Texting phone numbers that don't use TealTalk, through Twilio (SMS/MMS).
// See "Text messages to any phone number" in docs/PROTOCOL.md.
//
// Everything Twilio-specific lives here: configuration, phone number handling, webhook signature
// checks, signed media links, outbound sends (with retries), delivery status callbacks and
// incoming texts (with photo downloads). The HTTP layer only routes requests to this module.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const timers = require('node:timers/promises');
const { newId } = require('./util');

const DEFAULT_API_BASE = 'https://api.twilio.com';
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MEDIA_LIMIT = 10 * 1024 * 1024;
const MAX_INBOUND_MEDIA = 10; // Twilio sends MediaUrl0..MediaUrl9
const MAX_REDIRECTS = 5;
const MEDIA_LINK_TTL_S = 60 * 60;
const MAX_SMS_BODY_CHARS = 1600; // Twilio rejects longer message bodies (error 21617)
const MAX_INBOUND_BODY_CHARS = 4000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];
const REQUEST_TIMEOUT_MS = 20000;
const EARLY_STATUS_TTL_MS = 5 * 60 * 1000;
const MAX_EARLY_STATUSES = 500;
const SID_RE = /^[A-Za-z0-9]{2,64}$/;

// ---- phone numbers ----------------------------------------------------------------

/**
 * Normalizes a typed phone number to E.164 (`+15551234567`), or returns null if it isn't one.
 * Accepts `+` or `00` international prefixes and common separators (spaces, dashes, dots,
 * parentheses). Numbers without a prefix get `defaultCountryCode` (for `1`: 10 digits, or 11
 * starting with 1; for other codes one national trunk `0` is dropped).
 */
function normalizePhone(input, defaultCountryCode = '1') {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 40) return null;
  if (!/^\+?[\d\s().\- ]+$/.test(s)) return null;
  let international = false;
  if (s.startsWith('+')) {
    international = true;
    s = s.slice(1);
  }
  let digits = s.replace(/\D/g, '');
  if (!international && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }
  if (!international) {
    const cc = defaultCountryCode ? String(defaultCountryCode).replace(/\D/g, '') : '';
    if (!cc) return null;
    if (cc === '1') {
      if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
      if (digits.length !== 10) return null;
    } else if (digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    digits = cc + digits;
  }
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  // North American numbers are always exactly 10 digits and the area code never starts with 0/1.
  if (digits.startsWith('1') && !/^1[2-9]\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

/** The sender of an incoming text: an E.164 number, or the bare digits of a short code. */
function normalizeInboundSender(from) {
  if (typeof from !== 'string') return null;
  const s = from.trim();
  if (/^\d{3,8}$/.test(s)) return s; // short code
  if (!s.startsWith('+')) return null;
  return normalizePhone(s, null);
}

/** Display form: `(555) 123-4567` for North American numbers, E.164 otherwise. */
function formatPhone(phone) {
  if (typeof phone !== 'string') return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}

// ---- configuration ------------------------------------------------------------------

/** Parses `SMS_NUMBERS` ("+15551230000=chris,+15559870000=maya") or an object { phone: username }. */
function parseSmsNumbers(value) {
  const numbers = new Map(); // phone -> username
  const byUser = new Map(); // username -> phone (first one wins)
  const problems = [];
  let entries = [];
  if (typeof value === 'string') {
    entries = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
      });
  } else if (value && typeof value === 'object') {
    entries = value instanceof Map ? [...value] : Object.entries(value);
  }
  for (const [rawPhone, rawUser] of entries) {
    const phone = normalizePhone(String(rawPhone), null);
    const username = String(rawUser || '').trim().toLowerCase();
    if (!phone) {
      problems.push(`"${String(rawPhone).trim()}" is not an E.164 phone number (like +15551230000)`);
      continue;
    }
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      problems.push(`${phone} needs a TealTalk username (${phone}=username)`);
      continue;
    }
    if (numbers.has(phone)) {
      problems.push(`${phone} is listed more than once; using ${numbers.get(phone)}`);
      continue;
    }
    numbers.set(phone, username);
    if (byUser.has(username)) {
      problems.push(`${username} has more than one number; texts go out from ${byUser.get(username)}`);
    } else {
      byUser.set(username, phone);
    }
  }
  return { numbers, byUser, problems };
}

/** SMS options from the environment, in the shape createApp({ sms }) accepts. */
function smsOptionsFromEnv(env = process.env) {
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    numbers: env.SMS_NUMBERS,
    publicUrl: env.PUBLIC_URL,
    defaultCountryCode: env.SMS_DEFAULT_COUNTRY_CODE,
  };
}

/**
 * Validates SMS options. Texting is enabled only when the account sid, auth token, at least one
 * number and the public URL are all present. Never includes secrets in `missing`/`problems`.
 */
function resolveSmsConfig(options) {
  const o = options || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const accountSid = str(o.accountSid);
  const authToken = str(o.authToken);
  const { numbers, byUser, problems } = parseSmsNumbers(o.numbers);
  let publicUrl = str(o.publicUrl).replace(/\/+$/, '');
  if (publicUrl) {
    let u = null;
    try {
      u = new URL(publicUrl);
    } catch {
      /* invalid */
    }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.search || u.hash || u.username) {
      problems.push('PUBLIC_URL must be an https:// origin like https://tealtalk.example.com');
      publicUrl = '';
    } else if (u.protocol !== 'https:') {
      problems.push('PUBLIC_URL should use https:// (Twilio signs and fetches over https)');
    }
  }
  let apiBase = str(o.apiBase).replace(/\/+$/, '') || DEFAULT_API_BASE;
  try {
    if (!/^https?:$/.test(new URL(apiBase).protocol)) throw new Error('bad protocol');
  } catch {
    problems.push('the Twilio API base URL is invalid; using the default');
    apiBase = DEFAULT_API_BASE;
  }
  const ccRaw = o.defaultCountryCode === undefined || o.defaultCountryCode === null ? '1' : String(o.defaultCountryCode);
  const defaultCountryCode = ccRaw.replace(/\D/g, '');
  if (ccRaw.trim() && !/^\+?\d{1,3}$/.test(ccRaw.trim())) problems.push('SMS_DEFAULT_COUNTRY_CODE must be 1-3 digits');
  const retryDelaysMs = Array.isArray(o.retryDelaysMs) ? o.retryDelaysMs.slice(0, 5) : DEFAULT_RETRY_DELAYS_MS;

  const missing = [];
  if (!publicUrl) missing.push('PUBLIC_URL');
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!numbers.size) missing.push('SMS_NUMBERS');
  return {
    enabled: missing.length === 0,
    accountSid,
    authToken,
    numbers,
    byUser,
    publicUrl,
    apiBase,
    defaultCountryCode,
    retryDelaysMs,
    missing,
    problems,
  };
}

// ---- Twilio webhook signatures -----------------------------------------------------

/**
 * Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST param name+value,
 * sorted by name)). `params` is an array of [name, value] pairs (repeated names allowed).
 */
function twilioSignature(authToken, url, params) {
  const pairs = [...params].map(([k, v]) => [String(k), String(v)]);
  pairs.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  let data = url;
  for (const [k, v] of pairs) data += k + v;
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function validTwilioSignature(authToken, url, params, header) {
  if (!authToken || typeof header !== 'string' || !header || header.length > 128) return false;
  return safeEqual(twilioSignature(authToken, url, params), header.trim());
}

// ---- signed media links (so Twilio can fetch outgoing photos without a login) -------------

function mediaSignature(authToken, attachmentId, exp) {
  return crypto.createHmac('sha256', authToken).update(`${attachmentId}.${exp}`).digest('base64url');
}

function signMedia(authToken, attachmentId, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + MEDIA_LINK_TTL_S;
  return { exp, sig: mediaSignature(authToken, attachmentId, exp) };
}

function verifyMediaSignature(authToken, attachmentId, exp, sig, nowMs = Date.now()) {
  if (!authToken || typeof exp !== 'string' || typeof sig !== 'string') return false;
  if (!/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  const expS = Number(exp);
  const nowS = Math.floor(nowMs / 1000);
  if (expS < nowS || expS > nowS + MEDIA_LINK_TTL_S + 60) return false;
  return safeEqual(mediaSignature(authToken, attachmentId, exp), sig);
}

// ---- delivery status -----------------------------------------------------------------

const STATUS_MAP = {
  queued: 'queued',
  accepted: 'queued',
  sending: 'queued',
  scheduled: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  failed: 'failed',
  undelivered: 'failed',
  canceled: 'failed',
};
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2 };

/** Twilio MessageStatus -> TealTalk sms.status (or null for statuses we don't track). */
function mapTwilioStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, status) ? STATUS_MAP[status] : null;
}

const UNDELIVERABLE = "Couldn't be delivered to this number";
const ERROR_MESSAGES = {
  20003: "Texting isn't set up correctly on this server (Twilio rejected the credentials)",
  21211: "That isn't a valid phone number",
  21408: "Texting this country isn't turned on for this TealTalk server",
  21606: "This TealTalk number can't send texts",
  21610: 'This number has opted out (they replied STOP)',
  21612: "This number can't be texted from this TealTalk number",
  21614: "This number can't receive text messages",
  21617: 'The message is too long',
  30001: 'Too many texts queued, try again later',
  30002: "Texting isn't set up correctly on this server (Twilio account suspended)",
  30003: UNDELIVERABLE,
  30004: 'This number is blocking your texts',
  30005: UNDELIVERABLE,
  30006: UNDELIVERABLE,
  30007: 'The carrier blocked this text as spam',
  30008: "Couldn't be delivered (unknown carrier error)",
  30019: 'The photo is too big for a text message',
  30032: 'Blocked: the TealTalk number is a toll-free number that is not verified yet',
  30034: 'Blocked: the TealTalk number is not registered for US texting (A2P 10DLC)',
  11200: "The carrier couldn't fetch the photo",
  12300: "The carrier couldn't fetch the photo",
};

/** Human readable text for a Twilio error code (fallback: `fallback`, or a generic message). */
function smsErrorMessage(code, fallback) {
  const n = Number(code);
  if (Number.isInteger(n) && ERROR_MESSAGES[n]) return ERROR_MESSAGES[n];
  if (fallback) return String(fallback).slice(0, 300);
  return Number.isInteger(n) && n > 0 ? `Couldn't be delivered (error ${n})` : "Couldn't be delivered";
}

// ---- the service -----------------------------------------------------------------------

function paramsObject(pairs) {
  const out = Object.create(null);
  for (const [k, v] of pairs) if (!(k in out)) out[k] = v;
  return out;
}

class SmsService {
  /**
   * @param {object} deps
   * @param {ReturnType<typeof resolveSmsConfig>} deps.config
   */
  constructor({ config, store, hub, push, uploadsDir, log = console }) {
    this.config = config;
    this.store = store;
    this.hub = hub;
    this.push = push;
    this.uploadsDir = uploadsDir;
    this.log = log;
    this.closed = false;
    this.abort = new AbortController();
    this.pending = new Set();
    this.earlyStatuses = new Map(); // Twilio sid -> { params, at }, for callbacks that beat our POST response
    this.basicAuth = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
    this.apiOrigin = config.enabled ? new URL(config.apiBase).origin : null;
  }

  get enabled() {
    return this.config.enabled;
  }

  /** The Twilio number a TealTalk user texts from, or null if they can't text. */
  numberForUser(user) {
    if (!this.enabled || !user) return null;
    return this.config.byUser.get(user.username) || null;
  }

  /** The `sms` field of GET /api/me. */
  infoFor(user) {
    const number = this.numberForUser(user);
    return { enabled: !!number, number };
  }

  normalizePhone(input) {
    return normalizePhone(input, this.config.defaultCountryCode);
  }

  /** Human readable startup summary. Never includes secrets. */
  describe() {
    const c = this.config;
    if (!c.enabled) {
      return `SMS texting is off (to turn it on, set ${c.missing.join(', ')})`;
    }
    const who = [...c.numbers].map(([phone, username]) => {
      const exists = this.store.usernameExists(username);
      return `${username} ${phone}${exists ? '' : ' (no account yet)'}`;
    });
    return `SMS texting is on via Twilio for: ${who.join(', ')}; webhooks at ${c.publicUrl}/api/sms/twilio`;
  }

  verifyWebhook(pathAndQuery, params, signatureHeader) {
    return validTwilioSignature(this.config.authToken, this.config.publicUrl + pathAndQuery, params, signatureHeader);
  }

  mediaUrl(attachmentId, nowMs = Date.now()) {
    const { exp, sig } = signMedia(this.config.authToken, attachmentId, nowMs);
    return `${this.config.publicUrl}/api/sms/media/${encodeURIComponent(attachmentId)}?exp=${exp}&sig=${sig}`;
  }

  verifyMediaLink(attachmentId, exp, sig, nowMs = Date.now()) {
    return this.enabled && verifyMediaSignature(this.config.authToken, attachmentId, exp, sig, nowMs);
  }

  // ---- fan-out helpers ----

  fanoutMessage(message) {
    this.hub.sendToUsers(this.store.memberIds(message.conversationId), { type: 'message', message });
  }

  broadcastConversation(conv) {
    for (const memberId of this.store.memberIds(conv.id)) {
      if (this.hub.isOnline(memberId)) {
        this.hub.sendToUser(memberId, { type: 'conversation', conversation: this.store.conversationFor(conv, memberId) });
      }
    }
  }

  track(promise) {
    const p = promise
      .catch((err) => {
        if (!this.closed) this.log.error('sms task failed:', err && err.stack ? err.stack : err);
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  /** Resolves when every in-flight send has settled (tests and shutdown). */
  async idle() {
    await new Promise((r) => setImmediate(r));
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  close() {
    this.closed = true;
    this.abort.abort();
    this.earlyStatuses.clear();
  }

  /**
   * Moves a message's SMS status forward (queued -> sent -> delivered), or to failed from any
   * state. `failed` and `received` are final. Fans out the updated message when it changed.
   */
  applyStatus(messageId, status, error = null) {
    if (this.closed || !status) return null;
    const row = this.store.getMessageSms(messageId);
    if (!row || !row.sms_status || row.sms_status === 'received' || row.sms_status === 'failed') return null;
    if (status !== 'failed' && !(STATUS_RANK[status] > STATUS_RANK[row.sms_status])) return null;
    this.store.setMessageSmsStatus(messageId, status, status === 'failed' ? error || "Couldn't be delivered" : null);
    const message = this.store.getMessage(messageId);
    this.fanoutMessage(message);
    return message;
  }

  // ---- outbound ----

  /** Starts sending a just-saved (status `queued`) message. Never throws; the result arrives as status updates. */
  send(message, conv, user) {
    const from = this.numberForUser(user);
    const params = new URLSearchParams();
    params.set('From', from);
    params.set('To', conv.sms_phone);
    if (message.body) params.set('Body', message.body);
    if (message.attachment) params.set('MediaUrl', this.mediaUrl(message.attachment.id));
    params.set('StatusCallback', `${this.config.publicUrl}/api/sms/twilio/status`);
    return this.track(this.deliver(message.id, params));
  }

  async deliver(messageId, params) {
    const url = `${this.config.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`;
    const delays = this.config.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      if (this.closed) return;
      let res;
      let text;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: this.basicAuth,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: params.toString(),
          redirect: 'error',
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        text = await res.text();
      } catch (err) {
        if (this.closed) return;
        if (attempt < delays.length) {
          this.log.warn(`sms send attempt ${attempt + 1} failed (${err && err.message}); retrying`);
          try {
            await timers.setTimeout(delays[attempt], undefined, { signal: this.abort.signal });
          } catch {
            return; // shutting down
          }
          continue;
        }
        this.log.warn(`sms send failed after ${attempt + 1} attempts:`, err && err.message);
        this.applyStatus(messageId, 'failed', "Couldn't reach the texting service. Try again.");
        return;
      }
      if (this.closed) return;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (res.ok && json && typeof json.sid === 'string' && SID_RE.test(json.sid)) {
        this.store.setMessageSmsSid(messageId, json.sid);
        const mapped = mapTwilioStatus(json.status);
        if (mapped) this.applyStatus(messageId, mapped, smsErrorMessage(json.error_code, json.error_message));
        const early = this.earlyStatuses.get(json.sid);
        if (early) {
          this.earlyStatuses.delete(json.sid);
          this.handleStatusCallback(early.params);
        }
        return;
      }
      const code = json && json.code;
      if (res.status === 401 || Number(code) === 20003) {
        this.log.error('Twilio rejected TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN (401); texts cannot be sent');
      } else {
        this.log.warn(`Twilio refused a text: HTTP ${res.status}${code ? ` code ${code}` : ''}`);
      }
      const fallback = (json && typeof json.message === 'string' && json.message) || `The texting service returned an error (${res.status})`;
      this.applyStatus(messageId, 'failed', smsErrorMessage(code, fallback));
      return;
    }
  }

  /** Delivery status callback (already signature-checked). */
  handleStatusCallback(pairs) {
    const p = Array.isArray(pairs) ? paramsObject(pairs) : pairs;
    const sid = p.MessageSid || p.SmsSid;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return;
    if (p.AccountSid && p.AccountSid !== this.config.accountSid) return;
    const status = mapTwilioStatus(p.MessageStatus || p.SmsStatus);
    if (!status) return;
    const messageId = this.store.getMessageIdBySmsSid(sid);
    if (!messageId) {
      // The callback can arrive before Twilio's answer to our POST; apply it once we know the sid.
      const now = Date.now();
      for (const [k, v] of this.earlyStatuses) if (now - v.at > EARLY_STATUS_TTL_MS) this.earlyStatuses.delete(k);
      if (this.earlyStatuses.size < MAX_EARLY_STATUSES) this.earlyStatuses.set(sid, { params: p, at: now });
      return;
    }
    this.applyStatus(messageId, status, status === 'failed' ? smsErrorMessage(p.ErrorCode, p.ErrorMessage) : null);
  }

  // ---- inbound ----

  /**
   * Incoming text webhook (already signature-checked). Saves the text (and photos) in the owner's
   * conversation with that number, then fans out. Returns { outcome } for logging/tests.
   * Never creates users: texts to numbers without a matching TealTalk account are dropped.
   */
  async handleInbound(pairs) {
    const p = paramsObject(pairs);
    if (p.AccountSid && p.AccountSid !== this.config.accountSid) return { outcome: 'ignored', reason: 'other account' };
    const to = normalizePhone(typeof p.To === 'string' ? p.To.trim() : '', null);
    const username = to ? this.config.numbers.get(to) : null;
    if (!username) {
      this.log.warn(`incoming text to ${to || 'an unknown number'}, which is not in SMS_NUMBERS; ignored`);
      return { outcome: 'ignored', reason: 'unknown To' };
    }
    const owner = this.store.getUserByUsername(username);
    if (!owner) {
      this.log.warn(`incoming text for ${username}, who has no TealTalk account yet; ignored`);
      return { outcome: 'ignored', reason: 'no such user' };
    }
    const from = normalizeInboundSender(p.From);
    if (!from) return { outcome: 'ignored', reason: 'bad From' };
    const sid = p.MessageSid || p.SmsMessageSid || p.SmsSid;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return { outcome: 'ignored', reason: 'bad MessageSid' };
    if (!this.store.claimInboundSms(sid)) return { outcome: 'duplicate' };

    try {
      const numMedia = Math.min(MAX_INBOUND_MEDIA, Math.max(0, Number.parseInt(p.NumMedia, 10) || 0));
      const attachments = [];
      let skipped = 0;
      for (let i = 0; i < numMedia; i++) {
        const url = p[`MediaUrl${i}`];
        if (typeof url !== 'string' || !url) continue;
        try {
          const att = await this.downloadMedia(url, p[`MediaContentType${i}`], owner.id);
          if (att) attachments.push(att);
          else skipped++;
        } catch (err) {
          if (this.closed) throw err;
          this.log.warn(`couldn't download a photo from an incoming text: ${err && err.message}`);
          skipped++;
        }
      }
      if (this.closed) throw new Error('shutting down');

      let body = typeof p.Body === 'string' ? p.Body.trim() : '';
      if (body.length > MAX_INBOUND_BODY_CHARS) body = body.slice(0, MAX_INBOUND_BODY_CHARS);
      if (skipped) {
        const note = skipped === 1 ? "[1 attachment TealTalk can't show]" : `[${skipped} attachments TealTalk can't show]`;
        body = body ? `${body}\n${note}` : note;
      }
      const parts = [];
      if (body || attachments.length) parts.push({ body, attachment: attachments[0] || null });
      for (const att of attachments.slice(1)) parts.push({ body: '', attachment: att });
      if (!parts.length) return { outcome: 'empty' };

      const { row: conv, created } = this.createConversation(owner, from, null);
      const now = Date.now();
      const messages = parts.map((part, i) =>
        this.store.insertMessage({
          conversationId: conv.id,
          senderId: null,
          clientId: i === 0 ? `twilio:${sid}` : `twilio:${sid}:${i}`,
          body: part.body,
          attachmentId: part.attachment ? part.attachment.id : null,
          createdAt: now,
          smsStatus: 'received',
        })
      );

      if (created) this.broadcastConversation(conv);
      for (const message of messages) this.fanoutMessage(message);
      this.push.notifyMessage(messages[0], conv, null, this.store.memberIds(conv.id), {
        title: conv.title || formatPhone(from),
      });
      return { outcome: 'saved', conversationId: conv.id, messages };
    } catch (err) {
      try {
        this.store.releaseInboundSms(sid); // let a Twilio retry try again
      } catch {
        /* store may be closed */
      }
      throw err;
    }
  }

  /** Finds or creates `owner`'s text conversation with `phone`. Returns { row, created }. */
  createConversation(owner, phone, title) {
    const existing = this.store.findSmsConversation(owner.id, phone);
    if (existing) return { row: existing, created: false };
    try {
      const row = this.store.createConversation({
        id: newId('c'),
        title,
        isGroup: false,
        dmKey: null,
        createdBy: owner.id,
        memberIds: [owner.id],
        createdAt: Date.now(),
        smsPhone: phone,
      });
      return { row, created: true };
    } catch (err) {
      const again = this.store.findSmsConversation(owner.id, phone);
      if (again) return { row: again, created: false };
      throw err;
    }
  }

  /**
   * Downloads one incoming MMS photo. Twilio media URLs need Basic auth and redirect to a CDN;
   * redirects are followed by hand so credentials are only ever sent to the Twilio API origin.
   * Returns the attachment, or null when it isn't a supported image type.
   */
  async downloadMedia(rawUrl, typeHint, ownerId) {
    const hint = typeof typeHint === 'string' ? typeHint.split(';')[0].trim().toLowerCase() : '';
    if (hint && !MEDIA_TYPES.has(hint)) return null;
    let url = new URL(rawUrl);
    if (url.origin !== this.apiOrigin) throw new Error(`media URL is not on ${this.apiOrigin}`);
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let res;
    for (let hop = 0; ; hop++) {
      const headers = url.origin === this.apiOrigin ? { Authorization: this.basicAuth } : {};
      res = await fetch(url, { headers, redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) throw new Error('too many or broken media redirects');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && next.origin !== this.apiOrigin) throw new Error('media redirect is not https');
      url = next;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`media fetch returned HTTP ${res.status}`);
    }
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!MEDIA_TYPES.has(mime)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MEDIA_LIMIT) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MEDIA_LIMIT) {
        await res.body.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
    if (!size) throw new Error('empty media');
    const id = newId('a');
    const tmp = path.join(this.uploadsDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    await fs.promises.writeFile(tmp, Buffer.concat(chunks, size), { flag: 'wx', mode: 0o600 });
    try {
      await fs.promises.rename(tmp, path.join(this.uploadsDir, id));
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    return this.store.insertAttachment({ id, uploaderId: ownerId, mime, size, createdAt: Date.now() });
  }
}

module.exports = {
  SmsService,
  resolveSmsConfig,
  smsOptionsFromEnv,
  parseSmsNumbers,
  normalizePhone,
  normalizeInboundSender,
  formatPhone,
  twilioSignature,
  validTwilioSignature,
  signMedia,
  verifyMediaSignature,
  mediaSignature,
  mapTwilioStatus,
  smsErrorMessage,
  MAX_SMS_BODY_CHARS,
  MEDIA_LINK_TTL_S,
};
