# desktop-engine: the extension-engine pack (Uchiyomi Desktop, Phase 0 spike S7)

A prototype that proves Suwayomi-Server can run as Uchiyomi Desktop's downloaded extension engine. Nothing
here ships. Phase 2 moves `EngineShim.java` + `IsolatedPreferences.java` to `desktop/engine-shim/`,
`pack.mjs` (+ `lib/archive.mjs`) to `desktop/scripts/engine-pack.mjs`, and `lib/engine.mjs` becomes
`desktop/src/engine.ts`.

| File | What it is |
|---|---|
| `EngineShim.java` | `dev.uchiyomi.EngineShim`: stdin lifeline (EOF or `quit` -> `System.exit(0)`, so shutdown hooks close H2; a dead parent closes the pipe too), env -> system properties for paths and secrets, then the jar's own `Main-Class` (`suwayomi.tachidesk.MainKt`). |
| `IsolatedPreferences.java` | an in-memory `java.util.prefs` factory, so the engine never touches the registry / `~/Library/Preferences` / `~/.java`. |
| `build-shim.mjs` | `javac --release 21` -> `uchiyomi-shim.jar` (reproducible `--date`). |
| `pack.mjs` | downloads the pinned Suwayomi v2.3.2243 asset (SHA-256 pinned), keeps `jre/` + `bin/Suwayomi-Server.jar`, adds `bin/uchiyomi-shim.jar` + `engine.json`, writes `engine-pack-<platform>.zip` + `.sha256` + sizes. |
| `run.mjs` | launches a pack the way the shell will, for manual runs. |
| `spike.mjs` | the S7 checks (boot ASCII/non-ASCII, loopback only, basic auth incl. the bff's own client, headless, extension install from a neutral repo, FlareSolverr wiring, idle RSS, graceful stop, orphan, 20 kill cycles, Windows console). |
| `lib/` | `archive.mjs` (zip/zip64 read, zip write with unix modes, streaming tar.gz), `engine.mjs` (launch), `stubs.mjs` (FlareSolverr + fake Cloudflare site), `probes.mjs` (sockets, RSS, children, console, footprint). |

```sh
node desktop-engine/pack.mjs --platform linux-x64 --cache /tmp/dl --out /tmp/pack      # JDK 21+ for javac
node desktop-engine/run.mjs --pack /tmp/pack/engine-pack-linux-x64.zip --runtime /tmp/rt --root /tmp/data
node desktop-engine/spike.mjs --pack /tmp/pack/engine-pack-linux-x64.zip --work /tmp/spike [--bff bff]
```

CI: `.github/workflows/desktop-engine-spike.yml` (windows-latest, macos-15, macos-15-intel).

## The launch

```
cd <runtime>        # the unpacked pack; the classpath is relative so no path on the command line
UCHIYOMI_ENGINE_ROOT_DIR=<data>/engine UCHIYOMI_ENGINE_TMP_DIR=<data>/engine-tmp
UCHIYOMI_ENGINE_AUTH_USERNAME=<rand> UCHIYOMI_ENGINE_AUTH_PASSWORD=<rand>
UCHIYOMI_ENGINE_FLARESOLVERR_URL=http://127.0.0.1:<solverPort>/<token>
jre/bin/java -Xmx768m -XX:+UseSerialGC -Djava.awt.headless=true
  -Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory
  -cp bin/Suwayomi-Server.jar<sep>bin/uchiyomi-shim.jar
  -Dsuwayomi.tachidesk.config.server.ip=127.0.0.1 -D…server.port=<enginePort>
  -D…server.webUIEnabled=false -D…server.initialOpenInBrowserEnabled=false -D…server.systemTrayEnabled=false
  -D…server.downloadAsCbz=true -D…server.autoDownloadNewChapters=false
  -D…server.flareSolverrEnabled=true -D…server.authMode=BASIC_AUTH -D…server.kcefEnabled=false
  dev.uchiyomi.EngineShim                                            (spawned with windowsHide: true)
```

Two traps the spike found in the design's layout and flags:

- **The jar must stay in `bin/`.** Next to `jre/`, ClassGraph treats it as part of the JRE and skips it; the
  GraphQL schema then has no classes and Suwayomi dies at boot (`InvalidPackagesException`).
- **Set repos after reading them.** `extensionRepos` is a deprecated `MigratedConfigValue`; when
  `setSettings(extensionRepos)` is the first access after boot, the change is echoed back but never reaches
  `extensionStores`/`server.conf`. The bff's admin route reads first, so it works; `addExtensionStore` avoids it.
