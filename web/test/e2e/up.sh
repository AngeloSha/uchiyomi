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
#   KEEP=1 E2E_ADULT=1 bash web/test/e2e/up.sh   # fake-b declares itself adult: what walk42 needs
#   E2E_EMBEDDED=1 bash web/test/e2e/up.sh   # no Postgres container: the image runs its own (DATABASE_URL unset)
#   KEEP=1 E2E_ENGINE=fake E2E_ENGINE_MODE=down bash web/test/e2e/up.sh   # with the fake extension engine (walk49 engine)
#   KEEP=1 E2E_ENGINE=fake E2E_ARCHIVE_FAST=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # the stack for all of walk49
#     -- which then needs E2E_ARCHIVE_FAST=1 on its own command too (walk49.mjs's header): this flag only sets the
#     app's archive timing, and a walk without it skips the archive checks that need that timing
#   E2E_NO_WALK=1 skips the run.mjs walk at the end (with KEEP=1: just bring an instance up to poke at)
#   E2E_MIN_FREE_GB=0 on a host with less than 10 GiB free: the downloader's floor refuses every download under it
#   KEEP=1 E2E_SKIP_BUILD=1 E2E_IMAGE=uchiyomi:e2e-final E2E_NO_WALK=1 bash web/test/e2e/up.sh
#     reuses that already-built AIO image. Skip mode requires an explicit E2E_IMAGE, verifies it before changing any
#     stack state, and runs its resolved image ID, so every phase can exercise the exact same final build.
#   KEEP=1 E2E_ENGINE=fake E2E_FAKE_EXTRA=v54 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # the stack for walk49's replace
#   KEEP=1 E2E_ENGINE=fake E2E_FAKE_EXTRA=v55 E2E_MAX_SOURCES=2 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # walk49's autofix
#   KEEP=1 E2E_SOLVERS=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # walk49's solver: a main and a backup solver, fake-b
#     behind a fake Cloudflare
#   KEEP=1 E2E_EMPTY_LIBRARY=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # walk49's find: a new server, nothing in its library
#   KEEP=1 E2E_ANILIST=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh   # walk49's matches: a fake AniList (fakeAniList.mjs) as
#     ANILIST_API_URL, so nothing on the instance asks the real AniList
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
FAKE_C="$NET-fake-c"
FAKE_D="$NET-fake-d"
ENGINE_C="$NET-engine"
SOLVER_MAIN="$NET-solver-main"
SOLVER_BACKUP="$NET-solver-backup"
ANILIST_C="$NET-anilist"
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
# v0.55.1, the autofix walk's two more (E2E_FAKE_EXTRA=v55 only): fake-c, whose images answer 429, and fake-d, whose page
# lists fail -- the owner's Mangakakalot and AllManga. From a range of their own, two per app port: 24000-25999.
FAKE_C_PORT=${E2E_FAKE_C_PORT:-$((24000 + (PORT % 1000) * 2))}
FAKE_D_PORT=${E2E_FAKE_D_PORT:-$((FAKE_C_PORT + 1))}
OWNER=0
case ",${E2E_FAKE_EXTRA:-}," in *,v55,*) OWNER=1 ;; esac
# The engine's from a range of its own: the fake sources hold 20000-21999 (two per app port) and walk43's webhook
# listener 22000-22999. It was FAKE_B_PORT + 1 -- the next app port's fake-a port -- so an instance with the engine
# stopped the one started on PORT+1 from binding its first fake source.
ENGINE_PORT=${E2E_ENGINE_PORT:-$((23000 + PORT % 1000))}
# v0.55.3, E2E_SOLVERS=1: two fake Cloudflare solvers (fakeSolver.mjs) -- the main greeting as trawl 1.7.0, the backup
# as FlareSolverr 3.5.2 -- as the app's FLARESOLVERR_URL and FLARESOLVERR_FALLBACK_URL, and fake-b behind a fake
# Cloudflare: its stub answers only a request carrying a solver's cf_clearance (fakeSource.mjs --cloudflare yes), and the
# app asks it through the solvers (FAKE_SOURCE_CLOUDFLARE). For walk49's solver phase (solverWalk.mjs). Their control
# ports from a range of their own, two per app port: 26000-27999.
SOLVERS=${E2E_SOLVERS:-0}
SOLVER_MAIN_PORT=${E2E_SOLVER_MAIN_PORT:-$((26000 + (PORT % 1000) * 2))}
SOLVER_BACKUP_PORT=$((SOLVER_MAIN_PORT + 1))
# v0.55.7, E2E_ANILIST=1: a fake AniList (fakeAniList.mjs) as the app's ANILIST_API_URL -- every AniList call, the title
# lookups for covers, banners and links included (bff lib/anilist.ts) -- for walk49's matches phase (v557Walk.mjs). Unset,
# the app asks the real AniList, as every walk before did. Its control port from a range of its own: 28000-28999.
ANILIST=${E2E_ANILIST:-0}
ANILIST_PORT=${E2E_ANILIST_PORT:-$((28000 + PORT % 1000))}
# E2E_ENGINE=fake: the strict fake Suwayomi v2.3.2243 (bff/test/fixtures/fakeSuwayomiEngine.mjs) as the extension
# engine, in E2E_ENGINE_MODE (up, down, slow, extension_error; /__mode switches it later). Unset: no engine at
# all, SUWAYOMI_URL empty -- the "No extension engine is set up" state (#72).
ENGINE=${E2E_ENGINE:-}
# The image's tag: its own per run when several instances are built at once (parallel lanes), so one run never
# starts another's build.
IMAGE=${E2E_IMAGE:-uchiyomi:e2e}
SKIP_BUILD=${E2E_SKIP_BUILD:-0}
case "$SKIP_BUILD" in
  0) ;;
  1)
    # Fail before mktemp, container removal or network creation. A typo must not silently run whatever happens to be
    # tagged uchiyomi:e2e, and resolving the explicit ref now keeps this stack on one immutable local image ID.
    [ -n "${E2E_IMAGE:-}" ] || { echo "E2E_SKIP_BUILD=1 requires an explicit E2E_IMAGE" >&2; exit 1; }
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null) \
      || { echo "E2E_SKIP_BUILD=1 image does not exist: $IMAGE" >&2; exit 1; }
    [ -n "$IMAGE_ID" ] || { echo "E2E_SKIP_BUILD=1 could not resolve image: $IMAGE" >&2; exit 1; }
    IMAGE="$IMAGE_ID"
    ;;
  *) echo "E2E_SKIP_BUILD must be 0 or 1" >&2; exit 1 ;;
esac
LIB=$(mktemp -d)
DATA=$(mktemp -d)
# The v0.42.0 walk needs one provider that declares itself adult, to prove the "Show 18+" reveal keeps it
# off Discover (issue #64). Opt-in, and fake-b rather than fake-a, because an adult source is skipped by
# the failure hunt (bff/src/lib/sourceHunt.ts) and by every listing while the reveal is off -- marking one
# by default would change what the v0.40 and v0.41 walks see. Empty means nothing is marked, which is the
# ordinary shape of this instance.
# The same walk needs one series whose title carries characters a keyboard cannot type (#66), and it is
# served by fake-a alone so that adding it names one provider and no fold has to be resolved.
if [ "${E2E_ADULT:-0}" = "1" ]; then ADULT_SOURCE="fake-b"; EXTRA_A="v42"; else ADULT_SOURCE=""; EXTRA_A="none"; fi
# E2E_FAKE_EXTRA: more of fakeSource.mjs's opt-in series, on BOTH fakes (`v54`: replaceWalk.mjs's swap-* series, which a
# Replace run moves from fake-a to fake-b). Unset: each fake serves what it always did.
EXTRA_B="${E2E_FAKE_EXTRA:-none}"
if [ -n "${E2E_FAKE_EXTRA:-}" ]; then EXTRA_A="$EXTRA_A,$E2E_FAKE_EXTRA"; fi
# What the app is started with beyond the common set, for both database layouts.
APP_ENV=()
# E2E_ARCHIVE_FAST=1: the slow archive's test-only timing (#117; bff lib/archive.ts, lib/archivePace.ts). With the
# owner's defaults its first look comes ten minutes after a boot, every chapter is followed by a break of at least
# 45 s and pages are 1.5-4 s apart, so a walk could never watch a chapter land. Here: the first look 5 s after the
# boot, a 2 s floor under the break, pages 20-60 ms apart, a tick every 2 s. Each has its own name to override
# (ARCHIVE_FIRST_RUN_MS=… and so on). Off by default: every walk before v0.49 runs against the real pacing.
if [ "${E2E_ARCHIVE_FAST:-0}" = "1" ]; then
  APP_ENV+=(-e "ARCHIVE_FIRST_RUN_MS=${ARCHIVE_FIRST_RUN_MS:-5000}" -e "ARCHIVE_MIN_BREAK_MS=${ARCHIVE_MIN_BREAK_MS:-2000}"
    -e "ARCHIVE_PAGE_GAP_MS=${ARCHIVE_PAGE_GAP_MS:-20,60}" -e "ARCHIVE_TICK_MS=${ARCHIVE_TICK_MS:-2000}")
fi
# E2E_MIN_FREE_GB: the downloader's free-space floor (MIN_FREE_GB, 10 GiB when unset), measured where the app
# downloads to -- in this rig the host's own disk. A test host with less free than that refuses every download, and
# the walks read it as a broken feature; 0 turns the floor off. Unset: the app's own default.
if [ -n "${E2E_MIN_FREE_GB:-}" ]; then APP_ENV+=(-e "MIN_FREE_GB=$E2E_MIN_FREE_GB"); fi
# E2E_MAX_SOURCES: the extension engine's source limit (SUWAYOMI_MAX_SOURCES, 25 when unset). The autofix walk runs
# under a limit of two: the two packages Fix everything keeps fit, one at a time beside each it tries and removes, and a
# third used source is then the one over it (Free a slot). Unset: the app's own default.
if [ -n "${E2E_MAX_SOURCES:-}" ]; then APP_ENV+=(-e "SUWAYOMI_MAX_SOURCES=$E2E_MAX_SOURCES"); fi
# After ENGINE_ENV on the app's command line, so these win over the engine's stand-in solver address.
if [ "$SOLVERS" = "1" ]; then
  APP_ENV+=(-e "FLARESOLVERR_URL=http://$SOLVER_MAIN:8191" -e "FLARESOLVERR_FALLBACK_URL=http://$SOLVER_BACKUP:8191" -e "FAKE_SOURCE_CLOUDFLARE=fake-b")
  CLOUDFLARE_B="yes"
else
  CLOUDFLARE_B="no"
fi
# v0.56.0: Discover's name lookups ask MangaDex and MangaUpdates after AniList; the fake answers both with nothing, so a
# walk never asks the real ones about its made-up titles.
if [ "$ANILIST" = "1" ]; then APP_ENV+=(-e "ANILIST_API_URL=http://$ANILIST_C:$ANILIST_PORT/" -e "MANGADEX_API_URL=http://$ANILIST_C:$ANILIST_PORT/md" -e "MANGAUPDATES_API_URL=http://$ANILIST_C:$ANILIST_PORT/mu"); fi

cleanup() {
  [ "${KEEP:-0}" = "1" ] && { echo "kept: $NET on :$PORT, fake sources on :$FAKE_A_PORT/:$FAKE_B_PORT${ENGINE:+, fake engine on :$ENGINE_PORT}$([ "$OWNER" = "1" ] && echo ", fake-c/fake-d on :$FAKE_C_PORT/:$FAKE_D_PORT")$([ "$SOLVERS" = "1" ] && echo ", solvers on :$SOLVER_MAIN_PORT/:$SOLVER_BACKUP_PORT")$([ "$ANILIST" = "1" ] && echo ", fake AniList on :$ANILIST_PORT") (library $LIB, data $DATA)"; return; }
  # -v: postgres:16-alpine declares its data directory a volume, and every run left that anonymous volume behind
  # (about 49 MB); nothing else here has one to leave.
  docker rm -f -v "$APP" "$DB" "$FAKE_A" "$FAKE_B" "$FAKE_C" "$FAKE_D" "$ENGINE_C" "$SOLVER_MAIN" "$SOLVER_BACKUP" "$ANILIST_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # /data is written by the container as PUID (our own uid), so a plain rm works.
  rm -rf "$LIB" "$DATA"
}
trap cleanup EXIT INT TERM

docker rm -f -v "$APP" "$DB" "$FAKE_A" "$FAKE_B" "$FAKE_C" "$FAKE_D" "$ENGINE_C" "$SOLVER_MAIN" "$SOLVER_BACKUP" "$ANILIST_C" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --subnet "$SUBNET" "$NET" >/dev/null

echo "· starting the two v0.40 fake sources"
docker run -d --name "$FAKE_A" --network "$NET" -p "127.0.0.1:$FAKE_A_PORT:$FAKE_A_PORT" \
  -v "$REPO:/repo:ro" -w /repo node:24-alpine \
  node web/test/e2e/fakeSource.mjs --name fake-a --port "$FAKE_A_PORT" --extra "$EXTRA_A" >/dev/null
docker run -d --name "$FAKE_B" --network "$NET" -p "127.0.0.1:$FAKE_B_PORT:$FAKE_B_PORT" \
  -v "$REPO:/repo:ro" -w /repo node:24-alpine \
  node web/test/e2e/fakeSource.mjs --name fake-b --port "$FAKE_B_PORT" --extra "$EXTRA_B" --cloudflare "$CLOUDFLARE_B" >/dev/null
FAKES="fake-a=http://$FAKE_A:$FAKE_A_PORT,fake-b=http://$FAKE_B:$FAKE_B_PORT"
STUBS="http://127.0.0.1:$FAKE_A_PORT/__log http://127.0.0.1:$FAKE_B_PORT/__log"
if [ "$OWNER" = "1" ]; then
  echo "· and the autofix walk's fake-c (images answer 429) and fake-d (page lists fail)"
  docker run -d --name "$FAKE_C" --network "$NET" -p "127.0.0.1:$FAKE_C_PORT:$FAKE_C_PORT" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeSource.mjs --name fake-c --port "$FAKE_C_PORT" --extra v551 >/dev/null
  docker run -d --name "$FAKE_D" --network "$NET" -p "127.0.0.1:$FAKE_D_PORT:$FAKE_D_PORT" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeSource.mjs --name fake-d --port "$FAKE_D_PORT" --extra v551 >/dev/null
  # Registered before fake-b, so a search asks them first (lib/scanOrder.ts keeps the registry's order): Replace must
  # pass over fake-d, which lists Fix Search but cannot update it, rather than reach fake-b first by luck.
  FAKES="fake-a=http://$FAKE_A:$FAKE_A_PORT,fake-c=http://$FAKE_C:$FAKE_C_PORT,fake-d=http://$FAKE_D:$FAKE_D_PORT,fake-b=http://$FAKE_B:$FAKE_B_PORT"
  STUBS="$STUBS http://127.0.0.1:$FAKE_C_PORT/__log http://127.0.0.1:$FAKE_D_PORT/__log"
fi
if [ "$SOLVERS" = "1" ]; then
  echo "· and two Cloudflare solvers: the main (trawl), the backup (FlareSolverr)"
  docker run -d --name "$SOLVER_MAIN" --network "$NET" -p "127.0.0.1:$SOLVER_MAIN_PORT:8191" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeSolver.mjs --name main --port 8191 --greeting trawl --version 1.7.0 >/dev/null
  docker run -d --name "$SOLVER_BACKUP" --network "$NET" -p "127.0.0.1:$SOLVER_BACKUP_PORT:8191" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeSolver.mjs --name backup --port 8191 --greeting flaresolverr --version 3.5.2 >/dev/null
  STUBS="$STUBS http://127.0.0.1:$SOLVER_MAIN_PORT/__mode http://127.0.0.1:$SOLVER_BACKUP_PORT/__mode"
fi
if [ "$ANILIST" = "1" ]; then
  echo "· and a fake AniList"
  docker run -d --name "$ANILIST_C" --network "$NET" -p "127.0.0.1:$ANILIST_PORT:$ANILIST_PORT" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeAniList.mjs --port "$ANILIST_PORT" --host "$ANILIST_C:$ANILIST_PORT" >/dev/null
  STUBS="$STUBS http://127.0.0.1:$ANILIST_PORT/__log"
fi
for stub in $STUBS; do
  ready=0
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "$stub"; then ready=1; break; fi
    sleep .1
  done
  [ "$ready" = "1" ] || { echo "fake source did not start: $stub" >&2; exit 1; }
done

ENGINE_ENV=()
if [ "$ENGINE" = "fake" ]; then
  echo "· starting the fake extension engine (${E2E_ENGINE_MODE:-up})"
  docker run -d --name "$ENGINE_C" --network "$NET" -p "127.0.0.1:$ENGINE_PORT:$ENGINE_PORT" \
    -v "$REPO:/repo:ro" -w /repo node:24-alpine \
    node web/test/e2e/fakeEngine.mjs --port "$ENGINE_PORT" --mode "${E2E_ENGINE_MODE:-up}" --extra "${E2E_FAKE_EXTRA:-none}" >/dev/null
  ready=0
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "http://127.0.0.1:$ENGINE_PORT/__mode"; then ready=1; break; fi
    sleep .1
  done
  [ "$ready" = "1" ] || { echo "fake engine did not start" >&2; exit 1; }
  # A solver address for the app to share with the engine (Connect); nothing needs it to answer.
  ENGINE_ENV=(-e "SUWAYOMI_URL=http://$ENGINE_C:$ENGINE_PORT" -e "FLARESOLVERR_URL=http://$NET-solver:8191")
  # v0.55.1: the autofix walk's GitHub, the fake engine's stand-in for the releases list Fix everything ranks extensions
  # by (bff lib/githubRelease.ts GITHUB_API_URL). Only there: every other stack asks nothing of GitHub it relies on.
  if [ "$OWNER" = "1" ]; then ENGINE_ENV+=(-e "GITHUB_API_URL=http://$ENGINE_C:$ENGINE_PORT/__github"); fi
fi

# E2E_EMPTY_LIBRARY=1 (v0.55.4): nothing seeded, so the library a new owner meets is the one the walk sees -- where
# "Import your library" is offered (walk49's find). run.mjs needs the seeded series: never both.
if [ "${E2E_EMPTY_LIBRARY:-0}" = "1" ]; then
  echo "· an empty library: nothing seeded"
else
  echo "· seeding a library"
  python3 "$REPO/web/test/e2e/seed.py" "$LIB"
fi

if [ "$SKIP_BUILD" = "1" ]; then
  echo "· using the prebuilt all-in-one image $IMAGE"
else
  echo "· building the all-in-one image"
  docker build -q -f "$REPO/Dockerfile.aio" -t "$IMAGE" "$REPO" >/dev/null
fi

if [ "$EMBEDDED" = "1" ]; then
  echo "· embedded database: no Postgres container, DATABASE_URL unset, /data mounted"
  docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
    -e JWT_SECRET='e2e-secret-at-least-16-chars' \
    -e LIBRARY_BACKEND=owned \
    -e FAKE_SOURCE_URLS="$FAKES" \
    -e FAKE_SOURCE_NSFW="$ADULT_SOURCE" \
    -e DOWNLOAD_PAGE_GAP_MS=20 -e DOWNLOAD_RESUME_WAIT_MS=200,200,200 \
    -e PUID="$(id -u)" -e PGID="$(id -g)" ${ENGINE_ENV[@]+"${ENGINE_ENV[@]}"} ${APP_ENV[@]+"${APP_ENV[@]}"} \
    -v "$LIB":/library -v "$DATA":/data "$IMAGE" >/dev/null
else
  docker run -d --name "$DB" --network "$NET" \
    -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=yomi postgres:16-alpine >/dev/null
  # Over TCP, not the socket: the image's first start runs initdb against a temporary server that listens on the
  # socket only, answers "ready", and is then stopped and started again. An app that connected in that gap died
  # with "the database system is starting up" and the walk had no instance to drive.
  for _ in $(seq 1 60); do docker exec "$DB" pg_isready -q -h 127.0.0.1 2>/dev/null && break; sleep 1; done

  docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:3000" \
    -e DATABASE_URL="postgres://postgres:e2e@$DB:5432/yomi" \
    -e JWT_SECRET='e2e-secret-at-least-16-chars' \
    -e LIBRARY_BACKEND=owned \
    -e FAKE_SOURCE_URLS="$FAKES" \
    -e FAKE_SOURCE_NSFW="$ADULT_SOURCE" \
    -e DOWNLOAD_PAGE_GAP_MS=20 -e DOWNLOAD_RESUME_WAIT_MS=200,200,200 \
    -e PUID="$(id -u)" -e PGID="$(id -g)" ${ENGINE_ENV[@]+"${ENGINE_ENV[@]}"} ${APP_ENV[@]+"${APP_ENV[@]}"} \
    -v "$LIB":/library "$IMAGE" >/dev/null
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

[ "${E2E_NO_WALK:-0}" = "1" ] && { echo "up: $NET on :$PORT"; exit 0; }

echo "· driving the browser"
cd "$REPO/web"
WALK_SCRIPT=${E2E_WALK_SCRIPT:-test/e2e/run.mjs}
# LIB and E2E_NET are harmless extras for the original walk and are the only safe handles the feature walks use to
# seed their disposable filesystem/database. Keeping the selected script inside this process means this file's EXIT
# trap owns cleanup and, with `set -e`, the browser's exact exit code reaches CI.
BASE="http://127.0.0.1:$PORT" E2E_USER="$USER" E2E_PASS="$PASS" LIB="$LIB" E2E_NET="$NET" node "$WALK_SCRIPT"
