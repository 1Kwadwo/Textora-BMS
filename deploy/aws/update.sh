#!/usr/bin/env bash
# Pull the latest code from GitHub and restart KebSEND with no downtime.
#   sudo bash /opt/kebsend/deploy/aws/update.sh
set -euo pipefail
APP_DIR=/opt/kebsend
RUN_USER=${SUDO_USER:-ubuntu}

sudo -u "$RUN_USER" bash -c "cd $APP_DIR && git pull --ff-only && npm ci --omit=dev && (cd web && npm ci --omit=dev)"
cp "$APP_DIR/deploy/aws/Caddyfile" /etc/caddy/Caddyfile && systemctl reload caddy
sudo -u "$RUN_USER" bash -c "cd $APP_DIR && pm2 startOrReload deploy/aws/ecosystem.config.js && pm2 save"
sudo -u "$RUN_USER" pm2 status
