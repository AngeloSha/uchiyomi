# The performance rig

Frame timings for the pages people scroll, measured against a real instance. It was written for #71 ("laggy,
stutters when scrolling", Firefox on a modest Windows PC) so that the next report like it is **measured, not
guessed**. It is not part of CI, on purpose: every number here is a frame timing, and a shared runner's
timings are noise.

- `lib.mjs`: one browser, one sign-in, and a fabricated library of 200 series. Every fourth one is a favourite,
  so the heart badges are on screen. The fixture is built inside the page, so it works the same in Chrome
  and in Firefox.
- `scroll.mjs`: wheel-scrolls the library and home at 1440×900 and 390×844. It runs once as the account is,
  then again with **Reduce effects** switched on through the real Profile row, then switches it back off.
- `interact.mjs` (Chrome only) measures:
  - composited layers,
  - the home → library page transition,
  - the phone nav pill,
  - card tilt on the home rails.

## Running it

```sh
# an instance to measure (any instance works; this one is throwaway)
KEEP=1 E2E_NET=perf E2E_PORT=18140 E2E_SUBNET=10.222.40.0/24 bash web/test/e2e/up.sh

cd web
BASE=http://127.0.0.1:18140 node test/perf/scroll.mjs                      # Chrome, CPU throttled 4x / 6x
BASE=http://127.0.0.1:18140 node test/perf/interact.mjs                    # layers, transitions, tilt
BROWSER=firefox BASE=http://127.0.0.1:18140 node test/perf/scroll.mjs      # Firefox, unthrottled
VARIANTS=ab BASE=… node test/perf/scroll.mjs              # + one row per effect taken away
VARIANTS=ab AB_WHEN=on BASE=… node test/perf/scroll.mjs   # …only with the switch on: what still costs
EXTRA='{"my idea":".fx-mesh{contain:strict}"}' BASE=… node test/perf/scroll.mjs   # your own A/B row
PERF_OUT=/tmp/perf BASE=… node test/perf/scroll.mjs       # also write the raw JSON there
```

- Node ≥ 22.12 and the puppeteer Chrome (`npx puppeteer browsers install chrome@152.0.7977.75`). For Firefox,
  run `npx puppeteer browsers install firefox` once.
- `E2E_USER` and `E2E_PASS` default to the e2e instance's account. Sign-in is rate limited to 10 per 5
  minutes, so each script signs in exactly once.
- The switch is flipped on the account you give it, and put back when the run ends.
- Every row is 3 fresh page loads (`REPEAT`). Read all three runs, not only the median.

Tear the instance down with `docker rm -f perf perf-db perf-fake-a perf-fake-b; docker network rm perf`.

## What the numbers can and cannot say

- **Chrome's CPU throttle slows only the main thread.** It is a stand-in for "a modest PC", not a copy of one.
  A weak GPU pays for blends, filters and backdrop blur in the compositor, and throttling does not show that.
- **Headless Firefox composites in software, unthrottled.** The costs WebRender puts on a weak GPU land on the
  CPU here, where `requestAnimationFrame` can see them. That makes it the closer proxy for the #71 reporter.
  It has no CPU throttle, so read its rows against each other and never against Chrome's.
- **fps is the requestAnimationFrame cadence.** With Lenis (the default) the page scrolls from that loop, so the
  cadence is the scroll. With native scrolling (Reduce effects) the compositor can scroll smoothly while the
  main thread is busy, so the rAF figure then under-reports how smooth the scroll looked, never over-reports it.
- Run on a quiet machine. Another process on the host (a test suite, a second rig run) reads as the app
  getting slower. The first #71 table had a row at 7.7 fps that was contention, and one that was not (below).

## Traps this rig has already fallen into

- ⚠️ **The layer count.** The first version waited for a layer-tree change after hiding the cinematic layers.
  On a page that had stopped changing, none came, and it printed "0 layers without CinematicFX". That is
  impossible (a composited page always has its root), yet it went into the plan as a measurement. The real
  reading is below: 184 → 179. `layerSnapshot` now re-enables the domain for every reading and nudges one
  frame (a page with nothing animating commits none, and sends no tree). It prints `n/a`, never 0.
- ⚠️ **Tilt was never measured.** `SeriesCard` on the home rails tilts, and the library's `SeriesTile` does
  not. On top of that, headless Chrome reports no hover-capable fine pointer, so the tilt's own
  `(hover: hover) and (pointer: fine)` gate switched it off everywhere. The sweep now answers that query as a
  desktop mouse would, and it counts the tilts it caused, so a row with "0 tilt updates" is visibly empty.
- ⚠️ **`will-change: transform` on `.fx-mesh` makes the library five times slower.** It measured 7.8 fps
  against 40.2 at 4×, in three runs out of three. It keeps the 2700×1890 blurred layer re-rasterising. It
  looks like the textbook fix for an animated layer, and here it is the opposite.
- ⚠️ **Firefox refuses things Chrome allows.** WebDriver BiDi rejects request interception, and every
  intercepted cover came back broken, so the fixture rewrites cover URLs in the page instead. It also rejects
  a pointer outside the viewport, so a fixed 700,450 killed every 390-wide run.
- ⚠️ **A minifier can undo a CSS fix.** Tailwind's lightningcss keeps only `-webkit-backdrop-filter` when it
  follows `backdrop-filter`, and Chrome and Firefox both ignore the prefixed form. Check the built CSS, not the
  source. `web/test/effects.test.ts` runs the Reduce effects block through the same optimiser for that reason.
- ⚠️ **Headless Firefox does not composite `backdrop-filter`, so its rows cannot price a blur.** It accepts
  the property — `getComputedStyle(nav .glass).backdropFilter` reads `blur(20px) saturate(1.3)` and
  `CSS.supports('backdrop-filter', 'blur(10px)')` is true — and then paints nothing: as shipped, forced to
  `blur(40px)` and forced to `none` give screenshots identical to the pixel at 390×844, while `filter:
  blur(6px)` on the same element moves 6.2 % of them. So a Firefox A/B of "with and without the glass blur"
  is a null result by construction, not a finding, and any Firefox number here prices everything *except*
  the backdrop blur. Chrome 152 does composite it; verify a blur there.
- ⚠️ **The baseline phase measures whatever the ACCOUNT holds until the rig sets it.** `scroll.mjs` and
  `interact.mjs` open with a phase labelled "switch off"; on an account left with Reduce effects on, that
  phase used to print ~60 fps on every row — a table saying "nothing is wrong" about a page with no fx
  layers, no Lenis and no blur. Both now call `requireReduceEffects(page, false)` before it and print
  `[reduce … lenis … fx … tiles …]` beside every row, so a row taken in the wrong state says so.

## #71: what it measured (v0.42.0 → v0.43.0)

The owner's rule for #71 was that the default look does not change. v0.43.0's default renders pixel-identical
to v0.42.0: frozen screenshots of home, library and a series page at 1440 and 390 differ by at most 1 channel
level on at most 6 pixels, which is also the difference between two runs of the same build. So the default
rows are unchanged within noise. **Reduce effects** (Profile → Settings → Appearance) is the performance mode.

That comparison predates the one change to the default the owner approved for v0.43.0: the unprefixed
`backdrop-filter` on `.glass` and `.glass-strong` now survives the build (the minifier trap above), so the
phone nav, dialogs, the command palette and the sign-in card differ from v0.42.0 by exactly that blur in
every browser that composites it — Chrome does, headless Firefox does not (also above), so the Firefox rows
below price everything except this blur. The scrolling rows were measured
again on the release build afterwards: Chrome default 40.6 / 54.4 / 41.5 / 59.2 / 60 fps down the first table,
60 on every row with the switch on; Firefox default 8.3 / 11.5 / 19.1, and 57.8 / 57 / 60 with the switch on —
the same within run-to-run spread.
Same instance, same data, the v0.42.0 web build swapped for v0.43.0's; median of 3 runs (Firefox v0.42.0
rows: 2).

**Scrolling, headless Chrome 152, CPU throttled** (fps, then the share of frames over 33 ms)

| | v0.42.0 | v0.43.0 default | v0.43.0 Reduce effects |
|---|---|---|---|
| library 1440×900, 4× | 38.8 (49 %) | 40.7 (44 %) | **60 (0 %)** |
| home 1440×900, 4× | 51.2 (16 %) | 53.3 (11 %) | **60 (0 %)** |
| library 1440×900, 6× | 40.5 (45 %) | 41.3 (43 %) | **60 (0 %)** |
| library 390×844, 4× | 60 | 60 | 60 |
| home 390×844, 4× | 59.6 | 60 | 60 |

**Scrolling, headless Firefox 155, unthrottled** (software compositing)

| | v0.42.0 | v0.43.0 default | v0.43.0 Reduce effects |
|---|---|---|---|
| library 1440×900 | 7.7 | 7.6 | **57.9** |
| home 1440×900 | 12.3 | 8.9 | **55.1** |
| library 390×844 | (rig crashed, see above) | 19.3 | **60** |

The two default columns are the same CSS; home's 12.3 against 8.9 is Firefox's run-to-run spread (its runs
read 12.3 / 9 and 8.9 / 8.7 / 11.7).

**Everything else, headless Chrome 152**

| | v0.42.0 | v0.43.0 default | v0.43.0 Reduce effects |
|---|---|---|---|
| composited layers, library 1440 | 184 (66.1 Mpx) | 184 (66.1 Mpx) | **24 (22.1 Mpx)** |
| composited layers, home 1440 | 62 (20.5 Mpx) | 62 (20.5 Mpx) | **6 (5 Mpx)** |
| page transition home → library, 4× | 39.6 fps | 42.8–50.3 | **58.1–58.7** |
| page transition home → library, 6× | 49.8 fps | 40.6–43.9 | **58.7–59.4** |
| card tilt sweep, home rail, 4× | not measured (tilt gated off) | 56.5 (53 tilts) | 60 (0 tilts) |
| phone nav pill, 390, 4× | 60 | 60 | 60 |

**Where a frame goes.** With everything on, taking ONE thing away on the library at 1440:

- **Chrome at 4×** (the pre-release audit): the grain's overlay blend 37.7 → 55.2 fps; all three cinematic
  layers → 60; the mesh → 46; the vignette → 44; backdrop blur → 51; Lenis → 54.
- **Firefox:** the mesh 7.7 → 13.4 fps; the image sharpen-in → 12; all three layers → 11.7. Nothing alone
  comes close.
- **Firefox with Reduce effects on,** before the masked rims were added to it: 32.1 fps, and 59.5 with only
  the `.grad-border` rims gone. That is why the switch hides them.

**Invisible optimisations tried on the default, rejected** (library 1440, Chrome 4×, as rendered 40.2):

| candidate | Chrome 4× (fps) | Firefox (fps) |
|---|---|---|
| `contain: strict` on the three fx layers | 40.2 | 7.2 |
| `transform: translateZ(0)` on grain + vignette | 40.0 | 7.4 |
| `isolation: isolate` on `main` | 40.5 | – |
| `will-change: transform` on the mesh | **7.8** | – |

None bought a frame, so the default was left exactly as v0.42.0 drew it.
