#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="uchiyomi-ios-auth-$RANDOM-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# No persistent volume; only an ephemeral localhost port is exposed.
docker run --rm -d --name "$container" -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=uchiyomi_test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -U test -d uchiyomi_test >/dev/null 2>&1; then break; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp)"
export TEST_DATABASE_URL="postgres://test:test@127.0.0.1:${port##*:}/uchiyomi_test"
cd ios
swift test --disable-xctest --filter NativeAuthTests
