# TealTalk protocol and build contract

This is the single source of truth that the server (`server/`), the client (`public/`) and the tests (`tests/`) are built against. If you need to change it, change this file too.

## Principles

- **Full quality, both directions.** Photos and videos arrive exactly as they were sent: no downscaling, no "compressed for MMS". Reactions, replies, edits, unsend, voice messages and group management work identically between iPhone and Android.
- **Same app on Android and iPhone.** The client is an installable PWA (Add to Home Screen on iOS Safari, Install on Android Chrome). No platform gets a different colour, fewer features or a "degraded" mode. Nobody is on blue: your bubbles are teal, everyone else's are neutral grey, on every device.
- **No ads, no trackers, no analytics, no third-party requests.** The server never contacts anyone except the push service the user's own browser picked (Apple/Google/Mozilla web push endpoints). The client loads nothing from a CDN; everything is served from the TealTalk server. CSP enforces this.
- **Zero-build.** Plain HTML/CSS/ES modules in `public/`. Node 22.5+ server. Only npm dependencies: `ws` and `web-push`.
- Storage: `node:sqlite` (`DatabaseSync`). Uploaded files live in `DATA_DIR/uploads/`.

## Server configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `./data` | SQLite database, uploads, generated VAPID keys |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | contact for web push |

`server/index.js` exports `createApp({ dataDir, port })` which returns a promise of `{ url, port, close() }`; `port: 0` picks a free port. When run directly (`node server/index.js`) it starts on `PORT`.

## Data shapes

```jsonc
// User (public)
{ "id": "u_8f3k...", "username": "sam", "displayName": "Sam" }

// Message
{
  "id": 42,                    // integer, globally increasing: use it for ordering and paging
  "conversationId": "c_...",
  "senderId": "u_...",
  "clientId": "uuid from the client, for idempotent retries",
  "body": "hi",                // string, may be "" when there is an attachment. Max 4000 chars.
  "attachment": null,          // or { "id": "a_...", "mime": "image/jpeg", "size": 12345 }
  "createdAt": 1790000000000   // ms since epoch, server time
}

// Conversation (as seen by the requesting user)
{
  "id": "c_...",
  "title": null,               // null for 1:1; groups may have a title
  "isGroup": false,
  "members": [User, ...],      // includes the requesting user
  "lastMessage": Message | null,
  "unreadCount": 0,            // messages from others with id > my last read id
  "readUpTo": { "u_...": 41 }, // each member's last read message id (0 if none)
  "createdAt": 1790000000000,
  "updatedAt": 1790000000000   // createdAt of lastMessage, or conversation createdAt
}
```

IDs other than message ids are random strings with a type prefix (`u_`, `c_`, `a_`).

## Auth

- Username: 3-24 chars, `^[a-z0-9_]+$` after lowercasing and trimming. Unique.
- Password: 8-200 chars. Hashed with `crypto.scrypt` + per-user random salt; compared with `timingSafeEqual`.
- Display name: 1-40 chars after trim; defaults to the username.
- Session token: 32 random bytes, base64url. Stored hashed (SHA-256) server-side. No expiry until logout.
- Send it as `Authorization: Bearer <token>` on HTTP, and as `?token=<token>` on the WebSocket URL and on attachment GETs (so `<img src>` works).
- Login and register are rate limited per IP (e.g. 20 attempts / 10 minutes -> `429`).

## HTTP API

All bodies are JSON unless stated. Errors are `{ "error": "human readable message" }` with a 4xx/5xx status. `401` when the token is missing or invalid, `403` when you are not a member of the conversation, `404` when it does not exist.

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /api/register` | `{ username, password, displayName? }` | `201 { token, user }` (409 if username taken, 400 if invalid) |
| `POST /api/login` | `{ username, password }` | `200 { token, user }` (401 wrong credentials) |
| `POST /api/logout` | - | `204`, token revoked |
| `GET /api/me` | - | `{ user }` |
| `PATCH /api/me` | `{ displayName }` | `{ user }` |
| `GET /api/users/search?q=sa` | - | `{ users: [User] }` prefix match on username or display name, max 20, excludes me |
| `GET /api/conversations` | - | `{ conversations: [Conversation] }` sorted by `updatedAt` desc |
| `POST /api/conversations` | `{ memberIds: [userId...], title? }` | `201 { conversation }`. With exactly one other member and no title it is a 1:1: if a 1:1 between the two already exists return it with `200`. Otherwise it is a group (`isGroup: true`). |
| `GET /api/conversations/:id` | - | `{ conversation }` |
| `GET /api/conversations/:id/messages?before=<msgId>&limit=50` | - | `{ messages: [Message] }` oldest first, the `limit` (max 100) newest messages with id < before |
| `POST /api/conversations/:id/messages` | `{ clientId, body?, attachmentId? }` | `201 { message }`. Needs a non-empty trimmed body or an attachment owned by the sender. Same `clientId` from the same sender returns the existing message with `200` (idempotent retry). |
| `POST /api/conversations/:id/read` | `{ messageId }` | `204`. Only moves forward. |
| `POST /api/attachments` | raw bytes, `Content-Type: image/jpeg|png|gif|webp` | `201 { attachment: { id, mime, size } }`. Max 10 MB (413). Other types 415. |
| `GET /api/attachments/:id?token=` | - | the bytes, with the stored mime type. Only members of a conversation containing it (or the uploader) may read it. `Cache-Control: private, max-age=31536000, immutable`. |
| `GET /api/push/public-key` | - | `{ publicKey }` (VAPID, generated on first start and saved in `DATA_DIR`) |
| `POST /api/push/subscribe` | `{ subscription }` (PushSubscription JSON) | `204` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `204` |
| `GET /api/health` | - | `{ ok: true }` (no auth) |

## WebSocket: `GET /ws?token=<token>`

Invalid token: close with code `4401`. All frames are JSON text.

Server -> client:

| `type` | Fields | When |
| --- | --- | --- |
| `hello` | `user` | right after connecting |
| `message` | `message` | a message was posted in one of my conversations (including my own, from any of my devices) |
| `conversation` | `conversation` | a conversation I'm in was created or changed (sent to every member, shaped for that member) |
| `read` | `conversationId, userId, messageId` | a member's read position moved |
| `typing` | `conversationId, userId` | a member (not me) is typing; clients show it for ~4 s |
| `presence` | `userId, online` | someone I share a conversation with came online / went offline (last socket closed) |
| `pong` | - | reply to `ping` |

Client -> server:

| `type` | Fields |
| --- | --- |
| `typing` | `conversationId` (throttle to one per 2 s) |
| `ping` | - (every 25 s; reconnect if no pong within 10 s) |

Sending messages and read receipts goes over HTTP so it gets a status code; the server then fans the result out over WebSocket.

## Push notifications

When a message is posted, each other member who has **no open WebSocket** gets a web push to every saved subscription: payload `{ "title": "<sender display name or group title>", "body": "<text preview, max 100 chars, or 'Photo'>", "conversationId": "c_..." }`. Subscriptions that return 404/410 are deleted. Push failures never fail the message request.

iOS only delivers web push to a PWA that was added to the Home Screen (iOS 16.4+), so the client explains that when notifications are unsupported.

## Client: element contract for tests

The client is a single page (`public/index.html` + `public/app.js`). The e2e tests locate things **only** through these `data-testid`s, so keep them stable:

| testid | Element |
| --- | --- |
| `auth-screen` | the login/register screen container |
| `auth-username`, `auth-password`, `auth-displayname` | inputs (`auth-displayname` only visible in register mode) |
| `auth-submit` | submit button |
| `auth-toggle` | switches between "Log in" (the default mode) and "Create account" |
| `auth-error` | error text |
| `chats-screen` | the conversation list screen |
| `new-chat-button` | opens the new-chat screen |
| `conversation-item` | one row per conversation, with `data-conversation-id` |
| `unread-badge` | inside a `conversation-item` when unreadCount > 0, text is the count |
| `new-chat-screen` | new chat screen |
| `user-search-input` | search box |
| `user-result` | one per search hit, with `data-user-id`; clicking toggles selection |
| `group-title-input` | optional group name |
| `create-chat-button` | creates (or opens) the chat |
| `chat-screen` | an open conversation |
| `chat-title` | conversation name in the header |
| `back-button` | back to the list from a chat (the new-chat and settings screens use `new-chat-back` and `settings-back`, because testids must be unique in the page) |
| `message` | one per message, with `data-message-id` (or `data-client-id` while pending) and `data-mine="true"|"false"` |
| `message-body` | text inside a `message` |
| `message-image` | `<img>` inside a `message` with an attachment |
| `message-status` | on my own messages: `sending`, `sent` or `read` as text content (exact lowercase word); `read` in a group means every other member has read it. `failed` (with a Retry button) only when the server rejects the message with a 4xx |
| `typing-indicator` | visible while someone else is typing |
| `message-input` | the composer textarea |
| `send-button` | send |
| `attach-input` | the `<input type="file" accept="image/*">` |
| `settings-button`, `settings-screen`, `displayname-input`, `save-settings-button`, `logout-button`, `enable-notifications-button`, `install-button` | settings |
| `connection-status` | hidden when connected; shows "Connecting..." / "Offline" otherwise |

Screens that are not active must be hidden (`hidden` attribute or `display:none`) so Playwright's visibility checks work.

Every testid is unique in the page: list items (`conversation-item`, `user-result`, `message`) exist only while their screen is open.

## Full-quality messaging (v2)

This section extends and, where it conflicts, overrides the sections above. Texting to phone numbers (SMS/Twilio) was removed: both people use TealTalk.

### Configuration additions

| Env | Default | Meaning |
| --- | --- | --- |
| `SIGNUP_CODE` | unset | if set, `POST /api/register` requires `{ signupCode }` to match (`403 { error: "That signup code isn't right." }`) |
| `MAX_UPLOAD_MB` | `250` | largest single photo/video/voice file |
| `MEDIA_RETENTION_DAYS` | `0` (keep forever) | if > 0, files older than this are deleted from the server (an hourly sweep). The message stays and its attachment gets `expired: true`. This is the main hosting-cost lever. |

### Data shape changes

```jsonc
// Attachment
{
  "id": "a_...", "mime": "video/mp4", "size": 48213450,
  "kind": "image" | "video" | "audio",
  "width": 1920, "height": 1080,      // null if unknown
  "durationMs": 12000,                // video/audio, null otherwise/unknown
  "thumbnailId": "a_..." | null,      // small JPEG preview (images and videos)
  "expired": false                    // true once removed by MEDIA_RETENTION_DAYS
}

// Message gains
"replyTo": null | { "id": 40, "senderId": "u_...", "body": "first 200 chars", "attachmentKind": "image" | null, "deleted": false },
"reactions": { "❤️": ["u_a", "u_b"], "😂": ["u_c"] },   // {} when none; each user has at most ONE reaction per message
"editedAt": null | 1790000000000,
"deletedAt": null | 1790000000000,  // unsent: body "", attachment null, reactions {}, replyTo null
"system": null | { "type": "member_added" | "member_left" | "renamed", "userIds": ["u_..."], "title": "..." }
                                     // senderId is the person who did it; body is ""
```

Every change to an existing message (reaction, edit, unsend) is broadcast as a normal `message` WS event carrying the full updated message with the same `id`. Clients replace it in place and never duplicate. Only brand-new messages count toward `unreadCount` and trigger push.

Conversations are still returned as before; `sms` fields no longer exist. `GET /api/me` returns `{ user }`.

### Uploads: full quality and resumable

- Accepted types: images `image/jpeg|png|gif|webp`; video `video/mp4|video/quicktime|video/webm`; audio `audio/mp4|audio/aac|audio/mpeg|audio/webm|audio/ogg`. The server checks the file's first bytes (magic numbers) against the declared type family and rejects mismatches with `415`. Files are always served with the stored type and `X-Content-Type-Options: nosniff`.
- **Small files (<= 10 MB)**: `POST /api/attachments` as before (raw body). Optional query `?width=&height=&durationMs=&thumbnailId=`.
- **Any size up to `MAX_UPLOAD_MB`**: resumable, in chunks, so a dropped connection on a phone doesn't restart a 200 MB video:

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /api/uploads` | `{ mime, size }` | `201 { uploadId, chunkSize: 5242880, received: 0 }`. `413` if too big, `415` bad type |
| `PUT /api/uploads/:id` | raw chunk (<= chunkSize), header `Upload-Offset: <n>` | `200 { received }`. `409 { received }` if the offset isn't exactly `received` (client resumes from there) |
| `GET /api/uploads/:id` | - | `{ received, size }` |
| `POST /api/uploads/:id/complete` | `{ width?, height?, durationMs?, thumbnailId? }` | `201 { attachment }` once `received == size` (else `409`). Magic-byte check happens here. |

| `DELETE /api/uploads/:id` | - | `204`: cancel and free the upload |

Only the uploader can touch an upload (`403` otherwise). A chunk over `chunkSize` gets `413`; an empty chunk or one past the end gets `400`; a second chunk sent while one is still arriving gets `409 { received }`. Bad metadata at `complete` gets `400`, and the upload can be completed again. A magic-byte mismatch at `complete` gets `415`, and the upload is deleted. Each person can have 5 unfinished uploads: starting a 6th replaces their oldest idle one, and it's `429` only if all 5 are receiving right now. Unfinished uploads are deleted 24 h after they started.
- A file can be attached to only one message (`400` on reuse). A thumbnail must be one of the sender's own images, and voice messages don't take one.
- An expired attachment returns `410`. After unsend, the attachment and its thumbnail are gone (`404`).
- `GET /api/attachments/:id` supports **HTTP Range requests** (`Accept-Ranges: bytes`, `206`, `416`). iPhone Safari won't play video without it. Same permission rules as before. `thumbnailId` attachments follow the permissions of the attachment that references them.

### Client rules for media

- **Photos go at full resolution.** Don't downscale or re-encode the original. For JPEGs, remove the GPS location from the EXIF data in place (overwrite the GPS IFD values; keep orientation and everything else) so sharing a photo doesn't share where you live. Also make a small JPEG thumbnail (longest side 480px) for the chat bubble. Tapping opens a full-screen viewer (`image-viewer`) that loads the original.
- **Videos go as the original file** with a poster thumbnail grabbed from an early frame. They play inline (`<video playsinline controls preload="metadata">`). If `video.canPlayType(mime)` says the device can't play it (e.g. an iPhone HEVC `.mov` on an older Android), show the poster plus a clear "Download to watch" link instead of a broken player.
- **Voice messages**: hold or tap the mic (`record-button`) and record with MediaRecorder, **preferring `audio/mp4` (AAC)** because it plays on both iPhone and Android. Fall back to `audio/webm;codecs=opus` only if mp4 recording isn't supported. Show a player with duration.
- Uploads show progress (`upload-progress`), survive a dropped connection (resume via `GET /api/uploads/:id`) and can be cancelled.

### Security headers (v2)

The CSP adds `media-src 'self' blob:` so videos, voice messages and local previews play. `Permissions-Policy` allows `microphone=(self)` for voice messages, and camera, geolocation etc. stay off.

### Reactions, replies, edit, unsend

| Method & path | Body | Response |
| --- | --- | --- |
| `PUT /api/conversations/:id/messages/:msgId/reaction` | `{ emoji }` (1 emoji, max 16 bytes UTF-8) | `200 { message }`. Replaces my previous reaction on that message |
| `DELETE /api/conversations/:id/messages/:msgId/reaction` | - | `200 { message }` |
| `POST /api/conversations/:id/messages` | adds optional `replyToId` (same conversation, else `400`) | as before |
| `PATCH /api/conversations/:id/messages/:msgId` | `{ body }` | `200 { message }`. Sender only (`403`), text messages only, within **15 minutes** of sending (`409` after), not system/deleted |
| `DELETE /api/conversations/:id/messages/:msgId` | - | `200 { message }` (unsent). Sender only, within **24 hours**. Deletes the file(s) from disk too. Replies quoting it show `replyTo.deleted: true` |

You can't react to, reply to or edit unsent or system messages (`400`). A reply's `replyTo` quote is looked up live: when the original is edited or unsent, the replies are re-sent as `message` events with the updated quote.

### Groups

| Method & path | Body | Response |
| --- | --- | --- |
| `PATCH /api/conversations/:id` | `{ title }` | groups only (1-80 chars; `400` for 1:1 or empty). Adds a `renamed` system message (`userIds: []`, `title` set; `title` is null for the other system types). Renaming to the same title adds nothing |
| `POST /api/conversations/:id/members` | `{ userIds: [...] }` | groups only, any member can add; `200 { conversation }`. Adds a `member_added` system message. New members see history from when they joined onward (messages before `joinedAfterMessageId` are hidden from them) |
| `DELETE /api/conversations/:id/members/me` | - | leave a group (`204`). Adds a `member_left` system message. The conversation disappears from my list; I get a `conversation_removed` WS event `{ conversationId }` |

Everyone affected gets a `conversation` WS event with the updated member list, and new members also get it so the chat appears for them.

### New testids

| testid | Element |
| --- | --- |
| `auth-signupcode` | signup code input (register mode only) |
| `message-menu` | opened by long-press (touch) or right-click / hover button (desktop) on a message |
| `reaction-option` | inside `message-menu`, one per quick emoji (`data-emoji`): ❤️ 👍 😂 😮 😢 🙏 |
| `menu-reply`, `menu-edit`, `menu-unsend`, `menu-copy` | menu actions (edit/unsend only on my own eligible messages) |
| `message-reactions` | reaction chips under a message; each chip is `reaction-chip` with `data-emoji`, text = emoji + count; tapping my own chip removes it |
| `reply-preview`, `reply-cancel` | "Replying to ..." bar above the composer |
| `message-reply-quote` | quoted message inside a reply bubble; clicking scrolls to the original |
| `message-edited` | "Edited" label |
| `message-unsent` | "This message was unsent" placeholder |
| `edit-bar`, `edit-cancel` | shown while editing a message in the composer |
| `message-video` | `<video>` in a message; `message-video-download` when the device can't play it |
| `message-audio` | voice message player; `record-button`, `record-cancel`, `record-send` while recording |
| `message-image` | now the **thumbnail** `<img>`; `image-viewer`, `image-viewer-close` for full size |
| `upload-progress` | progress indicator on a sending media message; `upload-cancel` |
| `system-message` | centered grey line for member_added / member_left / renamed |
| `group-info-button`, `group-info-screen`, `add-members-button`, `leave-group-button`, `rename-button`, `rename-input`, `rename-save-button` | group management |
