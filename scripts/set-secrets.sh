#!/usr/bin/env bash
# Run this yourself, once, before the first deploy (and again whenever a
# credential changes). It never writes the plaintext WAAREE password to
# disk, argv, or shell history: it's read with `read -s`, hashed locally
# with md5/md5sum, and only the hash is piped to `wrangler secret put`.
#
# Usage: scripts/set-secrets.sh
set -euo pipefail

cd "$(dirname "$0")/.."

md5_of() {
  # Prefer md5 (macOS/BSD); fall back to md5sum (Linux).
  if command -v md5 >/dev/null 2>&1; then
    printf '%s' "$1" | md5 | tr -d '\n'
  elif command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$1" | md5sum | awk '{print $1}'
  else
    echo "error: neither md5 nor md5sum is available" >&2
    exit 1
  fi
}

echo "This sets the four secrets solar-dash needs on Cloudflare:"
echo "  WAAREE_USERNAME, WAAREE_PASSWORD_MD5, DASH_PASSWORD, SESSION_SECRET"
echo "Nothing you type here is echoed, logged, or written to a file."
echo

read -r -p "WAAREE username: " WAAREE_USERNAME
read -r -s -p "WAAREE password: " WAAREE_PASSWORD
echo
WAAREE_PASSWORD_MD5="$(md5_of "$WAAREE_PASSWORD")"
unset WAAREE_PASSWORD

read -r -s -p "Dashboard password (what you'll type at /login): " DASH_PASSWORD
echo

SESSION_SECRET="$(openssl rand -hex 32)"

printf '%s' "$WAAREE_USERNAME" | npx wrangler secret put WAAREE_USERNAME
printf '%s' "$WAAREE_PASSWORD_MD5" | npx wrangler secret put WAAREE_PASSWORD_MD5
printf '%s' "$DASH_PASSWORD" | npx wrangler secret put DASH_PASSWORD
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET

unset WAAREE_PASSWORD_MD5 DASH_PASSWORD SESSION_SECRET

echo
echo "Done. Four secrets set: WAAREE_USERNAME, WAAREE_PASSWORD_MD5, DASH_PASSWORD, SESSION_SECRET."
echo "Run 'npm run deploy' to ship the worker."
