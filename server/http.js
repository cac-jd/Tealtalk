'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  HttpError,
  newId,
  setSecurityHeaders,
  sendJson,
  sendEmpty,
  readJson,
  readForm,
  parseTarget,
  hasControlChars,
} = require('./util');
const auth = require('./auth');
const { validateSubscription } = require('./push');
const { MAX_SMS_BODY_CHARS } = require('./sms');

const JSON_LIMIT = 64 * 1024;
const FORM_LIMIT = 64 * 1024; // Twilio webhooks are a few KB at most
const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BODY_CHARS = 4000;
const MAX_GROUP_MEMBERS = 256;
const MAX_TITLE_CHARS = 80;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9_]+$/;

// ---- validation helpers ---------------------------------------------------

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username || username.length < 3 || username.length > 24 || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Username must be 3-24 characters: letters, numbers or _');
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new HttpError(400, 'Password must be 8-200 characters');
  }
  return value;
}

function validateDisplayName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Display name must be a string');
  const name = value.trim();
  if (name.length < 1 || name.length > 40) throw new HttpError(400, 'Display name must be 1-40 characters');
  if (hasControlChars(name)) throw new HttpError(400, 'Display name contains invalid characters');
  return name;
}

function positiveInt(value, name) {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
}

// ---- handler factory --------------------------------------------------------

function validateTitle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Title must be a string');
  const t = value.trim();
  if (t.length > MAX_TITLE_CHARS) throw new HttpError(400, `Title must be at most ${MAX_TITLE_CHARS} characters`);
  if (hasControlChars(t)) throw new HttpError(400, 'Title contains invalid characters');
  return t || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function sendTwiml(res) {
  res.writeHead(200, {
    'Content-Type': 'text/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(TWIML_EMPTY),
    'Cache-Control': 'no-store',
  });
  res.end(TWIML_EMPTY);
}

function createHttpHandler({
  store,
  hub,
  push,
  sms,
  signupCode = null,
  staticHandler,
  uploadsDir,
  rateLimiter,
  trustProxy,
  log = console,
}) {
  function clientIp(req) {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.trim()) {
        const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function authenticate(req, query) {
    let token = auth.bearerToken(req);
    if (!token && query) {
      const q = query.get('token');
      if (q && q.length <= 512) token = q;
    }
    if (!token) throw new HttpError(401, 'Not logged in');
    const tokenHash = auth.hashToken(token);
    const user = store.getSessionUser(tokenHash);
    if (!user) throw new HttpError(401, 'Not logged in');
    return { user, tokenHash };
  }

  function rateLimit(req) {
    const r = rateLimiter.hit(clientIp(req));
    if (!r.ok) throw new HttpError(429, 'Too many attempts, try again later', { 'Retry-After': String(r.retryAfter) });
  }

  /** Loads a conversation the user belongs to: 404 if it does not exist, 403 if not a member. */
  function memberConversation(id, userId) {
    const conv = ID_RE.test(id) ? store.getConversationRow(id) : null;
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (!store.isMember(conv.id, userId)) throw new HttpError(403, 'You are not a member of this conversation');
    return conv;
  }

  function broadcastConversation(conv) {
    for (const memberId of store.memberIds(conv.id)) {
      if (!hub.isOnline(memberId)) continue;
      hub.sendToUser(memberId, { type: 'conversation', conversation: store.conversationFor(conv, memberId) });
    }
  }

  async function issueSession(res, status, user) {
    const { token, tokenHash } = auth.newToken();
    store.createSession(tokenHash, user.id);
    sendJson(res, status, { token, user });
  }

  // ---- route handlers -----------------------------------------------------

  async function register(req, res) {
    rateLimit(req);
    const body = await readJson(req, JSON_LIMIT);
    if (signupCode) {
      const given = typeof body.signupCode === 'string' ? body.signupCode.trim() : '';
      // Compare digests so the check takes the same time whatever was typed.
      if (!crypto.timingSafeEqual(sha256(given), sha256(signupCode))) {
        throw new HttpError(403, "That signup code isn't right.");
      }
    }
    const username = validateUsername(body.username);
    const password = validatePassword(body.password);
    let displayName = username;
    if (body.displayName !== undefined && body.displayName !== null) {
      if (typeof body.displayName !== 'string') throw new HttpError(400, 'Display name must be a string');
      if (body.displayName.trim()) displayName = validateDisplayName(body.displayName);
    }
    if (store.usernameExists(username)) throw new HttpError(409, 'That username is taken');
    const { salt, hash } = await auth.hashPassword(password);
    let user;
    try {
      user = store.createUser({ id: newId('u'), username, displayName, salt, hash, createdAt: Date.now() });
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) throw new HttpError(409, 'That username is taken');
      throw err;
    }
    await issueSession(res, 201, user);
  }

  async function login(req, res) {
    rateLimit(req);
    const body = await readJson(req, JSON_LIMIT);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw new HttpError(400, 'Username and password are required');
    }
    const username = normalizeUsername(body.username);
    const password = body.password.slice(0, 1024);
    const row = username && username.length <= 64 ? store.getUserAuthByUsername(username) : null;
    const ok = row
      ? await auth.verifyPassword(password, row.password_salt, row.password_hash)
      : await auth.burnPasswordCheck(password);
    if (!ok) throw new HttpError(401, 'Wrong username or password');
    await issueSession(res, 200, store.getUser(row.id));
  }

  async function logout(req, res) {
    const { tokenHash } = authenticate(req);
    store.deleteSession(tokenHash);
    hub.closeSession(tokenHash);
    sendEmpty(res, 204);
  }

  async function getMe(req, res) {
    const { user } = authenticate(req);
    sendJson(res, 200, { user, sms: sms.infoFor(user) });
  }

  async function patchMe(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const displayName = validateDisplayName(body.displayName);
    const updated = store.updateDisplayName(user.id, displayName);
    sendJson(res, 200, { user: updated });
    if (displayName !== user.displayName) {
      for (const convId of store.conversationIdsForUser(user.id)) {
        broadcastConversation(store.getConversationRow(convId));
      }
    }
  }

  async function searchUsers(req, res, query) {
    const { user } = authenticate(req);
    const q = (query.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { users: [] });
    if (q.length > 40) throw new HttpError(400, 'Search is too long');
    sendJson(res, 200, { users: store.searchUsers(q, user.id, 20) });
  }

  async function listConversations(req, res) {
    const { user } = authenticate(req);
    const conversations = store
      .conversationIdsForUser(user.id)
      .map((id) => store.conversationFor(id, user.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    sendJson(res, 200, { conversations });
  }

  async function createConversation(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    if (!Array.isArray(body.memberIds)) throw new HttpError(400, 'memberIds must be an array of user ids');
    if (body.memberIds.length > MAX_GROUP_MEMBERS) throw new HttpError(400, 'Too many members');
    const others = [];
    for (const id of body.memberIds) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'memberIds must be an array of user ids');
      if (id !== user.id && !others.includes(id)) others.push(id);
    }
    if (!others.length) throw new HttpError(400, 'Pick at least one other person');
    for (const id of others) {
      if (!store.getUser(id)) throw new HttpError(400, 'Unknown user in memberIds');
    }
    const title = validateTitle(body.title);
    const memberIds = [user.id, ...others];
    const isDm = others.length === 1 && title === null;
    let conv;
    let created = true;
    if (isDm) {
      const dmKey = [user.id, others[0]].sort().join(':');
      conv = store.findDm(dmKey);
      if (conv) {
        created = false;
      } else {
        try {
          conv = store.createConversation({
            id: newId('c'),
            title: null,
            isGroup: false,
            dmKey,
            createdBy: user.id,
            memberIds,
            createdAt: Date.now(),
          });
        } catch (err) {
          conv = store.findDm(dmKey); // lost a race with the other member
          if (!conv) throw err;
          created = false;
        }
      }
    } else {
      conv = store.createConversation({
        id: newId('c'),
        title,
        isGroup: true,
        dmKey: null,
        createdBy: user.id,
        memberIds,
        createdAt: Date.now(),
      });
    }
    sendJson(res, created ? 201 : 200, { conversation: store.conversationFor(conv, user.id) });
    if (created) {
      broadcastConversation(conv);
      // Members who just started sharing a conversation learn about each other's presence.
      for (const a of memberIds) {
        if (!hub.isOnline(a)) continue;
        for (const b of memberIds) {
          if (a !== b && hub.isOnline(b)) hub.sendToUser(a, { type: 'presence', userId: b, online: true });
        }
      }
    }
  }

  async function createSmsConversation(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const from = sms.numberForUser(user);
    if (!from) throw new HttpError(403, "Your account can't text phone numbers");
    const phone = sms.normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, "That doesn't look like a phone number");
    if (phone === from) throw new HttpError(400, "That's your own TealTalk texting number");
    const title = validateTitle(body.title);
    const { row, created } = sms.createConversation(user, phone, title);
    sendJson(res, created ? 201 : 200, { conversation: store.conversationFor(row, user.id) });
    if (created) broadcastConversation(row);
  }

  async function patchConversation(req, res, id) {
    const { user } = authenticate(req);
    const conv = memberConversation(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    if (!('title' in body)) throw new HttpError(400, 'title is required');
    const title = validateTitle(body.title);
    if (conv.sms_phone) {
      // Any title, or null to show the phone number.
    } else if (conv.is_group) {
      if (!title) throw new HttpError(400, 'Group name must be 1-80 characters');
    } else {
      throw new HttpError(400, "1:1 chats can't be renamed");
    }
    const updated = store.updateConversationTitle(conv.id, title);
    sendJson(res, 200, { conversation: store.conversationFor(updated, user.id) });
    if ((conv.title ?? null) !== title) broadcastConversation(updated);
  }

  async function getConversation(req, res, id) {
    const { user } = authenticate(req);
    const conv = memberConversation(id, user.id);
    sendJson(res, 200, { conversation: store.conversationFor(conv, user.id) });
  }

  async function listMessages(req, res, id, query) {
    const { user } = authenticate(req);
    const conv = memberConversation(id, user.id);
    const beforeRaw = query.get('before');
    const limitRaw = query.get('limit');
    const before = beforeRaw === null || beforeRaw === '' ? Number.MAX_SAFE_INTEGER : positiveInt(beforeRaw, 'before');
    const limit = limitRaw === null || limitRaw === '' ? 50 : Math.min(100, positiveInt(limitRaw, 'limit'));
    sendJson(res, 200, { messages: store.listMessages(conv.id, before, limit) });
  }

  async function postMessage(req, res, id) {
    const { user } = authenticate(req);
    const conv = memberConversation(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    const { clientId } = body;
    if (typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 100 || hasControlChars(clientId)) {
      throw new HttpError(400, 'clientId must be a string of 1-100 characters');
    }
    const existing = store.getMessageByClientId(user.id, clientId);
    if (existing) {
      if (existing.conversationId !== conv.id) throw new HttpError(409, 'clientId was already used in another conversation');
      sendJson(res, 200, { message: existing });
      return;
    }
    let text = '';
    if (body.body !== undefined && body.body !== null) {
      if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      text = body.body.trim();
      if (text.length > MAX_BODY_CHARS) throw new HttpError(400, `Messages can be at most ${MAX_BODY_CHARS} characters`);
    }
    let attachmentId = null;
    if (body.attachmentId !== undefined && body.attachmentId !== null) {
      if (typeof body.attachmentId !== 'string' || !ID_RE.test(body.attachmentId)) {
        throw new HttpError(400, 'attachmentId is invalid');
      }
      const att = store.getAttachment(body.attachmentId);
      if (!att || att.uploader_id !== user.id) throw new HttpError(400, 'Attachment not found');
      attachmentId = att.id;
    }
    if (!text && !attachmentId) throw new HttpError(400, 'Message is empty');
    if (conv.sms_phone) {
      if (conv.sms_owner_id !== user.id || !sms.numberForUser(user)) {
        throw new HttpError(403, "Your account can't text phone numbers");
      }
      if (text.length > MAX_SMS_BODY_CHARS) {
        throw new HttpError(400, `Text messages can be at most ${MAX_SMS_BODY_CHARS} characters`);
      }
    }

    let message;
    try {
      message = store.insertMessage({
        conversationId: conv.id,
        senderId: user.id,
        clientId,
        body: text,
        attachmentId,
        createdAt: Date.now(),
        smsStatus: conv.sms_phone ? 'queued' : null,
      });
    } catch (err) {
      // Concurrent retry with the same clientId.
      const dup = store.getMessageByClientId(user.id, clientId);
      if (dup && dup.conversationId === conv.id) {
        sendJson(res, 200, { message: dup });
        return;
      }
      throw err;
    }
    sendJson(res, 201, { message });

    const memberIds = store.memberIds(conv.id);
    hub.sendToUsers(memberIds, { type: 'message', message });
    push.notifyMessage(message, conv, user, memberIds);
    if (conv.sms_phone) sms.send(message, conv, user);
  }

  async function markRead(req, res, id) {
    const { user } = authenticate(req);
    const conv = memberConversation(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    const messageId = positiveInt(body.messageId, 'messageId');
    if (!store.messageInConversation(messageId, conv.id)) throw new HttpError(400, 'Message is not in this conversation');
    const moved = store.advanceRead(conv.id, user.id, messageId);
    sendEmpty(res, 204);
    if (moved) {
      hub.sendToUsers(store.memberIds(conv.id), { type: 'read', conversationId: conv.id, userId: user.id, messageId });
    }
  }

  async function uploadAttachment(req, res) {
    const { user } = authenticate(req);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ATTACHMENT_TYPES.has(mime)) throw new HttpError(415, 'Only JPEG, PNG, GIF or WebP images are allowed');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > ATTACHMENT_LIMIT) throw new HttpError(413, 'Image is larger than 10 MB');

    const id = newId('a');
    const tmp = path.join(uploadsDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    const size = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      let total = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        fs.rm(tmp, { force: true }, () => reject(err));
      };
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > ATTACHMENT_LIMIT) fail(new HttpError(413, 'Image is larger than 10 MB'));
      });
      req.on('aborted', () => fail(new HttpError(400, 'Upload aborted')));
      req.on('error', () => fail(new HttpError(400, 'Upload failed')));
      out.on('error', (err) => fail(err));
      out.on('finish', () => {
        if (!failed) resolve(total);
      });
      req.pipe(out);
    });
    if (size === 0) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(400, 'Empty upload');
    }
    fs.renameSync(tmp, path.join(uploadsDir, id));
    const attachment = store.insertAttachment({ id, uploaderId: user.id, mime, size, createdAt: Date.now() });
    sendJson(res, 201, { attachment });
  }

  async function getAttachment(req, res, id, query) {
    const { user } = authenticate(req, query);
    const att = ID_RE.test(id) ? store.getAttachment(id) : null;
    if (!att) throw new HttpError(404, 'Attachment not found');
    if (!store.canReadAttachment(att.id, user.id)) throw new HttpError(403, 'You cannot view this attachment');
    serveAttachment(req, res, att, 'private, max-age=31536000, immutable');
  }

  function serveAttachment(req, res, att, cacheControl) {
    const file = path.join(uploadsDir, att.id);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'Attachment not found');
    }
    const headers = {
      'Content-Type': att.mime,
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
      'Content-Disposition': 'inline',
      ETag: `"${att.id}"`,
    };
    if (req.headers['if-none-match'] === headers.ETag) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---- SMS (Twilio) -----------------------------------------------------------

  /** Parses a Twilio form post and checks X-Twilio-Signature against PUBLIC_URL + the request path. */
  async function twilioParams(req) {
    if (!sms.enabled) throw new HttpError(404, 'Texting is not set up on this server');
    const signature = req.headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !signature) throw new HttpError(403, 'Missing Twilio signature');
    const params = await readForm(req, FORM_LIMIT);
    if (!sms.verifyWebhook(req.url, params, signature)) throw new HttpError(403, 'Invalid Twilio signature');
    return params;
  }

  async function twilioIncoming(req, res) {
    const params = await twilioParams(req);
    await sms.handleInbound(params);
    sendTwiml(res);
  }

  async function twilioStatus(req, res) {
    const params = await twilioParams(req);
    sms.handleStatusCallback(params);
    sendTwiml(res);
  }

  /** Lets Twilio fetch the photo of an outgoing text via a short-lived signed link (no login). */
  async function smsMedia(req, res, id, query) {
    if (!sms.enabled || !ID_RE.test(id)) throw new HttpError(404, 'Not found');
    if (!sms.verifyMediaLink(id, query.get('exp'), query.get('sig'))) {
      throw new HttpError(403, 'This link is invalid or has expired');
    }
    const att = store.getAttachment(id);
    if (!att || !store.isOutgoingSmsAttachment(att.id)) throw new HttpError(404, 'Not found');
    serveAttachment(req, res, att, 'private, no-store');
  }

  async function pushSubscribe(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const sub = validateSubscription(body.subscription);
    if (!sub) throw new HttpError(400, 'Invalid push subscription');
    push.subscribe(user.id, sub);
    sendEmpty(res, 204);
  }

  async function pushUnsubscribe(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    if (typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 2048) {
      throw new HttpError(400, 'endpoint is required');
    }
    push.unsubscribe(user.id, body.endpoint);
    sendEmpty(res, 204);
  }

  // ---- router ---------------------------------------------------------------

  function methodNotAllowed(allowed) {
    return new HttpError(405, 'Method not allowed', { Allow: allowed.join(', ') });
  }

  async function routeApi(req, res, pathname, query) {
    const m = req.method;
    const pick = (table) => {
      const fn = table[m] || (m === 'HEAD' && table.GET);
      if (!fn) throw methodNotAllowed(Object.keys(table));
      return fn;
    };
    switch (pathname) {
      case '/api/health':
        return pick({ GET: () => sendJson(res, 200, { ok: true }) })();
      case '/api/register':
        return pick({ POST: register })(req, res);
      case '/api/login':
        return pick({ POST: login })(req, res);
      case '/api/logout':
        return pick({ POST: logout })(req, res);
      case '/api/me':
        return pick({ GET: getMe, PATCH: patchMe })(req, res);
      case '/api/users/search':
        return pick({ GET: searchUsers })(req, res, query);
      case '/api/conversations':
        return pick({ GET: listConversations, POST: createConversation })(req, res);
      case '/api/attachments':
        return pick({ POST: uploadAttachment })(req, res);
      case '/api/push/public-key':
        return pick({ GET: () => sendJson(res, 200, { publicKey: push.publicKey }) })();
      case '/api/push/subscribe':
        return pick({ POST: pushSubscribe })(req, res);
      case '/api/push/unsubscribe':
        return pick({ POST: pushUnsubscribe })(req, res);
      case '/api/sms/conversations':
        return pick({ POST: createSmsConversation })(req, res);
      case '/api/sms/twilio':
        return pick({ POST: twilioIncoming })(req, res);
      case '/api/sms/twilio/status':
        return pick({ POST: twilioStatus })(req, res);
      default:
        break;
    }
    let match = /^\/api\/conversations\/([^/]+)(?:\/(messages|read))?$/.exec(pathname);
    if (match) {
      const id = match[1];
      if (!match[2]) return pick({ GET: getConversation, PATCH: patchConversation })(req, res, id);
      if (match[2] === 'messages') {
        return pick({ GET: listMessages, POST: postMessage })(req, res, id, query);
      }
      return pick({ POST: markRead })(req, res, id);
    }
    match = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
    if (match) return pick({ GET: getAttachment })(req, res, match[1], query);
    match = /^\/api\/sms\/media\/([^/]+)$/.exec(pathname);
    if (match) return pick({ GET: smsMedia })(req, res, match[1], query);
    throw new HttpError(404, 'Not found');
  }

  function sendError(req, res, err) {
    let status = 500;
    let message = 'Internal server error';
    let headers = null;
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
      headers = err.headers;
    } else {
      log.error('Unhandled error:', err && err.stack ? err.stack : err);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const extra = { ...(headers || {}) };
    // If we did not consume the request body, do not keep the connection around.
    if (!req.complete) extra.Connection = 'close';
    sendJson(res, status, { error: message }, extra);
    if (!req.complete) req.resume();
  }

  return async function handle(req, res) {
    setSecurityHeaders(res);
    const { pathname, query } = parseTarget(req.url);
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await routeApi(req, res, pathname, query);
      } else if (pathname === '/ws') {
        sendJson(res, 426, { error: 'Use a WebSocket to connect here' }, { Upgrade: 'websocket' });
      } else {
        await staticHandler(req, res, pathname);
      }
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

module.exports = { createHttpHandler, ATTACHMENT_LIMIT, JSON_LIMIT };
