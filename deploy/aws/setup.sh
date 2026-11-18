#!/usr/bin/env bash
# One-time setup for KebSEND on a fresh Ubuntu 22.04/24.04 server (AWS Lightsail or EC2).
# Run it from the server's browser SSH window:
#   curl -fsSL https://raw.githubusercontent.com/1Kwadwo/Textora-BMS/main/deploy/aws/setup.sh | sudo bash
# Safe to run again: it skips what is already done.
set -euo pipefail

APP_DIR=/opt/kebsend
REPO=https://github.com/1Kwadwo/Textora-BMS.git
BRANCH=${BRANCH:-main}
RUN_USER=${SUDO_USER:-ubuntu}

echo "==> 1/7 Adding 1 GB swap (keeps npm install from running out of memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 2/7 Installing Node.js 22, git"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git

echo "==> 3/7 Installing Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> 4/7 Installing PM2 (keeps the website and bot running, restarts on crash/reboot)"
command -v pm2 >/dev/null || npm install -g pm2

echo "==> 5/7 Getting the KebSEND code"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
sudo -u "$RUN_USER" bash -c "cd $APP_DIR && git pull --ff-only && npm ci --omit=dev && (cd web && npm ci --omit=dev)"
mkdir -p "$APP_DIR/data" && chown "$RUN_USER":"$RUN_USER" "$APP_DIR/data"

echo "==> 6/7 Web server config"
cp "$APP_DIR/deploy/aws/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy && systemctl reload-or-restart caddy

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/deploy/aws/env.template" "$APP_DIR/.env"
  chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"
  echo
  echo "************************************************************"
  echo "  Almost done. Now paste your settings into the .env file:"
  echo "    nano $APP_DIR/.env"
  echo "  Save with Ctrl+O, Enter, then Ctrl+X. Then run this again:"
  echo "    curl -fsSL https://raw.githubusercontent.com/1Kwadwo/Textora-BMS/main/deploy/aws/setup.sh | sudo bash"
  echo "************************************************************"
  exit 0
fi

echo "==> 7/7 Starting the website and the bot"
sudo -u "$RUN_USER" bash -c "cd $APP_DIR && pm2 startOrReload deploy/aws/ecosystem.config.js && pm2 save"
env PATH="$PATH" pm2 startup systemd -u "$RUN_USER" --hp "/home/$RUN_USER" >/dev/null

sleep 4
echo
sudo -u "$RUN_USER" pm2 status
echo
if curl -fsS http://127.0.0.1:4000/health >/dev/null; then
  echo "Website is up on this server."
else
  echo "Website did not answer yet. See logs with: pm2 logs kebsend-web --lines 50"
fi
echo "Bot logs: pm2 logs kebsend-bot --lines 50"
echo "Later updates: sudo bash $APP_DIR/deploy/aws/update.sh"
