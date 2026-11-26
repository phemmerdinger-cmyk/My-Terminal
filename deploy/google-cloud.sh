#!/usr/bin/env bash
# Market Desk on Google Cloud's free e2-micro server — run this in Google Cloud Shell (shell.cloud.google.com).
#   bash <(curl -fsSL https://raw.githubusercontent.com/phemmerdinger-cmyk/My-Terminal/main/deploy/google-cloud.sh)
# It creates (or reuses) one project, one free-tier VM (e2-micro, 30 GB standard disk, us-central1), a static IP and a
# firewall rule for the web. The VM installs Node 22 + Caddy (free HTTPS via sslip.io), runs server.js as a service,
# and pulls main every 5 minutes (like Render's auto-deploy). Secrets are typed here once and kept in the VM's
# metadata (visible only to the project's owners); nothing is written to the repo.
# Re-running is safe: it skips what already exists; answer "y" to "update secrets" to change them.
set -euo pipefail

REGION=us-central1 ZONE=us-central1-a VM=market-desk IPNAME=market-desk-ip
say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

# ---- project + billing (the free tier still needs a billing account; free usage isn't charged)
PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT" ]; then
  PROJECT="market-desk-$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
  say "Creating project $PROJECT"
  gcloud projects create "$PROJECT" --name="Market Desk"
  gcloud config set project "$PROJECT"
fi
say "Using project $PROJECT"
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  ACCT=$(gcloud billing accounts list --filter=open=true --format='value(name)' | head -1)
  if [ -z "$ACCT" ]; then echo "No billing account yet. Open https://console.cloud.google.com/billing, create one, then run this again."; exit 1; fi
  gcloud billing projects link "$PROJECT" --billing-account="$ACCT"
fi
gcloud services enable compute.googleapis.com

# ---- secrets (copy them from Render → petersfinanceterminal → Environment)
if gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
  read -rp "The server already exists. Update its secrets? [y/N] " UPD
else UPD=y; fi
ENVFILE=$(mktemp); trap 'rm -f "$ENVFILE"' EXIT
if [ "${UPD,,}" = "y" ]; then
  say "Paste each value from Render (press Enter to leave one empty). Typing is hidden."
  echo "MODE=public" >>"$ENVFILE"; echo "PORT=3000" >>"$ENVFILE"
  for K in SITE_PASSWORD DESK_TOKEN FINNHUB_API_KEY GEMINI_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN SEC_USER_AGENT GITHUB_TOKEN ANTHROPIC_API_KEY CLAUDE_PASSWORD_HASH; do
    read -rsp "$K: " V; echo; [ -n "$V" ] && printf '%s=%s\n' "$K" "$V" >>"$ENVFILE"
  done
fi

# ---- static IP + firewall
gcloud compute addresses describe "$IPNAME" --region "$REGION" >/dev/null 2>&1 || gcloud compute addresses create "$IPNAME" --region "$REGION"
IP=$(gcloud compute addresses describe "$IPNAME" --region "$REGION" --format='value(address)')
HOST="${IP//./-}.sslip.io"
gcloud compute firewall-rules describe market-desk-web >/dev/null 2>&1 || \
  gcloud compute firewall-rules create market-desk-web --allow=tcp:80,tcp:443 --target-tags=market-desk-web

# ---- what the VM runs on every boot
STARTUP=$(mktemp)
cat >"$STARTUP" <<'BOOT'
#!/bin/bash
set -e
MD=http://metadata.google.internal/computeMetadata/v1/instance/attributes
get() { curl -fsS -H "Metadata-Flavor: Google" "$MD/$1"; }
if ! command -v node >/dev/null || ! node -v | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
# 1 GB swap so a memory spike slows the server instead of crashing it (e2-micro has ~1 GB RAM)
[ -f /swapfile ] || { fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
swapon /swapfile 2>/dev/null || true
id md >/dev/null 2>&1 || useradd -r -m -d /opt/md md
[ -d /opt/md/app/.git ] || sudo -u md git clone https://github.com/phemmerdinger-cmyk/My-Terminal.git /opt/md/app
get md-env | base64 -d > /etc/market-desk.env 2>/dev/null || true; chmod 600 /etc/market-desk.env
HOST=$(get md-host)
grep -q '^SELF_URL=' /etc/market-desk.env || echo "SELF_URL=https://$HOST" >> /etc/market-desk.env
# the real visitor IP for rate limits and sign-in lockouts (server.js trusts True-Client-IP; Caddy overwrites any sent)
printf '%s {\n  encode gzip\n  reverse_proxy 127.0.0.1:3000 {\n    header_up True-Client-IP {remote_host}\n  }\n}\n' "$HOST" > /etc/caddy/Caddyfile
cat > /etc/systemd/system/market-desk.service <<'UNIT'
[Unit]
Description=Market Desk
After=network-online.target
[Service]
User=md
WorkingDirectory=/opt/md/app
EnvironmentFile=/etc/market-desk.env
ExecStart=/usr/bin/node --max-old-space-size=640 server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
# auto-deploy: pull main every 5 minutes and restart only when it changed
cat > /usr/local/bin/market-desk-update <<'UPD'
#!/bin/bash
cd /opt/md/app || exit 0
before=$(sudo -u md git rev-parse HEAD); sudo -u md git pull -q --ff-only origin main || exit 0
[ "$before" != "$(sudo -u md git rev-parse HEAD)" ] && systemctl restart market-desk || true
UPD
chmod +x /usr/local/bin/market-desk-update
cat > /etc/systemd/system/market-desk-update.service <<'UNIT'
[Service]
Type=oneshot
ExecStart=/usr/local/bin/market-desk-update
UNIT
cat > /etc/systemd/system/market-desk-update.timer <<'UNIT'
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now market-desk market-desk-update.timer
systemctl restart market-desk caddy
BOOT

META=(--metadata-from-file=startup-script="$STARTUP" --metadata=md-host="$HOST")
[ -s "$ENVFILE" ] && META+=(--metadata=md-env="$(base64 -w0 "$ENVFILE")")

if gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
  say "Updating the server"
  gcloud compute instances add-metadata "$VM" --zone "$ZONE" "${META[@]}"
  gcloud compute ssh "$VM" --zone "$ZONE" --command "sudo google_metadata_script_runner startup" -- -q
else
  say "Creating the free server (e2-micro)"
  gcloud compute instances create "$VM" --zone "$ZONE" --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --address="$IP" --tags=market-desk-web "${META[@]}"
fi

say "Done. In about 3 minutes Market Desk will be at:  https://$HOST"
echo "Bot HQ:  https://$HOST/hq"
echo "Laptop:  set PUBLIC_URL=https://$HOST (instead of the onrender.com address)."
echo "Then delete or suspend the Render service so the bots don't run in two places."
