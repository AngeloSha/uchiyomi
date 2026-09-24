# Screenshots

Screenshots are **generated, never hand-taken**. If you change a screen, re-run the rig rather than cropping a
window by hand. The previous set was captured manually and went stale within a day: five features shipped in
the thirteen hours after it, and none of them appeared in a single image.

```bash
bash scripts/shots/run.sh --yes                        # everything
bash scripts/shots/run.sh --yes --only home,library    # a subset
bash scripts/shots/run.sh --yes --site-dir /path/to/site  # also refresh the marketing site's copies
bash scripts/shots/run.sh --yes --record                 # the tour video instead of stills
# the fixture shots (extensions, providers) against a throwaway instance -- see "Shots that use a fixture"
SHOT_NET=<its docker network> SHOT_BASE=http://<its container>:3000 \
  bash scripts/shots/run.sh --yes --login <user>:<password> --only admin-extensions,crop-extensions
# the desktop app's own pages, from the real Electron app
SHOT_SERVER=http://127.0.0.1:<port> xvfb-run -a node scripts/shots/desktop.mjs
```

Output lands in `docs/shots/` as WebP. With `--site-dir` it also writes smaller copies into the marketing
site's `assets/shots/` — one capture, two encodes, because the docs want sharpness and the site wants bytes.
Point `--site-dir` at either the site checkout or its `assets/shots/` directly; both resolve to the same
place.

## What it does

It drives a real browser (`ghcr.io/puppeteer/puppeteer`) against a **running** Uchiyomi over the Docker
network. Because the shots should show a real library rather than an empty demo, it runs against your own
instance.

The real admin account usually has 2FA, which a scripted password login can't get past, so the rig creates a
temporary `shotbot` admin directly in the database, signs in **once**, reuses that one session for every shot,
and deletes the account again in a trap that fires even if it crashes. It prints what it will insert and delete
before doing it, and refuses to start if a previous run left its account behind.

Everything is captured with `prefers-reduced-motion` forced on, and each shot waits for network idle, then for
every image to actually decode, then for fonts. That last part matters: the old `series.jpg` shipped for two
months with a blurred placeholder banner, an empty cover box and blank chapter thumbnails because it was taken
before the art arrived.

## Profiles

| Profile | Viewport | Output |
| --- | --- | --- |
| `desk` | 1366 × 860 @2x | 2732 × 1720 |
| `phone` | 390 × 844 @3x | 1170 × 2532 |
| `crop` | element-clipped | varies |

Admin screens are framed by scrolling the relevant panel into view rather than clipping the column: a plain
full-viewport shot of a two-column settings grid is mostly the hero, and a full-column clip comes out absurdly
tall.

## Shots that use a fixture

Some states can't exist on a capture-only account, and some must not be photographed as they really are, so
the rig supplies them. Every one renders real components from real response shapes; only the inputs are
provided. They are listed here so nobody later mistakes them for mockups.

- **`login-sso`** — intercepts `GET /auth/config` to report an OIDC provider. SSO isn't configured on the
  instance these are captured from, and `oidcEnabled()` is a pure env check, so the button cannot appear
  otherwise.
- **The extension and sources shots** — `admin-extensions`, `crop-extensions`, `crop-repo-empty`,
  `crop-repo-added`, `crop-repo-toast` (the success message, taken the moment the add answers: it lasts 3.2 s),
  `ext-strip-1..3`, `admin-providers`, and the site's phone plates `phone-repo-empty`,
  `phone-repo-added`, `phone-extensions` and `phone-sources`. Since v0.45.0 no screenshot may show a real
  extension, site or repository name (the owner's rule): the live catalogue is a legible wall of third-party site
  names, some 18+, and a shot of the repository row would show the live server's repository address. So these
  are taken on a page whose `/api/admin/extensions/*`, `/api/sources` and `/api/admin/sources*` answers come from
  `scripts/shots/fixtures.mjs` — made-up extensions (*Example Manga (EN)*, *Sample Reader*…), generated icons with no letters
  in them, MangaDex beside two made-up sites, and the repository `https://example.org/repo/index.min.json` the
  tests use. It applies on every run, against any instance, so a later live run cannot bring the real names
  back; and unlike the older shots these fail loudly when an element is missing. They need no library, so take
  them against a throwaway instance with `--login` (no database is touched), never by creating an account on
  someone's server.
- **`desktop-library-folder`** (from `desktop.mjs`) — the folder page's path is set through the page's own
  `show()` to what a Windows PC computes (`C:\Users\you\Uchiyomi Library`, 412 GB free) instead of the Linux
  build host's home folder. Everything else on the desktop pages is what the app showed: a certificate made at
  run time for `manga.home.arpa` (RFC 8375's home-network name, mapped to 127.0.0.1 inside Chromium, so no real
  host is involved), whose fingerprint the script checks against `openssl` before it takes the picture.

- **Every shot taken on a real library, and the tour** — `neutralNames()` in `fixtures.mjs`. A real library
  names where its chapters come from: `series` showed a real site and two scanlation groups in its supply line,
  and the tour showed the same line, a scanlator's credits page and the live extension catalogue. So the library
  pages (in `capture.mjs`) and the tour's page (in `record.mjs`) show every source and translation-group name the
  app's own API answers carry as a made-up one (*Example Manga*, *Example Scans*, *Sample Translations*…) — in
  text and in `title` / `aria-label` / `alt`, from the first frame — and every source or extension icon (a site's
  logo) as a generated tile. MangaDex stays: it is the built-in source every guide names. The names are met first
  (the Providers tab lists them all), so a name inside a sentence is caught too. The tour also uses the extension
  fixture above for its catalogue, and keeps no frame until the reader has jumped past a chapter's first page
  (the credits page). ⚠️ Silent by design, like the rest of the rig: a name that reaches the screen by a field
  `namesIn()` does not read is not rewritten — look at every image and every second of the video.

Everything else is the real thing, including the health findings.

## The desktop app's pages

`scripts/shots/desktop.mjs` launches the real Electron app under Xvfb on a fresh profile and photographs its
own pages: the first-launch choice, the server address, the certificate prompt and the changed-certificate
warning (a self-signed https front it runs itself, proxying to `SHOT_SERVER`), the error page for a server that
does not answer, the library-folder page, and the Extensions tab before the engine download (that one needs
the standalone payload staged: `node desktop/scripts/stage.mjs`). It needs Linux with Xvfb, node 22+,
`npm ci` and `npm run build` in `desktop/` with the Electron binary installed, and openssl. The black around a
shell page is trimmed. The tray menus and native dialogs cannot be reached from the page, so they are
described in words, not pictured; operating-system dialogs (SmartScreen, Gatekeeper) are never faked.

## Per-user screens look empty, and that is correct

The rig signs in as a freshly created account, so anything scoped to one user renders with nothing in it:
`profile-stats` shows zero chapters and no streak, `crop-tokens` shows "No tokens yet". For documenting a
feature that is honest and fine. For marketing it usually is not, so don't reach for `profile-stats` or
`wrapped` to illustrate a claim about a busy library. Use a screen that is server-wide instead, like
`library`, `admin-members`, `admin-libraries` or `admin-health`.

Capturing a populated stats page would mean signing in as a real reader, which the rig deliberately cannot
do: the real accounts have 2FA, and working around that is worse than the screenshot is worth.

## Currency

The whole set was re-captured against **v0.40.0** on 2026-09-22, along with the tour video, so nothing in
`docs/shots/` currently shows a retired screen. For **v0.45.0** the extension and sources shots were retaken on
the fixture above and the desktop pages added. Then everything that showed a third-party name was retaken
behind `neutralNames()`: **the tour** (`tour.webp`, and the site's `tour.mp4`/`tour.webm`/posters: a real site
and its groups in the series supply line, a scanlator's credits page with its site address and a Discord invite,
the live extension catalogue), **`series`** (the same supply line), **`home`** (a scraped summary naming a
site), **`library`** (a site's name as a format tag, a scanlator's logo on a cover), **`admin-libraries`** (a
library named after a site, and folders named after sites and scanlators — the site's `phone-libraries` plate is
a crop of it), **`phone-home`** (a credits page as the Keep reading thumbnail), **`phone-library`**, and
**`reader`**, **`phone-reader`** and **`discover`** with them. They were taken on a throwaway instance
(`--login`, no account created anywhere) holding a small library of MangaDex series — the rig's live-library run
creates an account on the server, which is not done for a fix — with a readiness-only solver stand-in so Health
reads as a healthy server, one extra library ("Family", 13+) so the Libraries shot has two, and
`SHOT_PALETTE_QUERY` / `SHOT_DISCOVER_QUERY` set to words that library matches. `admin-health`, `admin-members`
and the per-user shots show no third-party name and were not retaken; the next live run takes every library
shot behind `neutralNames()` automatically.

Two things that run were worth writing down, because both had been silently wrong for weeks:

- `profile-security` and `profile-stats` had been **byte-identical**. The Account capture navigates to
  `/profile/?tab=Account`, and `?tab=` addresses only arrived in v0.39.0 — before that the deep link was
  ignored and the rig photographed the You tab twice. Two identical files is the tell; check for it.
- `admin-import` had been defined in `capture.mjs` since v0.35.0 and had **never produced a file**, so the
  reviewed-import page was undocumented and unillustrated. A capture that is defined but not referenced
  anywhere is easy to lose; `ls docs/shots/` against the `want(...)` calls catches it.

`record.mjs` had drifted separately: it clicked **Providers** and then looked for the extension search
field, which moved to its own tab in v0.39.0. Everything after that point was guarded by `if (f)`, so the
recording simply lost its last twelve seconds without saying anything.

## Adding a shot

Add a `want('<name>')` block in `scripts/shots/capture.mjs` and re-run with `--only <name>`. Prefer a whole
screen over a crop unless the crop is going to be used small, always look at the result before committing
it, and reference it from a doc or the site — an unreferenced shot stops being maintained.
