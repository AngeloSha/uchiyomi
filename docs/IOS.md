# Uchiyomi for iPhone

The iOS client is a native SwiftUI/WebKit wrapper for your chosen Uchiyomi server. It downloads and verifies the server's web app for offline launch; the IPA contains only the native client. Minimum iOS: 17. This branch is a **beta candidate**. Physical acceptance is complete for both installation channels on the builds recorded below; that evidence does not automatically verify every later binary.

## Compatible server

Use an HTTPS **origin** with a certificate trusted by iOS, for example `https://books.example.com:8443`. Password sign-in, including TOTP 2FA, is supported. URL subpaths, client certificates, desktop servers, and external/SSO-only sign-in are unsupported.

A compatible server must serve `/mobile-assets.json` publicly as JSON on the same origin. The normal `npm --prefix web run build` now creates this inventory automatically. Both `Dockerfile.aio` and the split web/nginx build include it. Existing upstream releases without this patch cannot prepare the app yet.

The inventory specifies protocol **1**, offline storage schema **2**, the readable web package `version`, every static export asset, byte sizes, hashes, and a deterministic content `buildId`. It includes reader route documents, Next route payloads, and lazy chunks. New builds also acknowledge successful startup. Keep frontend and backend versions matched; do not deploy the current export over an older backend. See [Docker prototype deployment](../ios/DOCKER-PROTOTYPE.md) for a reversible version-matched static mount.

## First use

1. Enter your server address and tap **Connect to server**. Preparation needs a connection and enough free storage; the keyboard dismisses as it starts.
2. Sign in to Uchiyomi. The wrapper does not save your password. Refresh/image cookies are stored in the device Keychain for that server.
3. Download chapters using Uchiyomi's existing offline controls. Wait for each download to finish before going offline.
4. Open Downloads to read offline. The native app can cold-launch without the server after preparation. Progress queues locally and syncs to its original account after reconnecting.

A full restart opens Uchiyomi's home page. If the server is unavailable, the web app uses the saved offline identity to open Downloads. Returning from the background keeps the current screen. Chapter progress remains saved and is used when you choose that chapter again.

Safari/PWA storage is separate and is not imported. Signing out or expiration of the offline identity requires another online sign-in before reading that account's downloads. Removing the app or OS removal of website data can remove local chapters; the server remains the library's durable copy. Network transfers and progress sync resume in the foreground; background downloading and native push notifications are not implemented.

## Servers and recovery

The reader's **… → Servers** opens a dedicated Uchiyomi-themed page to select saved profiles, add a server, or remove one. Each has a persistent WebKit store, local address, UI cache, and cookie jar. Switching stops the old web view and its requests. Selecting an existing profile preserves its downloads.

The trash button requires confirmation. Removal deletes that server's **local** session, downloaded chapters, cached app, and unsynced progress. It does not delete the remote library or another profile. Reconnect first if you need pending progress synced.

The app checks `/mobile-assets.json` automatically on a full launch and whenever a server is selected. An unchanged inventory reuses the verified cache. A changed version/build downloads to a separate generation with a themed progress page, verifies every file and the final inventory, then opens Home. Foreground resume keeps the current reader and does not replace the UI while reading. The active server hostname appears as the menu heading above **Servers** and **Reload**. The reader toolbar has no persistent hostname; chapter downloads remain in the web app.

An unavailable server or failed update uses the last working cache. The manifest check has a five-second request timeout. The previous confirmed UI is retained; if the new UI fails to acknowledge startup within 30 seconds, the app automatically restores it. An unconfirmed updated UI also rolls back on the next launch. The rejected build is skipped until the host publishes another build ID. **Try again** and **Restore previous version** appear when recovery needs attention. UI replacement preserves chapters, identity, cookies and queued progress. Unsupported protocol/storage schema changes are refused; the wrapper does not downgrade an offline database.

Older compatible manifests without `version` remain supported through their build ID. The readable version comes from the host's `web/package.json`; changing either it or the asset contents changes the build ID. Older UI without a startup acknowledgement still asks you to confirm that it opened correctly. A first download with no working fallback requires a connection to retry if it fails.

## Developer installation

Install Xcode and finish its first-launch setup. Open `ios/Uchiyomi.xcodeproj`, select the shared **Uchiyomi** scheme and your phone. Enable Developer Mode and trust the Mac. Select your Apple developer team and a unique bundle identifier in ignored `ios/Local.xcconfig`:

```xcconfig
DEVELOPMENT_TEAM = YOUR_TEAM_ID
PRODUCT_BUNDLE_IDENTIFIER = your.reverse.domain.uchiyomi
UCHI_TEST_BUNDLE_IDENTIFIER = your.reverse.domain.uchiyomi.webview-tests
```

Use **Run** for a direct device install. Keep the effective bundle ID and signing team stable for updates. Build numbers must increase; neither uninstall the existing app nor reset its data to test an upgrade.

### Archive and IPA

From the repository root, after the checks below:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
bash ios/scripts/package.sh ios/build/candidate-5
# For a later candidate, use a NEW output directory and a higher number:
UCHI_BUILD_NUMBER=6 bash ios/scripts/package.sh ios/build/candidate-6
```

The script archives Release for physical iOS, verifies its signature, and wraps the development-signed archived app in `Payload/Uchiyomi.app`. It fails rather than overwriting an output directory. Outputs:

- `Uchiyomi.ipa` and `SHA256SUMS`.
- `release.json`: version/build, effective bundle/team identity, minimum iOS, entitlements, checksum, actual profile expiration, and explicit verification flags.
- `source.json`: Git revision, dirty state, and hashes of non-ignored working sources. Signed builds are not promised byte-identical; this records the exact candidate's inputs and artifact.
- Archive, build log, signing details, and decoded local provisioning profile. Provisioning files can include registered device identifiers; share the IPA and `release.json`, not the whole build directory.

No App Store export or upload occurs. This packaging path needs the configured development certificate/profile; AltStore will replace the signature. The app requests local networking for LAN servers, uses its own Keychain session items and loopback-only WebKit domain, and has no push, app-group, iCloud, JIT, or associated-domain entitlement. Inspect `release.json` for the actual signature rather than assuming a fixed expiration.

### Automated IPA releases and AltStore source

The [iOS beta workflow](../.github/workflows/ios-release.yml) supports pull requests, manual **Run workflow** builds, and `ios-v*` release tags. It uses GitHub's `xcode-27` runner with Xcode 27.1 and Node 24, runs packaging regressions and native core tests, creates the device IPA, then builds the frontend fixture and runs the real WebKit/lifecycle tests on iPhone Duo. Publishing waits for all checks. The database-dependent native TOTP case remains gated in this job; its separate fixture and physical acceptance are documented above.

New packages require the **iOS 27.1 SDK or later** for the Duo's full display; the deployment minimum remains **iOS 17**. Packaging records the actual SDK/Xcode build in `release.json` and rejects older SDKs. Earlier CI build1005 used iOS26.2 and is letterboxed on the Duo, whereas local builds used iOS27.2. Historical releases remain verifiable in the source. See [Apple's Duo SDK/layout guidance](https://developer.apple.com/iphone-duo/prepare/) and the [hosted runner's installed toolchains](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md).

Manual/PR runs produce downloadable Actions artifacts and an **unpublished source preview**. Preview URLs describe where a future release would live; they are not promised to resolve. Tag runs publish a GitHub **prerelease** with the IPA, `SHA256SUMS`, and `release.json`. They never move the main GitHub latest release or trigger the existing Docker `v*` pipeline.

For a local build with the same credential-free packaging mode:

```sh
UCHI_PACKAGE_MODE=altstore UCHI_VERSION=0.1.0 UCHI_BUILD_NUMBER=6 \
  bash ios/scripts/package.sh ios/build/altstore-local-6

python3 ios/scripts/altstore-source.py \
  --records-dir ios/build/altstore-local-6 \
  --repository YOUR_ACCOUNT/YOUR_FORK \
  --base-url https://YOUR_ACCOUNT.github.io/YOUR_FORK \
  --output ios/build/source-preview-6
```

This produces `Uchiyomi-0.1.0-6.ipa` with a local **ad-hoc signature**, empty entitlements, and no personal provisioning profile. AltStore supplies the actual device signature; this IPA cannot be installed directly with Xcode/devicectl as a development-signed app. No Apple credentials or signing certificate are needed for packaging. `UCHI_PACKAGE_MODE=development` remains the default for existing direct-install commands. Keep output directories under ignored `ios/build/` so build artifacts do not enter the source fingerprint.

#### Set up publishing (upstream or an authorized fork)

1. Push the wrapper changes to a repository where you have write access and enable Actions. The workflow file must be on its default branch for the **Run workflow** button to be available. The workflow derives owner/repository URLs from `github.repository`; it has no dependency on an upstream publishing token. Public release assets are required for the public AltStore feed.
2. Review [listing.json](../ios/distribution/listing.json). The release bundle ID is `com.uchiyomi.reader`, matching the committed Xcode defaults. CI does not inherit ignored `Local.xcconfig`. Keep the ID stable for update continuity; changing the listing ID after publishing requires a separate source/history. Edit the display/developer text for your fork before publication. The existing app icon is copied into the generated site; screenshots are optional and currently omitted.
3. Run **iOS beta → Run workflow** on the branch first. Download the IPA and test an AltStore install/update. This is required evidence before treating the distribution path as device-verified.
4. To publish an iOS beta, push a new tag, for example `ios-v0.1.0-beta.1`. Accepted tags are `ios-vMAJOR.MINOR.PATCH` or `ios-vMAJOR.MINOR.PATCH-beta.N`. The tag supplies the marketing version. The CI build number is `1000 + github.run_number`; reruns keep the same number. All releases from this workflow remain prereleases. Use a fresh tag for a changed binary.
5. To enable the public feed, set **Settings → Pages → Source** to **GitHub Actions**, allow `ios-v*` tags in the `github-pages` environment's deployment rules, and add repository variable **`IOS_ALTSTORE_PUBLISH=true`** before the next release. The workflow deploys the repository's Pages site; use a dedicated fork or integrate this job with an existing site before enabling it. A custom Pages domain is supported through the Pages action's configured base URL.
6. Add the published site's **`/altstore.json`** URL to AltStore Classic. The generator lists all published iOS versions, newest native version/build first, and declares the IPA's local-network permission. It includes a SHA-256 for each IPA. Your AltStore account/AltServer still handle signing and refresh.

#### Upstream Pages compatibility

Reviewed **2026-11-01**, against upstream main commit [`e6047fc7d467a82744d5fcf076bba6ac518e9a8d`](https://github.com/AngeloSha/uchiyomi/tree/e6047fc7d467a82744d5fcf076bba6ac518e9a8d): GitHub's [repository metadata](https://api.github.com/repos/AngeloSha/uchiyomi) reports `has_pages: false`, the default `https://angelosha.github.io/uchiyomi/` address returns HTTP 404, and none of the seven upstream workflows publishes Pages. The tree contains no `CNAME` or Pages site configuration. The repository instead links to the working public website [uchiyomi.com](https://uchiyomi.com). Its hosting configuration is not part of this repository.

There is currently no upstream Pages deployment to integrate with. Maintainers can enable the optional feed at `https://angelosha.github.io/uchiyomi/altstore.json` using the setup above, without changing the public website or its DNS. That URL is a proposed destination, not a currently published source. Merging the workflow alone does not enable Pages publication; `IOS_ALTSTORE_PUBLISH` must be explicitly enabled. IPA builds and tagged prereleases work without Pages or Apple signing secrets.

The configured app identity is `com.uchiyomi.reader`. Earlier prototype releases in the [testing feed](https://nvitius.github.io/uchiyomi/altstore.json) use `ca.box.nv.uchiyomi`; their release history must remain separate from the new identity. Moving to the new identity is not an in-place update of those installations. Recheck Pages ownership before enabling publication. If this repository later hosts another site, combine that site's output and the AltStore files in a single Pages deployment: the existing source job replaces the entire Pages artifact, even if feed files are moved into a subdirectory.

The publication job stages a draft, uploads versioned assets, downloads them for verification, then publishes it. Retries may resume identical partial uploads, but refuse to overwrite different bytes. Rerun a failed publication job using its existing build artifact; rerunning the entire workflow may rebuild different ZIP/signature bytes and deliberately fail the immutable-asset check. Actions artifacts expire after 14 days; published Release assets remain available.

When enabled, source publication downloads and verifies every advertised **public** release before deploying Pages. Missing assets, metadata/hash/permission/identity conflicts, or network errors stop that deployment and preserve the previous live feed. The source is rebuilt from Release history, so input ordering or a retry cannot silently put an older native version first. Keep historical release assets available. The app itself still obtains reader UI updates from its chosen server independently of native IPA updates.

Local checks:

```sh
python3 -m unittest discover -s ios/Tests/Distribution -v
actionlint .github/workflows/ios-release.yml
shellcheck ios/scripts/package.sh ios/scripts/test-webview.sh
# Requires web/out from npm --prefix web run build; creates/deletes its own simulator.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bash ios/scripts/test-webview.sh ios/build/WebViewLocal
```

Each publishing fork must verify its hosted Xcode build and GitHub Release/Pages jobs. Local script, archive, source-preview and simulator results do not substitute for hosted execution or a source-based phone install/update.

The testing fork is [nVitius/uchiyomi](https://github.com/nVitius/uchiyomi). Use its [iOS beta workflow](https://github.com/nVitius/uchiyomi/actions/workflows/ios-release.yml) for manual builds and its [releases](https://github.com/nVitius/uchiyomi/releases) for published IPAs. Its configured AltStore source is `https://nvitius.github.io/uchiyomi/altstore.json`, populated after a successful iOS tag release. Test betas keep device and AltStore acceptance marked pending until installation/update checks are recorded.

The first public test release is [0.1.0 (1005), beta 3](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.3). Its [hosted build, release and Pages jobs](https://github.com/nVitius/uchiyomi/actions/runs/41290404805) passed; the public IPA, checksum, metadata, feed, icon and landing page were independently downloaded and verified. Publication required one retry because GitHub's draft listing lagged; subsequent publisher code resolves draft identity directly through GraphQL and reads assets by release ID. The user reports a successful fresh source installation, preparation, sign-in, two chapter downloads, and offline chapter/position retention through force-quit and a full phone reboot. The earlier app was removed first, so this does not establish update or cross-channel data retention. Exact signing expiration was not supplied.

[0.1.0 (1007), beta 5](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.5) updates the hosted toolchain for the Duo's full display. Its [build, release and source jobs](https://github.com/nVitius/uchiyomi/actions/runs/41292081105) passed, including 22 distribution tests and all five Duo WebKit/lifecycle tests. Independent downloads verify the IPA and published source; the executable itself links against iOS 27.1 with a minimum deployment version of 17.0. The user confirms the 1005-to-1007 source update retained the server, account, both downloaded chapters and a new unsynced position when reopened offline, and the app now fills the Duo's inner display without letterboxing. After reconnecting and relaunching, an undownloaded chapter opened without another sign-in, and the same Safari/PWA account showed the position saved offline before the update. Beta 4 was cancelled before publication. Published release metadata is immutable; subsequent device results are recorded separately.

[0.1.0 (1008), beta 6](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.6) opens Home after a full restart. All [hosted build and publication jobs](https://github.com/nVitius/uchiyomi/actions/runs/41293309719) passed, including six Duo WebKit/lifecycle tests covering cold home startup, normal foreground resume, and the real frontend's offline fallback to readable downloads. The public IPA and feed were independently verified. The user confirms that, after updating to 1008, a full online restart from a chapter opens Home, and an offline restart still reaches Downloads with the chapter and saved position available. No server update was needed.

References: [AltStore source format](https://faq.altstore.io/developers/make-a-source), [version ordering](https://faq.altstore.io/developers/updating-apps), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## AltStore Classic

Follow the official [macOS installation guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos): install AltServer on your Mac, connect/unlock the iPhone, enable Finder's Wi-Fi visibility, then choose **Install AltStore → your phone** from AltServer. Complete Apple account authentication locally and trust the developer if iOS requests it. Developer Mode must be enabled.

Transfer `Uchiyomi.ipa` to Files on the iPhone and import it using **My Apps → +** in AltStore Classic, completing its signing flow. Keep AltServer reachable for signing/refresh as required by your setup. Review the expiration and effective identity shown by AltStore. See [AltStore's My Apps/account guide](https://faq.altstore.io/altstore-classic/your-altstore) for refresh and account limits.

Treat an AltStore install as its own installation channel: re-signing can change the effective app identity. Existing Xcode data is not promised to migrate between channels or teams. For the continuity test, prepare/download in AltStore, then import a later native build through the **same AltStore account and identity** without removing the app. A test beta may be published after artifact verification to exercise source installation; keep its device/AltStore verification flags false until those checks pass.

## Verification

```sh
npm --prefix web ci
npm --prefix bff ci
npm --prefix web run build
npm --prefix web test
npm --prefix bff run build
# BFF integration tests need a disposable PostgreSQL database:
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/uchiyomi_test npm --prefix bff run test:ci
node --test ios/scripts/manifest.test.mjs
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash ios/scripts/test-core.sh
# Starts/removes a disposable local PostgreSQL Docker container; never use a live database.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash ios/scripts/test-auth.sh
```

The native auth test uses the real BFF password/TOTP/refresh/logout routes. `test-core.sh` skips that database-dependent case unless `TEST_DATABASE_URL` is set. Gateway tests verify bounded binary streaming, cancellation, cookie isolation, blocked redirects, cached routes and listener restart. Cache tests cover corruption, interrupted updates, changed manifests, unsupported schemas, and disk-write failure.

The BFF CI runner creates a separate disposable database for each test file. Run the full suite on Linux for its GNU tar, case-sensitive filesystem, and Linux-only translation fixtures. On macOS, `TMPDIR=/private/tmp` avoids failures caused by the system temporary-directory symlink; it does not make those Linux-specific fixtures portable.

Run the real frontend WebKit suite on an installed simulator, keeping default signing for Keychain access:

```sh
npm --prefix web ci
npm --prefix web run build
UCHI_SIMULATOR_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-Duo \
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bash ios/scripts/test-webview.sh ios/build/SimulatorTests
```

The script creates a disposable simulator matching the selected SDK, or uses `UCHI_SIMULATOR_ID` without deleting it. It bundles the real web download store into **test resources only** for interrupted-transfer checks. Those fixtures are never packaged in the IPA. Direct `xcodebuild test` also requires `node ios/scripts/prepare-webview-fixture.mjs` after installing web dependencies.

The authentication boundary case runs in a separate test-host process after the other cases. Hosted WebKit intermittently stalled its initial sign-in setup after the update/recovery fixture's repeated process replacements. Both invocations are required, without automatic retries: `tests.xcresult` holds the other cases and `auth.xcresult` holds authentication. CI preserves both bundles on failure. This isolates fixture state; it does not establish the underlying WebKit cause or change production behavior.

WebKit tests cover offline reader routes, interrupted chapter cleanup/retry, expired identity, account boundaries and sign-out, automatic UI update/broken startup/rollback with retained chapters and outbox, and two servers with identical user/chapter IDs. Lifecycle tests exercise cold Home startup versus foreground resume, overlapping server actions, and callbacks from retired views. Normal app startup is suppressed while XCTest owns the process, so test models cannot collide with its listener.

`testNativeUpgradeRetentionFixture` is an opt-in installation check. On a disposable simulator with an empty app catalog, put `prepare` (without a newline) in the app's `Documents/native-upgrade-phase.txt` and run that test. It seeds two server profiles, fake Keychain cookies, chapter blobs, offline identity, a saved position and unsynced progress. Install/open the previous **simulator** app with the same bundle ID without uninstalling, change the marker to `verify`, then run the test with the new executable. It compares the catalog and checks retained credentials, identity, chapter data, position and outbox. Normal CI skips this installation-only case. Simulator installation does not establish Apple provisioning, AltStore re-signing or physical-device behavior.

### Simulator acceptance — 2026-11-01

An isolated iPhone Duo simulator (iOS 27.2, Xcode 27.2) passed eight real WebKit/lifecycle cases, including the opt-in native installation check. The ordinary CI suite runs seven cases and skips that opt-in check. Evidence: `ios/build/automatic-update-release-check/tests.xcresult`.

- Automatic manifest checks, unchanged-cache reuse, changed UI activation, failed-startup rollback and rejection of the same bad build passed with the real frontend, chapter blobs and queued progress retained. Foreground resume did not check or replace the UI.
- Interrupted chapter cleanup and retry, expired offline identity, account switching and sign-out passed. Auth boundaries recreate the reader to avoid racing frontend navigation.
- Installing the prior Home-startup simulator executable and then the new executable without uninstalling retained two profiles, a fixture Keychain cookie, offline identity, both chapters, position and unsynced outbox. This was a simulator executable update, not an AltStore IPA or Apple provisioning test.
- Visually checked the themed Servers page, selected server, add/switch, removal confirmation/cancel, full inner/outer display layouts, rotation, keyboard dismissal on Connect, connection error and foreground restoration. The menu contains Servers and Reload. Screenshots: `ios/build/automatic-update-servers-portrait.png`, `ios/build/automatic-update-servers-inner.png` and `ios/build/automatic-update-loading.png`.
- Native core reports 25 cases (one gated TOTP skip); manifest 5/5, distribution 22/22, and focused offline/native web tests 43/43 pass. At this checkpoint, external-link handoff was unverified because Device Hub input and an attempted hosted-test handoff could not complete. The later simulator handoff result is recorded below.

At that checkpoint, the v0.101.0 manifest included a content build ID, sufficient for automatic checks, and the readable-version update was staged with all 180 assets unchanged. Deployment was blocked first by a Podman thread-resource error and then by a remote tooling/IPC failure. The successful version-matched deployment is recorded below. Do not replace its frontend with this repository's newer v0.103.1 export.

A later fresh connection check returned HTTP 502 with the hosting provider's “This App is Down” page, both in the simulator and in an independent native URLSession request. A cache-busted public request confirmed 502; earlier cached 200 responses did not establish current health. Remote tooling initially blocked runtime diagnosis. Recovery and the subsequent readable-version deployment are recorded below.

### Server recovery and availability feedback — 2026-11-01

The service was recovered through direct SSH after coordinating with the remote chat. Existing container processes remained alive, but transient container runtime/network state and port forwarding were missing. Why that state disappeared is unverified. PostgreSQL completed a clean shutdown before the existing pod restarted; container IDs, images, data volumes and frontend mounts were preserved. Fresh public health, authentication configuration and manifest checks returned HTTP 200 at 18:52:46 UTC. At recovery, the frontend was still the 180-asset v0.101.0 build (`69d59082…`); readable-version publication followed later.

HTTP server errors and network outages now show “Server unavailable. You’re using the saved offline reader.” when a verified cache is available. Storage, TLS and compatibility failures remain separate. An outage notice clears after a successful availability check on foreground resume or a 30-second retry while the notice is visible and the app is active. These checks preserve the current web view, page and reading position; they never trigger a UI download or reload. Backgrounding, dismissal and server replacement stop the notice's retries.

The Servers page shows an icon and accessible text for Checking, Available, Unavailable or Needs attention, refreshed on appearance or pull-to-refresh. Probes fetch public authentication configuration with a five-second limit and never read or write saved account cookies. Cancelled or superseded probes retain the last completed observation and cannot restore removed profiles or leave a stale Checking state.

Native core reports 27 cases with one gated TOTP skip. The complete Duo simulator suite passes nine enabled cases with one opt-in installation-test skip, including recovery on resume and while reading, retained web-view identity and in-page state, cancellation/overlap/removal, and HTTP 502 cache fallback. Evidence: `ios/build/server-recovery-final.xcresult`. Visual checks confirm the outage notice and both available/unavailable server indicators on the inner and outer displays; the real host is shown as Available. Screenshots: `ios/build/server-status-servers-inner.png`, `ios/build/server-status-servers-outer.png` and `ios/build/server-unavailable-notice.png`.

[0.1.0 (1011), beta 9](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.9) publishes these changes through the existing AltStore source. The first hosted attempt timed out in the authentication fixture; cancellation interrupted its diagnostic-bundle upload, but the full text log was retained. Four additional local repetitions passed. The unchanged source passed all nine enabled WebKit/lifecycle cases on a fresh runner, plus the native core, 22 distribution and five manifest checks. All build, release and Pages jobs passed in [attempt 2](https://github.com/nVitius/uchiyomi/actions/runs/41339458796/attempts/2).

Independent public downloads verify the IPA, checksum, metadata, complete feed history, icon and landing page. Source: `af9f9304a4dfd5a3010c37e5e2f2e3c1980a1a43`; IPA SHA-256: `02e6c4b443cbea1733a2507f9a3d489185413cb7766117f8e9bce04681e8c068`; size: 927174 bytes. The executable links iOS 27.1 with minimum 17.0. Evidence: `ios/build/fork-release-verification-beta9.json`, `ios/build/fork-beta9-hosted-build.log` and `ios/build/server-recovery-and-status-verification.json`. Fresh public checks at 19:26:44 UTC still returned 200 for health, authentication configuration and the unchanged manifest. Physical acceptance of 1011 remains pending, and immutable verification flags remain false.

### Automatic-update release history

The first hosted attempt (`ios-v0.1.0-beta.7`, run `41296633859`) passed automatic update/recovery and the other enabled cases, but its process exited during the authentication case. Publication was blocked. The authentication fixture now mounts the real WKWebView explicitly in UIKit, keeping the same identity and logout assertions; native SwiftUI presentation remains covered by the update test and manual UI checks. Test timeouts are bounded, and failed hosted runs retain their full XCTest result bundle. The full local suite passes (seven enabled cases, one opt-in skip), followed by three consecutive passes of the authentication case. Evidence: `ios/build/automatic-update-auth-host-fix/tests.xcresult` and `ios/build/automatic-update-auth-repeat.xcresult`.

[0.1.0 (1010), beta 8](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.8) publishes the themed Servers/loading pages and automatic updates. Its [hosted build, release and Pages jobs](https://github.com/nVitius/uchiyomi/actions/runs/41298474024) all passed, including seven enabled WebKit/lifecycle cases and one opt-in installation-test skip. Independent downloads verify the IPA, checksum, metadata, complete AltStore source history, icon and landing page. The actual executable links against iOS 27.1 with deployment minimum 17.0. Source: `7250830f07466910302ac4e382a7dba1cbafd5be`; IPA SHA-256: `8dffcb9678fed184734ef04cc92916751087e1acffc134bf587eadcae62bb384`; size: 908051 bytes. Evidence: `ios/build/fork-release-verification-beta8.json` and `ios/build/fork-beta8-hosted-build.log`. The release is available through the existing AltStore source. Physical acceptance of this build is pending; immutable device/AltStore verification flags remain false.

At that checkpoint, physical lifecycle/link edge cases, cached UI update/recovery and a direct developer-channel update with unsynced progress remained open. Those checks are now complete, as recorded below.

### Version publication and final test preparation — 2026-11-01

The test host now publishes readable version **0.101.0**, with build ID `f6310f7ee18defae0d793405e9f8164d8f95307fb9bdbd5892f341b9a76358a6`. All 180 frontend assets are unchanged from the previously deployed v0.101.0 build. The backend image, environment, pod, companion containers and persistent mounts were preserved. An initial deployment guard rolled back because `/home` and `/mnt` aliases were reported differently; resolving and checking those paths proved they refer to the same directories. The retry passed. Independent public verification at 20:35:52 UTC checked every asset's hash, size and MIME, the manifest, routes, service worker, health/authentication and JSON API 404. Evidence: `ios/build/live-version-metadata-verification.json`.

The expanded real-WebKit update test also passes on the isolated Duo/iOS 27.2 simulator. It opens a chapter before a host update, verifies foreground resume keeps the same document, then checks interrupted transfers, corrupted bytes and unsupported storage schemas through `ReaderModel`. Each rejected update keeps the confirmed UI, chapter blob, offline identity and original queued progress. The existing bad-startup rollback and rejected-build checks remain enabled. Evidence: `ios/build/remaining-update-matrix.xcresult` (one focused test, zero failures). This supplements the original core failure tests; it is not physical-device evidence.

External-link handoff also passed a manual simulator check. Clicking the disposable navigation fixture's `target="_blank"` link opened `https://example.com/` in Safari; returning through Home and the Uchiyomi icon restored the usable native shell and fixture. Device Hub coordinate input worked on this attempt. Evidence: `ios/build/external-link-simulator-verification.json`, `external-link-safari.png` and `external-link-return.png`. This establishes simulator Safari handoff and return only; physical handoff and chapter-position retention across that handoff remain open in task 4.5.

### Device acceptance evidence

Direct developer builds **1–2**, iPhone Duo / iOS 27.2, version-matched Uchiyomi v0.101.0 frontend/backend:

- UI prepared; password login; two chapters downloaded before their reader routes were visited.
- Airplane Mode with Wi-Fi off: cold launch, both chapters, saved position, another force-quit/reopen, and a full device reboot all passed.
- Reconnection: session restored, an undownloaded online chapter loaded, and offline progress matched the same account in Safari/PWA.
- Native build 2 update retained server, session, chapters, and position. Progress had already synced before that update.

AltStore source builds **1005–1007**, on the same phone:

- Fresh installation of 1005, preparation, sign-in and two previously unopened chapter downloads passed by user report.
- Both chapters and reading position survived cold offline relaunch and a full offline reboot on 1005.
- Updating to 1007 without uninstalling retained server, account, both chapters and a distinct unsynced position when reopened with Airplane Mode on and Wi-Fi off.
- The user confirms 1007 fills the Duo's inner display without letterboxing.
- After reconnecting and relaunching 1007, an undownloaded chapter opened without another sign-in, and the retained position synced to the same account in Safari/PWA.

AltStore source build **1008**: the user confirms a full online restart from a chapter opens Home, while an offline restart reaches Downloads and opens the saved chapter at its retained position.

**Build 5 was an earlier candidate.** It prevents overlapping server/update transitions and ignores startup callbacks from retired readers. Subsequent beta work also fixes a profile-switch cancellation crash found by hosted CI; use the newest published beta for testing. The final physical session below completed foreground/rotation/external-link checks, partial downloads, logout/expired identity and account switching, pending-progress retention across a direct developer update, and cached UI update/recovery. Real TOTP is verified through the native transport/BFF fixture, not a human phone sign-in. Record the IPA checksum and effective signing identity with each run. Do not label a candidate device-verified from earlier builds' results.

### Physical acceptance completed

The plan is **36/36 complete**. Current physical fixture results and user-confirmed developer build 1014 → 1015 results are recorded below. Earlier AltStore installation/update, cold Airplane Mode and full offline reboot evidence remains scoped to the builds listed above. The final device session did not repeat those earlier AltStore/reboot checks.

The nine enabled WebKit tests ran on the Duo in a separate developer installation. Disposable profiles covered download/account failure boundaries and cached UI update/recovery. Native-only development builds then verified real server preparation, layout/lifecycle/links/keyboard behavior, offline update retention and correct reconnection synchronization. Their effective identity is `ca.box.nv.uchiyomi`; the separate AltStore installation remains `ca.box.nv.uchiyomi.VAAF4FG764`.

The optional native-upgrade seeding XCTest was excluded from the physical fixture run. Developer update continuity was instead exercised manually with real chapter downloads and a distinct unsynced position. Fixtures live only in the test bundle and are excluded from both release IPAs. Do not opt into fixture seeding against a populated personal catalog.

See `ios/build/direct-device-acceptance-pair-1014-1015.json` for artifact hashes, clean source, matching identity/entitlements, observed provisioning expiration and actual results. Published release metadata stays immutable; this separate acceptance record does not relabel older binaries.

## Physical device tests resumed — 2026-11-01

This chronological log retains intermediate failures and pending states. The completed results at the end supersede those checkpoints.

The user confirmed AltStore build 1011 and connected/unlocked the Duo for testing. Read-only inspection confirmed that its effective identity remains `ca.box.nv.uchiyomi.VAAF4FG764`; the separate developer test app uses `ca.box.nv.uchiyomi`.

The first physical fixture run exposed a cache-ownership comparison bug: canonical and aliased filesystem paths for the same cache directory were compared inconsistently. Six tests stopped at activation; download failure/retry, profile isolation/removal and availability refresh passed. A focused alias regression reproduced the error before the fix. Activation now resolves both directory paths after staging, retaining rejection of other profiles. Native core reports 28 cases (one separately gated TOTP skip). Evidence: `ios/build/cache-alias-regression-before.log` and `cache-alias-core-after.log`.

After rebuilding with the fix and generic loading text, all nine enabled WebKit/lifecycle tests passed on the physical Duo, iOS 27.2, in 25.8 seconds. The optional native-upgrade seeding test was explicitly excluded. This verifies actual-device expired identity/account switching/logout, interrupted download cleanup/retry, unavailable-server reading, isolated profiles/removal, cold-home versus foreground behavior, outage recovery without reloading, automatic UI updates, interrupted/corrupt/schema-rejected generations, and failed-startup rollback with chapter blobs and the original queued event retained. Test bundle build 1014; app source changes are committed as `d0fe3148` and `0a484901`. Evidence: `ios/build/physical-acceptance-path-fix.xcresult`, its `.log`, and `physical-acceptance-path-fix-summary.json` (9 passed, 0 failed).

Task 5.4 is complete. Tasks 4.5, 5.3 and 6.2 remain open for manual layout/link/foreground checks and direct developer update continuity. Progress: **33/36**. The previously prepared developer IPAs 1012/1013 predate this fix and are superseded for the final update test; prepare new native-only builds from the corrected source. The AltStore app and production server were not modified by these tests. The fix has not yet been published through AltStore.

Corrected native-only developer builds 1014 and 1015 were packaged from clean source `fdb4bb3ee8a1720315c1940c4b2a866bb0098144`, with matching source fingerprint, bundle/team/application identity, entitlements and observed provisioning expiration `2027-11-01T04:59:17Z`. SHA-256: 1014 `0928f394e4283aeb56fd0d2b48d98abbc16f802cc1f51b7d2d49d662d536f1e5`; 1015 `5ae56eb58db48b0d4cfbd6d2626d982f9853e4d77c2f0699ea18240a46d5c8f8`. Build 1014 installed and launched successfully for user preparation. Build 1015 is withheld until the user confirms an unsynced offline position and closed app. Neither IPA is marked acceptance-complete. Proof: `ios/build/direct-device-acceptance-pair-1014-1015.json`.

User-confirmed developer build 1014 results: connection to the live matched server, local password sign-in and both chapter downloads succeeded. Reading layout/controls remain usable through rotation and inner/outer display changes. Returning from Home without force-quitting retains the reading position. Manual external-link/public-share and Servers/keyboard/cancel checks are pending, followed by unsynced-position retention across 1014 → 1015 and reconnection. No additional task is marked complete yet.

User-confirmed developer build 1014 interface checks all passed: an external link opens outside the privileged app and the chapter retains its position on return; copied series links use the selected public HTTPS server, not localhost. Servers shows Available, cancelled removal retains the profile, and reconnecting to the same origin dismisses the visible keyboard while retaining the existing account and downloads. Combined with the earlier layout/foreground checks, physical recovery fixtures and transport credential-boundary coverage, task 4.5 is complete. Progress: **34/36**. Tasks 5.3 and 6.2 remain open until the offline native-update and reconnection steps complete. The user has been asked to save a distinct chapter-two position with Airplane Mode on/Wi-Fi off, close the developer app, and keep USB connected before build 1015 is installed.

The user confirmed both chapters open offline, saved a distinct unsynced chapter-two position with Airplane Mode on/Wi-Fi off, and closed developer build 1014. Build 1015 then installed successfully over the same developer identity via USB without an agent launch. Read-only inspection confirms developer 1015 and the unchanged separate AltStore 1011 installation. Offline retention and reconnection results remain pending. Install evidence: `ios/build/direct-acceptance-1015/install.json` and `installed-apps.json`.

The user confirms that developer build 1015, reopened with Airplane Mode on/Wi-Fi off after the in-place 1014 update, retains the saved server/account, both downloaded chapters and the distinct unsynced chapter-two position. Final reconnection/session refresh and same-account Safari/PWA synchronization confirmation is pending; tasks 5.3 and 6.2 remain open until that result is recorded.

Final user-confirmed reconnection check passed on developer build 1015: after restoring connectivity and force-quitting/reopening, an undownloaded chapter opens without another sign-in, and the same account in Safari/PWA shows the distinct position saved offline before the 1014 → 1015 update. This completes direct developer update continuity (6.2) and the remaining physical matrix (5.3), alongside the explicitly recorded earlier cold-offline/reboot evidence and current physical fixture cases. **All 36/36 OpenSpec tasks are complete.** Hosted verification of the latest fix is still running in manual workflow 41358308989; final report/spec synchronization/archive will follow that result. The physical acceptance record is `ios/build/direct-device-acceptance-pair-1014-1015.json`; original artifact metadata and historical published-release flags remain unchanged. No further phone interaction is required for these acceptance tasks.

After the physical acceptance session, the user requested moving the persistent server hostname into the context menu. The native reader now has an empty toolbar title and a menu section headed by the active hostname above Servers/Reload. Server-selection and connection/loading screens retain their useful host context. Simulator compilation and visible menu-open/menu-closed verification pass; this presentation-only refinement was not installed on the phone. Evidence: `ios/build/reader-menu-hostname-build.log`, `reader-menu-hostname.png` and `reader-without-hostname.png`.


## Final hosted verification follow-up — 2026-11-01

The manual run 41358308989 passed all enabled gates (28 native-core cases with one separately gated TOTP skip, 22 distribution tests, five manifest tests, and nine enabled WebKit/lifecycle cases). The subsequent immutable beta10 tag at 55cab956 failed publication: eight enabled WebKit cases passed, the optional installation case skipped, and the authentication boundary case exceeded its 300-second allowance at initial sign-in after the update/recovery fixture. The complete log, xcresult and timeout spindump were downloaded. The main run loop was responsive while the async case waited; the underlying WebKit cause is unproven. No beta10 release or feed was published.

The test runner now gives authentication a fresh test-host process after the other cases, with every assertion, timeout and both required success statuses retained. CI preserves both result bundles. This is fixture isolation, without automatic retries or production behavior changes. Local and hosted mitigation verification is pending; archive remains pending until the final release checks complete. Evidence: ios/build/beta10-auth-timeout-diagnosis.json and ios/build/beta10-attempt1-diagnostics/WebViewCI/tests.xcresult.

The revised runner passes locally on the isolated Duo/iOS27.2 simulator: eight enabled cases plus the optional installation skip in tests.xcresult, followed by authentication 1/1 in auth.xcresult, in a different app process. All nine required cases ran without retries. Evidence: ios/build/isolated-auth-release-check/{main,auth}-summary.json. ShellCheck, actionlint and diff checks pass. A new immutable beta tag will verify the isolated runner on hosted iOS27.1 before publication.

The revised hosted runner passed all nine required WebKit/lifecycle cases without retries: eight cases plus the optional installation skip in the first process, followed by authentication in a fresh process. The tagged beta11 source remains 9a870b29. A subsequent fixture-only cleanup releases the first WKWebView before selecting an updated UI and asserts that it is no longer retained; previously the test's strong local reference kept that document alive through the update matrix. Both local invocations pass again (8+1 enabled, zero failures), including the new release assertion. Evidence: ios/build/fork-beta11-hosted-build.log and ios/build/released-reader-fixture-check/{main,auth}-summary.json. This cleanup changes no production source or published binary and has not been rerun on the hosted runner.


## Final beta and plan completion — 2026-11-01

[0.1.0 (1014), beta 11](https://github.com/nVitius/uchiyomi/releases/tag/ios-v0.1.0-beta.11) is available through the existing [AltStore source](https://nvitius.github.io/uchiyomi/altstore.json). All [build, release and Pages jobs](https://github.com/nVitius/uchiyomi/actions/runs/41361001381) passed. The public IPA, checksum, metadata, all six advertised releases, complete source history, icon and landing page were independently downloaded and verified. Actual signature inspection passes: ad-hoc signing, empty entitlements, no personal provisioning profile, SDK27.1 and minimum iOS17. Source `9a870b29010ba64f03a9fb625d9eb465ec961420`; IPA SHA-256 `f1a8a87e153bb1270d42ac5078dbc4fd67172276639c0df2015cdb9073264955`; size 927780 bytes. Evidence: `ios/build/fork-release-verification-beta11.json` and `ios/build/fork-beta11-hosted-build.log`.

This beta includes the hostname in the reader menu, generic loading text and the cache-path alias fix. The hosted runner passes every enabled case with authentication isolated in a fresh test-host process. Beta10 remains failed and unpublished, with its diagnostics retained. The later fixture-only reference cleanup is locally verified and does not change this tagged binary. This exact AltStore binary has not been physically installed; immutable device/AltStore verification flags remain false. Physical plan acceptance is established by the explicitly scoped developer1014→1015 and earlier AltStore/offline-reboot evidence above.

All **36/36 OpenSpec tasks** are complete. The three permanent specs contain the 17 implemented requirements, match their deltas and pass strict validation. No additional phone interaction is required to close this plan. An upstream PR draft is prepared locally with maintainer setup, verification scope and current distribution limits.
