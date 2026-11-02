# Prototype evidence — 2026-10-31

## Source and setup

- Upstream: `git@github.com:AngeloSha/uchiyomi.git`.
- Worktree branch: `feat/ios-offline-wrapper`, freshly based on fetched `origin/main` at `e6047fc7d467a82744d5fcf076bba6ac518e9a8d`. No drift from the planning revision.
- Native target: iOS 17+, configurable team/bundle ID, no third-party native dependencies.
- Installed Xcode: 27.2 (`27B52`), `/Applications/Xcode.app`. The user completed first-launch/license setup. Simulator build and tests now pass with explicit `DEVELOPER_DIR`.
- Native core tests pass with both Command Line Tools and Xcode's Swift Testing framework. No Xcode license was accepted by automation.
- Test server supplied by the user is reachable over trusted HTTPS, returns healthy `/healthz`, and has password authentication (`mode: local`, OIDC disabled). `/mobile-assets.json` initially returned the HTML fallback with HTTP 200. The version-matched frontend is now deployed and serves the verified JSON inventory. User-authorized coordination with the existing remote setup chat confirms rootless Podman 6.1.0, app v0.101.0 at revision `54588b913f18fcfed62f7eaaa7775c13c28da0fb`, container `uchiyomi` in `uchiyomi-pod`, and `WEB_ROOT=/app/web`. The actual launcher is a `start` script, not Compose. Personal server/SSH details are recorded only in ignored `Local-testing.md`.
- User's physical target is paired over USB: iPhone Duo, iOS 27.2 (24B91020), verified with `devicectl`. Developer Mode is enabled and DDI services are available. The user authorized the visible Personal Team; its Apple Development certificate was created and normal trust evaluation passes. `security find-identity -v -p codesigning` reports one valid identity. Team and bundle ID are configured in ignored `Local.xcconfig`.
- After the user approved the macOS signing-key prompt, the signed Debug build passed. `codesign --verify --deep --strict` passes outside the sandbox, where macOS trust services are available. The app was installed and launched on the phone with `devicectl`. The profile's recorded expiration is 2027-11-01 04:59:17 UTC; this is metadata from the issued profile, not an assumption based on the team's UI label. The certificate expires slightly earlier, at 2027-11-01 04:48:22 UTC.

## Verified

| Check | Result |
| --- | --- |
| `npm --prefix web run build` | Pass; complete Next static export |
| `node ios/scripts/manifest.mjs web/out` | 182 files, 9,432,106 bytes; includes reader/download route documents, `.txt` payloads, and static chunks |
| `node --test ios/scripts/manifest.test.mjs` | 3/3 pass: deterministic inventory, required routes, symlink rejection |
| Native core and loopback integration tests | 7/7 pass on macOS; also checks an explanatory error for an HTML fallback at the inventory URL |
| Focused web tests | 28/28 pass: native marker/outbox, existing offline identity and desktop surfaces |
| `npm --prefix web test` after corrections | 1,733/1,733 pass |
| Xcode project/Info.plist syntax | `plutil -lint` passes |
| iOS Simulator build | Pass for arm64/x86_64; unsigned Debug app launches on iPhone 18 Pro simulator, iOS 27.2; setup screen visually checked |
| Physical-device build/install/launch | Pass: signed Debug app installed and launched on the iPhone; after the fixture test, a fresh normal build was installed and launched, with no test plugins or bundled web export |
| Cached WKWebView integration test | Pass on both iOS 27.2 simulator and physical iPhone: real exported UI, two fixture chapters, recreated persistent web view, restarted listener, unreachable upstream, both reader routes render blob images, capability cookie stays HttpOnly, zero service-worker registrations |
| Real phone UI preparation, sign-in, and downloads | User reports all passed against the deployed matching frontend, with two chapters downloaded before opening either reader route |
| Real phone cold offline launch and app restart | User reports both chapters load with Airplane Mode on and Wi-Fi off after force-quitting; chapter two retains its reading position after another force-quit/reopen |
| Real phone offline reboot | User reports both downloaded chapters and chapter two’s saved reading position survive a full phone restart with Airplane Mode on and Wi-Fi off |
| Real phone reconnect and server sync | User reports session restored after app relaunch, an undownloaded online chapter loaded without another sign-in, and offline progress matched the same account in Safari/PWA |

The native transport fixture echoes a password/2FA-shaped body; this verifies byte preservation, **not actual Uchiyomi authentication or 2FA**. A fresh native client restores cookies from an in-memory test vault; real-device session persistence now also passes by user report after reboot and online relaunch. The web-view test seeds an offline identity and two SVG chapters directly into browser storage. It now passes on the physical phone as well as the simulator and verifies renderer/cache integration, not real chapter downloading or process/device restart persistence. Its UI export is in a test bundle only. A clean native-only build was reinstalled after testing.

The first simulator integration run caught a listener shutdown race: immediately rebinding the saved port could fail with `Address already in use`. Shutdown now retains the listener and awaits its `.cancelled` state. Both core tests and the iOS reproduction pass after the fix.

Local artifacts (ignored): `build/setup-ios27.2.png`, `build/webview-proof-3.xcresult`, and `build/webview-evidence/` contain screenshots and the successful test result. `build/uchiyomi-web-prototype-e6047fc7.tar.gz` contains the compatible static export, including local native-host changes, with SHA-256 `fe6d9351a0189aa89c156ab7bd6f4b95e60570e81fc24fde562bb9fb8b97c754`. It has not been deployed.

That initial export is based on v0.103.1; the selected live backend is v0.101.0. A matched v0.101.0 export has now been deployed after explicit user approval. `build/uchiyomi-ios-web-adapter.patch` is 17,892 bytes with SHA-256 `8b885f477045a94682a8d0587432685bb9902a25f4fc0a9a65604ac069a1debe`. All existing files it changes have identical upstream blobs at both revisions. The user subsequently authorized deployment and verification of this matched export.

The remote matched build and TypeScript checks pass, with 180 assets / 9,146,699 bytes verified against the inventory, including archived copies. Focused native/browser/offline-account tests pass 55/55 and manifest tests pass 3/3. The full serial suite had 1,671 passes and two fixture `EADDRINUSE` failures; both failed tests passed on isolated serial reruns. Prepared deployment/rollback launchers pin the current backend image and preserve its arguments and volumes. Pre-deployment drift checks passed. The approved deployment recreated only the application container with the existing pinned image and the read-only staged frontend mount, preserving backend version, persistent volumes, environment, pod, ports, and companion containers. Public health recovered in 12.309 seconds; no rollback was needed. The private, ignored `build/deployment-review-v0101.md` records exact paths, commands, checksums, and results. Remote GitHub SSH authentication was unavailable, so that chat fetched public source over HTTPS; the original Mac clone uses SSH.

The physical test passed 1/1 in `build/physical-webview-proof-1.xcresult`. Its screenshot in `build/physical-webview-evidence/` was visually checked and shows fixture chapter 2, page 1 of 2. The normal app subsequently installed on the phone is `build/DeviceApp/Build/Products/Debug-iphoneos/Uchiyomi.app` (no `PlugIns` directory or web export).

## Live server verification

Both the remote host and an independent Mac check verified all 180 served assets / 9,146,699 bytes against the expected manifest sizes and SHA-256 hashes. The Mac check also confirmed every MIME type, manifest schema/protocol/offline-schema versions (1/1/2), public health, local auth mode, root/downloads/reader HTML and Next route payloads, `/sw.js`, and JSON HTTP 404 for an unknown API route. Machine-readable evidence is in ignored `build/live-deployment-verification.json`.

A fresh browser session renders the sign-in form and has an activated root-scope `/sw.js` registration with no captured console errors. Together with the physical cached-web-view test's zero registrations and working reader rendering, this completes task 2.3's native-only service-worker bypass check. The user subsequently confirmed successful UI preparation, sign-in, and both requested chapter downloads on the physical phone. The user confirmed username/password sign-in only; actual 2FA remains unverified. No credentials were requested or collected.

## Physical acceptance checkpoint

The user confirmed that both real downloaded chapters load offline and chapter two retains its position across app termination/relaunch. This validates downloaded UI and reader resources from the persistent local origin in the normal app, which contains no bundled web export. Together with the route/payload integration tests, task 2.1 is complete. The user also confirmed both chapters and the saved position survive a full phone reboot while still offline. The user then confirmed that the session restored after networking and app relaunch, an undownloaded online chapter loaded without another sign-in, and the offline reading position matched in the same account’s Safari/PWA session. Username/password was used; no 2FA was enabled. The physical acceptance flow passes, completing tasks 2.4 and 2.5 with the existing listener, authorization, same-port, and auth-versus-network tests. Task 2.2 remains open for actual 2FA verification. Production phases may now proceed.

## Not yet verified / release gate

- The user reports successful cold offline launch, both real chapters readable, and reading position retained across force-quit/reopen, in response to the every-page test with Airplane Mode on and Wi-Fi off. Full device reboot persistence also passes by user report.
- Real server password sign-in, two downloads, restored session after process/device restart, an undownloaded online chapter, and correct-account progress sync pass by user report. Actual 2FA remains unverified because this account did not use it.
- Physical airplane-mode launch, app termination/relaunch, and full device restart now pass by user report. Listener recovery through iOS suspension, IPA, AltStore installation, and upgrade data retention remain unverified. Direct development signing/install/launch pass.

The physical offline-reading and reconnection gate has passed; production phases 3–6 can proceed. Asset-manifest build integration, update/rollback recovery, profile switching/removal, production transport behavior, and release packaging therefore remain open. No first-release offline guarantee or AltStore compatibility is claimed from macOS tests.

## Connection-screen refinement

Build 2 uses the default web palette and existing brand mark, removes both setup notices, and dismisses the keyboard before connecting (including a failed connection). Simulator visual/input checks pass. Normal ad hoc signing is needed for simulator Keychain access; a build with CODE_SIGNING_ALLOWED=NO can display the screen but returned -34018 when connecting. The normal signed simulator build reaches the expected network error against an unavailable local endpoint. Signed physical build 2 was installed and launched with the same app identity; update data retention is awaiting user confirmation. Preview: ignored `build/connection-screen-build-2.png`.
