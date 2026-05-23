# Render Keep Alive

This bot already exposes a health endpoint at:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

Render free web services can sleep after a period with no inbound traffic. The GitHub Actions workflow in `.github/workflows/render-keep-alive.yml` sends a request to that endpoint every 5 minutes so the bot keeps receiving inbound traffic.

## Setup

1. Push this repo to GitHub.
2. Open the GitHub repo settings.
3. Go to `Secrets and variables` -> `Actions`.
4. Add a repository secret named `RENDER_SERVICE_URL`.
5. Set the value to your Render service URL, without any path:

```text
https://YOUR-RENDER-SERVICE.onrender.com
```

After the workflow is on the default branch, GitHub will run it on the schedule. You can also run it manually from the `Actions` tab by selecting `Render Keep Alive` and clicking `Run workflow`.

## Notes

- The `/health` endpoint should return `200 OK`.
- A 5-minute interval is below Render's idle window and gives some buffer if GitHub runs a scheduled job a little late.
- Keeping a free Render service awake all month uses free instance hours continuously.
- If this is a private GitHub repo and Actions minutes are limited, use an external uptime monitor instead. Point it at the same `/health` URL with a 5-minute interval.
