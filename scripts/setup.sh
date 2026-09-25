#!/usr/bin/env bash
# One-time setup: creates the KV namespace under the user's own Cloudflare
# account and patches its id into wrangler.jsonc (which ships with a
# placeholder id so the repo itself never needs a real namespace to exist).
#
# Not run automatically by any agent — run this yourself after `wrangler
# login`:
#   scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Creating the SOLAR_KV namespace..."
output="$(npx wrangler kv namespace create SOLAR_KV)"
echo "$output"

id="$(printf '%s\n' "$output" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{32}')"

if [ -z "$id" ]; then
  echo
  echo "Couldn't parse a namespace id out of wrangler's output above." >&2
  echo "Copy the id it printed and paste it into wrangler.jsonc's" >&2
  echo "kv_namespaces[0].id by hand, replacing REPLACE_WITH_KV_NAMESPACE_ID." >&2
  exit 1
fi

# In-place edit, portable across BSD/macOS and GNU sed.
if sed --version >/dev/null 2>&1; then
  sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/$id/" wrangler.jsonc
else
  sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$id/" wrangler.jsonc
fi

echo
echo "wrangler.jsonc updated with KV namespace id: $id"
echo "Next: scripts/set-secrets.sh, then npm run deploy."
