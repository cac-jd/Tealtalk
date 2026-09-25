# TealTalk protocol and build contract

This is the single source of truth that the server (`server/`), the client (`public/`) and the tests (`tests/`) are built against. If you need to change it, change this file too.

## Principles

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
| `auth-toggle` | switches between "Log in" and "Create account" |
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
| `back-button` | back to the list |
| `message` | one per message, with `data-message-id` (or `data-client-id` while pending) and `data-mine="true"|"false"` |
| `message-body` | text inside a `message` |
| `message-image` | `<img>` inside a `message` with an attachment |
| `message-status` | on my own messages: `sending`, `sent` or `read` as text content (exact lowercase word) |
| `typing-indicator` | visible while someone else is typing |
| `message-input` | the composer textarea |
| `send-button` | send |
| `attach-input` | the `<input type="file" accept="image/*">` |
| `settings-button`, `settings-screen`, `displayname-input`, `save-settings-button`, `logout-button`, `enable-notifications-button` | settings |
| `connection-status` | hidden when connected; shows "Connecting..." / "Offline" otherwise |

Screens that are not active must be hidden (`hidden` attribute or `display:none`) so Playwright's visibility checks work.
