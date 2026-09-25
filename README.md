# TealTalk

**An ad-free messenger that works the same on Android and iPhone. Nobody is on blue.**

On most phones, who you can message and how well depends on which phone you and your friends bought. TealTalk ignores that. Everyone gets the same app, the same colours and the same features: read receipts, typing indicators, photos and group chats. Your messages are teal and everyone else's are grey, on every device.

- **No ads, no trackers, no analytics.** The app loads nothing from third parties, and a strict Content-Security-Policy enforces that.
- **Android and iPhone:** TealTalk is a Progressive Web App. Open it in the browser and add it to your home screen. It runs full screen like a native app, starts offline and gets push notifications. No app store is needed.
- **You host it.** One small Node server with a single SQLite file. Your messages live on your server and nowhere else.

## Features

- Username + password accounts. No phone number or email needed.
- 1:1 and group chats, with real-time delivery over WebSocket
- Read receipts (sending, sent, read) and typing indicators for everyone
- Photo sharing (downscaled on the device before upload)
- Push notifications on Android and on iPhone (iOS 16.4+, once the app is on the home screen)
- Works offline: the app shell is cached, and messages you write offline are queued and sent when you reconnect, without duplicates
- Dark mode, safe-area aware layout, large tap targets

## Run it

Requires Node 22.5 or later.

```sh
npm install
npm start                       # http://localhost:3000
PORT=8080 DATA_DIR=/srv/tealtalk npm start
```

| Env | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `./data` | SQLite database, uploaded photos and the generated push keys |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | contact address sent to push services |

### Put it on your phones

Phones need **HTTPS** to install the app and to get notifications. Put TealTalk behind any reverse proxy that terminates TLS and forwards WebSockets, for example [Caddy](https://caddyserver.com/):

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

Then:

- **iPhone:** open the site in Safari, tap **Share**, then **Add to Home Screen**. Open TealTalk from the home screen and enable notifications in Settings.
- **Android:** open the site in Chrome and tap **Install app** (or use TealTalk's own Install button in Settings).

## Tests

```sh
npm test            # server integration tests
npm run test:e2e    # browser test: an iPhone user and an Android user chatting (needs Playwright + Chromium)
```

## How it's built

- `server/`: Node HTTP + WebSocket server (`ws`), `node:sqlite` storage, `web-push` for notifications
- `public/`: the PWA in plain HTML, CSS and ES modules, with no build step and no framework
- `docs/PROTOCOL.md`: the API, WebSocket events and UI test contract

## License

MIT
