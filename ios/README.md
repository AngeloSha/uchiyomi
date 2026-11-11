# Uchiyomi iOS client

Experimental SwiftUI/WKWebView source beta for iPhone/iPad on iOS 17+. It uses a user-entered compatible HTTPS UchiYomi server and a verified protocol-2 frontend cache. Downloaded chapters, credentials and queued progress stay scoped to their account/server.

See [docs/IOS.md](../docs/IOS.md) for the unsigned Linux/Windows-WSL build, GitHub Actions candidates and opt-in releases, AltStore installation, compatibility, data handling and the exact-build physical checklist.

- Canonical native sources and Xcode project are retained.
- `scripts/build-linux.sh` uses pinned xtool 1.24.0 and builds an **unsigned IPA**, without Apple signing credentials or GitHub Actions.
- The **iOS beta** Actions workflow builds an ad-hoc-signed IPA for AltStore without Apple credentials. Public releases and Pages source publishing require explicit maintainer setup.
- `scripts/test-transport.sh` exercises production HTTP framing on Linux; WebKit/device correctness remains separate.
- `PROTOTYPE.md` and `DOCKER-PROTOTYPE.md` are historical contributor records, not current verification or deployment instructions.

On November 10, 2026, the owner confirmed installation and basic operation on an iPhone and approved source publication. Extended device checks, including offline reboot, account switching and in-place updates, remain pending. Public IPA distribution and an AltStore source feed require their own release acceptance.
