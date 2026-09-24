# desktop/engine: the extension-engine pack

Uchiyomi Desktop does not ship Suwayomi-Server in its installer. Admin → Extensions offers "Download the
extension engine (about 200 MB)"; the app downloads the pack for its platform from the `engine-v2.3.2243`
GitHub **prerelease**, checks it against the SHA-256 pinned in `../src/engine-pin.json` while it streams, unpacks
it to `<data>/engine-runtime/v2.3.2243/` and runs it (`../src/engine.js`). Phase 0 spike S7 proved the recipe on
Windows, macOS arm64 and macOS x64.

| File | What it is |
|---|---|
| `pack.mjs` | downloads the pinned Suwayomi-Server v2.3.2243 release asset (SHA-256 pinned from its `Checksums.sha256`), keeps `jre/` + `bin/Suwayomi-Server.jar`, adds `bin/uchiyomi-shim.jar` + `engine.json`, writes `engine-pack-<platform>.zip` + `.sha256` + a sizes `.json`. Needs a JDK 21+ for the shim. |
| `build-shim.mjs` | `javac --release 21` over `../engine-shim/*.java` → `uchiyomi-shim.jar` (reproducible `--date`). |
| `run.mjs` | launches a pack exactly the way the app does, for manual runs. |
| `lib/stubs.mjs` | a FlareSolverr stub and a fake Cloudflare site (manual runs). |
| `../engine-shim/EngineShim.java` | `dev.uchiyomi.EngineShim`: stdin lifeline (EOF or `quit` → `System.exit(0)`, so shutdown hooks close H2; a dead parent closes the pipe too), environment → system properties for paths and secrets, then the jar's own `Main-Class`. |
| `../engine-shim/IsolatedPreferences.java` | an in-memory `java.util.prefs` factory: the engine never touches the registry / `~/Library/Preferences` / `~/.java`. |

```sh
node engine/pack.mjs --platform win-x64|mac-arm64|mac-x64|linux-x64 --cache .cache/suwayomi --out engine/build
node engine/run.mjs --pack engine/build/engine-pack-linux-x64.zip --runtime /tmp/rt --root /tmp/data
```

Publishing: `.github/workflows/engine-pack.yml` builds the three packs and publishes them on the prerelease;
then `../src/engine-pin.json` gets their `sha256` and `bytes`. A new Suwayomi pin or a changed shim is a new
`engine-v*` tag and new hashes.

## The launch (`../src/engine.js` `buildLaunch`)

```
cd <runtime>        # the unpacked pack; the classpath is relative, so no path is on the command line
UCHIYOMI_ENGINE_ROOT_DIR=<data>/engine   UCHIYOMI_ENGINE_TMP_DIR=<ascii>/engine-tmp   TEMP=TMP=TMPDIR=<same>
UCHIYOMI_ENGINE_AUTH_USERNAME=<rand>     UCHIYOMI_ENGINE_AUTH_PASSWORD=<rand>
UCHIYOMI_ENGINE_FLARESOLVERR_URL=http://127.0.0.1:<solverPort>/<token>
jre/bin/java -Xmx768m -XX:+UseSerialGC -Djava.awt.headless=true
  -Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory
  -cp bin/Suwayomi-Server.jar<sep>bin/uchiyomi-shim.jar
  -D…server.ip=127.0.0.1 -D…server.port=<enginePort> -D…server.webUIEnabled=false
  -D…server.initialOpenInBrowserEnabled=false -D…server.systemTrayEnabled=false -D…server.downloadAsCbz=true
  -D…server.autoDownloadNewChapters=false -D…server.flareSolverrEnabled=true -D…server.authMode=BASIC_AUTH
  -D…server.kcefEnabled=false
  dev.uchiyomi.EngineShim                         (spawned with windowsHide: true, every stdio handle piped)
```

The traps (each cost a spike CI cycle; `test/shell.engine.test.mjs` and `test/shell.traps.test.mjs` pin them):

- **The jar must stay in `bin/`.** Next to `jre/`, ClassGraph treats it as part of the JRE and skips it; the
  GraphQL schema then has no classes and the engine never answers (it does not exit — the readiness deadline
  is what catches it).
- **Windows cannot take a non-ASCII path on the java command line, nor run java from one, nor load JNA's DLL
  from a non-ASCII temp dir.** rootDir travels through the environment; the runtime and temp folder move to the
  same private `%ProgramData%\Uchiyomi\<hash>\` fallback Postgres uses when the data folder is not ASCII.
- **`kcefEnabled=false`, always.** Otherwise the engine downloads a ~230 MB JetBrains runtime with CEF on first
  boot and, on macOS, dies in `cef_initialize` on every start. Extensions that need an in-app WebView do not
  work in the desktop app.
- **Set repos after reading them.** `extensionRepos` is a deprecated `MigratedConfigValue`: when
  `setSettings(extensionRepos)` is the first settings access after boot, the change is echoed back but lost.
  The bff's admin route reads first, so it works.
- **Stop it through stdin, never a kill.** H2 loses the last write on a hard kill.
