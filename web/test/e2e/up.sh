#!/usr/bin/env bash
# Bring up a throwaway instance, seed it, run the browser tests, tear it all down.
#
# Uses the all-in-one image, which is what makes this cheap enough to run in CI: one container plus Postgres,
# no nginx to wire up and no proxy hop to get wrong.
#
#   bash web/test/e2e/up.sh              # build, run, clean up
#   KEEP=1 bash web/test/e2e/up.sh       # leave it running to poke at
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT=${E2E_PORT:-18140}
NET=${E2E_NET:-uchiyomi-e2e}
# Container names are derived from the network, not hardcoded. They were hardcoded, so a second run with
# E2E_NET/E2E_PORT overridden -- the whole point of those knobs -- tore down the first run's containers on
# the way in and again on the way out.
APP="$NET"
DB="$NET-db"
# Docker's default address pools can be exhausted on a busy host, so the subnet is pinned rather than left
# to chance -- an unexplained "all predefined address pools have been fully subnetted" is a bad first
# impression of a test suite.
SUBNET=${E2E_SUBNET:-10.222.0.0/24}
USER=${E2E_USER:-e2e}
PASS=${E2E_PASS:-e2e-passw0rd-123}
LIB=$(mktemp -d)

cleanup() {
  [ "${KEEP:-0}" = "1" ] && { echo "kept: $NET on :$PORT (library $LIB)"; return; }
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$LIB"
}
trap cleanup EXIT INT TERM

echo "· seeding a library"
python3 "$REPO/web/test/e2e/seed.py" "$LIB"

echo "· building the all-in-one image"
docker build -q -f "$REPO/Dockerfile.aio" -t uchiyomi:e2e "$REPO" >/dev/null

docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --subnet "$SUBNET" "$NET" >/dev/null

docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=yomi postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$DB" pg_isready -q 2>/dev/null && break; sleep 1; done

docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
  -e DATABASE_URL="postgres://postgres:e2e@$DB:5432/yomi" \
  -e JWT_SECRET='e2e-secret-at-least-16-chars' \
  -e LIBRARY_BACKEND=owned \
  -e PUID="$(id -u)" -e PGID="$(id -g)" \
  -v "$LIB":/library uchiyomi:e2e >/dev/null

echo "· waiting for it to come up"
for _ in $(seq 1 90); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz" && break
  sleep 1
done

curl -sf -X POST "http://127.0.0.1:$PORT/api/setup" -H 'content-type: application/json' \
  -d "{\"displayName\":\"E2E\",\"username\":\"$USER\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sf -X POST "http://127.0.0.1:$PORT/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -sf -X POST "http://127.0.0.1:$PORT/api/refresh" -H "authorization: Bearer $TOKEN" >/dev/null
sleep 4

echo "· driving the browser"
cd "$REPO/web"
BASE="http://127.0.0.1:$PORT" E2E_USER="$USER" E2E_PASS="$PASS" node test/e2e/run.mjs
