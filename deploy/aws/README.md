# Hosting KebSEND on AWS (Lightsail)

One small always-on server runs **both** the website (kebsend.com, email.kebsend.com,
the developer API) and the Telegram bot. It never sleeps, so Uptime Robot is no longer needed.

**Cost:** Lightsail Linux, 1 GB RAM / 2 vCPU plan = about **US$7 a month**, so $100 of
credits covers roughly a year. Check first that your credits apply: AWS console →
Billing → Credits → look at "Applicable products".

MongoDB stays where it is (Atlas or wherever `MONGODB_URI` points). Nothing in the data moves.

---

## Step 1. Copy your settings out of Render (5 min)

Render keeps your settings even while suspended. For **each** of your two Render services
(the website and the bot `textora-bmsv2`): open it → **Environment** → copy every NAME and value
into a notes file. You will paste them into the server in Step 4.

## Step 2. Create the server (5 min)

1. Go to https://lightsail.aws.amazon.com → **Create instance**.
2. Region: **Ireland (eu-west-1)** or **Frankfurt** (closest to Ghana with Lightsail).
3. Platform **Linux/Unix**, blueprint **OS Only → Ubuntu 24.04 LTS**.
4. Plan: **$7 USD (1 GB RAM, 2 vCPUs, 40 GB SSD)** with public IPv4.
5. Name it `kebsend` → **Create instance**.
6. Open the instance → **Networking** tab:
   - **Create static IP** → attach to `kebsend`. Write the IP down.
   - Under **IPv4 Firewall** → **Add rule** → **HTTPS** (port 443). HTTP 80 and SSH 22 are already there.
7. If you use MongoDB Atlas: Atlas → Network Access → **Add IP Address** → the static IP.

## Step 3. Run the setup script (5 min)

On the instance page click **Connect using SSH** (a black terminal opens in your browser). Paste:

```bash
curl -fsSL https://raw.githubusercontent.com/1Kwadwo/Textora-BMS/main/deploy/aws/setup.sh | sudo bash
```

It installs everything and stops to ask for your settings.

## Step 4. Paste your settings

```bash
nano /opt/kebsend/.env
```

Fill in the values from Step 1 (right-click → paste works). Rules:
- Use the **same** `JWT_SECRET`, `MONGODB_URI`, `BOT_TOKEN` as Render.
- Change any value that contained `onrender.com` to `https://kebsend.com` (for example
  `APP_URL`, `PAYSTACK_CALLBACK_URL`, `PUBLIC_BASE_URL`).
- Skip `PORT`, `WEBHOOK_PORT`, `BOT_WEBHOOK_URL` (the server sets them).

Save: **Ctrl+O**, **Enter**, **Ctrl+X**. Then run the same setup line again:

```bash
curl -fsSL https://raw.githubusercontent.com/1Kwadwo/Textora-BMS/main/deploy/aws/setup.sh | sudo bash
```

It ends with "Website is up on this server." The bot starts answering on Telegram right away.

## Step 5. Point your domain at AWS (10 min + waiting)

Where kebsend.com's DNS is managed, set these records (delete any old CNAME to onrender.com first):

| Type | Name    | Value            |
|------|---------|------------------|
| A    | `@`     | your static IP   |
| A    | `www`   | your static IP   |
| A    | `email` | your static IP   |
| A    | `bot`   | your static IP (optional, only if you want the bot's own URL) |

Within minutes to a few hours https://kebsend.com and https://email.kebsend.com load,
with HTTPS set up automatically. Leave any `mail.kebsend.com` / Resend records as they are.

## Step 6. Update the webhook addresses

- **Paystack** dashboard → Settings → API Keys & Webhooks → Webhook URL:
  `https://kebsend.com/api/webhook/paystack`
- **Resend** (if KebSEND Email is on) → Webhooks → endpoint: `https://kebsend.com/webhooks/resend`

## Step 7. Shut Render down

Delete (or keep suspended) both Render services. If the old bot ever wakes up at the same time,
Telegram rejects one of them with a "409 conflict".

---

## Everyday commands (in the SSH window)

| What | Command |
|------|---------|
| Is it running? | `pm2 status` |
| Website logs | `pm2 logs kebsend-web --lines 100` |
| Bot logs | `pm2 logs kebsend-bot --lines 100` |
| Deploy the latest code from GitHub `main` | `sudo bash /opt/kebsend/deploy/aws/update.sh` |
| Change a setting | `nano /opt/kebsend/.env` then `pm2 restart all --update-env` |

Unlike Render, pushing to GitHub does **not** redeploy by itself. Run the update command after a push.

Optional backup: Lightsail instance → **Snapshots** → enable automatic snapshots (about $2/month for 40 GB).
