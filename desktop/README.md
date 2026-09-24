# desktop/: Uchiyomi Desktop (the Electron shell)

The same server and web app as the Docker install, as a Windows/macOS app with the library on this PC. The bff
runs unchanged in an Electron `utilityProcess` with `UCHIYOMI_DESKTOP=1` (see `bff/src/lib/desktop.ts`); this
folder is everything around it. User-facing docs: `docs/USAGE.md`, "Uchiyomi Desktop".

```
main.js ── single instance, window, tray, first run, bridge, updates, quit
  └─ supervisor.js   start: postgres -> solver -> engine (if installed) -> bff -> window
                     stop:  bff ({type:'shutdown'}, 25 s) -> engine (stdin, 15 s) -> solver -> postgres
       ├─ postgres.js    bundled PostgreSQL 16: initdb, pg_ctl, the Windows non-ASCII fallback, restore via psql
       ├─ solver.js      the FlareSolverr-compatible Cloudflare solver (src/solver/*.ts, hidden windows)
       ├─ engine.js      the extension engine, downloaded on first use (engine-pin.json, engine/, engine-shim/)
       └─ bff-entry.cjs  the bff's entry: {type:'shutdown'} -> its own SIGTERM path
  signin.js   the per-launch secret and the ONE request that carries it (POST /auth/desktop)
  preload.js  window.uchiyomiDesktop (contract 3) / window.uchiyomiShell (the local pages)
  bridge.js   the IPC handlers, each checking which page is calling
  env.js      the bff's environment (contract 1)
  firstrun.* / loading.html / restore.js / updates.js / i18n.js / paths.js / ports.js / state.js / log.js
```

## Build and run

```sh
npm ci && node node_modules/electron/install.js
npm run build                        # compile the solver (TypeScript) to out/
node scripts/stage.mjs               # web export + bff (as Dockerfile.aio) into resources/
node scripts/pg-dist.mjs             # PostgreSQL 16 into resources/pg (Linux dev: --from-dir <a local build>)
npx electron .                       # from source (Linux: --no-sandbox under a container)
npx electron-builder --win|--mac --publish never
```

Flags: `--data-dir=<dir>`, `--library-dir=<dir>` (non-interactive first run), `--hidden`, `--smoke`,
`--quit-for-update`, `--engine-pack-url=<u> --engine-pack-sha256=<hex>` (CI), `--no-ascii-fallback` (tests).

Hidden settings in `<data>/state.json`: `solverUserAgent: "native"` (the Electron UA instead of the default
Chrome-shaped one), `flaresolverrUrl` (use an external FlareSolverr instead of the built-in solver),
`readLibrary` (an existing manga folder as the read library, LIBRARY_ROOT).

## Tests

`npm test` (unit + the solver's contract tests; needs `bff/node_modules`), `npm run typecheck`,
`npm run test:electron` (the solver in real hidden windows; Linux: under `xvfb-run`). CI:
`.github/workflows/desktop.yml` builds and exercises the app on windows-latest, macos-15 and macos-15-intel
(`scripts/ci/`: the headless smoke, the product smoke, S2 Postgres, S5 NSIS update, S6 unsigned macOS).

## Releasing

The app ships on the server's own `v*` tag: `release.yml` calls `desktop.yml` beside the image builds (never in
front of them), and `desktop-publish` checks each installer against its update feed
(`scripts/release/check-feed.mjs`), merges the two macOS feeds (`scripts/release/merge-latest-mac.mjs`),
uploads the installers and then `latest.yml` / `latest-mac.yml`, and adds a downloads section to the Release
notes. `desktop/package.json`'s version moves with bff/web/openapi (`bff/test/desktopParity.test.ts`).

The extension engine is released separately, once per Suwayomi pin (or shim change), and BEFORE the app version
that should download it:

1. `git tag engine-v2.3.2243 && git push origin engine-v2.3.2243` (the tag `src/engine-pin.json` names) runs
   `.github/workflows/engine-pack.yml`: each pack is built and booted on its own OS, then all three are published
   on that tag as a **prerelease**. It refuses to replace a pack the pin already holds a hash for.
2. `node scripts/release/pin-engine.mjs` downloads the three packs as published, checks each against its
   `.sha256`, and writes `sha256` + `bytes` into `src/engine-pin.json`. Commit it; the next `desktop.yml` run
   installs the published pack in its smokes.
3. Then tag the app release. A new pack later is a new `engine-v*` tag and new hashes, never a replaced file.
