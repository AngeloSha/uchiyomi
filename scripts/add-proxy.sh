#!/usr/bin/env bash
# Optional: if you front the stack with Nginx Proxy Manager, this adds a proxy host (forward -> yomi-web:80
# by default; set FORWARD_HOST to front any other container on the proxy network)
# and requests a Let's Encrypt cert. Needs your NPM admin login. Set DOMAIN + NPM_URL for your setup.
# DNS: create an A record  <your domain> -> this server's IP  BEFORE running (for SSL).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${DOMAIN:-yomi.example.com}"
FORWARD_HOST="${FORWARD_HOST:-yomi-web}"
FORWARD_PORT="${FORWARD_PORT:-80}"

echo "NPM admin login (${NPM_URL:-http://your-npm-host:81})"
read -rp "  Email: " NPM_EMAIL
read -rsp "  Password: " NPM_PASS; echo
read -rp "  Let's Encrypt email [$NPM_EMAIL]: " LE_EMAIL
LE_EMAIL="${LE_EMAIL:-$NPM_EMAIL}"

docker run --rm --network proxy_internal \
  -e NPM_EMAIL="$NPM_EMAIL" -e NPM_PASS="$NPM_PASS" -e LE_EMAIL="$LE_EMAIL" -e DOMAIN="$DOMAIN" \
  -e FORWARD_HOST="$FORWARD_HOST" -e FORWARD_PORT="$FORWARD_PORT" \
  -v "$DIR/scripts":/s:ro \
  yomi-bff:prod node /s/npm-setup.cjs
