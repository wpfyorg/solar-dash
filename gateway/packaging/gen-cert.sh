#!/bin/sh
# Self-signed cert for the stick: same subject and SAN set as
# foxess_local_cloud/cert.py (the stick only checks that TLS completes).
# usage: gen-cert.sh <dir>   -> <dir>/cert.pem <dir>/key.pem
set -eu
DIR=${1:?usage: gen-cert.sh <dir>}
mkdir -p "$DIR"
SAN="IP:139.224.232.119,IP:8.209.116.72,IP:8.209.80.124,IP:47.91.86.144,IP:139.196.46.234,IP:8.211.20.96,IP:47.254.142.98,IP:8.209.79.219,IP:47.254.159.190,IP:101.133.233.208,IP:47.102.203.29,DNS:*.maitian-yun.com,DNS:*.foxesscloud.com,DNS:foxesscloud.com,DNS:www.foxesscloud.com"
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/C=CN/ST=JiangSu/L=Wuxi/O=FoxESS/CN=monitor" \
  -addext "subjectAltName=$SAN" 2>/dev/null
chmod 600 "$DIR/key.pem"
echo "wrote $DIR/cert.pem $DIR/key.pem"
