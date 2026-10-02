'use strict';

// PRAGMA user_version migrations: databases from every earlier TealTalk upgrade cleanly.
// v1: the original schema. v2: texting phone numbers (SMS, since removed). v3: SMS dropped,
// full-quality messaging added. v4: end-to-end encryption.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { startApp, request, send, putKeys, react, textOf, uploadEncrypted, RELOAD, PNG_BYTES } = require('./helpers');
const { SCHEMA_VERSION } = require('../server/db');
const { envelope } = require('./e2ee-helpers');

// The CREATE statements of server/db.js before migrations existed (git show 0baa583~1:server/db.js).
const V1_SCHEMA = `
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

// The v2 migration exactly as it shipped (git show 0baa583:server/db.js).
const V2_MIGRATION = `
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

// The v3 migration exactly as it shipped (git show d7c085d:server/db.js).
const V3_MIGRATION = `
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

const T = 1790000000000;

function tokenPair() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

/** Creates a v1 database with two users, a 1:1 with three messages (one a photo), and a push subscription. */
function seedV1(dataDir) {
  const file = path.join(dataDir, 'tealtalk.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(V1_SCHEMA);
  const { token, tokenHash } = tokenPair();
  const insUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
  insUser.run('u_alice', 'alice', 'Alice', 'salt', 'hash', T);
  insUser.run('u_bob', 'bob', 'Bob', 'salt', 'hash', T);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash, 'u_alice', T);
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?)').run('c_dm', null, 0, 'u_alice:u_bob', 'u_alice', T, T + 30);
  db.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run('c_dm', 'u_alice', 0, 2);
  db.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run('c_dm', 'u_bob', 1, 0);
  db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run('a_pic', 'u_bob', 'image/png', PNG_BYTES.length, T);
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'a_pic'), PNG_BYTES);
  const insMsg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
  insMsg.run(1, 'c_dm', 'u_alice', 'k1', 'hi bob', null, T + 10);
  insMsg.run(2, 'c_dm', 'u_bob', 'k2', 'hi alice', null, T + 20);
  insMsg.run(3, 'c_dm', 'u_bob', 'k3', '', 'a_pic', T + 30);
  // Ids issued and later gone still must never be reused.
  insMsg.run(9, 'c_dm', 'u_bob', 'k9', 'deleted later', null, T + 31);
  db.prepare('DELETE FROM messages WHERE id = 9').run();
  db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?)').run('https://push.example.com/x', 'u_alice', 'p'.repeat(20), 'a'.repeat(10), T);
  return { db, token };
}

/** Checks the upgraded schema: current version, no SMS leftovers, v3 columns and tables. */
function assertCurrentSchema(db) {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index')").all();
  assert.deepEqual(
    all.filter((o) => /sms/i.test(o.name) || /sms/i.test(o.sql || '')).map((o) => o.name),
    [],
    'no SMS tables, indexes or columns remain'
  );
  for (const c of ['reply_to_id', 'edited_at', 'deleted_at', 'system_type', 'system_data']) assert.ok(cols('messages').includes(c), c);
  for (const c of ['kind', 'width', 'height', 'duration_ms', 'thumbnail_id', 'expired']) assert.ok(cols('attachments').includes(c), c);
  assert.ok(cols('members').includes('visible_from'));
  assert.deepEqual(cols('reactions'), ['message_id', 'user_id', 'emoji', 'created_at', 'e2ee', 'client_id']);
  for (const c of ['e2ee', 'e2ee_client_id']) assert.ok(cols('messages').includes(c), c);
  assert.deepEqual(cols('key_bundles'), ['user_id', 'key_id', 'bundle', 'uploaded_at']);
  assert.deepEqual(cols('user_keys'), ['user_id', 'key_id', 'backup', 'updated_at']);
  assert.deepEqual(cols('message_attachments'), ['message_id', 'attachment_id', 'position']);
  assert.ok(cols('uploads').includes('received'));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_v2'").get(), undefined);
  const senderCol = db.prepare('PRAGMA table_info(messages)').all().find((c) => c.name === 'sender_id');
  assert.equal(senderCol.notnull, 0);
}

async function checkV1Data(app, token) {
  const alice = { token, user: { id: 'u_alice', username: 'alice', displayName: 'Alice' } };
  const me = await request(app, 'GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { user: alice.user });
  const conv = (await request(app, 'GET', '/api/conversations/c_dm', { token })).body.conversation;
  assert.equal('sms' in conv, false);
  assert.equal(conv.unreadCount, 1);
  assert.deepEqual(conv.readUpTo, { u_alice: 2, u_bob: 0 });
  const msgs = (await request(app, 'GET', '/api/conversations/c_dm/messages', { token })).body.messages;
  assert.deepEqual(
    msgs.map((m) => [m.id, m.senderId, m.clientId, m.body, m.attachment && m.attachment.id, m.createdAt]),
    [
      [1, 'u_alice', 'k1', 'hi bob', null, T + 10],
      [2, 'u_bob', 'k2', 'hi alice', null, T + 20],
      [3, 'u_bob', 'k3', '', 'a_pic', T + 30],
    ]
  );
  for (const m of msgs) {
    assert.equal('sms' in m, false);
    assert.deepEqual(
      [m.replyTo, m.reactions, m.legacyReactions, m.editedAt, m.deletedAt, m.system, m.e2ee, m.e2eeClientId, m.attachments],
      [null, {}, {}, null, null, null, null, null, []]
    );
  }
  // Old photos became image attachments.
  assert.deepEqual(msgs[2].attachment, {
    id: 'a_pic',
    mime: 'image/png',
    size: PNG_BYTES.length,
    kind: 'image',
    width: null,
    height: null,
    durationMs: null,
    thumbnailId: null,
    expired: false,
  });
  const img = await fetch(`${app.url}/api/attachments/a_pic?token=${token}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(img.status, 206);
  // An old (plaintext) copy of the app is told to reload, even for a retry.
  const retry = await request(app, 'POST', '/api/conversations/c_dm/messages', { token, body: { clientId: 'k1', body: 'hi bob' } });
  assert.equal(retry.status, 400);
  assert.deepEqual(retry.body, { error: RELOAD });
  // Nobody had keys before v3: the sender needs some first, then every member.
  const fakeKeyId = 'A'.repeat(43);
  const noKeys = await request(app, 'POST', '/api/conversations/c_dm/messages', {
    token,
    body: { clientId: 'n1', e2ee: envelope({ senderKeyId: fakeKeyId, recipients: { u_alice: fakeKeyId, u_bob: fakeKeyId } }) },
  });
  assert.equal(noKeys.status, 409);
  assert.deepEqual(noKeys.body, { error: 'keys_changed' });
  await putKeys(app, alice);
  const bobMissing = await request(app, 'POST', '/api/conversations/c_dm/messages', {
    token,
    body: { clientId: 'n2', e2ee: envelope({ senderKeyId: alice.keys.keyId, recipients: { u_alice: alice.keys.keyId, u_bob: fakeKeyId } }) },
  });
  assert.equal(bobMissing.status, 409);
  assert.deepEqual(bobMissing.body, { error: 'missing_keys', missing: ['u_bob'] });
  const bobSession = tokenPair();
  app.store.createSession(bobSession.tokenHash, 'u_bob');
  await putKeys(app, { token: bobSession.token, user: { id: 'u_bob' } });
  const fresh = await send(app, alice, 'c_dm', 'after the upgrade', { replyToId: 2 });
  assert.ok(fresh.id > 9, `new id ${fresh.id} continues after the old sequence`);
  assert.deepEqual(fresh.replyTo, { id: 2, senderId: 'u_bob', deleted: false });
  assert.equal(textOf(fresh), 'after the upgrade');
  const reacted = await react(app, alice, 'c_dm', 2, '👍');
  assert.equal(reacted.status, 200);
  assert.deepEqual(Object.keys(reacted.body.message.reactions), ['u_alice']);
  assert.deepEqual(reacted.body.message.legacyReactions, {});
  assert.equal(app.store.pushSubscriptionsFor('u_alice').length, 1);
  return fresh;
}

describe('database migrations', () => {
  test('v1 (before user_version) upgrades to the current schema and keeps its data', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-migrate-'));
    try {
      const { db, token } = seedV1(dataDir);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
      db.close();

      const app = await startApp({ dataDir });
      try {
        assertCurrentSchema(app.store.db);
        await checkV1Data(app, token);
      } finally {
        await app.close(true);
      }

      // Opening again is a no-op.
      const again = await startApp({ dataDir });
      try {
        assert.equal(again.store.schemaVersion, SCHEMA_VERSION);
        const msgs = (await request(again, 'GET', '/api/conversations/c_dm/messages', { token })).body.messages;
        assert.equal(msgs.length, 4);
        assert.equal(textOf(msgs[1].reactions.u_alice), '👍');
        assert.equal(textOf(msgs[3]), 'after the upgrade');
      } finally {
        await again.close(true);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('v2 (with texting data) upgrades: SMS columns, indexes and tables are dropped', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-migrate-'));
    try {
      const { db, token } = seedV1(dataDir);
      // Bring it to v2 exactly as the SMS release did.
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      db.exec(V2_MIGRATION);
      db.exec("UPDATE sqlite_sequence SET seq = MAX(seq, 9) WHERE name = 'messages'");
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
      // A text-message conversation with an outgoing (sent) and an incoming (null sender) text.
      db.prepare(
        'INSERT INTO conversations (id, title, is_group, dm_key, created_by, created_at, updated_at, sms_phone, sms_owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('c_sms', 'Plumber', 0, null, 'u_alice', T + 40, T + 60, '+15551234567', 'u_alice');
      db.prepare('INSERT INTO members (conversation_id, user_id, position, read_up_to) VALUES (?, ?, ?, ?)').run('c_sms', 'u_alice', 0, 0);
      const insSms = db.prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, client_id, body, attachment_id, created_at, sms_status, sms_error, sms_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insSms.run(10, 'c_sms', 'u_alice', 'k10', 'is tuesday ok?', null, T + 50, 'delivered', null, 'SM1');
      insSms.run(11, 'c_sms', null, 'sms-SM2', 'yes', null, T + 60, 'received', null, 'SM2');
      db.prepare('INSERT INTO sms_inbound VALUES (?, ?)').run('SM2', T + 60);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'conversations_sms'").get());
      db.close();

      const app = await startApp({ dataDir });
      try {
        assertCurrentSchema(app.store.db);
        const fresh = await checkV1Data(app, token);
        assert.ok(fresh.id > 11);
        // The old texting conversation stays readable as history.
        const conv = (await request(app, 'GET', '/api/conversations/c_sms', { token })).body.conversation;
        assert.equal(conv.title, 'Plumber');
        assert.equal(conv.isGroup, false);
        assert.equal(conv.unreadCount, 1);
        assert.equal('sms' in conv, false);
        const msgs = (await request(app, 'GET', '/api/conversations/c_sms/messages', { token })).body.messages;
        assert.deepEqual(
          msgs.map((m) => [m.id, m.senderId, m.body, 'sms' in m]),
          [
            [10, 'u_alice', 'is tuesday ok?', false],
            [11, null, 'yes', false],
          ]
        );
        const list = (await request(app, 'GET', '/api/conversations', { token })).body.conversations.map((c) => c.id);
        assert.deepEqual(list.sort(), ['c_dm', 'c_sms']);
        // Texting routes are gone.
        for (const p of ['/api/sms/conversations', '/api/sms/twilio', '/api/sms/twilio/status', '/api/sms/media/a_pic']) {
          assert.equal((await request(app, 'POST', p, { token, body: {} })).status, 404, p);
        }
      } finally {
        await app.close(true);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('v3 (full-quality messaging) upgrades to v4: legacy messages keep their plaintext shape', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-migrate-'));
    try {
      const { db, token } = seedV1(dataDir);
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      db.exec(V2_MIGRATION);
      db.exec("UPDATE sqlite_sequence SET seq = MAX(seq, 9) WHERE name = 'messages'");
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN');
      db.exec(V3_MIGRATION);
      db.exec('PRAGMA user_version = 3');
      db.exec('COMMIT');
      // v3 data: a group carol joined later, a video with a thumbnail, a reply, an edit, a
      // system line, plaintext reactions and an unfinished upload.
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run('u_carol', 'carol', 'Carol', 'salt', 'hash', T);
      db.prepare('INSERT INTO conversations (id, title, is_group, dm_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'c_grp', 'Hikers', 1, null, 'u_alice', T + 100, T + 140
      );
      const insMember = db.prepare('INSERT INTO members (conversation_id, user_id, position, read_up_to, visible_from) VALUES (?, ?, ?, ?, ?)');
      insMember.run('c_grp', 'u_alice', 0, 0, 0);
      insMember.run('c_grp', 'u_bob', 1, 0, 0);
      insMember.run('c_grp', 'u_carol', 2, 0, 13);
      const insAtt = db.prepare('INSERT INTO attachments (id, uploader_id, mime, size, kind, width, height, duration_ms, thumbnail_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insAtt.run('a_thumb', 'u_alice', 'image/jpeg', 10, 'image', 480, 270, null, null, T + 105);
      insAtt.run('a_vid', 'u_alice', 'video/mp4', 20, 'video', 1920, 1080, 4200, 'a_thumb', T + 106);
      for (const id of ['a_thumb', 'a_vid']) fs.writeFileSync(path.join(dataDir, 'uploads', id), Buffer.alloc(10, 1));
      const insMsg = db.prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, client_id, body, attachment_id, created_at, reply_to_id, edited_at, deleted_at, system_type, system_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insMsg.run(10, 'c_grp', 'u_alice', 'g10', 'look', 'a_vid', T + 110, null, null, null, null, null);
      insMsg.run(11, 'c_grp', 'u_bob', 'g11', 'wow (edited)', null, T + 120, 10, T + 121, null, null, null);
      insMsg.run(12, 'c_grp', 'u_bob', 'g12', '', null, T + 125, null, null, T + 126, null, null);
      insMsg.run(13, 'c_grp', 'u_alice', 'system-1', '', null, T + 130, null, null, null, 'member_added', JSON.stringify({ userIds: ['u_carol'], title: null }));
      insMsg.run(14, 'c_grp', 'u_carol', 'g14', 'hi all', null, T + 140, null, null, null, null, null);
      const insReaction = db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
      insReaction.run(10, 'u_bob', '❤️', T + 111);
      insReaction.run(10, 'u_alice', '❤️', T + 112);
      insReaction.run(11, 'u_alice', '😂', T + 122);
      db.prepare('INSERT INTO uploads (id, user_id, mime, kind, size, received, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('up_1', 'u_alice', 'video/mp4', 'video', 100, 10, Date.now());
      fs.writeFileSync(path.join(dataDir, 'uploads', '.part-up_1'), Buffer.alloc(10, 2));
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
      db.close();

      const app = await startApp({ dataDir });
      try {
        assertCurrentSchema(app.store.db);
        const msgs = (await request(app, 'GET', '/api/conversations/c_grp/messages', { token })).body.messages;
        assert.deepEqual(msgs.map((m) => m.id), [10, 11, 12, 13, 14]);
        for (const m of msgs) {
          assert.equal(m.e2ee, null);
          assert.equal(m.e2eeClientId, null);
          assert.deepEqual(m.attachments, []);
          assert.deepEqual(m.reactions, {});
          assert.deepEqual(m.reactionClientIds, {});
        }
        assert.deepEqual(msgs[0].attachment, {
          id: 'a_vid', mime: 'video/mp4', size: 20, kind: 'video', width: 1920, height: 1080, durationMs: 4200, thumbnailId: 'a_thumb', expired: false,
        });
        assert.equal(msgs[0].body, 'look');
        assert.deepEqual(msgs[0].legacyReactions, { '❤️': ['u_bob', 'u_alice'] });
        assert.deepEqual(msgs[1].legacyReactions, { '😂': ['u_alice'] });
        assert.deepEqual(msgs[1].replyTo, { id: 10, senderId: 'u_alice', body: 'look', attachmentKind: 'video', deleted: false });
        assert.equal(msgs[1].editedAt, T + 121);
        assert.equal(msgs[2].deletedAt, T + 126);
        assert.deepEqual(msgs[3].system, { type: 'member_added', userIds: ['u_carol'], title: null });
        // Legacy thumbnails keep following their video's permissions; the upload survives.
        const thumb = await request(app, 'GET', '/api/attachments/a_thumb', { token });
        assert.equal(thumb.status, 200);
        assert.deepEqual((await request(app, 'GET', '/api/uploads/up_1', { token })).body, { received: 10, size: 100 });
        assert.deepEqual(app.sweeper.sweep().unattached, []);

        // Everyone gets keys; new encrypted messages and reactions work next to the old ones.
        const alice = { token, user: { id: 'u_alice' } };
        await putKeys(app, alice);
        for (const id of ['u_bob', 'u_carol']) {
          const s = tokenPair();
          app.store.createSession(s.tokenHash, id);
          await putKeys(app, { token: s.token, user: { id } });
        }
        const file = await uploadEncrypted(app, alice);
        const fresh = await send(app, alice, 'c_grp', 'v4', { replyToId: 11, attachmentIds: [file.id] });
        assert.ok(fresh.id > 14);
        assert.deepEqual(fresh.replyTo, { id: 11, senderId: 'u_bob', deleted: false });
        assert.deepEqual(Object.keys(fresh.e2ee.keys).sort(), ['u_alice', 'u_bob', 'u_carol']);
        // A reaction to a message from before carol joined goes to alice and bob only.
        const r = await react(app, alice, 'c_grp', 10, '👍');
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.body.message.reactions.u_alice.keys).sort(), ['u_alice', 'u_bob']);
        assert.deepEqual(r.body.message.legacyReactions, { '❤️': ['u_bob'] });
      } finally {
        await app.close(true);
      }
      const again = await startApp({ dataDir });
      try {
        assert.equal(again.store.schemaVersion, SCHEMA_VERSION);
        const msgs = (await request(again, 'GET', '/api/conversations/c_grp/messages', { token })).body.messages;
        assert.equal(msgs.length, 6);
        assert.equal(textOf(msgs[5]), 'v4');
      } finally {
        await again.close(true);
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a fresh database starts at the current schema version', async () => {
    const app = await startApp();
    try {
      assertCurrentSchema(app.store.db);
    } finally {
      await app.close();
    }
  });

  test('a database from a newer TealTalk is refused, untouched', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-migrate-'));
    try {
      const db = new DatabaseSync(path.join(dataDir, 'tealtalk.db'));
      db.exec('PRAGMA user_version = 99');
      db.close();
      await assert.rejects(startApp({ dataDir }), /newer than this TealTalk/);
      const again = new DatabaseSync(path.join(dataDir, 'tealtalk.db'));
      assert.equal(again.prepare('PRAGMA user_version').get().user_version, 99);
      again.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
