#!/usr/bin/env bash
# Capture every screenshot the docs and the marketing site use.
#
#   bash scripts/shots/run.sh --yes                       # everything
#   bash scripts/shots/run.sh --yes --only home,library   # a subset
#   bash scripts/shots/run.sh --yes --site                # also refresh the marketing site's copies
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
# The app serves its own web UI, so there is no separate nginx to point at. These defaults follow the
# single-container layout; override them if you are shooting against the development stack, where the
# equivalents are `http://yomi-web` and `yomi-bff:prod`.
BASE=${SHOT_BASE:-http://uchiyomi:3000}
# Only used as a throwaway node+sharp environment for hashing a password and encoding WebP -- any image
# with the app's dependencies will do, which is why it is the app image rather than a separate tool.
BFF_IMAGE=${BFF_IMAGE:-ghcr.io/angelosha/uchiyomi:latest}
SHOT_USER=shotbot
OUT_PNG=$(mktemp -d)
OUT_WEBP="$REPO/docs/shots"
ONLY=""; YES=0; SITE=""; RECORD=0
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
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

psql() { docker exec -i "$DB" psql -h 127.0.0.1 -U "${PGUSER:-yomi}" -d "${PGDATABASE:-yomi}" -tAc "$1"; }

cat <<EOF
This will, against the LIVE database in container '$DB':
  • create a temporary admin account '$SHOT_USER' (random password)
  • capture screenshots from $BASE
  • DELETE that account again, even if it fails partway
It does not touch any existing user, series or file.
EOF
if [ "$YES" != "1" ]; then
  read -r -p "Continue? [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ] || exit 1
fi

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

# Pick real content so the shots show a real library rather than an empty state.
SERIES_ID=${SHOT_SERIES_ID:-$(psql "SELECT s.id FROM lib_series s JOIN series_art a ON a.series_id=s.id
  WHERE a.banner IS NOT NULL AND a.cover IS NOT NULL ORDER BY s.books_count DESC LIMIT 1" | tr -d ' ')}
BOOK_ID=${SHOT_BOOK_ID:-$(psql "SELECT b.id FROM lib_books b WHERE b.series_id='$SERIES_ID' AND b.pages > 3
  ORDER BY b.number LIMIT 1" | tr -d ' ')}
[ -n "$BOOK_ID" ] || BOOK_ID=$(psql "SELECT id FROM lib_books WHERE pages > 3 ORDER BY random() LIMIT 1" | tr -d ' ')
echo "· series $SERIES_ID · book $BOOK_ID"

chmod 777 "$OUT_PNG"

if [ "$RECORD" = "1" ]; then
  # Record the tour instead of taking stills. Encoding happens on the host, which has ffmpeg with x264,
  # vp9 and animated-webp — no extra image needed.
  docker run --rm --network "$NET" -w /home/pptruser \
    -e SHOT_BASE="$BASE" -e SHOT_OUT=/out -e SHOT_USER="$SHOT_USER" -e SHOT_PASS="$PW" \
    -e SHOT_SERIES_ID="$SERIES_ID" -e SHOT_BOOK_ID="$BOOK_ID" \
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
  -e SHOT_ONLY="$ONLY" -e SHOT_SERIES_ID="$SERIES_ID" -e SHOT_BOOK_ID="$BOOK_ID" \
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
