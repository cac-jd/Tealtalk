# Getting TealTalk online

Phones need an `https://` address to install TealTalk and get notifications. There are two ways to get one.

| | Cost | Good for |
| --- | --- | --- |
| **A. Your own computer + a free Cloudflare tunnel** | $0 | trying it on your own phones today. It works while that computer is on. |
| **B. A small cloud server** | ~$5–8/month. **Needs the owner's approval first** (see CLAUDE.md) | leaving it running for friends and family |

## A. Free: run it on your computer (about 5 minutes)

You need Node 22.5 or newer installed on a Mac, Windows or Linux computer.

1. Download the code and start TealTalk:

   ```sh
   git clone https://github.com/cac-jd/Tealtalk.git
   cd Tealtalk
   npm install
   SIGNUP_CODE=pick-a-secret-code npm start
   ```

   On Windows PowerShell, use `$env:SIGNUP_CODE="pick-a-secret-code"; npm start`.
2. Install Cloudflare's free `cloudflared` tool ([download page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)). In a second terminal, run:

   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```

   It prints an address like `https://random-words.trycloudflare.com`. That's your TealTalk. The quick tunnel needs no Cloudflare account and costs nothing, but the address changes each time you restart it.
3. Open that address on your phones:
   - **iPhone:** in **Safari**, tap **Share**, then **Add to Home Screen**.
   - **Android:** in **Chrome**, tap **Install app**.

   Create accounts using your signup code.

Your messages are stored in the `data/` folder on that computer. If you move to a cloud server later, copy that folder across.

## B. A cloud server (costs money: ask first)

Once you've approved a host, the repo is ready for either of these:

- **Railway** (simplest, around $5/month on its Hobby plan): New Project → Deploy from GitHub repo → cac-jd/Tealtalk. Add a **Volume** mounted at `/data`. Under Networking, click **Generate Domain**. Set these variables: `SIGNUP_CODE`, `TRUST_PROXY=1`, `VAPID_SUBJECT=mailto:you@example.com`. `railway.json` and the `Dockerfile` do the rest.
- **Any Linux VPS** (e.g. Hetzner, from about €5.49/month): install Docker, then run:

  ```sh
  docker build -t tealtalk .
  docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 -v tealtalk-data:/data \
    -e SIGNUP_CODE=... -e TRUST_PROXY=1 tealtalk
  ```

  Put [Caddy](https://caddyserver.com/) in front for automatic HTTPS:

  ```
  chat.example.com {
      reverse_proxy localhost:3000
  }
  ```

On a cloud server, keep TealTalk to **one instance**, because its database is a single file. Back up the `/data` volume. `MEDIA_RETENTION_DAYS=30` keeps storage (and cost) small: people's phones keep their copies, and the server deletes its copy after 30 days. See [SCALING.md](SCALING.md) for growing past one server.
