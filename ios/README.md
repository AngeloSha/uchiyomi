# Uchiyomi iOS client

Private SwiftUI/WKWebView candidate for iPhone/iPad on iOS 17+. It uses a user-entered compatible HTTPS UchiYomi server and a verified protocol-2 frontend cache. Downloaded chapters, credentials and queued progress stay scoped to their account/server.

See [docs/IOS.md](../docs/IOS.md) for the private Linux/Windows-WSL build, AltStore installation, compatibility, data handling and the exact-candidate physical checklist.

- Canonical native sources and Xcode project are retained.
- `scripts/build-linux.sh` uses pinned xtool 1.24.0 and builds an **unsigned private IPA**, without Apple signing credentials or GitHub Actions.
- `scripts/test-transport.sh` exercises production HTTP framing on Linux; WebKit/device correctness remains separate.
- `PROTOTYPE.md` and `DOCKER-PROTOTYPE.md` are historical contributor records, not current verification or deployment instructions.

Do not publish this candidate or enable public distribution until the owner has tested and explicitly approved it.
