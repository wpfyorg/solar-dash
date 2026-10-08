#!/bin/sh
# Build the static aarch64 binary and push it to the AP. The JioIDU boxes
# have no sftp-server, so copy with `ssh ... cat >` instead of scp.
# Never overwrites an existing config or cert. Push stays off until
# set-push.sh is run, so a first deploy only listens, decodes and logs.
set -eu
HOST=${1:-root@192.168.68.2}
cd "$(dirname "$0")/.."
cargo zigbuild --release --target aarch64-unknown-linux-musl
BIN=target/aarch64-unknown-linux-musl/release/stick-gateway
SSH="ssh -o BatchMode=yes $HOST"

$SSH 'cat > /tmp/stick-gateway.new && chmod +x /tmp/stick-gateway.new' < "$BIN"
$SSH 'cat > /etc/init.d/stick-gateway && chmod +x /etc/init.d/stick-gateway' < packaging/stick-gateway.init
$SSH '[ -s /etc/stick-gateway.json ] || { umask 077; cat > /etc/stick-gateway.json; }' < packaging/stick-gateway.json

if ! $SSH '[ -s /etc/stick-gateway/cert.pem ] && [ -s /etc/stick-gateway/key.pem ]'; then
  T=$(mktemp -d)
  packaging/gen-cert.sh "$T" >/dev/null
  $SSH 'umask 077; mkdir -p /etc/stick-gateway && cat > /etc/stick-gateway/cert.pem' < "$T/cert.pem"
  $SSH 'umask 077; cat > /etc/stick-gateway/key.pem' < "$T/key.pem"
  rm -rf "$T"
fi

# A firmware flash wipes /etc/init.d and /usr/bin unless listed in keep.d.
$SSH 'mkdir -p /lib/upgrade/keep.d && cat > /lib/upgrade/keep.d/stick-gateway' < packaging/keep.d-stick-gateway

$SSH '/etc/init.d/stick-gateway stop 2>/dev/null; mv /tmp/stick-gateway.new /usr/bin/stick-gateway; /etc/init.d/stick-gateway enable; /etc/init.d/stick-gateway start' </dev/null
echo "deployed $(du -h "$BIN" | cut -f1) to $HOST"
