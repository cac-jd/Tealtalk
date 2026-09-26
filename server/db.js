'use strict';

const { DatabaseSync } = require('node:sqlite');

// Version 1: the original schema. Kept verbatim (CREATE ... IF NOT EXISTS) so that databases
// created before `user_version` was tracked (they report version 0) pass through it unchanged.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  is_group   INTEGER NOT NULL,
  dm_key     TEXT UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  read_up_to      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  client_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  attachment_id   TEXT REFERENCES attachments(id),
  created_at      INTEGER NOT NULL,
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_attachment ON messages(attachment_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
`;

// Version 2: texting phone numbers (SMS/MMS via Twilio).
// - messages.sender_id becomes nullable (null = sent by the outside phone number). SQLite can't drop
//   NOT NULL in place, so the table is rebuilt (https://sqlite.org/lang_altertable.html#otheralter).
// - messages gain the SMS delivery status/error and the Twilio message sid.
// - conversations gain the phone number and owning user of a text-message conversation.
// - sms_inbound remembers Twilio MessageSids already processed, so retried webhooks are ignored.
const MIGRATE_V2 = `
CREATE TABLE messages_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT REFERENCES users(id),
  client_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  attachment_id   TEXT REFERENCES attachments(id),
  created_at      INTEGER NOT NULL,
  sms_status      TEXT,
  sms_error       TEXT,
  sms_sid         TEXT,
  UNIQUE (sender_id, client_id)
);
INSERT INTO messages_v2 (id, conversation_id, sender_id, client_id, body, attachment_id, created_at)
  SELECT id, conversation_id, sender_id, client_id, body, attachment_id, created_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_v2 RENAME TO messages;
CREATE INDEX messages_conv ON messages(conversation_id, id);
CREATE INDEX messages_attachment ON messages(attachment_id);
CREATE UNIQUE INDEX messages_sms_sid ON messages(sms_sid) WHERE sms_sid IS NOT NULL;

ALTER TABLE conversations ADD COLUMN sms_phone TEXT;
ALTER TABLE conversations ADD COLUMN sms_owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX conversations_sms ON conversations(sms_owner_id, sms_phone) WHERE sms_phone IS NOT NULL;

CREATE TABLE sms_inbound (
  message_sid TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
`;

/** Ordered migrations; migration i brings the database to `user_version` i + 1. */
const MIGRATIONS = [
  { sql: SCHEMA_V1, rebuildsTables: false },
  { sql: MIGRATE_V2, rebuildsTables: true },
];
const SCHEMA_VERSION = MIGRATIONS.length;

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.sender_id, m.client_id, m.body, m.attachment_id, m.created_at,
  m.sms_status, m.sms_error, a.mime AS attachment_mime, a.size AS attachment_size`;

function userView(row) {
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

function messageView(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    body: row.body,
    attachment: row.attachment_id
      ? { id: row.attachment_id, mime: row.attachment_mime, size: row.attachment_size }
      : null,
    createdAt: row.created_at,
    sms: row.sms_status ? { status: row.sms_status, error: row.sms_error ?? null } : null,
  };
}

/** Thin data-access layer over node:sqlite. All SQL is parameterized. */
class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.statements = new Map();
    this.closed = false;
    try {
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  get schemaVersion() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }

  /**
   * Brings the database up to SCHEMA_VERSION, one migration per transaction. Migrations that
   * rebuild a table run with foreign keys off (as SQLite requires; the pragma is a no-op inside a
   * transaction) and verify `foreign_key_check` before committing.
   */
  migrate() {
    const current = this.schemaVersion;
    if (current > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${current} is newer than this TealTalk (${SCHEMA_VERSION}); upgrade TealTalk`);
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      const { sql, rebuildsTables } = MIGRATIONS[version];
      if (rebuildsTables) this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const seqTable = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
          const seqBefore = seqTable ? this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() : null;
          this.db.exec(sql);
          if (seqBefore) {
            // Keep message ids increasing past anything ever issued before the rebuild.
            this.db
              .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'messages'")
              .run(seqBefore.seq);
          }
          const problems = this.db.prepare('PRAGMA foreign_key_check').all();
          if (problems.length) throw new Error(`Migration to version ${version + 1} broke ${problems.length} foreign key(s)`);
          this.db.exec(`PRAGMA user_version = ${version + 1}`);
          this.db.exec('COMMIT');
        } catch (err) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw err;
        }
      } finally {
        if (rebuildsTables) this.db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  q(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // ---- users & sessions -------------------------------------------------

  createUser({ id, username, displayName, salt, hash, createdAt }) {
    this.q(
      `INSERT INTO users (id, username, display_name, password_salt, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, username, displayName, salt, hash, createdAt);
    return this.getUser(id);
  }

  getUser(id) {
    return userView(this.q('SELECT id, username, display_name FROM users WHERE id = ?').get(id));
  }

  getUserByUsername(username) {
    return userView(this.q('SELECT id, username, display_name FROM users WHERE username = ?').get(username));
  }

  getUserAuthByUsername(username) {
    return this.q('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  usernameExists(username) {
    return !!this.q('SELECT 1 AS x FROM users WHERE username = ?').get(username);
  }

  updateDisplayName(id, displayName) {
    this.q('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
    return this.getUser(id);
  }

  searchUsers(prefix, excludeId, limit) {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    return this.q(
      `SELECT id, username, display_name FROM users
       WHERE id <> ? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT ?`
    )
      .all(excludeId, escaped, escaped, limit)
      .map(userView);
  }

  createSession(tokenHash, userId) {
    this.q('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(tokenHash, userId, Date.now());
  }

  getSessionUser(tokenHash) {
    return userView(
      this.q(
        `SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      ).get(tokenHash)
    );
  }

  deleteSession(tokenHash) {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  // ---- conversations ----------------------------------------------------

  getConversationRow(id) {
    return this.q('SELECT * FROM conversations WHERE id = ?').get(id) || null;
  }

  findDm(dmKey) {
    return this.q('SELECT * FROM conversations WHERE dm_key = ?').get(dmKey) || null;
  }

  findSmsConversation(ownerId, phone) {
    return this.q('SELECT * FROM conversations WHERE sms_owner_id = ? AND sms_phone = ?').get(ownerId, phone) || null;
  }

  createConversation({ id, title, isGroup, dmKey, createdBy, memberIds, createdAt, smsPhone = null }) {
    return this.transaction(() => {
      this.q(
        `INSERT INTO conversations (id, title, is_group, dm_key, created_by, created_at, updated_at, sms_phone, sms_owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, title, isGroup ? 1 : 0, dmKey, createdBy, createdAt, createdAt, smsPhone, smsPhone ? createdBy : null);
      const ins = this.q('INSERT INTO members (conversation_id, user_id, position) VALUES (?, ?, ?)');
      memberIds.forEach((userId, i) => ins.run(id, userId, i));
      return this.getConversationRow(id);
    });
  }

  updateConversationTitle(id, title) {
    this.q('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
    return this.getConversationRow(id);
  }

  isMember(conversationId, userId) {
    return !!this.q('SELECT 1 AS x FROM members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
  }

  memberIds(conversationId) {
    return this.q('SELECT user_id FROM members WHERE conversation_id = ? ORDER BY position').all(conversationId).map((r) => r.user_id);
  }

  conversationIdsForUser(userId) {
    return this.q(
      `SELECT c.id FROM members m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.user_id = ? ORDER BY c.updated_at DESC, c.created_at DESC, c.id`
    )
      .all(userId)
      .map((r) => r.id);
  }

  /** User ids that share at least one conversation with userId (excluding userId). */
  contactIds(userId) {
    return this.q(
      `SELECT DISTINCT m2.user_id FROM members m1
       JOIN members m2 ON m2.conversation_id = m1.conversation_id
       WHERE m1.user_id = ? AND m2.user_id <> ?`
    )
      .all(userId, userId)
      .map((r) => r.user_id);
  }

  /** The Conversation shape as seen by `viewerId`. */
  conversationFor(convOrId, viewerId) {
    const conv = typeof convOrId === 'string' ? this.getConversationRow(convOrId) : convOrId;
    if (!conv) return null;
    const memberRows = this.q(
      `SELECT u.id, u.username, u.display_name, m.read_up_to FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.position`
    ).all(conv.id);
    const readUpTo = {};
    let myRead = 0;
    for (const r of memberRows) {
      readUpTo[r.id] = r.read_up_to;
      if (r.id === viewerId) myRead = r.read_up_to;
    }
    const lastMessage = this.lastMessage(conv.id);
    const unread = this.q(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id IS NOT ? AND id > ?'
    ).get(conv.id, viewerId, myRead).n;
    return {
      id: conv.id,
      title: conv.title ?? null,
      isGroup: !!conv.is_group,
      members: memberRows.map(userView),
      lastMessage,
      unreadCount: unread,
      readUpTo,
      sms: conv.sms_phone ? { phone: conv.sms_phone } : null,
      createdAt: conv.created_at,
      updatedAt: lastMessage ? lastMessage.createdAt : conv.created_at,
    };
  }

  // ---- messages ---------------------------------------------------------

  lastMessage(conversationId) {
    return messageView(
      this.q(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id
         WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`
      ).get(conversationId)
    );
  }

  getMessage(id) {
    return messageView(
      this.q(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id WHERE m.id = ?`
      ).get(id)
    );
  }

  getMessageByClientId(senderId, clientId) {
    return messageView(
      this.q(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id
         WHERE m.sender_id = ? AND m.client_id = ?`
      ).get(senderId, clientId)
    );
  }

  listMessages(conversationId, before, limit) {
    const rows = this.q(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id
       WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`
    ).all(conversationId, before, limit);
    return rows.reverse().map(messageView);
  }

  insertMessage({ conversationId, senderId, clientId, body, attachmentId, createdAt, smsStatus = null }) {
    return this.transaction(() => {
      const info = this.q(
        `INSERT INTO messages (conversation_id, sender_id, client_id, body, attachment_id, created_at, sms_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(conversationId, senderId, clientId, body, attachmentId, createdAt, smsStatus);
      this.q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId);
      return this.getMessage(Number(info.lastInsertRowid));
    });
  }

  /** Raw SMS state of a message: { id, conversation_id, sms_status, sms_error, sms_sid } or null. */
  getMessageSms(id) {
    return this.q('SELECT id, conversation_id, sms_status, sms_error, sms_sid FROM messages WHERE id = ?').get(id) || null;
  }

  getMessageIdBySmsSid(sid) {
    const row = this.q('SELECT id FROM messages WHERE sms_sid = ?').get(sid);
    return row ? row.id : null;
  }

  setMessageSmsSid(id, sid) {
    this.q('UPDATE messages SET sms_sid = ? WHERE id = ?').run(sid, id);
  }

  setMessageSmsStatus(id, status, error) {
    this.q('UPDATE messages SET sms_status = ?, sms_error = ? WHERE id = ?').run(status, error, id);
  }

  /** Records an inbound Twilio MessageSid. Returns false if it was already processed. */
  claimInboundSms(messageSid) {
    return this.q('INSERT OR IGNORE INTO sms_inbound (message_sid, received_at) VALUES (?, ?)').run(messageSid, Date.now()).changes > 0;
  }

  releaseInboundSms(messageSid) {
    this.q('DELETE FROM sms_inbound WHERE message_sid = ?').run(messageSid);
  }

  /**
   * True if the attachment is on a message a TealTalk user sent (and uploaded the photo for)
   * in their own text-message conversation: the only files Twilio may fetch.
   */
  isOutgoingSmsAttachment(attachmentId) {
    return !!this.q(
      `SELECT 1 AS x FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN attachments a ON a.id = m.attachment_id
       WHERE m.attachment_id = ? AND m.sender_id IS NOT NULL AND m.sender_id = a.uploader_id
         AND c.sms_phone IS NOT NULL AND c.sms_owner_id = m.sender_id
       LIMIT 1`
    ).get(attachmentId);
  }

  messageInConversation(messageId, conversationId) {
    return !!this.q('SELECT 1 AS x FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
  }

  /** Moves a member's read position forward only. Returns true if it moved. */
  advanceRead(conversationId, userId, messageId) {
    const info = this.q(
      'UPDATE members SET read_up_to = ? WHERE conversation_id = ? AND user_id = ? AND read_up_to < ?'
    ).run(messageId, conversationId, userId, messageId);
    return info.changes > 0;
  }

  // ---- attachments ------------------------------------------------------

  insertAttachment({ id, uploaderId, mime, size, createdAt }) {
    this.q('INSERT INTO attachments (id, uploader_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      uploaderId,
      mime,
      size,
      createdAt
    );
    return { id, mime, size };
  }

  getAttachment(id) {
    return this.q('SELECT * FROM attachments WHERE id = ?').get(id) || null;
  }

  canReadAttachment(attachmentId, userId) {
    const att = this.getAttachment(attachmentId);
    if (!att) return false;
    if (att.uploader_id === userId) return true;
    return !!this.q(
      `SELECT 1 AS x FROM messages msg JOIN members mem ON mem.conversation_id = msg.conversation_id
       WHERE msg.attachment_id = ? AND mem.user_id = ? LIMIT 1`
    ).get(attachmentId, userId);
  }

  // ---- push subscriptions ------------------------------------------------

  upsertPushSubscription({ endpoint, userId, p256dh, auth }, maxPerUser) {
    this.transaction(() => {
      this.q(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, created_at = excluded.created_at`
      ).run(endpoint, userId, p256dh, auth, Date.now());
      // Keep the newest `maxPerUser` subscriptions per user.
      this.q(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
      ).run(userId, userId, maxPerUser);
    });
  }

  deletePushSubscription(endpoint, userId) {
    this.q('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
  }

  deletePushSubscriptionByEndpoint(endpoint) {
    this.q('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  pushSubscriptionsFor(userId) {
    return this.q('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all(userId)
      .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }
}

module.exports = { Store, userView, messageView, SCHEMA_VERSION };
