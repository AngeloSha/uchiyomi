#!/usr/bin/env bash
# Render the 1200x630 social card from scripts/og-card/card.html.
#
#   bash scripts/og-card/run.sh
#
# Writes web/public/art/og.jpg. That single file is the app's og:image, the CasaOS store thumbnail
# (read from raw.githubusercontent on main, so it updates the listing the moment this is merged) and the
# source for the marketing site's copy and the repo's social preview -- the last of which has to be
# uploaded by hand, because GitHub has no API for it.
#
# Everything runs in containers: chrome for the screenshot, the app image for sharp. No host toolchain.
set -euo pipefail
cd "$(dirname "$0")/../.."

SLOGAN=${SLOGAN:-'Self-hosted manga server that <span class="grad">downloads too</span>'}
META=${META:-'Self-hosted &middot; discover &middot; grab &middot; monitor &middot; read &middot; uchiyomi.com'}
OUT=${OUT:-web/public/art/og.jpg}
CHROME_IMAGE=${CHROME_IMAGE:-zenika/alpine-chrome:124}
BFF_IMAGE=${BFF_IMAGE:-ghcr.io/angelosha/uchiyomi:latest}

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 - "$SLOGAN" "$META" > "$work/card.html" <<'PY'
import sys
html = open('scripts/og-card/card.html').read()
print(html.replace('__SLOGAN__', sys.argv[1]).replace('__META__', sys.argv[2]))
PY
cp "$work/card.html" scripts/og-card/.card.rendered.html

# --no-sandbox: chrome in a container with no user namespace. Local file, no network, nothing untrusted.
# --user: the image's own `chrome` user is uid 1000 and cannot write into a checkout owned by anyone else,
# which chrome reports as a screenshot failure at the very end rather than a mount problem at the start.
# HOME has to be writable too, or it dies looking for a profile directory.
docker run --rm --network none -v "$PWD:/w" -w /w \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --entrypoint chromium-browser "$CHROME_IMAGE" \
  --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1200,630 \
  --screenshot=/w/scripts/og-card/.card.png \
  "file:///w/scripts/og-card/.card.rendered.html" 2>&1 | grep -iE "^.*(Failed to write|Fatal)" && { echo "chrome could not write the screenshot" >&2; exit 1; }
test -s scripts/og-card/.card.png || { echo "chrome produced no screenshot" >&2; exit 1; }

# Back down to exactly 1200x630: rendered at 2x so the type is not fringed, then resampled.
docker run --rm --network none -v "$PWD:/w" -w /w --user "$(id -u):$(id -g)" \
  --entrypoint node "$BFF_IMAGE" -e "
const sharp = require('/app/node_modules/sharp');
sharp('/w/scripts/og-card/.card.png')
  .resize(1200, 630, { fit: 'fill', kernel: 'lanczos3' })
  .jpeg({ quality: 88, chromaSubsampling: '4:4:4', progressive: true })
  .toFile('/w/$OUT')
  .then(i => console.log('$OUT', i.width + 'x' + i.height, i.size + ' bytes'));
"
rm -f scripts/og-card/.card.png scripts/og-card/.card.rendered.html
