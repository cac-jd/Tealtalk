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

// Version 3: texting phone numbers was dropped (the owner ruled out paid SMS gateways), and
// full-quality messaging arrived (docs/PROTOCOL.md, "Full-quality messaging (v2)").
// - The SMS columns, indexes and the sms_inbound table go. Indexes that name a column must be
//   dropped before the column (https://sqlite.org/lang_altertable.html#altertabdropcol).
//   messages.sender_id stays nullable: old texts from outside numbers keep a null sender.
// - attachments gain kind (image/video/audio), dimensions, duration, a thumbnail and `expired`
//   (MEDIA_RETENTION_DAYS removed the file).
// - messages gain reply_to_id, edited_at, deleted_at (unsent) and system messages
//   (system_type + system_data JSON { userIds, title }).
// - members.visible_from: the first message id a member may see (0 = everything). Set when
//   someone is added to an existing group so they only see history from when they joined.
// - reactions: at most one per user per message.
// - uploads: resumable chunked uploads in progress (the bytes live in uploads/.part-<id>).
const MIGRATE_V3 = `
DROP INDEX IF EXISTS messages_sms_sid;
ALTER TABLE messages DROP COLUMN sms_sid;
ALTER TABLE messages DROP COLUMN sms_status;
ALTER TABLE messages DROP COLUMN sms_error;
DROP INDEX IF EXISTS conversations_sms;
ALTER TABLE conversations DROP COLUMN sms_phone;
ALTER TABLE conversations DROP COLUMN sms_owner_id;
DROP TABLE IF EXISTS sms_inbound;

ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE attachments ADD COLUMN width INTEGER;
ALTER TABLE attachments ADD COLUMN height INTEGER;
ALTER TABLE attachments ADD COLUMN duration_ms INTEGER;
ALTER TABLE attachments ADD COLUMN thumbnail_id TEXT;
ALTER TABLE attachments ADD COLUMN expired INTEGER NOT NULL DEFAULT 0;
CREATE INDEX attachments_thumbnail ON attachments(thumbnail_id) WHERE thumbnail_id IS NOT NULL;
CREATE INDEX attachments_live ON attachments(created_at) WHERE expired = 0;

ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN system_type TEXT;
ALTER TABLE messages ADD COLUMN system_data TEXT;
CREATE INDEX messages_reply ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

ALTER TABLE members ADD COLUMN visible_from INTEGER NOT NULL DEFAULT 0;

CREATE TABLE reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE uploads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  received   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX uploads_user ON uploads(user_id);
CREATE INDEX uploads_created ON uploads(created_at);
`;

// Version 4: end-to-end encryption (docs/E2EE.md).
// - key_bundles: every public key bundle a user ever published (kept read-only so old messages
//   still verify). user_keys: each user's current keyId and encrypted private-key backup.
// - messages.e2ee: the encrypted envelope JSON (null for legacy plaintext and system messages);
//   messages.e2ee_client_id: the clientId the current envelope was made with (the message's own
//   clientId, or the clientId sent with the latest edit).
// - message_attachments: the opaque encrypted files of an encrypted message, in order. An
//   attachment can belong to only one message (UNIQUE).
// - reactions gain e2ee + client_id. Encrypted reactions store emoji = ''. Rows from before v4
//   keep their plaintext emoji and are shown as `legacyReactions`.
const MIGRATE_V4 = `
CREATE TABLE key_bundles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id      TEXT NOT NULL,
  bundle      TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key_id)
);

CREATE TABLE user_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_id     TEXT NOT NULL,
  backup     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, key_id) REFERENCES key_bundles(user_id, key_id)
);

ALTER TABLE messages ADD COLUMN e2ee TEXT;
ALTER TABLE messages ADD COLUMN e2ee_client_id TEXT;

CREATE TABLE message_attachments (
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (message_id, position)
);

ALTER TABLE reactions ADD COLUMN e2ee TEXT;
ALTER TABLE reactions ADD COLUMN client_id TEXT;

CREATE INDEX attachments_created ON attachments(created_at);
`;

/** Ordered migrations; migration i brings the database to `user_version` i + 1. */
const MIGRATIONS = [
  { sql: SCHEMA_V1, rebuildsTables: false },
  { sql: MIGRATE_V2, rebuildsTables: true },
  { sql: MIGRATE_V3, rebuildsTables: false },
  { sql: MIGRATE_V4, rebuildsTables: false },
];
const SCHEMA_VERSION = MIGRATIONS.length;

const REPLY_PREVIEW_CHARS = 200;

// Every message query selects these columns from MESSAGE_FROM.
const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.sender_id, m.client_id, m.body, m.attachment_id, m.created_at,
  m.reply_to_id, m.edited_at, m.deleted_at, m.system_type, m.system_data, m.e2ee, m.e2ee_client_id,
  a.mime AS a_mime, a.size AS a_size, a.kind AS a_kind, a.width AS a_width, a.height AS a_height,
  a.duration_ms AS a_duration_ms, a.thumbnail_id AS a_thumbnail_id, a.expired AS a_expired,
  r.sender_id AS r_sender_id, r.body AS r_body, r.deleted_at AS r_deleted_at, ra.kind AS r_kind`;
const MESSAGE_FROM = `
  messages m
  LEFT JOIN attachments a ON a.id = m.attachment_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN attachments ra ON ra.id = r.attachment_id`;

function userView(row) {
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

/** Public Attachment shape from an `attachments` row. */
function attachmentView(row) {
  if (!row) return null;
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    thumbnailId: row.thumbnail_id ?? null,
    expired: !!row.expired,
  };
}

function firstChars(text, n) {
  const chars = Array.from(text || '');
  return chars.length <= n ? chars.join('') : chars.slice(0, n).join('');
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const NO_EXTRAS = { reactions: {}, reactionClientIds: {}, legacyReactions: {}, attachments: [] };

/**
 * The Message shape. Encrypted messages (docs/E2EE.md, "Data shape changes") carry `e2ee`,
 * `e2eeClientId` (the clientId the envelope's AAD uses: the message's clientId, or the edit's),
 * `attachments: [{ id, size, expired }]`, `replyTo: { id, senderId, deleted }`, body "" and
 * attachment null. Legacy plaintext messages keep their v2 fields with `e2ee: null`.
 * `reactions` is { userId: Envelope } with `reactionClientIds` { userId: clientId }; plaintext
 * reactions from before v3 are listed in `legacyReactions` { emoji: [userId] }.
 */
function messageView(row, extras = NO_EXTRAS) {
  if (!row) return null;
  const encrypted = row.e2ee !== null && row.e2ee !== undefined;
  let replyTo = null;
  if (row.reply_to_id !== null && row.reply_to_id !== undefined) {
    const deleted = row.r_deleted_at !== null && row.r_deleted_at !== undefined;
    replyTo = encrypted
      ? { id: row.reply_to_id, senderId: row.r_sender_id ?? null, deleted }
      : {
          id: row.reply_to_id,
          senderId: row.r_sender_id ?? null,
          body: deleted ? '' : firstChars(row.r_body, REPLY_PREVIEW_CHARS),
          attachmentKind: deleted ? null : row.r_kind ?? null,
          deleted,
        };
  }
  let system = null;
  if (row.system_type) {
    const data = parseJson(row.system_data || '{}', {}) || {};
    system = {
      type: row.system_type,
      userIds: Array.isArray(data.userIds) ? data.userIds : [],
      title: typeof data.title === 'string' ? data.title : null,
    };
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    body: row.body,
    attachment: row.attachment_id
      ? {
          id: row.attachment_id,
          mime: row.a_mime,
          size: row.a_size,
          kind: row.a_kind,
          width: row.a_width ?? null,
          height: row.a_height ?? null,
          durationMs: row.a_duration_ms ?? null,
          thumbnailId: row.a_thumbnail_id ?? null,
          expired: !!row.a_expired,
        }
      : null,
    attachments: extras.attachments,
    e2ee: encrypted ? parseJson(row.e2ee, null) : null,
    e2eeClientId: encrypted ? row.e2ee_client_id ?? row.client_id : null,
    createdAt: row.created_at,
    replyTo,
    reactions: extras.reactions,
    reactionClientIds: extras.reactionClientIds,
    legacyReactions: extras.legacyReactions,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    system,
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

  createConversation({ id, title, isGroup, dmKey, createdBy, memberIds, createdAt }) {
    return this.transaction(() => {
      this.q(
        `INSERT INTO conversations (id, title, is_group, dm_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, title, isGroup ? 1 : 0, dmKey, createdBy, createdAt, createdAt);
      const ins = this.q('INSERT INTO members (conversation_id, user_id, position) VALUES (?, ?, ?)');
      memberIds.forEach((userId, i) => ins.run(id, userId, i));
      return this.getConversationRow(id);
    });
  }

  /** Renames a group and records a `renamed` system message, atomically. Returns the message. */
  renameConversation(id, title, actorId, clientId, createdAt) {
    return this.transaction(() => {
      this.q('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
      return this.insertMessageRow({
        conversationId: id,
        senderId: actorId,
        clientId,
        body: '',
        createdAt,
        systemType: 'renamed',
        systemData: { userIds: [], title },
      });
    });
  }

  /**
   * Adds members to a group with a `member_added` system message. New members see history from
   * that system message on. Returns the message.
   */
  addMembers(id, userIds, actorId, clientId, createdAt) {
    return this.transaction(() => {
      const message = this.insertMessageRow({
        conversationId: id,
        senderId: actorId,
        clientId,
        body: '',
        createdAt,
        systemType: 'member_added',
        systemData: { userIds, title: null },
      });
      const maxPos = this.q('SELECT COALESCE(MAX(position), -1) AS p FROM members WHERE conversation_id = ?').get(id).p;
      const ins = this.q('INSERT INTO members (conversation_id, user_id, position, visible_from) VALUES (?, ?, ?, ?)');
      userIds.forEach((userId, i) => ins.run(id, userId, maxPos + 1 + i, message.id));
      return message;
    });
  }

  /** Removes a member and records a `member_left` system message. Returns the message. */
  leaveConversation(id, userId, clientId, createdAt) {
    return this.transaction(() => {
      this.q('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(id, userId);
      return this.insertMessageRow({
        conversationId: id,
        senderId: userId,
        clientId,
        body: '',
        createdAt,
        systemType: 'member_left',
        systemData: { userIds: [userId], title: null },
      });
    });
  }

  isMember(conversationId, userId) {
    return !!this.q('SELECT 1 AS x FROM members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
  }

  /** { visibleFrom, readUpTo } for a member, or null if not a member. */
  membership(conversationId, userId) {
    const row = this.q('SELECT visible_from, read_up_to FROM members WHERE conversation_id = ? AND user_id = ?').get(
      conversationId,
      userId
    );
    return row ? { visibleFrom: row.visible_from, readUpTo: row.read_up_to } : null;
  }

  memberIds(conversationId) {
    return this.q('SELECT user_id FROM members WHERE conversation_id = ? ORDER BY position').all(conversationId).map((r) => r.user_id);
  }

  /** Members allowed to see message `messageId` (those who joined at or before it). */
  memberIdsSeeing(conversationId, messageId) {
    return this.q('SELECT user_id FROM members WHERE conversation_id = ? AND visible_from <= ? ORDER BY position')
      .all(conversationId, messageId)
      .map((r) => r.user_id);
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
      `SELECT u.id, u.username, u.display_name, m.read_up_to, m.visible_from FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.position`
    ).all(conv.id);
    const readUpTo = {};
    let myRead = 0;
    let visibleFrom = 0;
    for (const r of memberRows) {
      readUpTo[r.id] = r.read_up_to;
      if (r.id === viewerId) {
        myRead = r.read_up_to;
        visibleFrom = r.visible_from;
      }
    }
    const lastMessage = this.lastMessage(conv.id, visibleFrom);
    // Only new messages from others count: not system lines, not unsent ones.
    const unread = this.q(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id IS NOT ? AND id > ? AND id >= ?
         AND deleted_at IS NULL AND system_type IS NULL`
    ).get(conv.id, viewerId, myRead, visibleFrom).n;
    return {
      id: conv.id,
      title: conv.title ?? null,
      isGroup: !!conv.is_group,
      members: memberRows.map(userView),
      lastMessage,
      unreadCount: unread,
      readUpTo,
      createdAt: conv.created_at,
      updatedAt: lastMessage ? lastMessage.createdAt : conv.created_at,
    };
  }

  // ---- messages ---------------------------------------------------------

  /** Map messageId -> { reactions, reactionClientIds, legacyReactions, attachments } for the given ids. */
  extrasFor(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const get = (id) => {
      let e = out.get(id);
      if (!e) {
        e = { reactions: {}, reactionClientIds: {}, legacyReactions: {}, attachments: [] };
        out.set(id, e);
      }
      return e;
    };
    const json = JSON.stringify(ids);
    const reactions = this.q(
      `SELECT message_id, user_id, emoji, e2ee, client_id FROM reactions
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`
    ).all(json);
    for (const r of reactions) {
      const e = get(r.message_id);
      if (r.e2ee !== null) {
        e.reactions[r.user_id] = parseJson(r.e2ee, null);
        e.reactionClientIds[r.user_id] = r.client_id;
      } else {
        (e.legacyReactions[r.emoji] ||= []).push(r.user_id);
      }
    }
    const files = this.q(
      `SELECT ma.message_id, a.id, a.size, a.expired FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
       WHERE ma.message_id IN (SELECT value FROM json_each(?)) ORDER BY ma.message_id, ma.position`
    ).all(json);
    for (const f of files) get(f.message_id).attachments.push({ id: f.id, size: f.size, expired: !!f.expired });
    return out;
  }

  views(rows) {
    const extras = this.extrasFor(rows.map((r) => r.id));
    return rows.map((row) => messageView(row, extras.get(row.id) || { reactions: {}, reactionClientIds: {}, legacyReactions: {}, attachments: [] }));
  }

  view(row) {
    return row ? this.views([row])[0] : null;
  }

  lastMessage(conversationId, visibleFrom = 0) {
    return this.view(
      this.q(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.conversation_id = ? AND m.id >= ? ORDER BY m.id DESC LIMIT 1`).get(
        conversationId,
        visibleFrom
      )
    );
  }

  getMessage(id) {
    return this.view(this.q(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ?`).get(id));
  }

  /** The raw `messages` row, or null. */
  getMessageRow(id) {
    return this.q('SELECT * FROM messages WHERE id = ?').get(id) || null;
  }

  getMessageByClientId(senderId, clientId) {
    return this.view(
      this.q(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.sender_id = ? AND m.client_id = ?`).get(senderId, clientId)
    );
  }

  listMessages(conversationId, before, limit, visibleFrom = 0) {
    const rows = this.q(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE m.conversation_id = ? AND m.id < ? AND m.id >= ? ORDER BY m.id DESC LIMIT ?`
    ).all(conversationId, before, visibleFrom, limit);
    return this.views(rows.reverse());
  }

  /** Inserts a message and bumps the conversation; call inside a transaction. Returns the view. */
  insertMessageRow({
    conversationId,
    senderId,
    clientId,
    body,
    attachmentId = null,
    replyToId = null,
    createdAt,
    systemType = null,
    systemData = null,
    e2ee = null,
    attachmentIds = [],
  }) {
    const info = this.q(
      `INSERT INTO messages (conversation_id, sender_id, client_id, body, attachment_id, reply_to_id, created_at, system_type, system_data, e2ee, e2ee_client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId,
      senderId,
      clientId,
      body,
      attachmentId,
      replyToId,
      createdAt,
      systemType,
      systemData ? JSON.stringify(systemData) : null,
      e2ee ? JSON.stringify(e2ee) : null,
      e2ee ? clientId : null
    );
    const id = Number(info.lastInsertRowid);
    const link = this.q('INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)');
    attachmentIds.forEach((attId, i) => link.run(id, attId, i));
    this.q('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId);
    return this.getMessage(id);
  }

  insertMessage(fields) {
    return this.transaction(() => this.insertMessageRow(fields));
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

  /**
   * Sets (or replaces) a user's encrypted reaction; it also replaces a legacy plaintext one.
   * Returns true if anything changed (the same envelope again changes nothing).
   */
  setReaction(messageId, userId, envelope, clientId, createdAt) {
    const json = JSON.stringify(envelope);
    const info = this.q(
      `INSERT INTO reactions (message_id, user_id, emoji, e2ee, client_id, created_at) VALUES (?, ?, '', ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = '', e2ee = excluded.e2ee, client_id = excluded.client_id,
         created_at = excluded.created_at
       WHERE reactions.e2ee IS NOT excluded.e2ee`
    ).run(messageId, userId, json, clientId, createdAt);
    return info.changes > 0;
  }

  removeReaction(messageId, userId) {
    return this.q('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId).changes > 0;
  }

  /** Replaces an encrypted message's envelope with an edit envelope. */
  editMessage(id, envelope, clientId, editedAt) {
    this.q('UPDATE messages SET e2ee = ?, e2ee_client_id = ?, edited_at = ? WHERE id = ?').run(
      JSON.stringify(envelope),
      clientId,
      editedAt,
      id
    );
    return this.getMessage(id);
  }

  /** Ids of an encrypted message's files, in order. */
  messageAttachmentIds(messageId) {
    return this.q('SELECT attachment_id FROM message_attachments WHERE message_id = ? ORDER BY position')
      .all(messageId)
      .map((r) => r.attachment_id);
  }

  /** Ids of messages whose reply quote shows message `id`. */
  replyIdsTo(id) {
    return this.q('SELECT id FROM messages WHERE reply_to_id = ? AND deleted_at IS NULL ORDER BY id').all(id).map((r) => r.id);
  }

  /**
   * Unsends a message: clears body, attachment, reply and reactions and forgets its attachment
   * (and that attachment's thumbnail) unless something else still uses them.
   * Returns the attachment ids whose files should be deleted from disk.
   */
  unsendMessage(id, deletedAt) {
    return this.transaction(() => {
      const msg = this.getMessageRow(id);
      if (!msg || msg.deleted_at !== null) return [];
      const encryptedFiles = this.messageAttachmentIds(id);
      this.q(
        `UPDATE messages SET body = '', attachment_id = NULL, reply_to_id = NULL, edited_at = NULL, deleted_at = ?,
           e2ee = NULL, e2ee_client_id = NULL
         WHERE id = ?`
      ).run(deletedAt, id);
      this.q('DELETE FROM reactions WHERE message_id = ?').run(id);
      this.q('DELETE FROM message_attachments WHERE message_id = ?').run(id);
      const files = [];
      for (const attId of encryptedFiles) {
        if (this.forgetAttachmentIfUnused(attId)) files.push(attId);
      }
      if (msg.attachment_id) {
        const att = this.getAttachment(msg.attachment_id);
        if (att && this.forgetAttachmentIfUnused(att.id)) {
          files.push(att.id);
          if (att.thumbnail_id && this.forgetAttachmentIfUnused(att.thumbnail_id)) files.push(att.thumbnail_id);
        }
      }
      return files;
    });
  }

  /** Deletes an attachment row if no message or other attachment refers to it. */
  forgetAttachmentIfUnused(attachmentId) {
    const used =
      this.attachmentInUse(attachmentId) || this.q('SELECT 1 AS x FROM attachments WHERE thumbnail_id = ? LIMIT 1').get(attachmentId);
    if (used) return false;
    this.q('DELETE FROM attachments WHERE id = ?').run(attachmentId);
    return true;
  }

  // ---- attachments ------------------------------------------------------

  insertAttachment({ id, uploaderId, mime, size, kind, width = null, height = null, durationMs = null, thumbnailId = null, createdAt }) {
    this.q(
      `INSERT INTO attachments (id, uploader_id, mime, size, kind, width, height, duration_ms, thumbnail_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, uploaderId, mime, size, kind, width, height, durationMs, thumbnailId, createdAt);
    return attachmentView(this.getAttachment(id));
  }

  getAttachment(id) {
    return this.q('SELECT * FROM attachments WHERE id = ?').get(id) || null;
  }

  /** True if a message (legacy or encrypted) carries this attachment. */
  attachmentInUse(id) {
    return !!(
      this.q('SELECT 1 AS x FROM messages WHERE attachment_id = ? LIMIT 1').get(id) ||
      this.q('SELECT 1 AS x FROM message_attachments WHERE attachment_id = ? LIMIT 1').get(id)
    );
  }

  /**
   * The uploader may always read an attachment. Others must be a member of a conversation where
   * a message they are allowed to see carries it (as a legacy attachment or one of an encrypted
   * message's files), or carries a legacy attachment whose thumbnail it is.
   */
  canReadAttachment(attachmentId, userId) {
    const att = this.getAttachment(attachmentId);
    if (!att) return false;
    if (att.uploader_id === userId) return true;
    const encrypted = this.q(
      `SELECT 1 AS x FROM message_attachments ma
       JOIN messages msg ON msg.id = ma.message_id
       JOIN members mem ON mem.conversation_id = msg.conversation_id AND mem.user_id = ?
       WHERE ma.attachment_id = ? AND msg.id >= mem.visible_from
       LIMIT 1`
    ).get(userId, attachmentId);
    if (encrypted) return true;
    return !!this.q(
      `SELECT 1 AS x FROM messages msg
       JOIN members mem ON mem.conversation_id = msg.conversation_id AND mem.user_id = ?
       WHERE msg.id >= mem.visible_from AND (
         msg.attachment_id = ? OR
         msg.attachment_id IN (SELECT p.id FROM attachments p WHERE p.thumbnail_id = ?))
       LIMIT 1`
    ).get(userId, attachmentId, attachmentId);
  }

  /** Marks attachments created before `cutoff` as expired. Returns their ids (files to delete). */
  expireAttachmentsBefore(cutoff) {
    return this.transaction(() => {
      const ids = this.q('SELECT id FROM attachments WHERE expired = 0 AND created_at < ?').all(cutoff).map((r) => r.id);
      if (ids.length) {
        this.q('UPDATE attachments SET expired = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
      }
      return ids;
    });
  }

  /**
   * Deletes attachments created before `cutoff` that no message ever carried (abandoned sends,
   * thumbnails of cancelled uploads). A legacy thumbnail counts as carried while the attachment
   * that uses it is. Returns their ids (files to delete).
   */
  deleteUnattachedBefore(cutoff) {
    return this.transaction(() => {
      const ids = this.q(
        `SELECT a.id FROM attachments a
         WHERE a.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.attachment_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM attachments p JOIN messages pm ON pm.attachment_id = p.id WHERE p.thumbnail_id = a.id)`
      )
        .all(cutoff)
        .map((r) => r.id);
      if (ids.length) {
        this.q('DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
      }
      return ids;
    });
  }

  // ---- key directory -------------------------------------------------------

  /**
   * Publishes `bundle` as the user's current key with its backup. Earlier bundles stay in
   * key_bundles (read-only). Re-sending the current keyId changes nothing. A keyId the user published
   * before that isn't current, or a createdAt not newer than the current key's, is refused: an old
   * key never becomes current again (rollback protection).
   * Returns { bundle, changed } (changed: the current keyId moved) or { rollback: true }.
   */
  putKeys(userId, bundle, backup, now) {
    return this.transaction(() => {
      const before = this.getOwnKeys(userId);
      if (before && before.bundle && before.bundle.keyId === bundle.keyId) return { bundle: before.bundle, changed: false };
      if (this.getBundle(userId, bundle.keyId)) return { rollback: true };
      if (before && before.bundle && !(bundle.createdAt > before.bundle.createdAt)) return { rollback: true };
      this.q('INSERT INTO key_bundles (user_id, key_id, bundle, uploaded_at) VALUES (?, ?, ?, ?)').run(
        userId,
        bundle.keyId,
        JSON.stringify(bundle),
        now
      );
      this.q(
        `INSERT INTO user_keys (user_id, key_id, backup, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET key_id = excluded.key_id, backup = excluded.backup, updated_at = excluded.updated_at`
      ).run(userId, bundle.keyId, JSON.stringify(backup), now);
      return { bundle: this.getBundle(userId, bundle.keyId), changed: true };
    });
  }

  /** { bundle, backup } of the user's current key, or null. */
  getOwnKeys(userId) {
    const row = this.q(
      `SELECT k.backup, b.bundle FROM user_keys k JOIN key_bundles b ON b.user_id = k.user_id AND b.key_id = k.key_id
       WHERE k.user_id = ?`
    ).get(userId);
    return row ? { bundle: parseJson(row.bundle, null), backup: parseJson(row.backup, null) } : null;
  }

  /** A bundle the user published (current or older), or null. */
  getBundle(userId, keyId) {
    const row = this.q('SELECT bundle FROM key_bundles WHERE user_id = ? AND key_id = ?').get(userId, keyId);
    return row ? parseJson(row.bundle, null) : null;
  }

  /** Map userId -> { keyId, bundle } of current keys, for those of `userIds` that have keys. */
  currentKeys(userIds) {
    const out = new Map();
    if (!userIds.length) return out;
    const rows = this.q(
      `SELECT k.user_id, k.key_id, b.bundle FROM user_keys k JOIN key_bundles b ON b.user_id = k.user_id AND b.key_id = k.key_id
       WHERE k.user_id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(userIds));
    for (const r of rows) out.set(r.user_id, { keyId: r.key_id, bundle: parseJson(r.bundle, null) });
    return out;
  }

  // ---- resumable uploads ---------------------------------------------------

  createUpload({ id, userId, mime, kind, size, createdAt }) {
    this.q('INSERT INTO uploads (id, user_id, mime, kind, size, received, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(
      id,
      userId,
      mime,
      kind,
      size,
      createdAt
    );
    return this.getUpload(id);
  }

  getUpload(id) {
    return this.q('SELECT * FROM uploads WHERE id = ?').get(id) || null;
  }

  countUploads(userId) {
    return this.q('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ?').get(userId).n;
  }

  /** A user's unfinished upload ids, oldest first. */
  uploadIdsForUser(userId) {
    return this.q('SELECT id FROM uploads WHERE user_id = ? ORDER BY created_at, rowid').all(userId).map((r) => r.id);
  }

  setUploadReceived(id, received) {
    this.q('UPDATE uploads SET received = ? WHERE id = ?').run(received, id);
  }

  deleteUpload(id) {
    this.q('DELETE FROM uploads WHERE id = ?').run(id);
  }

  /** Deletes uploads started before `cutoff`; returns their ids. */
  deleteUploadsBefore(cutoff) {
    return this.transaction(() => {
      const ids = this.q('SELECT id FROM uploads WHERE created_at < ?').all(cutoff).map((r) => r.id);
      this.q('DELETE FROM uploads WHERE created_at < ?').run(cutoff);
      return ids;
    });
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

module.exports = { Store, userView, messageView, attachmentView, SCHEMA_VERSION, REPLY_PREVIEW_CHARS };
