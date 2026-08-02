# Render Keep Alive (Uptime Robot)

This bot exposes a health check endpoint at:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

Render free web services automatically spin down (go to sleep) after 15 minutes of inactivity (no inbound HTTP requests). Because the Telegram bot runs in **long polling mode**, its outgoing requests do not count as inbound traffic, meaning Render will still put the bot to sleep.

To prevent this, use an external uptime monitoring service like **Uptime Robot** to keep the bot awake continuously.

## Setup with Uptime Robot

1. Go to [Uptime Robot](https://uptimerobot.com/) and create a free account if you haven't already.
2. Click **Add New Monitor**.
3. Configure the monitor details:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** Textora Bot Health
   - **URL (or IP):** `https://YOUR-RENDER-SERVICE.onrender.com/health` (replace with your actual Render service URL)
   - **Monitoring Interval:** Every 5 minutes (Render's idle window is 15 minutes, so 5 minutes keeps it safely active).
4. Save the monitor.

## Notes
- The `/health` endpoint returns a `200 OK` status with `{"ok":true,"service":"textora-bot"}`.
- Keeping a free Render service awake continuously uses free instance hours. Monitor your monthly free hour usage on Render.
