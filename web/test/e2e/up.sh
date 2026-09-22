#!/usr/bin/env bash
# Bring up a throwaway instance, seed it, run the browser tests, tear it all down.
#
# Uses the all-in-one image, which is what makes this cheap enough to run in CI: one app container plus
# Postgres and two tiny test-only HTTP sources, no nginx to wire up and no proxy hop to get wrong.
#
#   bash web/test/e2e/up.sh              # build, run, clean up
#   KEEP=1 bash web/test/e2e/up.sh       # leave it running to poke at
#   KEEP=1 bash web/test/e2e/up.sh && WIDTH=1280 BASE=http://127.0.0.1:18140 npm run test:e2e:v040
#   Run the v0.40 walk once per fresh instance; repeat with WIDTH=390 and a fresh E2E_NET/E2E_PORT.
#   E2E_EMBEDDED=1 bash web/test/e2e/up.sh   # no Postgres container: the image runs its own (DATABASE_URL unset)
#
# The embedded leg is the proof that the one-container layout behaves like the two-container one, in the
# only place both are actually driven end to end. CI runs both.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT=${E2E_PORT:-18140}
NET=${E2E_NET:-uchiyomi-e2e}
# Container names are derived from the network, not hardcoded. They were hardcoded, so a second run with
# E2E_NET/E2E_PORT overridden -- the whole point of those knobs -- tore down the first run's containers on
# the way in and again on the way out.
APP="$NET"
DB="$NET-db"
FAKE_A="$NET-fake-a"
FAKE_B="$NET-fake-b"
# Docker's default address pools can be exhausted on a busy host, so the subnet is pinned rather than left
# to chance -- an unexplained "all predefined address pools have been fully subnetted" is a bad first
# impression of a test suite.
SUBNET=${E2E_SUBNET:-10.222.0.0/24}
USER=${E2E_USER:-e2e}
PASS=${E2E_PASS:-e2e-passw0rd-123}
EMBEDDED=${E2E_EMBEDDED:-0}
# Derive disjoint defaults from the app port. CI keeps the first instance while it starts the embedded
# leg on PORT+1; fixed 18150/18151 made those two otherwise-correct runs fight over a host port.
FAKE_A_PORT=${E2E_FAKE_A_PORT:-$((20000 + (PORT % 1000) * 2))}
FAKE_B_PORT=${E2E_FAKE_B_PORT:-$((FAKE_A_PORT + 1))}
LIB=$(mktemp -d)
DATA=$(mktemp -d)

cleanup() {
  [ "${KEEP:-0}" = "1" ] && { echo "kept: $NET on :$PORT, fake sources on :$FAKE_A_PORT/:$FAKE_B_PORT (library $LIB, data $DATA)"; return; }
  docker rm -f "$APP" "$DB" "$FAKE_A" "$FAKE_B" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # /data is written by the container as PUID (our own uid), so a plain rm works.
  rm -rf "$LIB" "$DATA"
}
trap cleanup EXIT INT TERM

docker rm -f "$APP" "$DB" "$FAKE_A" "$FAKE_B" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --subnet "$SUBNET" "$NET" >/dev/null

echo "· starting the two v0.40 fake sources"
docker run -d --name "$FAKE_A" --network "$NET" -p "127.0.0.1:$FAKE_A_PORT:$FAKE_A_PORT" \
  -v "$REPO:/repo:ro" -w /repo node:24-alpine \
  node web/test/e2e/fakeSource.mjs --name fake-a --port "$FAKE_A_PORT" >/dev/null
docker run -d --name "$FAKE_B" --network "$NET" -p "127.0.0.1:$FAKE_B_PORT:$FAKE_B_PORT" \
  -v "$REPO:/repo:ro" -w /repo node:24-alpine \
  node web/test/e2e/fakeSource.mjs --name fake-b --port "$FAKE_B_PORT" >/dev/null
for stub in "http://127.0.0.1:$FAKE_A_PORT/__log" "http://127.0.0.1:$FAKE_B_PORT/__log"; do
  ready=0
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "$stub"; then ready=1; break; fi
    sleep .1
  done
  [ "$ready" = "1" ] || { echo "fake source did not start: $stub" >&2; exit 1; }
done

echo "· seeding a library"
python3 "$REPO/web/test/e2e/seed.py" "$LIB"

echo "· building the all-in-one image"
docker build -q -f "$REPO/Dockerfile.aio" -t uchiyomi:e2e "$REPO" >/dev/null

if [ "$EMBEDDED" = "1" ]; then
  echo "· embedded database: no Postgres container, DATABASE_URL unset, /data mounted"
  docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
    -e JWT_SECRET='e2e-secret-at-least-16-chars' \
    -e LIBRARY_BACKEND=owned \
    -e FAKE_SOURCE_URLS="fake-a=http://$FAKE_A:$FAKE_A_PORT,fake-b=http://$FAKE_B:$FAKE_B_PORT" \
    -e DOWNLOAD_PAGE_GAP_MS=20 -e DOWNLOAD_RESUME_WAIT_MS=200,200,200 \
    -e PUID="$(id -u)" -e PGID="$(id -g)" \
    -v "$LIB":/library -v "$DATA":/data uchiyomi:e2e >/dev/null
else
  docker run -d --name "$DB" --network "$NET" \
    -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=yomi postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$DB" pg_isready -q 2>/dev/null && break; sleep 1; done

  docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
    -e DATABASE_URL="postgres://postgres:e2e@$DB:5432/yomi" \
    -e JWT_SECRET='e2e-secret-at-least-16-chars' \
    -e LIBRARY_BACKEND=owned \
    -e FAKE_SOURCE_URLS="fake-a=http://$FAKE_A:$FAKE_A_PORT,fake-b=http://$FAKE_B:$FAKE_B_PORT" \
    -e DOWNLOAD_PAGE_GAP_MS=20 -e DOWNLOAD_RESUME_WAIT_MS=200,200,200 \
    -e PUID="$(id -u)" -e PGID="$(id -g)" \
    -v "$LIB":/library uchiyomi:e2e >/dev/null
fi

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
