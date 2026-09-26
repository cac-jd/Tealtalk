# TealTalk: rules for anyone (human or agent) working on this repo

## The goal

iPhone and Android people message each other with **no second-class experience**: no blue vs green, no blurry downscaled videos, no "Liked 'your message'" text instead of a reaction, no broken group chats. Everyone gets the same features at full quality on every phone. Both people use TealTalk; we don't try to go through Apple Messages or carrier SMS.

## Hard rules

- **Anything that costs money needs the owner's explicit approval first.** That covers paid APIs (SMS gateways like Twilio are ruled out), hosting, domains, app store accounts, paid libraries, storage and CDNs. You may propose and estimate costs. You may not sign up, buy or wire in a paid service without a yes.
- **No ads, trackers or analytics, ever.** No third-party requests from the app. `tests/e2e` fails if the app contacts any host other than the TealTalk server.
- **Same experience on every platform.** My bubbles are teal and everyone else's grey, on every device. Never gate a feature by platform.
- The owner works in plain language. Explain choices without jargon, and ask before changing direction.

## Working here

- `docs/PROTOCOL.md` is the contract between `server/`, `public/` and `tests/`. Update it with any API or testid change.
- Node 22.5+, no build step. Dependencies are only `ws` and `web-push`; adding one needs a good reason.
- `npm test` runs the server integration tests, and `npm run test:e2e` runs the iPhone and Android browser test. Both must pass before you push.
- Pushes go to `main` on github.com/cac-jd/Tealtalk.
