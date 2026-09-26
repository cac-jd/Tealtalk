# What changes if TealTalk gets to 1 million users

Today TealTalk is built for **one server that you run for your people**: a single Node process, one SQLite file and photos on the same disk. That's the right shape for friends and family and is cheap to run. It won't carry a million users, but nothing in the design blocks getting there. The API contract (`PROTOCOL.md`) and the app can stay the same while the server underneath changes.

## How big is "1 million users"?

These are rough planning numbers. Real usage will differ.

| | Assumption | Result |
| --- | --- | --- |
| Daily active users | ~30% of 1M | ~300k |
| Connected at the busiest moment | ~10-30% of daily users | ~30k-100k open WebSockets |
| Messages | ~30 per active user per day | ~9M/day, ~100/s average, ~1,000/s peaks |
| Message text storage | ~300 bytes with indexes | ~3 GB/day, ~1 TB/year |
| Photos | ~1 per active user per day at ~300 KB | ~90 GB/day, ~30 TB/year |

A modest cluster handles TealTalk chat at this size. The hard parts are **media storage cost** and **running a public service (safety, law, reliability)**.

## 1. Paying for it without ads

Plain TealTalk messaging is cheap to run. The real cost is **storing full-quality photos and videos**, and how long the server keeps them. The interactive break-even planner compares a $4.99/year subscription, a one-time fee and a free app with a paid "TealTalk Plus" add-on. The short version:

- Keep messaging free, so the people you want to reach actually join.
- The server keeps media for 30 days (`MEDIA_RETENTION_DAYS`), and phones keep their own copies.
- Sell "keep everything forever + restore on a new phone" as Plus. About 1% of people buying it at $4.99/year covers the running costs at 1M users.

Texting regular phone numbers (SMS) was ruled out: it costs money on every message, and it's the reason free texting apps are full of ads.

## 2. Server changes

| Today | At scale | Why |
| --- | --- | --- |
| SQLite file | **PostgreSQL** (managed), messages partitioned by time | many app servers need one shared database; backups and point-in-time recovery |
| One Node process | **Many identical app servers** behind a load balancer | 100k WebSockets and no single point of failure |
| In-memory WebSocket fan-out | **Redis or NATS pub/sub** between servers | a message arriving on server A must reach the recipient connected to server B |
| Photos on local disk | **Object storage (S3 / Cloudflare R2) + CDN**, signed URLs | full-quality video adds up fast (hundreds of TB); the app servers stop serving bytes |
| Push sent inline | **Job queue** with retries | spikes, push service outages |
| In-memory rate limits | Redis-backed limits and abuse scoring | limits must hold across servers |

The code is already split so this is contained: storage lives behind `server/db.js`, so moving to Postgres means rewriting that module rather than the whole app. Attachments and fan-out are similarly isolated.

## 3. App changes

- **App Store and Play Store versions.** The web app works on both phones, but at scale people expect to find it in the stores, and native builds give more reliable notifications and access to contacts. The cheapest route is to wrap the existing web app with Capacitor, rather than rebuilding it.
- **Contact discovery**, so people can find friends already on TealTalk. Invite links are free; phone-number verification costs a few cents per text, which needs approval.
- **Account recovery** and multiple devices per account.
- **End-to-end encryption** (Signal protocol or MLS) for TealTalk-to-TealTalk chats. At this size people expect it, and it means the server can't read messages.

## 4. Running a public service

- **Safety:** block and report buttons, spam detection, rate limits and a way to act on reports. There are legal duties around illegal content, and the US requires reporting child abuse material you become aware of.
- **Legal:** a company entity, terms of service, privacy policy, GDPR/CCPA handling, age limits and a process for law-enforcement requests.
- **Reliability:** monitoring and alerts, on-call, tested backups, load testing and several availability zones.

## Suggested path

1. **Now to a few thousand users:** today's design on one server. Add blocking/reporting, password reset and the Capacitor store builds.
2. **~10k users:** move to Postgres, object storage, Redis fan-out and 2+ app servers. Add end-to-end encryption, phone verification and TealTalk Plus.
3. **~100k to 1M users:** partitioned storage, job queues, a trust & safety process, multiple regions and the business and legal setup to match.

Don't build step 3 before you have step 1's users. Each step can be done without changing the app people already have installed.
