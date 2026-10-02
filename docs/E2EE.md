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

1. **The server delivers the app's code.** TealTalk is a web app, so a malicious or hacked server could send a modified app that leaks keys. Settings shows an **app fingerprint** you can compare against the one published on GitHub for each release. An App Store version (later, with approval) removes this risk.
2. **No forward secrecy yet.** If someone steals your key and your recovery key, they can decrypt past messages they've also copied from the server. Signal's "double ratchet" fixes this. It's a later upgrade (see the roadmap at the end).
3. **One key per account**, shared by your devices through the recovery key. A lost device can't be cut off on its own: reset your key instead (contacts see a safety-number change).

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

IndexedDB database `tealtalk-keys`, object store `account`, keyed by userId: `{ userId, keyId, encPriv, sigPriv, encPub, sigPub, recoveryKey }`. The private keys are **non-extractable CryptoKey objects**: page scripts can use them but can never read them out. Store `contacts` holds `{ userId, keyId, verified: bool, firstSeenAt }` (trust-on-first-use pins). Call `navigator.storage.persist()` at setup.

**Generation:** generate extractable key pairs → export `pkcs8` → build the backup → re-import as non-extractable for daily use → drop the extractable copies.

### Recovery key and backup

- Recovery key: 20 random bytes, shown as 32 Crockford base32 characters in 8 groups of 4 (`7K3M-…`). Typing is case-insensitive, and O/I/L are read as 0/1/1.
- `backupKey = HKDF(ikm = recovery bytes, salt = utf8('tealtalk-backup|' + userId), info = utf8('tealtalk-backup-v1'))` → AES-256-GCM.
- `backup = { v: 1, keyId, iv, ct }`, where `ct = AES-GCM(backupKey, iv, utf8(JSON{ encPriv: b64u pkcs8, sigPriv: b64u pkcs8 }), aad = utf8(userId + '|' + keyId))`.
- 160 random bits can't be guessed offline, so no slow password hashing is needed. Never derive this from the account password.

### Flows

- **First login on any device, account has no keys:** generate, `PUT /api/keys`, show the recovery key (`recovery-key-display`, `recovery-copy-button`, `recovery-saved-button`). It can be viewed again later in Settings (`show-recovery-key-button`).
- **Login on a new device, account has keys:** "Enter your recovery key" (`recovery-screen`, `recovery-input`, `recovery-submit`, `recovery-error`). Decrypt the backup and check that the keyId matches. The option "Start fresh" (`recovery-reset-button`, after a confirm) makes new keys: old messages can't be read on any device that doesn't have the old key, and contacts see a safety-number change.
- **Logout** deletes the local keys after warning: "You'll need your recovery key to read your messages after logging back in."
- **Reset key** in Settings (`reset-keys-button`): same as Start fresh.

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
- `canonical(x)` = JSON with object keys sorted recursively and no whitespace.
- For edits and reactions, `clientId` is a fresh random id sent alongside the envelope.

### Receiving

1. Look up the sender's bundle for `senderKeyId` (cache by keyId; `GET /api/keys/:userId?keyId=` for old ones).
2. Verify `sig` first. If it fails, show "Couldn't verify this message" and don't decrypt.
3. Unwrap `keys[me]` with my encPriv, then decrypt `ct`. Any failure shows `message-undecryptable`: "Can't decrypt this message", for example when it was sent to a key this device doesn't have.
4. Check `payload.kind` equals `envelope.kind`.

Pin the sender's keyId on first sight. If a later message comes from a different keyId, show a local notice `safety-change-notice`: "Maya's safety number changed" (with the time) in every chat with that person.

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
{ "kind": "edit:<id>", "body": "new text" }
// kind "reaction:<id>"
{ "kind": "reaction:<id>", "emoji": "❤️" }
```

### Files (photos, videos, voice, thumbnails)

- Encrypt in **records** of `recordSize` = 256 KiB plaintext (the last one may be shorter).
- Record `i` uses nonce `noncePrefix (8 bytes) || uint32_be(i)` and `aad = utf8('tealtalk-file-v1') || uint32_be(i) || (0x01 if last record else 0x00)`, so missing, reordered or cut-off records fail to decrypt.
- Ciphertext size = size + 16 × number of records. An empty file is one empty final record.
- Encrypt while uploading. Because each record is deterministic given the key, nonce prefix and index, a resumed upload re-encrypts from the record containing the server's offset and continues.
- Upload with type **`application/vnd.tealtalk.e2ee`**. The server stores opaque bytes with that type and skips the magic-byte check for it. Real type, size, dimensions and duration live only in the encrypted payload.
- Download the whole ciphertext (with progress), decrypt record by record into Blob parts with the real mime, and use an object URL (revoke it when done). Videos play from the decrypted Blob. Range streaming of encrypted video is a later improvement.
- GPS stripping still happens before encryption.

## Safety numbers

- `fingerprint(user) = first 30 bytes of SHA-256 applied 1024 times to (0x00 0x01 || sigPub || encPub || utf8(userId))`. Each round hashes the previous output concatenated with the original input.
- Each 5-byte chunk → uint40 mod 100000 → 5 digits, giving 30 digits per user.
- Pair number = the lower userId's 30 digits followed by the other's: 60 digits in 12 groups of 5. It's identical on both phones.
- UI: chat header or group info → `verify-safety-button` → `safety-screen` with `safety-number` (the digits), `mark-verified-button` / `unmark-verified-button`. A verified contact shows `verified-badge`. If a **verified** contact's key changes, sending to them shows `safety-interstitial` with "Verify again" or "Send anyway" (`safety-send-anyway`) until acknowledged.

## Server API changes

| Method & path | Body | Response |
| --- | --- | --- |
| `PUT /api/keys` | `{ bundle, backup }` | `200 { bundle }`. Validates: both keys parse as P-256 spki, keyId recomputes, selfSig verifies for this userId, createdAt within ±1 day of server time, backup shape (≤ 4 KB). Replaces the current bundle; old bundles are kept (read-only) so old messages still verify. Sends a `keys` WS event `{ userId, bundle }` to everyone sharing a conversation (and to the user's own other sockets) |
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

**Push:** the payload is `{ conversationId, messageId, title: sender display name or group title, e2ee: Envelope if the whole payload stays ≤ 3000 bytes }`. The service worker opens IndexedDB, decrypts and shows the real text preview. If it can't decrypt, it shows "New message". Previews of photos say "Photo" and so on.

## App fingerprint

`npm run fingerprint` prints the SHA-256 over the sorted list of `path + '\n' + sha256(file)` lines for every file in `public/`. Settings → About shows the same value (`app-fingerprint`) computed by the client from the service worker's cached copies. Release notes publish it.

## Tests that prove it

- Crypto unit tests in Node (WebCrypto, same modules as the browser): round trips; tampering with ct, iv, keys, eph, sig, senderKeyId or kind fails; moving an envelope to another conversation or clientId fails; files fail on record swap, truncation or extension; resume re-encryption is byte-identical; backup round trip and wrong recovery key fail; safety numbers are identical from both sides and change when a key changes.
- Server tests for the validation rules above.
- The e2e test reads the server's SQLite file and every uploaded file after the scenario and asserts that **no plaintext appears anywhere**: the message texts, the emoji, a known photo byte sequence. It also checks new-device recovery, start fresh, and a safety-number change notice on both phones.

## Roadmap after v3

1. Per-device keys with device linking by QR code, so a lost device can be cut off without a reset.
2. Forward secrecy (double ratchet for 1:1, MLS for groups).
3. Encrypted group names and avatars.
4. Streaming decryption of large videos via the service worker.
