# Screenshots

Screenshots are **generated, never hand-taken**. If you change a screen, re-run the rig rather than cropping a
window by hand. The previous set was captured manually and went stale within a day: five features shipped in
the thirteen hours after it, and none of them appeared in a single image.

```bash
bash scripts/shots/run.sh --yes                        # everything
bash scripts/shots/run.sh --yes --only home,library    # a subset
bash scripts/shots/run.sh --yes --site-dir /path/to/site  # also refresh the marketing site's copies
bash scripts/shots/run.sh --yes --record                 # the tour video instead of stills
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

Two states can't exist on a capture-only account against a live server, so the rig supplies them. Both render
real components from real response shapes; only the inputs are provided. They are listed here so nobody later
mistakes them for mockups.

- **`login-sso`** — intercepts `GET /auth/config` to report an OIDC provider. SSO isn't configured on the
  instance these are captured from, and `oidcEnabled()` is a pure env check, so the button cannot appear
  otherwise.

Everything else is the real thing, including the extension catalogue and the health findings.

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
`docs/shots/` currently shows a retired screen.

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
