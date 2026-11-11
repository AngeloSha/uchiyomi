# Uchiyomi for iPhone and iPad

This experimental source beta integrates the SwiftUI/WKWebView client from [PR #390](https://github.com/AngeloSha/uchiyomi/pull/390) with UchiYomi v0.107's private libraries and account isolation. The native app prepares a verified copy of its server's web reader for offline launch. The IPA contains no server frontend, library, Apple credentials or personal signing profile.

**Current acceptance:** on November 10, 2026, the owner reported successful installation and basic operation on an iPhone and approved publishing the source. Protocol-2 integration, unsigned Linux packaging and server/browser tests do not establish every device behavior. The extended device checklist below, including offline reboot, account switching and in-place updates, remains pending. Earlier contributor builds do not verify this beta. GitHub Actions can build candidates; public IPA releases and AltStore source publishing remain disabled until maintainers explicitly enable them after release acceptance.

## Compatible server

Requires iOS/iPadOS 17+, a trusted HTTPS origin, password sign-in (including TOTP), and a frontend/backend built together from this integration. External/SSO-only sign-in, URL subpaths, client certificates, native background downloads, native push and App Store distribution are outside this candidate.

`npm --prefix web run build` generates public `/mobile-assets.json` with native protocol **2**, offline database schema **2**, the web version, static files, byte sizes, hashes and deterministic build identity. A missing manifest returns JSON 404, never the HTML fallback. Both the BFF and split nginx static server support this route.

Protocol 2 requires v0.107's owner fencing and private-response contract. A protocol-1 frontend or older saved generation is refused, including during recovery; UI rollback never downgrades the offline database or the privacy contract. Frontend/backend versions must stay matched.

Custom static-file overrides (for example a mounted login background) must be copied into the private export before regenerating its manifest. A runtime file whose bytes differ from the generated inventory is correctly rejected during native preparation. Keep personal artwork outside tracked source and preserve its mounts when deploying.

## Unsigned build on Linux or Windows/WSL

Use pinned **xtool 1.24.0**, the matching official Linux Swift toolchain, and an iOS SDK from Apple's Xcode archive. Windows builds use WSL. Download the Xcode `.xip` through Apple's authenticated browser flow and leave the archive intact; SDK extraction runs on Linux. Apple sign-in, two-factor prompts and agreement acceptance belong to the owner. No Apple credentials are needed by the build-only command.

The installed server toolchain and SDK should live on the data disk. Its activation script must set `PATH`, temporary directories and Swift/XDG caches there. No SDK or generated build belongs in Git. Then run:

```sh
# Activate your local Swift/xtool installation first.
UCHI_IOS_BUILD=2026111001 bash ios/scripts/build-linux.sh /absolute/data/path/ios-candidate-2026111001
```

The script stages copies of the canonical App/Core sources as one Swift Package, resolves Xcode plist variables, copies the brand image and icon, and runs `xtool dev build -c release --ipa`. It does not modify the Xcode project, ask xtool to sign, use a hosted builder or publish anything. `prepare-xtool.py` refuses to replace an unowned output directory. Use a new build number and output path for each device candidate.

Outputs include the private IPA, `native-source.json` and `candidate.json`. The inspector checks ZIP paths, arm64 iOS Mach-O target, actual iOS SDK (27.1 or newer), application identity, networking policy and absence of personal provisioning/test bundles/bundled frontend. Its metadata deliberately leaves signature and physical-device verification false. Compilation/packaging success is not proof of correct iPhone runtime behavior.

The Xcode project remains available for developers who have a Mac. Configure signing locally in ignored `ios/Local.xcconfig`; do not commit or transfer signing keys. The hosted workflow below uses the same Xcode project and macOS packaging script. The Linux/xtool build remains independent.

## GitHub Actions candidates and optional releases

The **iOS beta** workflow (`.github/workflows/ios-release.yml`) runs for pull requests touching the native client, web frontend or workflow, for `ios-v*` tags, and through **Actions → iOS beta → Run workflow**. Manual runs take a numeric native version such as `0.1.0` and never publish. Ordinary pushes to `main` and server release tags (`v*`) do not trigger it.

It uses the GitHub-hosted `xcode-27` runner with Xcode 27.2, runs the existing distribution, manifest, native core/transport and real WebKit/lifecycle checks, and archives an arm64 device app. No Apple account, certificate, provisioning profile or signing secret is required. The package receives a local **ad-hoc signature with empty entitlements**; AltStore replaces that signature using the installing user's Apple account. It is not an App Store or directly installable developer-signed package.

Successful runs retain two artifacts for 14 days:

- `ios-altstore-candidate`: the IPA, `release.json` and `SHA256SUMS`. Metadata records the source revision/fingerprint, protocol/schema, SDK, version, build and checksum. Device acceptance flags remain false.
- `ios-source-preview`: a generated `altstore.json`, icon and landing page. Its download links are placeholders until the corresponding release exists; it is not a published source.

The bundle identifier comes from `ios/distribution/listing.json` (`com.uchiyomi.reader`). Build numbers are `1000 + github.run_number`, so workflow reruns retain the same version/build identity. Keep the workflow name and app identity stable after the first public release. Forks with existing installations must preserve their own listing identifier and build-number sequence.

### Maintainer setup

Building candidates needs only GitHub Actions enabled and permission to use the hosted runner. To authorize **public beta releases** after completing the device checklist:

1. Under **Settings → Environments**, create `ios-release`. Configure required reviewers and allowed `ios-v*` tags if your release policy requires them.
2. Under **Settings → Secrets and variables → Actions → Variables**, add the repository variable `IOS_RELEASE_PUBLISH` with the exact value `true`.
3. Tag the intended commit with a new native release tag, for example `ios-v0.1.0-beta.1`, and push that tag. Native versions are independent of server versions. The accepted format is `ios-vMAJOR.MINOR.PATCH`, optionally followed by `-beta.N`; all releases from this workflow are marked prereleases and never replace the repository's latest stable release.

Only a successful tag build can enter the release job. It uses the built-in `GITHUB_TOKEN` with `contents: write` in that job only. It verifies the tag/source revision and IPA, uploads to a draft, downloads and checks every asset, then publishes. Existing assets are immutable: rerun failed jobs to resume an interrupted upload; a full rebuild that produces different bytes cannot overwrite a published version. Use a new tag for a replacement build.

To also publish an **AltStore source on GitHub Pages**:

1. Confirm the repository's Pages site will be dedicated to this source. The source job deploys the entire site; see the existing-site note below.
2. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
3. Allow `ios-v*` tags in the `github-pages` environment's deployment rules.
4. Set the repository variable `IOS_ALTSTORE_PUBLISH` to `true`, in addition to `IOS_RELEASE_PUBLISH`.

After a release succeeds, the source job downloads and verifies every advertised public iOS release, preserves version history, and publishes the feed using the configured Pages URL (including a custom domain, if configured). Add `<Pages URL>/altstore.json` in AltStore Classic. A failed fetch or verification leaves the deployed site unchanged. To disable future publication, remove the relevant variables; this does not remove existing releases or the live source.

**Existing Pages sites:** leave `IOS_ALTSTORE_PUBLISH` unset when another workflow publishes documentation or a website. Pages deployments replace the whole site, so two independent publishers cannot safely share it. Integrate `fetch-releases.py` and `altstore-source.py` into that site's build, generating into a new subdirectory such as `site/ios` with `--base-url "${PAGES_URL}/ios"`, then upload/deploy one combined artifact. The scripts work without enabling the dedicated source job. The project's separate `uchiyomi.com` homepage is not changed by this workflow.

## Install and use

Import your locally built or Actions-generated IPA into AltStore Classic with AltServer running on macOS or Windows, letting AltStore sign it with your own Apple account. If maintainers have enabled a public source, add its published source URL in AltStore instead. Keep that account and the effective installed app identity stable for subsequent in-place updates. Follow [AltStore's installation and refresh guidance](https://faq.altstore.io/altstore-classic/your-altstore).

1. Enter the compatible server's HTTPS origin and choose **Connect to server**.
2. Sign in to UchiYomi. The wrapper does not store your password; each server has an isolated Keychain cookie jar and persistent WebKit data store.
3. Download chapters using the existing offline controls. Wait for completion before disconnecting.
4. Read from Downloads offline. Queued progress stays owned by the original account and is flushed in the foreground after reconnecting.

Safari/PWA downloads live in separate storage. An expired offline identity or sign-out requires online sign-in again. Removing the app or its website data can remove local downloads; the server remains the durable library copy.

## Server profiles, updates and recovery

**… → Servers** selects, adds or removes server profiles. Every profile has its own stable local origin, UI cache, cookie jar and WebKit store. Switching cancels old requests and stops the previous web view. Removing a profile requires confirmation and removes only its local credentials/downloads/unsynced progress; reconnect first to sync progress you need to keep.

On a full launch or server selection, the app checks the manifest. Changed assets are staged separately, hash-checked, and activated atomically only after the complete inventory is verified again. Foreground resume does not replace the interface mid-chapter. A compatible previous generation remains available if downloading fails or the new interface cannot acknowledge startup. A reachable server declaring an incompatible protocol/schema cannot be used through a saved older frontend. That refusal is stored across cache instances and app restarts, blocks manual Restore too, and clears only after a validated compatible server manifest. Normal offline fallback remains available when no incompatibility has been recorded. Offline launch revalidates the saved inventory and hashes too.

## Native privacy and uploads

The native HTTP cache is disabled. The gateway preserves the server's `Vary: *`, `Cache-Control: private, no-store` and `X-Uchiyomi-Private` headers. Native mode avoids service-worker registration/cache barriers/background-sync hints, while retaining foreground owner-scoped progress and v0.107's account-transition document replacement. Normal browser/PWA behavior remains unchanged.

The loopback gateway accepts only the profile's host/origin and an HttpOnly capability cookie. Redirects are refused; gateway cookies and forwarded headers never reach another server. Request framing is parsed incrementally. Password/TOTP and other bounded JSON bodies stay in memory and are never spooled. Only library-upload fixed-length or chunked bodies use mode-0600 files inside an owned private upload directory and a file stream, instead of whole-upload RAM buffering. Failed/cancelled/expired connections remove their spool. Startup reaps marked, unlocked upload sessions left by a terminated app; file locks preserve uploads belonging to another active profile/process. A free-space reserve protects the device's database. Uploads allow up to 16 GiB plus multipart framing; ordinary request bodies allow 32 MiB. The upstream server still enforces its own smaller configured limits, content validation and account/library scope.

## Automated checks

```sh
node --test ios/scripts/manifest.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ios/Tests/Distribution
bash ios/scripts/test-transport.sh
```

The portable transport test compiles the **production HTTP framing/response file** and exercises uploads above the former eight-MiB limit, byte-fragmented chunk boundaries, malformed/ambiguous framing, authorization before spooling, size limits, cancelled-file cleanup, no plaintext credential files, crash-orphan cleanup that preserves active uploads, and private-response header encoding. It supplies only a small error-type shim; it does not emulate Apple networking, WebKit or cryptography.

Run the existing web authentication/native/offline regression tests and BFF static-root tests too. `swiftc -frontend -parse` and `swift package dump-package` are useful syntax/package checks, not iOS compilation or device execution. On macOS, the retained core/auth/WebKit suites provide additional real-platform coverage; Linux has no iOS Simulator execution.

## Required checks on this exact IPA

Record the IPA checksum, build number and effective signing identity with these results:

- Sign in with password; use a fixture account with TOTP too. Download two chapters, including one never opened before downloading.
- Disable connectivity, force-quit and cold-launch. Read both chapters, change position, restart the app and reboot the phone; verify pages and position remain.
- Reconnect and verify progress reaches the same server account. Interrupt/retry a download and image-chapter upload; completed data must remain intact.
- Switch between two accounts on one server, including private content and age restrictions. Delayed old-account requests must not display or modify the replacement account. Repeat with two servers whose chapter IDs overlap.
- Test rotation, background/foreground, external links and public share URLs.
- Install a higher-numbered candidate **in place**, without uninstalling. Keep downloaded pages, server profiles, session and a distinct unsynced offline position.
- Exercise a frontend update, failed/interrupted preparation and recovery; downloaded chapters and owner-scoped outbox remain. An older protocol-1 UI must never become the fallback.

The source beta is approved for publication. Complete these extended checks and obtain release approval before preparing a public IPA release or AltStore source feed. Historical contributor evidence remains in `ios/PROTOTYPE.md` and the upstream PR for provenance; none of it sets this beta's verification flags.
