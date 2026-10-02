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
  parseTarget,
  hasControlChars,
} = require('./util');
const auth = require('./auth');
const { validateSubscription } = require('./push');
const { SNIFF_BYTES, baseMime, kindOf, matchesKind, parseRange, removeFiles, partFile } = require('./media');
const { E2EE_MIME, KEY_ID_RE, validateBundle, validateBackup, validateEnvelope, checkRecipients } = require('./e2ee');

const JSON_LIMIT = 64 * 1024;
// Messages, edits and reactions carry an envelope of up to 64 KB plus a few small fields.
const MESSAGE_JSON_LIMIT = 80 * 1024;
const ATTACHMENT_LIMIT = 10 * 1024 * 1024; // single-request uploads; bigger files use /api/uploads
const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_OPEN_UPLOADS = 5; // unfinished resumable uploads per user
const MAX_GROUP_MEMBERS = 256;
const MAX_RECIPIENTS = MAX_GROUP_MEMBERS + 1; // the creator plus everyone they added
const MAX_TITLE_CHARS = 80;
const MAX_MESSAGE_ATTACHMENTS = 20;
const MAX_KEY_LOOKUP = 100;
const MAX_DIMENSION = 100000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9_]+$/;

const TYPE_ERROR =
  'Only photos (JPEG, PNG, GIF, WebP), videos (MP4, MOV, WebM) and voice messages (M4A, AAC, MP3, WebM, Ogg) can be sent';
const MISMATCH_ERROR = "That file isn't the type it says it is";
const RELOAD_ERROR = 'Please reload TealTalk to get the encrypted version.';

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

function validateTitle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Title must be a string');
  const t = value.trim();
  if (t.length > MAX_TITLE_CHARS) throw new HttpError(400, `Title must be at most ${MAX_TITLE_CHARS} characters`);
  if (hasControlChars(t)) throw new HttpError(400, 'Title contains invalid characters');
  return t || null;
}

/**
 * clientIds go into the envelope's AAD, which joins fields with '|': only 1-64 letters, digits,
 * '-' and '_' are allowed, so a clientId can never smuggle in a separator.
 */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    throw new HttpError(400, 'clientId must be 1-64 letters, digits, - or _');
  }
  return clientId;
}

/**
 * Since v3 messages, edits and reactions are encrypted only. A request with plaintext fields (or
 * without an envelope) comes from an old copy of the app, which gets told to reload.
 */
function rejectPlaintext(body, plaintextFields) {
  for (const field of plaintextFields) {
    const v = body[field];
    if (v !== undefined && v !== null && v !== '') throw new HttpError(400, RELOAD_ERROR);
  }
  if (body.e2ee === undefined || body.e2ee === null) throw new HttpError(400, RELOAD_ERROR);
}

/** Optional whole number from JSON (number) or a query string (digits); null when absent. */
function optionalInt(value, name, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

/**
 * Streams a request body into `file` (opened with `flags`, writing from byte `start`).
 * Rejects with `tooBig(total)` as soon as more than `limit` bytes arrive. Leaves any partial file
 * for the caller to clean up. Resolves { total, head } where head is the first SNIFF_BYTES bytes.
 */
function receiveToFile(req, file, { flags, start = 0, limit, tooBig }) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags, start, mode: 0o600 });
    let total = 0;
    const headChunks = [];
    let headLen = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        fail(tooBig(total));
        return;
      }
      if (headLen < SNIFF_BYTES) {
        const part = chunk.subarray(0, SNIFF_BYTES - headLen);
        headChunks.push(part);
        headLen += part.length;
      }
    });
    req.on('aborted', () => fail(new HttpError(400, 'Upload aborted')));
    req.on('close', () => {
      if (!req.complete) fail(new HttpError(400, 'Upload aborted'));
    });
    req.on('error', () => fail(new HttpError(400, 'Upload failed')));
    out.on('error', (err) => fail(err));
    out.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ total, head: Buffer.concat(headChunks, headLen) });
    });
    req.pipe(out);
  });
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function mb(bytes) {
  const v = bytes / (1024 * 1024);
  return Number.isInteger(v) ? `${v} MB` : `${v.toFixed(1)} MB`;
}

/** Magic-byte check for plaintext media. Encrypted files are opaque bytes and skip it. */
function contentMatches(head, kind) {
  return kind === 'e2ee' || matchesKind(head, kind);
}

// ---- handler factory --------------------------------------------------------

function createHttpHandler({
  store,
  hub,
  push,
  signupCode = null,
  staticHandler,
  uploadsDir,
  rateLimiter,
  keysRateLimiter,
  trustProxy,
  maxUploadBytes = 250 * 1024 * 1024,
  now = Date.now,
  log = console,
}) {
  const smallUploadLimit = Math.min(ATTACHMENT_LIMIT, maxUploadBytes);
  // MAX_UPLOAD_MB is about the real file: an encrypted copy may be bigger by its GCM tags
  // (16 bytes per 256 KiB record, docs/E2EE.md "Files").
  const withTags = (n) => n + 16 * Math.max(1, Math.ceil(n / (256 * 1024)));
  const maxE2eeUploadBytes = withTags(maxUploadBytes);
  const smallE2eeUploadLimit = Math.min(withTags(ATTACHMENT_LIMIT), withTags(maxUploadBytes));
  const sizeLimit = (mime) => (mime === E2EE_MIME ? maxE2eeUploadBytes : maxUploadBytes);
  const busyUploads = new Set(); // resumable uploads with a chunk or completion in flight

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

  /**
   * Loads a conversation the user belongs to: 404 if it does not exist, 403 if not a member.
   * Returns { conv, visibleFrom } (the first message id this member may see).
   */
  function memberAccess(id, userId) {
    const conv = ID_RE.test(id) ? store.getConversationRow(id) : null;
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const membership = store.membership(conv.id, userId);
    if (!membership) throw new HttpError(403, 'You are not a member of this conversation');
    return { conv, visibleFrom: membership.visibleFrom };
  }

  /** A message in `conv` that this member can see (404 otherwise). Returns the raw row. */
  function visibleMessageRow(conv, visibleFrom, rawId) {
    const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : 0;
    const row = id > 0 ? store.getMessageRow(id) : null;
    if (!row || row.conversation_id !== conv.id || row.id < visibleFrom) throw new HttpError(404, 'Message not found');
    return row;
  }

  function broadcastConversation(conv) {
    for (const memberId of store.memberIds(conv.id)) {
      if (!hub.isOnline(memberId)) continue;
      hub.sendToUser(memberId, { type: 'conversation', conversation: store.conversationFor(conv, memberId) });
    }
  }

  /** Sends a new or changed message to every member allowed to see it. */
  function broadcastMessage(message) {
    hub.sendToUsers(store.memberIdsSeeing(message.conversationId, message.id), { type: 'message', message });
  }

  /** After a message's text or state changed, the replies quoting it changed too. */
  function broadcastRepliesTo(messageId) {
    for (const id of store.replyIdsTo(messageId)) broadcastMessage(store.getMessage(id));
  }

  /** People who just started sharing a conversation learn about each other's presence. */
  function introduce(newcomers, everyone) {
    for (const a of newcomers) {
      if (!hub.isOnline(a)) continue;
      for (const b of everyone) {
        if (a === b || !hub.isOnline(b)) continue;
        hub.sendToUser(a, { type: 'presence', userId: b, online: true });
        if (!newcomers.includes(b)) hub.sendToUser(b, { type: 'presence', userId: a, online: true });
      }
    }
  }

  function systemClientId() {
    return `system-${crypto.randomUUID()}`;
  }

  async function issueSession(res, status, user) {
    const { token, tokenHash } = auth.newToken();
    store.createSession(tokenHash, user.id);
    sendJson(res, status, { token, user });
  }

  // ---- auth & users -----------------------------------------------------------

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
    sendJson(res, 200, { user });
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

  // ---- conversations ------------------------------------------------------------

  async function listConversations(req, res) {
    const { user } = authenticate(req);
    const conversations = store
      .conversationIdsForUser(user.id)
      .map((id) => store.conversationFor(id, user.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    sendJson(res, 200, { conversations });
  }

  /** Validates a list of user ids: known users, deduplicated, never `excludeId`. */
  function validateUserIds(list, excludeId, field) {
    if (!Array.isArray(list)) throw new HttpError(400, `${field} must be an array of user ids`);
    if (list.length > MAX_GROUP_MEMBERS) throw new HttpError(400, 'Too many members');
    const ids = [];
    for (const id of list) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `${field} must be an array of user ids`);
      if (id !== excludeId && !ids.includes(id)) ids.push(id);
    }
    for (const id of ids) {
      if (!store.getUser(id)) throw new HttpError(400, `Unknown user in ${field}`);
    }
    return ids;
  }

  async function createConversation(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const others = validateUserIds(body.memberIds, user.id, 'memberIds');
    if (!others.length) throw new HttpError(400, 'Pick at least one other person');
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
            createdAt: now(),
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
        createdAt: now(),
      });
    }
    sendJson(res, created ? 201 : 200, { conversation: store.conversationFor(conv, user.id) });
    if (created) {
      broadcastConversation(conv);
      introduce(memberIds, memberIds);
    }
  }

  async function getConversation(req, res, id) {
    const { user } = authenticate(req);
    const { conv } = memberAccess(id, user.id);
    sendJson(res, 200, { conversation: store.conversationFor(conv, user.id) });
  }

  /** Renames a group (1-80 chars) and adds a `renamed` system message. */
  async function patchConversation(req, res, id) {
    const { user } = authenticate(req);
    const { conv } = memberAccess(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    if (!conv.is_group) throw new HttpError(400, "1:1 chats can't be renamed");
    if (!('title' in body)) throw new HttpError(400, 'title is required');
    const title = validateTitle(body.title);
    if (!title) throw new HttpError(400, 'Group name must be 1-80 characters');
    if ((conv.title ?? null) === title) {
      sendJson(res, 200, { conversation: store.conversationFor(conv, user.id) });
      return;
    }
    const message = store.renameConversation(conv.id, title, user.id, systemClientId(), now());
    const updated = store.getConversationRow(conv.id);
    sendJson(res, 200, { conversation: store.conversationFor(updated, user.id) });
    broadcastConversation(updated);
    broadcastMessage(message);
  }

  /** Any member adds people to a group; they see history from the `member_added` line on. */
  async function addMembers(req, res, id) {
    const { user } = authenticate(req);
    const { conv } = memberAccess(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    if (!conv.is_group) throw new HttpError(400, 'People can only be added to group chats');
    const requested = validateUserIds(body.userIds, user.id, 'userIds');
    if (!requested.length) throw new HttpError(400, 'Pick at least one person to add');
    const current = store.memberIds(conv.id);
    const added = requested.filter((uid) => !current.includes(uid));
    if (current.length + added.length > MAX_GROUP_MEMBERS + 1) throw new HttpError(400, 'Too many members');
    if (!added.length) {
      sendJson(res, 200, { conversation: store.conversationFor(conv, user.id) });
      return;
    }
    const message = store.addMembers(conv.id, added, user.id, systemClientId(), now());
    const updated = store.getConversationRow(conv.id);
    sendJson(res, 200, { conversation: store.conversationFor(updated, user.id) });
    broadcastConversation(updated);
    broadcastMessage(message);
    introduce(added, [...current, ...added]);
  }

  /** Leaves a group: a `member_left` line for the others, `conversation_removed` for me. */
  async function leaveConversation(req, res, id) {
    const { user } = authenticate(req);
    const { conv } = memberAccess(id, user.id);
    if (!conv.is_group) throw new HttpError(400, "You can't leave a 1:1 chat");
    const message = store.leaveConversation(conv.id, user.id, systemClientId(), now());
    sendEmpty(res, 204);
    hub.sendToUser(user.id, { type: 'conversation_removed', conversationId: conv.id });
    broadcastConversation(store.getConversationRow(conv.id));
    broadcastMessage(message);
  }

  // ---- messages -----------------------------------------------------------------

  async function listMessages(req, res, id, query) {
    const { user } = authenticate(req);
    const { conv, visibleFrom } = memberAccess(id, user.id);
    const beforeRaw = query.get('before');
    const limitRaw = query.get('limit');
    const before = beforeRaw === null || beforeRaw === '' ? Number.MAX_SAFE_INTEGER : positiveInt(beforeRaw, 'before');
    const limit = limitRaw === null || limitRaw === '' ? 50 : Math.min(100, positiveInt(limitRaw, 'limit'));
    sendJson(res, 200, { messages: store.listMessages(conv.id, before, limit, visibleFrom) });
  }

  const keysFor = (userIds) => store.currentKeys(userIds);

  /**
   * `attachmentIds` of a new encrypted message: at most 20 distinct files, each the sender's own
   * unexpired upload of type application/vnd.tealtalk.e2ee that no message carries yet.
   */
  function validateAttachmentIds(list, userId) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new HttpError(400, `attachmentIds must be a list of at most ${MAX_MESSAGE_ATTACHMENTS} files`);
    }
    const ids = [];
    for (const attId of list) {
      if (typeof attId !== 'string' || !ID_RE.test(attId)) throw new HttpError(400, 'attachmentIds is invalid');
      if (ids.includes(attId)) throw new HttpError(400, 'The same file is attached twice');
      const att = store.getAttachment(attId);
      if (!att || att.uploader_id !== userId) throw new HttpError(400, 'Attachment not found');
      if (att.mime !== E2EE_MIME) throw new HttpError(400, 'Only encrypted files can be attached');
      if (att.expired) throw new HttpError(400, 'That file has expired');
      if (store.attachmentInUse(att.id)) throw new HttpError(400, 'That file was already sent');
      ids.push(att.id);
    }
    return ids;
  }

  /** `{ clientId, e2ee, attachmentIds?, replyToId? }`: an encrypted message (docs/E2EE.md). */
  async function postMessage(req, res, id) {
    const { user } = authenticate(req);
    const { conv, visibleFrom } = memberAccess(id, user.id);
    const body = await readJson(req, MESSAGE_JSON_LIMIT);
    rejectPlaintext(body, ['body', 'attachmentId']);
    const clientId = validateClientId(body.clientId);
    const existing = store.getMessageByClientId(user.id, clientId);
    if (existing) {
      if (existing.conversationId !== conv.id) throw new HttpError(409, 'clientId was already used in another conversation');
      sendJson(res, 200, { message: existing });
      return;
    }
    const e2ee = validateEnvelope(body.e2ee, 'message', clientId, MAX_RECIPIENTS);
    const attachmentIds = validateAttachmentIds(body.attachmentIds, user.id);
    let replyToId = null;
    if (body.replyToId !== undefined && body.replyToId !== null) {
      const rid = positiveInt(body.replyToId, 'replyToId');
      const target = store.getMessageRow(rid);
      if (!target || target.conversation_id !== conv.id || target.id < visibleFrom) {
        throw new HttpError(400, 'You can only reply to a message in this conversation');
      }
      if (target.deleted_at !== null || target.system_type) throw new HttpError(400, "You can't reply to that message");
      replyToId = target.id;
    }
    // A new message is seen by every current member (its id is past everyone's visible_from).
    const memberIds = store.memberIds(conv.id);
    checkRecipients(e2ee, user.id, memberIds, keysFor);

    // No await between the checks above and this insert, so nothing can change in between.
    const message = store.insertMessage({
      conversationId: conv.id,
      senderId: user.id,
      clientId,
      body: '',
      e2ee,
      attachmentIds,
      replyToId,
      createdAt: now(),
    });
    sendJson(res, 201, { message });
    hub.sendToUsers(memberIds, { type: 'message', message });
    push.notifyMessage(message, conv, user, memberIds);
  }

  /** The message a reaction, edit or unsend acts on (visible to the caller). */
  function actionTarget(req, id, msgId) {
    const { user } = authenticate(req);
    const { conv, visibleFrom } = memberAccess(id, user.id);
    const row = visibleMessageRow(conv, visibleFrom, msgId);
    return { user, conv, row };
  }

  /** `{ clientId, e2ee }` with kind `reaction:<msgId>`, addressed to everyone who can see the message. */
  async function putReaction(req, res, id, msgId) {
    const { user, row } = actionTarget(req, id, msgId);
    const body = await readJson(req, MESSAGE_JSON_LIMIT);
    rejectPlaintext(body, ['emoji']);
    if (row.deleted_at !== null || row.system_type) throw new HttpError(400, "You can't react to that message");
    const clientId = validateClientId(body.clientId);
    const e2ee = validateEnvelope(body.e2ee, `reaction:${row.id}`, clientId, MAX_RECIPIENTS);
    checkRecipients(e2ee, user.id, store.memberIdsSeeing(row.conversation_id, row.id), keysFor);
    const changed = store.setReaction(row.id, user.id, e2ee, clientId, now());
    const message = store.getMessage(row.id);
    sendJson(res, 200, { message });
    if (changed) broadcastMessage(message);
  }

  async function deleteReaction(req, res, id, msgId) {
    const { user, row } = actionTarget(req, id, msgId);
    if (row.deleted_at !== null || row.system_type) throw new HttpError(400, "You can't react to that message");
    const changed = store.removeReaction(row.id, user.id);
    const message = store.getMessage(row.id);
    sendJson(res, 200, { message });
    if (changed) broadcastMessage(message);
  }

  /**
   * `{ clientId, e2ee }` with kind `edit:<msgId>`: replaces the envelope and sets editedAt. Sender
   * only, encrypted text messages only (the edit payload carries just the new text, so a message
   * with files would lose their keys), within 15 minutes.
   */
  async function editMessage(req, res, id, msgId) {
    const { user, row } = actionTarget(req, id, msgId);
    const body = await readJson(req, MESSAGE_JSON_LIMIT);
    if (row.sender_id !== user.id) throw new HttpError(403, 'You can only edit your own messages');
    rejectPlaintext(body, ['body']);
    if (row.deleted_at !== null || row.system_type) throw new HttpError(400, "That message can't be edited");
    if (row.e2ee === null) throw new HttpError(400, "Messages sent before encryption can't be edited");
    if (row.attachment_id || store.messageAttachmentIds(row.id).length) throw new HttpError(400, 'Only text messages can be edited');
    const clientId = validateClientId(body.clientId);
    const e2ee = validateEnvelope(body.e2ee, `edit:${row.id}`, clientId, MAX_RECIPIENTS);
    if (now() - row.created_at > EDIT_WINDOW_MS) throw new HttpError(409, 'Messages can only be edited for 15 minutes');
    checkRecipients(e2ee, user.id, store.memberIdsSeeing(row.conversation_id, row.id), keysFor);
    if (JSON.stringify(e2ee) === row.e2ee && clientId === row.e2ee_client_id) {
      sendJson(res, 200, { message: store.getMessage(row.id) });
      return;
    }
    const message = store.editMessage(row.id, e2ee, clientId, now());
    sendJson(res, 200, { message });
    broadcastMessage(message);
    // Replies quoting an encrypted message show only { id, senderId, deleted }: nothing to re-send.
  }

  async function unsendMessage(req, res, id, msgId) {
    const { user, row } = actionTarget(req, id, msgId);
    if (row.sender_id !== user.id) throw new HttpError(403, 'You can only unsend your own messages');
    if (row.system_type) throw new HttpError(400, "That message can't be unsent");
    if (row.deleted_at !== null) {
      sendJson(res, 200, { message: store.getMessage(row.id) });
      return;
    }
    if (now() - row.created_at > UNSEND_WINDOW_MS) throw new HttpError(409, 'Messages can only be unsent for 24 hours');
    removeFiles(uploadsDir, store.unsendMessage(row.id, now()));
    const message = store.getMessage(row.id);
    sendJson(res, 200, { message });
    broadcastMessage(message);
    broadcastRepliesTo(row.id);
  }

  async function markRead(req, res, id) {
    const { user } = authenticate(req);
    const { conv, visibleFrom } = memberAccess(id, user.id);
    const body = await readJson(req, JSON_LIMIT);
    const messageId = positiveInt(body.messageId, 'messageId');
    if (messageId < visibleFrom || !store.messageInConversation(messageId, conv.id)) {
      throw new HttpError(400, 'Message is not in this conversation');
    }
    const moved = store.advanceRead(conv.id, user.id, messageId);
    sendEmpty(res, 204);
    if (moved) {
      hub.sendToUsers(store.memberIds(conv.id), { type: 'read', conversationId: conv.id, userId: user.id, messageId });
    }
  }

  // ---- key directory -------------------------------------------------------------------

  /**
   * Whose public keys a user may look up: their own, anyone they share a conversation with, and
   * anyone they can find through user search. Search matches every account by username prefix
   * (that is how new chats start), so in practice this is any existing user; unknown ids look
   * exactly like users without keys.
   */
  function canSeeKeys(viewerId, targetId) {
    return viewerId === targetId || !!store.getUser(targetId);
  }

  /**
   * `{ bundle, backup }`: publish a new current key (old bundles stay readable).
   * - Re-sending the current keyId is a no-op 200.
   * - A keyId from the user's history that isn't current, or a createdAt that isn't newer than the
   *   current key's, is `409 { error: "key_rollback" }`: an old (maybe stolen) key never comes back.
   * - At most 5 key changes per user per 24 hours (429).
   */
  async function putKeys(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const own = store.getOwnKeys(user.id);
    const bundle = validateBundle(body.bundle, user.id, now(), { allowOld: !own });
    const backup = validateBackup(body.backup, bundle.keyId);
    if (own && own.bundle && own.bundle.keyId === bundle.keyId) {
      sendJson(res, 200, { bundle: own.bundle });
      return;
    }
    if (store.getBundle(user.id, bundle.keyId) || (own && own.bundle && bundle.createdAt <= own.bundle.createdAt)) {
      throw new HttpError(409, 'key_rollback');
    }
    const r = keysRateLimiter.hit(user.id, now());
    if (!r.ok) {
      throw new HttpError(429, 'Too many key changes today, try again later', { 'Retry-After': String(r.retryAfter) });
    }
    const result = store.putKeys(user.id, bundle, backup, now());
    if (result.rollback) throw new HttpError(409, 'key_rollback');
    sendJson(res, 200, { bundle: result.bundle });
    if (result.changed) {
      hub.sendToUsers([user.id, ...store.contactIds(user.id)], { type: 'keys', userId: user.id, bundle: result.bundle });
    }
  }

  async function getMyKeys(req, res) {
    const { user } = authenticate(req);
    const own = store.getOwnKeys(user.id);
    sendJson(res, 200, { bundle: own ? own.bundle : null, backup: own ? own.backup : null });
  }

  /** `?userIds=u1,u2` (at most 100): `{ keys: { u1: Bundle | null } }`, current bundles. */
  async function getKeys(req, res, query) {
    const { user } = authenticate(req);
    const raw = query.get('userIds');
    if (raw === null) throw new HttpError(400, 'userIds is required');
    const ids = [];
    for (const part of raw.split(',')) {
      const uid = part.trim();
      if (!uid) continue;
      if (!ID_RE.test(uid)) throw new HttpError(400, 'userIds must be a comma-separated list of user ids');
      if (!ids.includes(uid)) ids.push(uid);
      if (ids.length > MAX_KEY_LOOKUP) throw new HttpError(400, `At most ${MAX_KEY_LOOKUP} users at a time`);
    }
    const visible = ids.filter((uid) => canSeeKeys(user.id, uid));
    const current = store.currentKeys(visible);
    const keys = Object.create(null);
    for (const uid of ids) keys[uid] = current.has(uid) ? current.get(uid).bundle : null;
    sendJson(res, 200, { keys });
  }

  /** `/api/keys/:userId?keyId=`: a bundle that user published (current or older); current without keyId. */
  async function getUserKey(req, res, userId, query) {
    const { user } = authenticate(req);
    const keyId = query.get('keyId');
    if (keyId !== null && keyId !== '' && !KEY_ID_RE.test(keyId)) throw new HttpError(400, 'keyId is invalid');
    let bundle = null;
    if (ID_RE.test(userId) && canSeeKeys(user.id, userId)) {
      if (keyId) bundle = store.getBundle(userId, keyId);
      else bundle = store.currentKeys([userId]).get(userId)?.bundle ?? null;
    }
    if (!bundle) throw new HttpError(404, 'Key not found');
    sendJson(res, 200, { bundle });
  }

  // ---- media ------------------------------------------------------------------------

  /**
   * Validates optional media metadata (from a query string or JSON). Dimensions only apply to
   * photos and videos, durations to videos and voice messages. A thumbnail must be one of my own
   * photos. Encrypted files keep no metadata at all: it lives in the encrypted payload.
   */
  function mediaMeta(src, kind, userId) {
    if (kind === 'e2ee') return { width: null, height: null, durationMs: null, thumbnailId: null };
    const width = optionalInt(src.width, 'width', 1, MAX_DIMENSION);
    const height = optionalInt(src.height, 'height', 1, MAX_DIMENSION);
    const durationMs = optionalInt(src.durationMs, 'durationMs', 0, MAX_DURATION_MS);
    let thumbnailId = null;
    if (src.thumbnailId !== undefined && src.thumbnailId !== null && src.thumbnailId !== '') {
      if (kind === 'audio') throw new HttpError(400, 'Voice messages have no thumbnail');
      if (typeof src.thumbnailId !== 'string' || !ID_RE.test(src.thumbnailId)) throw new HttpError(400, 'thumbnailId is invalid');
      const thumb = store.getAttachment(src.thumbnailId);
      if (!thumb || thumb.uploader_id !== userId || thumb.kind !== 'image' || thumb.expired) {
        throw new HttpError(400, 'Thumbnail not found');
      }
      thumbnailId = thumb.id;
    }
    return {
      width: kind === 'audio' ? null : width,
      height: kind === 'audio' ? null : height,
      durationMs: kind === 'image' ? null : durationMs,
      thumbnailId,
    };
  }

  /** Small files in one request: the raw body, with the file's type as `Content-Type`. */
  async function uploadAttachment(req, res, query) {
    const { user } = authenticate(req);
    const mime = baseMime(req.headers['content-type']);
    const kind = kindOf(mime);
    if (!kind) throw new HttpError(415, TYPE_ERROR);
    const limit = mime === E2EE_MIME ? smallE2eeUploadLimit : smallUploadLimit;
    const tooBig = () => new HttpError(413, `Files over ${mb(smallUploadLimit)} need a resumable upload`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw tooBig();
    const meta = mediaMeta(Object.fromEntries(query), kind, user.id);

    const id = newId('a');
    const tmp = path.join(uploadsDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    let received;
    try {
      received = await receiveToFile(req, tmp, { flags: 'wx', limit, tooBig });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    if (received.total === 0) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(400, 'Empty upload');
    }
    if (!contentMatches(received.head, kind)) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(415, MISMATCH_ERROR);
    }
    fs.renameSync(tmp, path.join(uploadsDir, id));
    const attachment = store.insertAttachment({ id, uploaderId: user.id, mime, size: received.total, kind, ...meta, createdAt: now() });
    sendJson(res, 201, { attachment });
  }

  /** A resumable upload that belongs to the caller (404 unknown, 403 someone else's). */
  function ownUpload(req, id) {
    const { user } = authenticate(req);
    const upload = ID_RE.test(id) ? store.getUpload(id) : null;
    if (!upload) throw new HttpError(404, 'Upload not found');
    if (upload.user_id !== user.id) throw new HttpError(403, 'This upload belongs to someone else');
    return { user, upload };
  }

  function discardUpload(id) {
    store.deleteUpload(id);
    fs.rmSync(partFile(uploadsDir, id), { force: true });
  }

  async function startUpload(req, res) {
    const { user } = authenticate(req);
    const body = await readJson(req, JSON_LIMIT);
    const mime = typeof body.mime === 'string' ? baseMime(body.mime) : '';
    const kind = kindOf(mime);
    if (!kind) throw new HttpError(415, TYPE_ERROR);
    const { size } = body;
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'size must be a positive number of bytes');
    if (size > sizeLimit(mime)) throw new HttpError(413, `Files can be at most ${mb(maxUploadBytes)}`);
    // At most MAX_OPEN_UPLOADS unfinished uploads per person. A new one replaces the oldest idle
    // one, so abandoned uploads never lock anyone out for a day.
    const open = store.uploadIdsForUser(user.id);
    if (open.length >= MAX_OPEN_UPLOADS) {
      const excess = open.length - MAX_OPEN_UPLOADS + 1;
      const idle = open.filter((uid) => !busyUploads.has(uid));
      if (idle.length < excess) throw new HttpError(429, 'Too many uploads in progress; wait for one to finish');
      for (const uid of idle.slice(0, excess)) discardUpload(uid);
    }
    const id = newId('up');
    fs.writeFileSync(partFile(uploadsDir, id), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    store.createUpload({ id, userId: user.id, mime, kind, size, createdAt: now() });
    sendJson(res, 201, { uploadId: id, chunkSize: CHUNK_SIZE, received: 0 });
  }

  async function getUploadStatus(req, res, id) {
    const { upload } = ownUpload(req, id);
    sendJson(res, 200, { received: upload.received, size: upload.size });
  }

  async function putChunk(req, res, id) {
    const { upload } = ownUpload(req, id);
    const rawOffset = req.headers['upload-offset'];
    if (typeof rawOffset !== 'string' || !/^\d{1,15}$/.test(rawOffset.trim())) {
      throw new HttpError(400, 'Upload-Offset header must be a byte offset');
    }
    const offset = Number(rawOffset.trim());
    if (busyUploads.has(upload.id) || offset !== upload.received) {
      throw new HttpError(409, 'Upload offset does not match', null, { received: upload.received });
    }
    const limit = Math.min(CHUNK_SIZE, upload.size - offset);
    const tooBig = (total) =>
      total > CHUNK_SIZE
        ? new HttpError(413, `Chunks can be at most ${CHUNK_SIZE} bytes`)
        : new HttpError(400, 'Chunk goes past the end of the file');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw tooBig(declared);

    busyUploads.add(upload.id);
    try {
      let total;
      try {
        ({ total } = await receiveToFile(req, partFile(uploadsDir, upload.id), { flags: 'r+', start: offset, limit, tooBig }));
      } catch (err) {
        if (err && err.code === 'ENOENT') throw new HttpError(404, 'Upload not found');
        throw err;
      }
      if (total === 0) throw new HttpError(400, 'Empty chunk');
      if (!store.getUpload(upload.id)) throw new HttpError(404, 'Upload not found'); // swept meanwhile
      store.setUploadReceived(upload.id, offset + total);
      sendJson(res, 200, { received: offset + total });
    } finally {
      busyUploads.delete(upload.id);
    }
  }

  async function completeUpload(req, res, id) {
    const { user } = ownUpload(req, id);
    const body = await readJson(req, JSON_LIMIT);
    const upload = store.getUpload(id); // re-read: chunks may have landed while the body arrived
    if (!upload) throw new HttpError(404, 'Upload not found');
    if (busyUploads.has(upload.id) || upload.received !== upload.size) {
      throw new HttpError(409, 'The upload is not finished yet', null, { received: upload.received, size: upload.size });
    }
    const meta = mediaMeta(body, upload.kind, user.id);
    const part = partFile(uploadsDir, upload.id);
    let head;
    try {
      head = readHead(part);
    } catch {
      discardUpload(upload.id);
      throw new HttpError(404, 'Upload not found');
    }
    if (!contentMatches(head, upload.kind)) {
      discardUpload(upload.id);
      throw new HttpError(415, MISMATCH_ERROR);
    }
    const attId = newId('a');
    fs.truncateSync(part, upload.size);
    fs.renameSync(part, path.join(uploadsDir, attId));
    store.deleteUpload(upload.id);
    const attachment = store.insertAttachment({
      id: attId,
      uploaderId: user.id,
      mime: upload.mime,
      size: upload.size,
      kind: upload.kind,
      ...meta,
      createdAt: now(),
    });
    sendJson(res, 201, { attachment });
  }

  async function cancelUpload(req, res, id) {
    const { upload } = ownUpload(req, id);
    if (busyUploads.has(upload.id)) {
      throw new HttpError(409, 'A chunk is still being received', null, { received: upload.received });
    }
    discardUpload(upload.id);
    sendEmpty(res, 204);
  }

  async function getAttachment(req, res, id, query) {
    const { user } = authenticate(req, query);
    const att = ID_RE.test(id) ? store.getAttachment(id) : null;
    if (!att) throw new HttpError(404, 'Attachment not found');
    if (!store.canReadAttachment(att.id, user.id)) throw new HttpError(403, 'You cannot view this attachment');
    if (att.expired) throw new HttpError(410, 'This file has expired and was removed from the server');
    serveAttachment(req, res, att);
  }

  /** Streams an attachment, honouring conditional requests and a single byte range. */
  function serveAttachment(req, res, att) {
    const file = path.join(uploadsDir, att.id);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'Attachment not found');
    }
    const size = st.size;
    const etag = `"${att.id}"`;
    const lastModified = new Date(att.created_at).toUTCString();
    const headers = {
      'Content-Type': att.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    };
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers['if-range'];
    if (range && typeof ifRange === 'string' && ifRange.trim() !== etag && ifRange.trim() !== lastModified) range = null;
    if (range && range.unsatisfiable) {
      throw new HttpError(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    }
    let status = 200;
    let streamOpts;
    if (range) {
      status = 206;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      streamOpts = { start: range.start, end: range.end };
    } else {
      headers['Content-Length'] = size;
    }
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, streamOpts);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---- push ---------------------------------------------------------------------------

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
        return pick({ POST: uploadAttachment })(req, res, query);
      case '/api/uploads':
        return pick({ POST: startUpload })(req, res);
      case '/api/keys':
        return pick({ GET: getKeys, PUT: putKeys })(req, res, query);
      case '/api/keys/me':
        return pick({ GET: getMyKeys })(req, res);
      case '/api/push/public-key':
        return pick({ GET: () => sendJson(res, 200, { publicKey: push.publicKey }) })();
      case '/api/push/subscribe':
        return pick({ POST: pushSubscribe })(req, res);
      case '/api/push/unsubscribe':
        return pick({ POST: pushUnsubscribe })(req, res);
      default:
        break;
    }
    let match = /^\/api\/conversations\/([^/]+)(?:\/(messages|read|members))?$/.exec(pathname);
    if (match) {
      const id = match[1];
      if (!match[2]) return pick({ GET: getConversation, PATCH: patchConversation })(req, res, id);
      if (match[2] === 'messages') return pick({ GET: listMessages, POST: postMessage })(req, res, id, query);
      if (match[2] === 'members') return pick({ POST: addMembers })(req, res, id);
      return pick({ POST: markRead })(req, res, id);
    }
    match = /^\/api\/conversations\/([^/]+)\/members\/me$/.exec(pathname);
    if (match) return pick({ DELETE: leaveConversation })(req, res, match[1]);
    match = /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)(\/reaction)?$/.exec(pathname);
    if (match) {
      if (match[3]) return pick({ PUT: putReaction, DELETE: deleteReaction })(req, res, match[1], match[2]);
      return pick({ PATCH: editMessage, DELETE: unsendMessage })(req, res, match[1], match[2]);
    }
    match = /^\/api\/uploads\/([^/]+)(\/complete)?$/.exec(pathname);
    if (match) {
      if (match[2]) return pick({ POST: completeUpload })(req, res, match[1]);
      return pick({ GET: getUploadStatus, PUT: putChunk, DELETE: cancelUpload })(req, res, match[1]);
    }
    match = /^\/api\/keys\/([^/]+)$/.exec(pathname);
    if (match) return pick({ GET: getUserKey })(req, res, match[1], query);
    match = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
    if (match) return pick({ GET: getAttachment })(req, res, match[1], query);
    throw new HttpError(404, 'Not found');
  }

  function sendError(req, res, err) {
    let status = 500;
    let message = 'Internal server error';
    let headers = null;
    let fields = null;
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
      headers = err.headers;
      fields = err.fields;
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
    sendJson(res, status, { ...(fields || {}), error: message }, extra);
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

module.exports = {
  createHttpHandler,
  ATTACHMENT_LIMIT,
  JSON_LIMIT,
  MESSAGE_JSON_LIMIT,
  RELOAD_ERROR,
  CHUNK_SIZE,
  MAX_OPEN_UPLOADS,
  EDIT_WINDOW_MS,
  UNSEND_WINDOW_MS,
};
