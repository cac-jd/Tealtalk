# Getting TealTalk online

This guide puts TealTalk on [Railway](https://railway.com) with a real `https://` address, so you can install it on iPhones and Android phones. Then it connects a [Twilio](https://www.twilio.com) number so TealTalk can text any phone number.

Service dashboards change their menus now and then. If a button has moved, search that service's docs for the step name.

## Part 1: Railway (about 10 minutes)

1. **Create the project.** Sign in at railway.com with your GitHub account. Choose **New Project** → **Deploy from GitHub repo** → **cac-jd/Tealtalk**. Railway finds `railway.json` and builds the `Dockerfile`.
2. **Add storage.** Your messages and photos are kept on a volume. Without one they are wiped on every deploy. On the TealTalk service, choose **Add Volume** (right-click the service, or use the command palette, Ctrl/Cmd+K), and set the mount path to **`/data`**.
3. **Get a web address.** Go to the service's **Settings** → **Networking** → **Generate Domain**. You'll get something like `tealtalk-production.up.railway.app`.
4. **Set variables.** Under the service's **Variables** tab, add:

   | Variable | Value |
   | --- | --- |
   | `SIGNUP_CODE` | a code only you and your people know, like `teal-sunset-42`. **Required on a public server**, otherwise anyone on the internet can sign up. |
   | `TRUST_PROXY` | `1` |
   | `PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` (Railway fills in your domain) |
   | `VAPID_SUBJECT` | `mailto:you@example.com` (your email, which push services can contact if something goes wrong) |

5. Railway redeploys. Open your domain: you should see the TealTalk login screen. Choose **Create account** and enter your signup code.
6. **Install it on your phones:**
   - **iPhone:** open the address in **Safari**, tap **Share**, then **Add to Home Screen**. Open TealTalk from the home screen, then go to **Settings** and **Enable notifications**.
   - **Android:** open it in **Chrome** and tap **Install app** (or use TealTalk's **Settings** → **Install**).

Keep TealTalk at **one replica**. It stores everything in a single SQLite file on the volume, so it can't run on several machines at once. One small instance comfortably handles hundreds of people chatting. See [SCALING.md](SCALING.md) for what changes beyond that.

**Backups:** turn on backups for the volume in Railway, if your plan offers them, or copy `/data` somewhere safe now and then.

## Part 2: Texting any phone number with Twilio

With this set up, you can start a chat with any phone number from TealTalk, on iPhone or Android. The other person gets a normal text from your TealTalk number, and their replies land back in TealTalk.

### What to expect

- **Cost:** you pay Twilio for the number (roughly $1–2 a month in the US) and a small amount per text and photo (around a cent per text). Check [twilio.com/pricing](https://www.twilio.com/en-us/sms/pricing/us) for current prices. TealTalk adds nothing on top.
- **Registration:** US carriers block texts from unregistered app numbers. You must register (called **A2P 10DLC**; individuals without a business use **Sole Proprietor**). There is a small one-time fee, and approval takes from a few days to a couple of weeks. Until it's approved, texts may fail with "undelivered".
- **Your contacts see the Twilio number**, not your cell number.
- **One-to-one texts only.** Twilio doesn't support group texts, so group chats stay TealTalk-only.
- People can reply **STOP** to opt out. Twilio then blocks further texts to them, and TealTalk shows "This number has opted out".

### Steps

1. **Account.** Sign up at twilio.com and **upgrade** from the trial. Trial accounts can only text numbers you've verified, and they add "Sent from your Twilio trial account" to every message.
2. **Buy a number.** Go to **Phone Numbers** → **Buy a number**, and pick a local number with **SMS** and **MMS** ticked.
3. **Register it.** Go to **Messaging** → **Regulatory compliance** (A2P 10DLC) and register a **Sole Proprietor** brand and campaign. For the use case, describe it truthfully, e.g. "Personal conversational messaging between the account owner and their friends and family who have texted or agreed to be texted." Add your number to the Messaging Service the registration creates.
4. **Point incoming texts at TealTalk.** On the Messaging Service (or on the number itself if you're not using one), under **Integration** / **A message comes in**, choose **Webhook**, **HTTP POST**, with the URL:

   ```
   https://<your-railway-domain>/api/sms/twilio
   ```

   TealTalk sets the delivery-status callback on each message it sends, so you don't need to configure that.
5. **Tell TealTalk about it.** In Railway **Variables**, add:

   | Variable | Value |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | from the Twilio console home page (starts with `AC`) |
   | `TWILIO_AUTH_TOKEN` | from the same page. Keep it secret: put it only in Railway, never in the code or in a chat. |
   | `SMS_NUMBERS` | `+15551234567=yourusername`: the Twilio number and the TealTalk username that owns it. Add more, comma separated, if you buy numbers for other people. |

6. After Railway redeploys, open TealTalk → **New chat**. You'll see **Text a phone number**. Text your own cell to try it, then reply from your cell to see it arrive in TealTalk.

### If something doesn't work

- **The "Text a phone number" option doesn't show:** check that `SMS_NUMBERS` names *your* username exactly, and that `PUBLIC_URL` starts with `https://`. The Railway deploy log prints one line saying whether texting is on.
- **Replies don't arrive:** the webhook URL in Twilio must match `PUBLIC_URL` + `/api/sms/twilio` exactly. TealTalk rejects requests whose Twilio signature doesn't match that address. Twilio's **Monitor** → **Logs** → **Errors** shows what happened.
- **Texts say "failed" or "undelivered":** usually registration isn't approved yet, or the number opted out. The error text is shown under the message in TealTalk.
