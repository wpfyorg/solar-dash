# Cutover: stick -> AP2 gateway -> Worker

Run these yourself, in order. Nothing here was applied by an agent.

## 1. Worker (after merging `feat/stick-ingest`)

```bash
openssl rand -hex 24                      # copy this token
npx wrangler secret put INGEST_TOKEN      # paste it
npm run deploy
```

## 2. Point AP2 at the Worker

```bash
gateway/packaging/set-push.sh https://<your-worker>.workers.dev/api/ingest
```

Prompts for the same token (hidden), writes `/etc/stick-gateway.json` (mode 600), restarts the daemon.

## 3. Router: redirect the stick to AP2

On `root@192.168.68.1`. Swaps the live table in one transaction:

```bash
nft -f - <<'EOF'
delete table ip solarproxy
table ip solarproxy {
	chain pre {
		type nat hook prerouting priority dstnat - 5; policy accept;
		ip saddr { 192.168.68.99, 192.168.68.133 } tcp dport 14431 dnat to 192.168.68.2:14431
	}
	chain post {
		type nat hook postrouting priority srcnat - 5; policy accept;
		ip saddr { 192.168.68.99, 192.168.68.133 } ip daddr 192.168.68.2 tcp dport 14431 masquerade
	}
}
EOF
```

The stick's open TCP session stays on the Mac until it closes (no `conntrack` tool on the router). Stop the Mac gateway when you are done with it; the stick reconnects within a minute and lands on AP2. Check: `ssh root@192.168.68.2 'logread -e stick-gateway | tail'`.

### Persist across reboot / firewall reload

fw4 does not remove foreign tables, so the file drops and recreates its own:

```bash
cat > /etc/solarproxy.nft <<'EOF'
table ip solarproxy
delete table ip solarproxy
table ip solarproxy {
	chain pre {
		type nat hook prerouting priority dstnat - 5; policy accept;
		ip saddr { 192.168.68.99, 192.168.68.133 } tcp dport 14431 dnat to 192.168.68.2:14431
	}
	chain post {
		type nat hook postrouting priority srcnat - 5; policy accept;
		ip saddr { 192.168.68.99, 192.168.68.133 } ip daddr 192.168.68.2 tcp dport 14431 masquerade
	}
}
EOF
nft -c -f /etc/solarproxy.nft && echo syntax ok
uci set firewall.solarproxy=include
uci set firewall.solarproxy.type='nftables'
uci set firewall.solarproxy.path='/etc/solarproxy.nft'
uci set firewall.solarproxy.position='ruleset-append'
uci commit firewall
echo /etc/solarproxy.nft >> /etc/sysupgrade.conf
/etc/init.d/firewall reload && nft list table ip solarproxy
```

### Undo

Back to the Mac (temporary, in-memory): rerun the step 3 block with `192.168.68.10` in both places.
Remove entirely:

```bash
uci delete firewall.solarproxy; uci commit firewall
rm /etc/solarproxy.nft; sed -i '\#/etc/solarproxy.nft#d' /etc/sysupgrade.conf
nft delete table ip solarproxy
/etc/init.d/firewall reload
```

The stick then goes back to the (dead) WAAREE cloud.

## AP2 daemon

- Deploy / update: `gateway/packaging/deploy.sh` (never overwrites config or cert).
- Logs: `logread -e stick-gateway`; a `stats:` line every minute (unique/s, resend %).
- Raw frames: `/tmp/stick-gw/frames.jsonl` (RAM, rotates at 1 MiB, plus `.1`).
- Try a data-ACK variant live, no restart: `echo mirror7e > /tmp/stick-gw/ack_mode` (also `mirror7f`, `ts7e`, `none`). Compare `unique/s` and `resend%` over ~10 min each.
- Remove: `/etc/init.d/stick-gateway disable; stop; rm /usr/bin/stick-gateway /etc/init.d/stick-gateway /etc/stick-gateway.json; rm -r /etc/stick-gateway /lib/upgrade/keep.d/stick-gateway`.

## WAAREE relay (on by default in the shipped config)

- The stick is relayed to `34.93.70.153:14431` while that answers; the gateway only listens in (decodes, pushes) and sends no replies of its own. `set-push.sh` writes the `relay` block; an AP2 config without it keeps relaying off.
- Mute or dead upstream: if nothing comes back within 30 s of the stick registering (or the connect fails), the gateway drops it and answers locally; the stick sees only a ~30 s delay.
- Switching back happens only between sessions. A probe (TLS connect, every 10 min, backing off to 1 h) flags the upstream as back, the local session is closed, the stick reconnects and the relay is tried again. If it is still mute, the cycle repeats. A TLS connect alone does not prove the cloud works: as of 2026-10-08 it accepts TLS (cert sha256 `4d123da9fe38054deb16303327f3822c1a742d328d654655f60b743389da73c3`) but never answers.
- Set `"pin_sha256"` to that value to refuse any other certificate; every connect logs the fingerprint.
- `state.waaree_link` on the Worker carries `relaying | down | off | unknown`.
