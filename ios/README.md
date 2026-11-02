# Uchiyomi iOS client

Native SwiftUI + WKWebView client for iOS 17+. Users enter their own compatible HTTPS server; the client downloads and verifies its frontend for offline launch. The IPA contains no web UI.

See **[docs/IOS.md](../docs/IOS.md)** for server compatibility, first use, Xcode and AltStore Classic installation, packaging, profile removal, recovery, tests, and the current device-verification status.

The **[iOS beta workflow](../.github/workflows/ios-release.yml)** builds an IPA without Apple credentials, publishes versioned prerelease assets on `ios-v*` tags, and can publish a generated AltStore source through GitHub Pages. Manual runs only create test artifacts. See [release and source setup](../docs/IOS.md#automated-ipa-releases-and-altstore-source) before enabling publication in a fork.

- [PROTOTYPE.md](PROTOTYPE.md): the original physical-device acceptance evidence.
- [DOCKER-PROTOTYPE.md](DOCKER-PROTOTYPE.md): reversible deployment of a version-matched frontend to an existing Docker/Podman server.

This branch is a beta candidate, not an App Store release. The implementation plan's physical acceptance is complete across the recorded developer and AltStore builds, including offline reboot and update continuity. See the verification history for exact artifacts and results; each later binary retains its own acceptance status.
