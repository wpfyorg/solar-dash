#!/bin/sh
# Run this yourself: points the gateway at the Worker. The token is read
# silently and goes straight to the AP's config (mode 600), not to argv or
# shell history. It must equal the INGEST_TOKEN Worker secret.
# usage: set-push.sh https://<your-worker>/api/ingest [root@192.168.68.2]
set -eu
URL=${1:?usage: set-push.sh <worker-ingest-url> [host]}
HOST=${2:-root@192.168.68.2}
printf 'ingest token: ' >&2
stty -echo; read -r TOKEN; stty echo; echo >&2
case "$TOKEN" in *[!A-Za-z0-9._~+/=-]*|'') echo "token has unexpected characters" >&2; exit 1;; esac
ssh -o BatchMode=yes "$HOST" "umask 077; cat > /etc/stick-gateway.json" <<JSON
{
  "listen": "0.0.0.0:14431",
  "cert": "/etc/stick-gateway/cert.pem",
  "key": "/etc/stick-gateway/key.pem",
  "log_dir": "/tmp/stick-gw",
  "log_max_bytes": 1048576,
  "push_url": "$URL",
  "push_token": "$TOKEN",
  "push_interval_s": 300,
  "ack_mode": "none",
  "relay": { "enabled": true, "upstream": "34.93.70.153:14431", "connect_timeout_s": 10, "reply_timeout_s": 30, "probe_interval_s": 600, "pin_sha256": "" }
}
JSON
ssh -o BatchMode=yes "$HOST" '/etc/init.d/stick-gateway restart' </dev/null
echo "push configured -> $URL"
