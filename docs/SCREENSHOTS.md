# Screenshots

Screenshots are **generated, never hand-taken**. If you change a screen, re-run the rig rather than cropping a
window by hand. The previous set was captured manually and went stale within a day: five features shipped in
the thirteen hours after it, and none of them appeared in a single image.

```bash
bash scripts/shots/run.sh --yes                        # everything
bash scripts/shots/run.sh --yes --only home,library    # a subset
bash scripts/shots/run.sh --yes --site                 # also refresh the marketing site's copies
```

Output lands in `docs/shots/` as WebP. With `--site` it also writes smaller copies into the marketing site's
`assets/shots/` — one capture, two encodes, because the docs want sharpness and the site wants bytes.

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

Admin screens are framed by scrolling the relevant panel into view rather than clipping the column: the admin
content is capped around 768px inside a 1366px viewport, so a plain full-viewport shot is mostly empty black
and a full-column clip comes out absurdly tall.

## Shots that use a fixture

Two states can't exist on a capture-only account against a live server, so the rig supplies them. Both render
real components from real response shapes; only the inputs are provided. They are listed here so nobody later
mistakes them for mockups.

- **`login-sso`** — intercepts `GET /auth/config` to report an OIDC provider. SSO isn't configured on the
  instance these are captured from, and `oidcEnabled()` is a pure env check, so the button cannot appear
  otherwise.

Everything else is the real thing, including the extension catalogue and the health findings.

## Adding a shot

Add an entry to `SHOTS` handling in `scripts/shots/capture.mjs` and re-run with `--only <name>`. Prefer a
whole screen over a crop unless the crop is going to be used small, and always look at the result before
committing it.
