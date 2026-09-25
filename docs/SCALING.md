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

A modest cluster handles TealTalk-to-TealTalk chat at this size. The two hard parts are **texting phone numbers (money and rules)** and **running a public service (safety, law, reliability)**.

## 1. Texting any phone number is the expensive part

Chat between TealTalk users costs a few cents per user per month to run. Texts to real phone numbers cost real money on every message:

- **A number per user:** roughly $1+ a month each, so about **$1M+ a month** for 1M users.
- **Texts:** roughly 1¢ each with carrier fees. If 20% of users send 10 texts a day, that's ~2M texts a day, about **$600k a month**.
- **Rules:** a service that texts on behalf of many people is registered with US carriers as a platform (an "ISV"), with spam monitoring. If spam gets through, carriers block your numbers for everyone.

That is why free texting apps (like the one with the big Pluto TV ad) are full of ads: ads pay for the texts. TealTalk won't have ads, so the options are:

- **Recommended:** TealTalk-to-TealTalk chat is free. Texting phone numbers is an optional paid add-on (for example a few dollars a month for a number and a monthly text allowance). This covers its own cost with no ads.
- Share a pool of numbers instead of one per user. It's cheaper, but routing replies gets messy and some carriers dislike it.
- An Android-only option that relays texts through the user's own phone and real number. It's free to run, but iPhone users can't have it.

## 2. Server changes

| Today | At scale | Why |
| --- | --- | --- |
| SQLite file | **PostgreSQL** (managed), messages partitioned by time | many app servers need one shared database; backups and point-in-time recovery |
| One Node process | **Many identical app servers** behind a load balancer | 100k WebSockets and no single point of failure |
| In-memory WebSocket fan-out | **Redis or NATS pub/sub** between servers | a message arriving on server A must reach the recipient connected to server B |
| Photos on local disk | **Object storage (S3 / Cloudflare R2) + CDN**, signed URLs | ~30 TB/year; the app servers stop serving bytes |
| Push and SMS sent inline | **Job queue** with retries | spikes, provider outages, rate limits |
| In-memory rate limits | Redis-backed limits and abuse scoring | limits must hold across servers |

The code is already split so this is contained: storage lives behind `server/db.js`, so moving to Postgres means rewriting that module rather than the whole app. Attachments and fan-out are similarly isolated.

## 3. App changes

- **App Store and Play Store versions.** The web app works on both phones, but at scale people expect to find it in the stores, and native builds give more reliable notifications and access to contacts. The cheapest route is to wrap the existing web app with Capacitor, rather than rebuilding it.
- **Phone number sign-up and contact discovery**, so people can find friends already on TealTalk. It needs verification texts (a few cents each) and private contact matching.
- **Account recovery** and multiple devices per account.
- **End-to-end encryption** (Signal protocol or MLS) for TealTalk-to-TealTalk chats. At this size people expect it, and it means the server can't read messages. Texts to regular phone numbers can never be end-to-end encrypted.

## 4. Running a public service

- **Safety:** block and report buttons, spam detection, rate limits and a way to act on reports. There are legal duties around illegal content, and the US requires reporting child abuse material you become aware of.
- **Legal:** a company entity, terms of service, privacy policy, GDPR/CCPA handling, age limits and a process for law-enforcement requests.
- **Reliability:** monitoring and alerts, on-call, tested backups, load testing and several availability zones.

## Suggested path

1. **Now to a few thousand users:** today's design on one server. Add blocking/reporting, password reset and the Capacitor store builds.
2. **~10k users:** move to Postgres, object storage, Redis fan-out and 2+ app servers. Add end-to-end encryption, phone verification and a paid texting add-on.
3. **~100k to 1M users:** partitioned storage, job queues, a trust & safety process, multiple regions and the business and legal setup to match.

Don't build step 3 before you have step 1's users. Each step can be done without changing the app people already have installed.
