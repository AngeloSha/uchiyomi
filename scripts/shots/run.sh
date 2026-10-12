#!/usr/bin/env bash
# Capture every screenshot the docs and the marketing site use.
#
#   bash scripts/shots/run.sh --yes                       # everything
#   bash scripts/shots/run.sh --yes --only home,library   # a subset
#   bash scripts/shots/run.sh --yes --site                # also refresh the marketing site's copies
#   SHOT_NET=<net> SHOT_BASE=http://<app>:3000 bash scripts/shots/run.sh --yes --login user:pass --only admin-extensions
#                                                         # a throwaway instance's own account; no database is touched
#
# Screenshots are GENERATED, never hand-taken. See docs/SCREENSHOTS.md.
#
# This signs in as a throwaway admin it creates and then deletes, because the real admin account has 2FA and
# a scripted password login cannot get past it. That means it writes to a live database, so it says exactly
# what it will do and refuses to run if a previous run left its account behind.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=${DB_CONTAINER:-yomi-db}
NET=${SHOT_NET:-yomi_yomi_app}
# The defaults are the maintainer's server: its database container, its network, and the app container on it. On
# another install set DB_CONTAINER, SHOT_NET and SHOT_BASE; the single-container install keeps its database inside the
# app container, so there point DB_CONTAINER at that (`uchiyomi`). Against the development stack the app is
# `http://yomi-web` and the image `yomi-bff:prod`.
BASE=${SHOT_BASE:-http://uchiyomi:3000}
# Only used as a throwaway node+sharp environment for hashing a password and encoding WebP -- any image
# with the app's dependencies will do, which is why it is the app image rather than a separate tool.
BFF_IMAGE=${BFF_IMAGE:-ghcr.io/angelosha/uchiyomi:latest}
SHOT_USER=shotbot
OUT_PNG=$(mktemp -d)
OUT_WEBP="$REPO/docs/shots"
ONLY=""; YES=0; SITE=""; RECORD=0; LOGIN=""
# A reading life for the capture account (fixtures.mjs seedReading): only for the throwaway one this script creates.
SEED=0
SITE_DIR=${SITE_DIR:-}     # only for --site: where to ALSO publish shots (a marketing site checkout)

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --site)
      [ -n "$SITE_DIR" ] || { echo "--site needs SITE_DIR=<path> (or use --site-dir <path>)" >&2; exit 1; }
      SITE="$SITE_DIR"; shift ;;
    --record) RECORD=1; shift ;;
    --site-dir) SITE="$2"; shift 2 ;;
    # user:password of an account that already exists on SHOT_BASE -- a throwaway instance (web/test/e2e/up.sh
    # with KEEP=1). Then nothing is written to any database. The fixture shots (extensions, providers) need no
    # real library, so they are taken this way; never create accounts on someone's live server for them.
    --login) LOGIN="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

psql() { docker exec -i "$DB" psql -h 127.0.0.1 -U "${PGUSER:-yomi}" -d "${PGDATABASE:-yomi}" -tAc "$1"; }

if [ -n "$LOGIN" ]; then
  SHOT_USER="${LOGIN%%:*}"; PW="${LOGIN#*:}"
  echo "· signing in as '$SHOT_USER' on $BASE (--login: no account is created, no database is touched)"
  SERIES_ID=${SHOT_SERIES_ID:-}; BOOK_ID=${SHOT_BOOK_ID:-}
  cleanup() { docker run --rm -u 0 -v "$OUT_PNG":/t alpine sh -c 'rm -rf /t/* /t/.[!.]* 2>/dev/null' >/dev/null 2>&1 || true; rm -rf "$OUT_PNG"; }
  trap cleanup EXIT INT TERM
else
cat <<EOF
This will, against the LIVE database in container '$DB':
  • create a temporary admin account '$SHOT_USER' (random password)
  • give it some reading progress, one rating and one favourite, so the screens show what a reader sees
  • capture screenshots from $BASE
  • DELETE that account again, even if it fails partway -- and everything it read, rated and favourited with it
It does not touch any existing user, series or file. The audit log keeps its sign-ins, as for any account.
EOF
if [ "$YES" != "1" ]; then
  read -r -p "Continue? [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ] || exit 1
fi

# Said plainly: without this a missing container read as "a previous run did not clean up" below.
docker inspect "$DB" >/dev/null 2>&1 || { echo "error: no database container '$DB' -- set DB_CONTAINER" >&2; exit 1; }
if [ "$(psql "SELECT count(*) FROM users WHERE username='$SHOT_USER'")" != "0" ]; then
  echo "error: a '$SHOT_USER' account already exists — a previous run did not clean up." >&2
  echo "       remove it with: docker exec $DB psql -U yomi -d yomi -c \"DELETE FROM users WHERE username='$SHOT_USER'\"" >&2
  exit 1
fi

cleanup() {
  local rc=$?
  psql "DELETE FROM users WHERE username='$SHOT_USER'" >/dev/null 2>&1 || true
  # the capture container writes as its own user, so hand the files back before removing them
  docker run --rm -u 0 -v "$OUT_PNG":/t alpine sh -c 'rm -rf /t/* /t/.[!.]* 2>/dev/null' >/dev/null 2>&1 || true
  rm -rf "$OUT_PNG"
  [ $rc -eq 0 ] || echo "(cleaned up after a failure)" >&2
}
trap cleanup EXIT INT TERM

PW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
HASH="$(docker run --rm -e PW="$PW" --entrypoint node "$BFF_IMAGE" \
  -e 'require("@node-rs/argon2").hash(process.env.PW).then(h=>process.stdout.write(h))')"
psql "INSERT INTO users (username, display_name, password_hash, role, auth_kind)
      VALUES ('$SHOT_USER','Admin','$HASH','admin','password')" >/dev/null
echo "· temporary admin created"

# Pick real content so the shots show a real library rather than an empty state: the most popular series with its
# own banner and cover art and a checked AniList score (the ratings panel's tile, v0.60.0), of a size a progress bar
# reads well at; else the biggest one with art. Never a removed or merged series, nor a deleted chapter, which has no
# pages to photograph (lib/chapterCleanup.ts deletes chapters once read, and chapter 1 is the first to go).
SERIES_ID=${SHOT_SERIES_ID:-$(psql "SELECT s.id FROM lib_series s
  JOIN series_art sa ON sa.series_id = s.id AND sa.banner IS NOT NULL AND sa.cover IS NOT NULL
  JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
  JOIN anilist_scores a ON a.anilist_id = t.external_id AND a.score IS NOT NULL
  WHERE s.deleted_at IS NULL AND s.merged_into IS NULL AND s.books_count BETWEEN 30 AND 400
  ORDER BY a.popularity DESC NULLS LAST LIMIT 1" | tr -d ' ')}
[ -n "$SERIES_ID" ] || SERIES_ID=$(psql "SELECT s.id FROM lib_series s JOIN series_art a ON a.series_id=s.id
  WHERE a.banner IS NOT NULL AND a.cover IS NOT NULL AND s.deleted_at IS NULL AND s.merged_into IS NULL
  ORDER BY s.books_count DESC LIMIT 1" | tr -d ' ')
# Chapter 1 before any chapter 0: a "chapter 0" is a prologue or teaser, often a few panels on black, and the v0.60.1
# re-shoot's reader landed on a nearly empty dark page because of it.
BOOK_ID=${SHOT_BOOK_ID:-$(psql "SELECT b.id FROM lib_books b WHERE b.series_id='$SERIES_ID' AND b.pages > 3
  AND b.pruned_at IS NULL ORDER BY (b.number < 1), b.number LIMIT 1" | tr -d ' ')}
[ -n "$BOOK_ID" ] || BOOK_ID=$(psql "SELECT id FROM lib_books WHERE pages > 3 AND pruned_at IS NULL ORDER BY random() LIMIT 1" | tr -d ' ')
# crop-related (v0.61.0): the series whose AniList entry has the most related works, so the Related row is a row. The
# shot series often has one (a sequel) and the band would be one cover and a field of black. Never an 18+ one.
RELATED_ID=${SHOT_RELATED_ID:-$(psql "SELECT s.id FROM lib_series s
  JOIN series_art sa ON sa.series_id = s.id AND sa.cover IS NOT NULL
  JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
  JOIN anilist_related r ON r.anilist_id = t.external_id
  WHERE s.deleted_at IS NULL AND s.merged_into IS NULL
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.relations) x WHERE (x->>'adult')::boolean)
  ORDER BY jsonb_array_length(r.relations) DESC, s.books_count DESC LIMIT 1" 2>/dev/null | tr -d ' ')}
SEED=1
echo "· series $SERIES_ID · book $BOOK_ID"
fi

chmod 777 "$OUT_PNG"

if [ "$RECORD" = "1" ]; then
  # Record the tour instead of taking stills. Encoding happens on the host, which has ffmpeg with x264,
  # vp9 and animated-webp — no extra image needed.
  docker run --rm --network "$NET" -w /home/pptruser \
    -e SHOT_BASE="$BASE" -e SHOT_OUT=/out -e SHOT_USER="$SHOT_USER" -e SHOT_PASS="$PW" \
    -e SHOT_SERIES_ID="$SERIES_ID" -e SHOT_BOOK_ID="$BOOK_ID" -e SHOT_SEED="$SEED" \
    -e SHOT_PALETTE_QUERY -e SHOT_DISCOVER_QUERY \
    -v "$OUT_PNG":/out -v "$REPO/scripts/shots":/home/pptruser/shots:ro \
    ghcr.io/puppeteer/puppeteer:latest node /home/pptruser/shots/record.mjs

  DEMO="${DEMO_DIR:-"$REPO/docs/shots"}"   # set DEMO_DIR= to also drop the video on a marketing site
  mkdir -p "$DEMO"
  F="$OUT_PNG/frames"
  echo "· encoding"
  # No global speed-up: record.mjs varies the rate per segment and writes it into the frame durations, so
  # the moments worth watching play near real time while loading and dead air are compressed.
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$F/concat.txt" -vf "scale=1280:-2,fps=30" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 31 -movflags +faststart -an "$DEMO/tour.mp4"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$F/concat.txt" -vf "scale=1280:-2,fps=30" \
    -c:v libvpx-vp9 -crf 40 -b:v 0 -row-mt 1 -an "$DEMO/tour.webm"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$F/concat.txt" -vf "scale=1280:-2" -frames:v 1 "$DEMO/tour-poster.webp"
  # GitHub will not play an MP4 inline, so the README gets an animated WebP instead.
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$F/concat.txt" -vf "scale=800:-2,fps=11" \
    -t 12 -c:v libwebp_anim -lossless 0 -q:v 55 -loop 0 "$REPO/docs/shots/tour.webp"
  ls -la "$DEMO" "$REPO/docs/shots/tour.webp" | grep -E "tour|total" | sed 's/^/  /'
  exit 0
fi

docker run --rm --network "$NET" \
  -w /home/pptruser \
  -e SHOT_BASE="$BASE" -e SHOT_OUT=/out -e SHOT_USER="$SHOT_USER" -e SHOT_PASS="$PW" \
  -e SHOT_ONLY="$ONLY" -e SHOT_SERIES_ID="$SERIES_ID" -e SHOT_BOOK_ID="$BOOK_ID" -e SHOT_SEED="$SEED" -e SHOT_RELATED_ID="${RELATED_ID:-}" \
  -v "$OUT_PNG":/out -v "$REPO/scripts/shots":/home/pptruser/shots:ro \
  ghcr.io/puppeteer/puppeteer:latest node /home/pptruser/shots/capture.mjs

mkdir -p "$OUT_WEBP"
# Encode with the bff image's sharp — no new dependency, and it is already in every dev's cache.
# Docs get sharp originals; the marketing site gets smaller ones. One source, two encodes.
# The docs say the site copies land in the marketing site's `assets/shots/`, and the encoder below writes to
# the root of whatever is mounted at /site. Point --site-dir at a site checkout and you get six webp files
# dumped in its root instead, which is silent: the run reports success and the site keeps serving the old
# images. Resolve it here so both readings of --site-dir do the right thing.
if [ -n "$SITE" ] && [ -d "$SITE/assets/shots" ]; then
  echo "· site: resolving $SITE -> $SITE/assets/shots"
  SITE="$SITE/assets/shots"
fi

docker run --rm -u 0 --entrypoint node -w /app -e NODE_PATH=/app/node_modules \
  -v "$OUT_PNG":/png -v "$OUT_WEBP":/webp ${SITE:+-v "$SITE":/site} "$BFF_IMAGE" -e '
const sharp=require("sharp"), fs=require("fs");
(async()=>{
  const site = fs.existsSync("/site");
  for (const f of fs.readdirSync("/png").filter(n=>n.endsWith(".png"))) {
    const n=f.replace(/\.png$/,""), src=`/png/${f}`;
    const crop=n.startsWith("crop-");
    await sharp(src).webp({quality:crop?88:82}).toFile(`/webp/${n}.webp`);
    if (site) await sharp(src).resize({width:1800,withoutEnlargement:true}).webp({quality:76}).toFile(`/site/${n}.webp`);
    console.log("  ·", n);
  }
})();'
echo "✓ docs/shots/ updated${SITE:+ (and the marketing site)}"
