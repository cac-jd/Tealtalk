# TealTalk end-to-end encryption (v3)

## In plain words

Messages, photos, videos, voice messages, reactions and edits are locked on the sender's phone and only unlocked on the recipients' phones. The TealTalk server stores and forwards scrambled data it cannot read, so the person running it can't either, and neither can anyone who breaks into it.

Each account has a **key** that lives on your phone. When you first set up, TealTalk shows you a **recovery key** (8 groups of 4 letters/digits). Write it down. It's how you get your messages back on a new phone. Without it, a new phone starts fresh and old messages stay locked.

Every pair of people has a **safety number**. If you compare it in person or on a call and it matches, nobody can be secretly listening in. If a contact's safety number changes (they reset their key or got a new phone without their recovery key), TealTalk tells you.

### What the server can still see

- Who talks to whom, when, and how big each message or file is
- Account usernames, display names, group names and member lists
- That a reaction or edit happened (not which emoji or what the new text says)

Hiding this metadata too is a much bigger project (Signal-style "sealed sender"), left for later.

### Honest limits of this version

1. **The server delivers the app's code.** TealTalk is a web app, so a malicious or hacked server could send a modified app that leaks keys. Settings shows an **app fingerprint**, but a modified app can show whatever fingerprint it likes: the in-app number only catches accidental drift (a stale or half-updated copy). Real verification needs a check from outside the app, such as hashing the files your browser received and comparing them with the GitHub release, or a future native app. An App Store version (later, with approval) removes this risk.
2. **The server decides who is in a group.** TealTalk never lets the server add anyone to a one-to-one chat: a 1:1 chat is only ever encrypted for its two people. In a group, the server's member list decides who gets new messages; your phone shows "Sam was added to this chat" (made by your phone, not the server) before anything is encrypted for someone new, so a secretly added member is visible, but not prevented. Signed group membership is a later upgrade.
3. **No forward secrecy yet.** If someone steals your key and your recovery key, they can decrypt past messages they've also copied from the server. Signal's "double ratchet" fixes this. It's a later upgrade (see the roadmap at the end).
4. **One key per account**, shared by your devices through the recovery key. A lost device can't be cut off on its own: reset your key instead (contacts see a safety-number change).

### Known gaps found in review (to fix next)

- A malicious server can re-serve an older genuine edit or reaction from the same person for a message. Edit ordering is remembered only until the app reloads, and reactions have no ordering yet.
- Removing a reaction is a plain request, so the server could silently remove reactions.
- History signed with a contact's older key can show one extra "safety number changed" notice on a new device.

## Building blocks

WebCrypto only. It's built into every browser and into Node 22, so there's no crypto library to trust or update.

| Use | Algorithm |
| --- | --- |
| Key agreement | ECDH P-256 |
| Signatures | ECDSA P-256 with SHA-256 |
| Encryption | AES-256-GCM (96-bit IV) |
| Key derivation | HKDF-SHA-256 |
| Hashing | SHA-256 |

P-256 instead of X25519 because every iPhone and Android browser that runs TealTalk supports it. Binary values in JSON are **base64url without padding** (`b64u`). Public keys are `spki` DER, and private keys are `pkcs8` DER.

## Keys

### Account key bundle (public, stored on the server)

```jsonc
{
  "v": 1,
  "encPub": "b64u spki ECDH P-256",
  "sigPub": "b64u spki ECDSA P-256",
  "keyId": "b64u(SHA-256(0x01 || sigPub || encPub))",   // 43 chars
  "createdAt": 1790000000000,
  "selfSig": "b64u ECDSA(sigPriv, utf8('tealtalk-keys-v1|' + userId + '|' + keyId + '|' + createdAt))"
}
```

ECDSA signatures are WebCrypto's raw `r||s` (64 bytes) format, and Node verifies them with `dsaEncoding: 'ieee-p1363'`.

### On the device

IndexedDB database `tealtalk-keys` (also read by the service worker for push previews):
- store `account`, keyed by userId: `{ userId, keyId, encPriv, sigPriv, encPub, sigPub, bundle, backup, published, recoverySaved }`. The private keys are **non-extractable CryptoKey objects**: page scripts can use them but can never read them out. `backup` is the already-encrypted backup blob, kept so the device can put its key back if the server ever loses it. **The recovery key is never stored** (records from earlier versions have it removed on load).
- store `contacts`, keyed by userId: trust-on-first-use pins `{ userId, owner, keyId, bundle, seenKeyIds, verified, firstSeenAt, pinnedAt, unackedKeyIds, needsAck, changes: [{ at, keyId }] }`. `keyId`/`bundle` is the **pinned key, the only key we encrypt to**. `owner` is the account the pins belong to: they survive logout and are cleared only when a different account signs in on the device.

IndexedDB database `tealtalk-local` (page only):
- `oldKeys` `{ id: userId|keyId, userId, keyId, encPriv, bundle, retiredAt }`: keys this device used before (after "Start fresh", "Reset key" or a key change elsewhere). Messages sent to them still open here. Deleted at logout.
- `members` `{ conversationId, owner, isGroup, members, notices }`: who this device has seen in each chat (see "Sealing").
- `meta` `firstEncrypted`: per chat, the id of the first encrypted message seen (see "Receiving").
- `outbox` `{ clientId, owner, iv, ct, savedAt }` and `outboxKey` `{ userId, key }`: unsent messages, AES-256-GCM encrypted (aad `tealtalk-outbox-v1|userId|clientId`) under a **non-extractable** key made per account and stored as a CryptoKey. Older versions' plaintext `localStorage` outbox is moved here on load. Failed or held-back messages expire after 7 days. Logout deletes the outbox and its key.

Call `navigator.storage.persist()` at setup.

**Generation:** generate extractable key pairs → export `pkcs8` → build the backup → re-import as non-extractable for daily use → drop the extractable copies.

### Recovery key and backup

- Recovery key: 20 random bytes, shown as 32 Crockford base32 characters in 8 groups of 4 (`7K3M-…`). Typing is case-insensitive, and O/I/L are read as 0/1/1.
- `backupKey = HKDF(ikm = recovery bytes, salt = utf8('tealtalk-backup|' + userId), info = utf8('tealtalk-backup-v1'))` → AES-256-GCM.
- `backup = { v: 1, keyId, iv, ct }`, where `ct = AES-GCM(backupKey, iv, utf8(JSON{ encPriv: b64u pkcs8, sigPriv: b64u pkcs8 }), aad = utf8(userId + '|' + keyId))`.
- 160 random bits can't be guessed offline, so no slow password hashing is needed. Never derive this from the account password.

### Flows

- **First login on any device, account has no keys (and neither has this device):** generate, `PUT /api/keys`, show the recovery key **once** (`recovery-key-display`, `recovery-copy-button`). To continue, the person re-types its last group of 4 (`recovery-confirm-input`, `recovery-confirm-button`; case-insensitive, O/I/L read as 0/1/1). It is kept in memory only until then and can't be shown again. If the app closes before that, Settings says so (`recovery-unconfirmed-note`) and suggests Reset key. Settings explains: "Lost your recovery key? Reset your key (old messages stay readable only on devices that have them)."
- **Login on a new device, account has keys:** "Enter your recovery key" (`recovery-screen`, `recovery-input`, `recovery-submit`, `recovery-error`). Decrypt the backup and check that the keyId matches. The option "Start fresh" (`recovery-reset-button`, after a confirm) makes new keys: old messages can't be read on any device that doesn't have the old key, and contacts see a safety-number change.
- **The server says my key changed** (launch, a `keys` event about me, or a `keys_changed` 409 about my own key, always confirmed with `GET /api/keys/me`): this device **never deletes or overwrites its key**. It moves the key to `oldKeys` (so old messages stay readable), stops sending and shows `key-conflict-screen` on the recovery screen: "Your key was changed on another device at <time>. If this wasn't you, reset your key and change your password." The choices are the recovery key for the new key, or Start fresh. (Keeping this device's old key isn't possible: the server refuses to make an old key current again, see `PUT /api/keys`.)
- **The server says I have no key** (`bundle: null`) but this device has one: re-`PUT` this device's own bundle with its stored backup blob. Never a new key. (The one exception: a key made here that never got uploaded and whose recovery key nobody saw is replaced, since nothing can depend on it.)
- **Logout** deletes this device's private keys (current and old) and the outbox after warning: "You'll need your recovery key to read your messages after logging back in." Pins, member lists and markers stay for the next login of the same account.
- **Reset key** in Settings (`reset-keys-button`): same as Start fresh. The previous key moves to `oldKeys`.

## Messages

### Envelope

New messages, edits and reactions all use one envelope:

```jsonc
{
  "v": 1,
  "kind": "message" | "edit:<messageId>" | "reaction:<messageId>",
  "senderKeyId": "...",
  "eph": "b64u spki: one fresh ECDH P-256 key pair per envelope",
  "iv": "b64u 12 bytes",
  "ct": "b64u AES-GCM(K, iv, utf8(JSON payload), aad = AAD)",
  "keys": { "<userId>": { "k": "<recipient keyId>", "w": "b64u(iv12 || AES-GCM(wrapKey_u, K))" } },
  "sig": "b64u ECDSA(senderSigPriv, utf8(canonical(envelope without sig) + '|' + AAD))"
}
```

- `K`: a random 256-bit AES-GCM key per envelope.
- `AAD = 'tealtalk-msg-v1|' + conversationId + '|' + senderId + '|' + clientId + '|' + kind`. It binds the ciphertext to its conversation, sender and purpose, so the server can't move it to another chat or replay it as an edit.
- `wrapKey_u = HKDF(ikm = ECDH(ephPriv, encPub_u), salt = SHA-256(eph spki), info = utf8('tealtalk-wrap-v1|' + conversationId + '|' + clientId + '|' + kind + '|' + userId + '|' + k))` → AES-256-GCM.
- `keys` has one entry for **every member who can see the message, including the sender** (so your other devices and your own history can read it).

### Sealing

- **Only ever to the pinned key.** If the server offers a different keyId for someone (any `createdAt`), that's a safety-number change (notice in all chats with them), the pin moves to the new key, and if they were verified the send waits for `safety-interstitial` ("Verify again" or `safety-send-anyway`). Unverified contacts: the notice, then the message goes (like Signal). Bundles dated more than a day ahead are refused.
- **Only to people this device knows are in the chat.** The device keeps each chat's members (`members` store; the first time it sees a chat it records the server's list). A **1:1 chat is never sealed to anyone but its two people**: a 1:1 chat listed with anyone else (now or at first sight), even if the server later calls it a group, is refused with an error and nothing is sent. In a group, sealing to someone the device hasn't seen there first adds a local `member-change-notice` ("Sam was added to this chat") and records them. Group membership itself is the server's (see the limits above).
- `canonical(x)` = JSON with object keys sorted recursively and no whitespace.
- For edits and reactions, `clientId` is a fresh random id sent alongside the envelope.

### Receiving

0. Refuse (as `message-undecryptable`) any envelope whose conversationId, senderId or clientId contains `|`, since the AAD joins them with `|`. A message's own envelope opens with `message.clientId`; only an edit envelope uses `message.e2eeClientId`.
1. Look up the sender's bundle for `senderKeyId` (cache by keyId; `GET /api/keys/:userId?keyId=` for old ones). Bundles dated more than a day in the future are refused. For my own messages only keys this device has had (current or `oldKeys`) count; the server's word isn't enough.
2. Verify `sig` first. If it fails, show "Couldn't verify this message" and don't decrypt.
3. Unwrap `keys[me]` with my encPriv, then decrypt `ct`. Any failure shows `message-undecryptable`: "Can't decrypt this message", for example when it was sent to a key this device doesn't have.
4. Check `payload.kind` equals `envelope.kind`.

Unwrap with the current key, or with an `oldKeys` key when `keys[me].k` names one.

**Pins (trust on first use).** Pin the sender's key on first sight. A message signed with a key that is **neither pinned nor in `seenKeyIds`**, whatever its `createdAt`, is a safety-number change first: a local notice `safety-change-notice` "Maya's safety number changed" (with the time) in every chat with that person, and the key joins `seenKeyIds` (the pin itself doesn't move: we keep encrypting to the key we know). If the person was **verified**, they no longer are, and every message signed with that key shows `message-unverified-key-warning`: "Sent with a key you haven't verified", until the person taps "Send anyway" or verifies again. Dates never decide trust: a server-made key dated in the past is still a change.

**No plaintext where there should be none.** Reactions on an encrypted message only come from encrypted reaction envelopes (`legacyReactions` and the old array shape are ignored there). The device remembers, per chat, the id of the first encrypted message; an unencrypted, non-system message with a higher id shows `message-unencrypted-warning`: "This message wasn't encrypted and may not be from <name>" instead of the legacy label.

### Payloads (inside `ct`)

```jsonc
// kind "message"
{ "kind": "message", "body": "text, max 4000 chars",
  "attachments": [ {
      "id": "a_...", "mime": "image/jpeg", "size": 4123456,          // plaintext size
      "width": 4032, "height": 3024, "durationMs": null, "kind": "image",
      "key": "b64u 32 bytes", "noncePrefix": "b64u 8 bytes", "recordSize": 262144,
      "thumb": { "id": "a_...", "mime": "image/jpeg", "size": 23456, "width": 480, "height": 360,
                 "key": "...", "noncePrefix": "...", "recordSize": 262144 } | null
  } ],
  "replyTo": { "id": 40, "senderId": "u_...", "snippet": "first 200 chars" } | null }
// kind "edit:<id>"
{ "kind": "edit:<id>", "body": "new text",
  "target": { "senderId": "u_...", "clientId": "<the original message's clientId>" },
  "seq": 1 }                      // 1 for the first edit, then 2, 3, ...
// kind "reaction:<id>"
{ "kind": "reaction:<id>", "emoji": "❤️",
  "target": { "senderId": "u_...", "clientId": "<the original message's clientId>" } }
```

- `target` binds an edit or reaction to the original message, not just to the server's message id: it must equal the shown message's `senderId` and `clientId` (and, for edits, the original this device decrypted under that id), else the edit shows as `message-undecryptable` and the reaction is ignored.
- `seq` numbers a message's edits. The device remembers the highest `seq` (and its text) per message; an older edit served again shows the newest one seen. An edit without a valid `seq` doesn't show.
- `replyTo.snippet` is only a fallback: a reply quote shows the quoted message as this device decrypted it (current text, edits included) whenever it's loaded, and the sender's snippet only when it isn't, marked "Quoted by sender" (`reply-quoted-by-sender`).

### Files (photos, videos, voice, thumbnails)

- Encrypt in **records** of `recordSize` = 256 KiB plaintext (the last one may be shorter).
- Record `i` uses nonce `noncePrefix (8 bytes) || uint32_be(i)` and `aad = utf8('tealtalk-file-v1') || uint32_be(i) || (0x01 if last record else 0x00)`, so missing, reordered or cut-off records fail to decrypt.
- Ciphertext size = size + 16 × number of records. An empty file is one empty final record.
- Encrypt while uploading. Because each record is deterministic given the key, nonce prefix and index, a resumed upload re-encrypts from the record containing the server's offset and continues.
- Upload with type **`application/vnd.tealtalk.e2ee`**. The server stores opaque bytes with that type and skips the magic-byte check for it. Real type, size, dimensions and duration live only in the encrypted payload.
- Download the whole ciphertext (with progress), decrypt record by record into Blob parts with the real mime, and use an object URL (revoke it when done). Only small things download by themselves: thumbnails up to 1 MB, and files up to 40 MB (videos, and photos without a thumbnail, whose preview is the photo itself). Anything bigger shows `media-load` and waits for a tap. Videos play from the decrypted Blob. Range streaming of encrypted video is a later improvement.
- GPS stripping still happens before encryption.

## Safety numbers

- `fingerprint(user) = first 30 bytes of SHA-256 applied 1024 times to (0x00 0x01 || sigPub || encPub || utf8(userId))`. Each round hashes the previous output concatenated with the original input.
- Each 5-byte chunk → uint40 mod 100000 → 5 digits, giving 30 digits per user.
- Pair number = the lower userId's 30 digits followed by the other's: 60 digits in 12 groups of 5. It's identical on both phones.
- UI: chat header or group info → `verify-safety-button` → `safety-screen` with `safety-number` (the digits), `mark-verified-button` / `unmark-verified-button`. A verified contact shows `verified-badge`. If a **verified** contact's key changes, sending to them shows `safety-interstitial` with "Verify again" or "Send anyway" (`safety-send-anyway`) until acknowledged.

## Server API changes

| Method & path | Body | Response |
| --- | --- | --- |
| `PUT /api/keys` | `{ bundle, backup }` | `200 { bundle }`. Validates: both keys are uncompressed P-256 spki (exactly 91 bytes), keyId recomputes, selfSig verifies for this userId, createdAt at most 1 day ahead of server time and at most 1 day behind it (the behind limit is waived only when the account has no current key, so a device can put back a key the server lost), backup shape (≤ 4 KB). Re-sending the current keyId is a no-op `200`. A keyId from the user's history that isn't current, or a createdAt not newer than the current bundle's, is `409 { error: "key_rollback" }`: an old (possibly stolen) key never becomes current again. At most 5 key changes per user per 24 hours (`429`). Replaces the current bundle; old bundles are kept (read-only) so old messages still verify. Sends a `keys` WS event `{ userId, bundle }` to everyone sharing a conversation (and to the user's own other sockets) |
| `GET /api/keys/me` | - | `{ bundle: Bundle or null, backup: Backup or null }` (owner only) |
| `GET /api/keys?userIds=u1,u2` | - | `{ keys: { u1: Bundle or null } }`, current bundles, max 100 ids, only users you share a conversation with or can search (404-safe: unknown → null) |
| `GET /api/keys/:userId?keyId=` | - | `{ bundle }` for that historic key, same visibility rule |
| `POST /api/conversations/:id/messages` | `{ clientId, e2ee, attachmentIds?: [...max 20], replyToId? }` | Encrypted only. A plaintext `body` or `attachmentId` returns `400 { error: "Please reload TealTalk to get the encrypted version." }`. See validation below |
| `PATCH /api/conversations/:id/messages/:msgId` | `{ clientId, e2ee }` (kind `edit:<id>`) | same rules as before (sender, 15 min), validated like a message |
| `PUT /api/conversations/:id/messages/:msgId/reaction` | `{ clientId, e2ee }` (kind `reaction:<id>`) | one per user per message as before |

**Envelope validation on the server** (it can't decrypt, but it can enforce delivery to everyone):
- Shape: all fields present, b64u lengths sane, envelope JSON ≤ 64 KB, `kind` matches the route and message id.
- `senderKeyId` = the sender's current keyId, else `409 { error: "keys_changed" }`.
- `keys` userIds = **exactly** the members who can see this message (for edits and reactions: members who can see the target message), else `409 { error: "members_changed", members: [userIds] }`.
- Each `k` = that member's current keyId, else `409 { error: "keys_changed", keys: { userId: Bundle } }`.
- A member with no keys at all: `409 { error: "missing_keys", missing: [userIds] }`. The client shows "Waiting for Maya to open TealTalk" and keeps the message queued.
- Each id in `attachmentIds` must be the sender's own upload of type `application/vnd.tealtalk.e2ee`, not yet attached to another message.

**Data shape changes:**
- Message gains `e2ee: Envelope | null` (null for legacy and system messages); `body` is `""` for encrypted messages.
- `attachments: [{ id, size }]` lists the opaque files, and `attachment` stays null for encrypted messages. Expired files show `expired: true`.
- `replyTo` becomes `{ id, senderId, deleted }`, because the snippet is in the encrypted payload.
- `reactions` becomes `{ "<userId>": Envelope }`. Clients decrypt to get the emoji.
- Edits replace `e2ee` and set `editedAt`.
- Legacy plaintext messages (from before v3) keep their old fields and show a small "Not encrypted" note in the client (`legacy-unencrypted-label`).

**Details settled while building the server:**
- `message.e2eeClientId`: the clientId the current envelope's AAD uses (the original, or the latest edit's). Reactions also come with `reactionClientIds: { userId: clientId }`.
- `message.legacyReactions: { emoji: [userIds] }` (always present, `{}` when empty) holds reactions from before v3. An encrypted reaction from that person replaces their legacy one.
- Edits are allowed only on encrypted, text-only messages (`400` otherwise), so an edit can never drop file keys.
- Thumbnails are separate encrypted uploads, and their ids must also be listed in `attachmentIds`.
- Strict shapes: no extra fields; canonical unpadded b64u; `iv` 12 bytes; `sig`/`selfSig` 64 bytes; each `w` exactly 60 bytes; `eph` must be an uncompressed P-256 spki (91 bytes). `clientId` (messages, edits, reactions) must match `^[A-Za-z0-9_-]{1,64}$`, so it can never contain the AAD's `|` separator.
- `MAX_UPLOAD_MB` limits the real file: an encrypted upload may be up to `MAX + 16 × ceil(MAX / 256 KiB)` bytes (its GCM tags). Envelopes over 64 KB get `413`. `backup.keyId` must equal `bundle.keyId`, and `PUT /api/keys` requires the backup.
- 409 checks run in this order: sender key, exact members, missing keys, recipient keys. `keys_changed.keys` lists only the changed members.
- Uploads never attached to a message are deleted after 7 days.

**Push:** the payload is `{ conversationId, messageId, senderId, clientId, title: sender display name or group title, e2ee: Envelope if the whole payload stays ≤ 3000 bytes }`. senderId and clientId let the service worker rebuild the AAD. The service worker opens IndexedDB, decrypts and shows the real text preview. If it can't decrypt, it shows "New message". Previews of photos say "Photo" and so on.

## App fingerprint

`npm run fingerprint` prints the SHA-256 over the sorted list of `path + '\n' + sha256(file)` lines for every file in `public/`. Settings → About shows the same value (`app-fingerprint`) computed by the client from the service worker's cached copies. Release notes publish it.

This in-app number **only catches accidental drift** (a stale or half-updated copy of the app). A malicious server can serve an app that displays the expected fingerprint. Real verification has to happen outside the app: for example saving the files the browser received and comparing their hashes with the GitHub release, or a future native app whose code doesn't come from the server.

## Tests that prove it

- Crypto unit tests in Node (WebCrypto, same modules as the browser): round trips; tampering with ct, iv, keys, eph, sig, senderKeyId or kind fails; moving an envelope to another conversation or clientId fails; files fail on record swap, truncation or extension; resume re-encryption is byte-identical; backup round trip and wrong recovery key fail; safety numbers are identical from both sides and change when a key changes.
- Server tests for the validation rules above, including key rollback, the key-change rate limit, clientId characters, 91-byte spki and the encrypted upload size (`tests/e2ee-hardening.test.js`).
- `tests/trust.test.js` runs the real `public/js/e2ee.js` and `outbox.js` against a stand-in server and proves the trust rules: older- or future-dated keys, server-added recipients, the server claiming my key changed or vanished, moved or rolled-back edits and reactions, server-written plaintext, the recovery key never stored, pins kept across logout, and the encrypted outbox.
- The e2e test reads the server's SQLite file and every uploaded file after the scenario and asserts that **no plaintext appears anywhere**: the message texts, the emoji, a known photo byte sequence. It also checks new-device recovery, start fresh, and a safety-number change notice on both phones.

## Roadmap after v3

1. Per-device keys with device linking by QR code, so a lost device can be cut off without a reset.
2. Forward secrecy (double ratchet for 1:1, MLS for groups).
3. Encrypted group names and avatars.
4. Streaming decryption of large videos via the service worker.
5. Group membership signed by the members, so the server can't add anyone to a group.
