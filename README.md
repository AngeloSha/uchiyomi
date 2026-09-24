# Uchiyomi

*Self-hosted manga server that downloads too — a manga, manhwa and webtoon reader that keeps up with new
chapters on its own.*

[![CI](https://github.com/AngeloSha/uchiyomi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AngeloSha/uchiyomi/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/AngeloSha/uchiyomi?label=release&color=7c5cff)](https://github.com/AngeloSha/uchiyomi/releases/latest)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)
[![Container images](https://img.shields.io/badge/ghcr.io-amd64%20%2B%20arm64-2496ED?logo=docker&logoColor=white)](https://github.com/AngeloSha?tab=packages&repo_name=uchiyomi)

### 🌐 [**uchiyomi.com**](https://uchiyomi.com) · 🐙 [GitHub](https://github.com/AngeloSha/uchiyomi) · ☕ [Ko-fi](https://ko-fi.com/angeloshaheen) · 📜 [Changelog](CHANGELOG.md)

A self-hosted **manga server** that runs on your own hardware. It stores and serves your library the way
Komga or Kavita do, and it also **downloads and watches for new chapters** the way a source app does — in
one Docker image, behind a true-black OLED interface with a vertical-scroll webtoon reader at the centre,
installable as an app on any device.

[![Uchiyomi — a walk through the app](docs/shots/tour.webp)](https://uchiyomi.com)

**If you already run Sonarr for TV and Radarr for films**, this is the same idea for manga, except the
reader is included: the indexer, the scheduler, the downloader, the Cloudflare solver and the media server
are one container instead of five. The whole mapping is in the
[comparison](docs/COMPARISON.md) — an *\*arr stack for manga*, without the stack.

Uchiyomi is a **bring-your-own-library reader** first: like Komga / Kavita / Calibre-web, it reads comics
*you* supply, and the library and reader work on nothing but files you already own.

**It also fetches**, by two routes, and both ship in the default install. **Mihon / Tachiyomi extensions**:
you point Uchiyomi at an extension repository you trust ([how](docs/extensions.md#add-an-extension-repository--step-by-step)),
and from then on its extensions are browsable in the admin panel, installable with one click and searchable
immediately, run by a bundled engine that starts with the stack. And **generic engines** for the common manga-site families, where you paste a
site's URL yourself. Plus **MangaDex**, via its official public API.

Uchiyomi hosts no sources, ships no extensions and compiles nothing into the image; no source is enabled
until you choose one. You pick what to enable, and you are responsible for using it in line with those
sites' terms and your local law.

> 📖 **[Full usage guide →](docs/USAGE.md)**: every screen walked through with screenshots (library, reader,
> Discover, admin, security, offline).

## Features

**Reading**

- **Webtoon-first reader** — vertical scroll or paged, RTL, double-page spreads, per-series settings.
- **Skips the pages that are not the story** — the scanlator credit page that opens every chapter is found
  by repetition and collapsed into a band you can tap open (or hide entirely, or show everything).
- **True-black OLED interface**, built for a phone and installable as a PWA.
- **Offline downloads** — save chapters to the device and read them with no connection at all.
- **Moments** — star a page and it lands on its own screen as the panel itself, with notes.
- **Reading Studio & Wrapped** — a year heat-map, chapters by month and weekday, your top series and genres.

**Your library**

- **Files you already own** — CBZ, CBR, PDF, image EPUB or a folder of images, in any folder layout.
- **Library management** — several libraries, a filter panel (sort, read state, status, format, genres),
  *Select all* with bulk fetch and removal, editable metadata that survives a rescan, merge, delete, restore
  and forget.
- **Health** — finds chapter gaps, suspiciously short chapters, bad downloads and duplicates; *Verify
  chapter files* re-checks that what the database claims is on disk actually is.
- **Import what you already track** — a Mihon backup, a MangaDex list, a pasted list of titles, or your
  AniList / MyAnimeList / Kitsu list. Every match is **reviewed before it lands**, with a confidence score,
  *Change* and *Skip*, and batches you can resume.

**Fetching**

- **~1,400 Mihon / Tachiyomi extensions** from a repository you add, plus generic engines for common site
  families (paste a URL) and MangaDex. Nothing is enabled until you choose it.
- **Discover** — what your sources just published, grouped by language, and a search that **answers
  progressively**: results appear as each source replies instead of waiting for the slowest, and every
  source says whether it answered, failed or timed out.
- **Follows a series on more than one source**, and when a chapter will not come down it tries the other
  copies, then other sources, before giving up.
- **Chooses the translation** — prefer or block scanlation groups, server-wide or per series; wait a couple
  of days for a preferred group; see every version of a chapter and fetch a specific one. The group is
  written into the file as ComicInfo `<Translator>`.
- **Shows you what you do not have** — chapters the sources list but your disk lacks appear as grey rows you
  can select and fetch.
- **Survives real-world sources** — it slows down when a site rate-limits instead of hammering it, and a
  chapter missing a handful of pages is kept as a **partial**, with placeholders, and repaired overnight
  rather than thrown away.

**Household**

- **Multi-user** — accounts, per-user progress and favourites, streaks and a leaderboard.
- **Age ratings and an 18+ library** that stays off the home screen, the grid and search until somebody asks
  for it, with a per-member rating cap and a per-member permission to add series at all.
- **Security** — 2FA, lockout, active sessions, an audit log, and **OIDC single sign-on** against Authentik,
  Authelia or Keycloak.
- **Scoped API tokens** — read, write or admin, revocable, with an opt-in for 18+ libraries.
- **Automatic nightly backups** of the database and config, rotated and restorable, at an hour you pick.

**Beyond the browser**

- **Push notifications** when a followed series gets a new chapter, and one digest per library update to a
  **webhook, Home Assistant, ntfy or Discord**.
- **OPDS** — read from Panels, Chunky or KOReader, page by page over OPDS-PSE.
- **A Mihon / Tachimanga extension** — read your library from Mihon, any Tachiyomi fork, Tachimanga (iOS)
  or Suwayomi with one API token: [uchiyomi-extension](https://github.com/AngeloSha/uchiyomi-extension).
- **A Komga-compatible API** — point Mihon's own Komga extension at Uchiyomi instead and its built-in Komga
  tracker syncs reading progress back in both directions, forward-only: [how to set it up](docs/extensions.md#komga-compatible-api).
- **Progress sync** to AniList, MyAnimeList and Kitsu.
- **Nine languages**, with right-to-left layout for Arabic.
- **A Windows and macOS app (beta)** — the whole thing as a program on your own computer, with the library in a
  folder there and no server to run; or, if you already run a server, a window onto it:
  [download the desktop app](#download-the-desktop-app).

**Nothing phones home.** An update check reads GitHub's public releases page and sends nothing about your
server; it can be turned off. An anonymous install count exists and is **off unless you turn it on**, and
the settings page shows you the exact object it would send before you agree to it — a monthly-rotating id,
the version, the CPU architecture and which deployment shape you run. No library, no titles, no accounts,
no address. [What leaves your server](docs/CONFIGURATION.md#what-leaves-your-server).

> 📖 Every screen walked through with screenshots: **[docs/USAGE.md](docs/USAGE.md)**

## Install

**Requirements:** Docker and Docker Compose, plus a manga library on disk. Any folder layout works — a
directory counts as a series when it directly contains chapters, at whatever depth.

> **Don't clone the repo to install it.** The top-level `docker-compose.yml` builds from source and is the
> *development* stack. The two commands below are the whole install.

```bash
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.yml
docker compose up -d
```

Open **http://localhost:8080** and create your admin account in the browser. Nothing to generate, no config
file to edit. That is Uchiyomi in one container with Postgres inside it; multi-arch images (amd64 + arm64)
mean it comes up in seconds on a NAS or a Raspberry Pi.

> 📦 CasaOS, Unraid, Umbrel, an external database, reverse proxies and updating:
> **[docs/INSTALL.md](docs/INSTALL.md)**

Rather not run a server at all? The desktop app below is the same Uchiyomi on your own Windows PC or Mac.

## Download the desktop app

**Uchiyomi Desktop (beta)** for Windows and Mac. On first launch it asks how you want to use it: **on this
computer** (the whole app, with the library in a folder on your PC and no Docker, server or account) or
**connected to your server** (a window onto the Uchiyomi you already run).

| Your computer | Download (always the newest version) |
|---|---|
| Windows (x64) | [Uchiyomi-Setup.exe](https://github.com/AngeloSha/uchiyomi/releases/latest/download/Uchiyomi-Setup.exe) |
| Mac with Apple silicon (M1 or newer) | [Uchiyomi-mac-arm64.dmg](https://github.com/AngeloSha/uchiyomi/releases/latest/download/Uchiyomi-mac-arm64.dmg) |
| Mac with an Intel processor | [Uchiyomi-mac-x64.dmg](https://github.com/AngeloSha/uchiyomi/releases/latest/download/Uchiyomi-mac-x64.dmg) |

- **Windows:** run it; it installs for your account with no administrator prompt. The first time, choose
  **More info** → **Run anyway** on *"Windows protected your PC"* (the app is not signed yet).
- **Mac:** drag Uchiyomi to Applications. The first time, macOS refuses to open it; choose **Open Anyway** in
  **System Settings → Privacy & Security**. Not sure which Mac? Apple menu → *About This Mac*: **Chip** means
  Apple silicon, **Processor** means Intel.

Everything else — step by step with pictures, the two modes, adding sources, updates, backups, where files live,
uninstalling — is in **[the desktop guide](docs/DESKTOP.md)**. No Linux or Windows on Arm build; use Docker there.

## Documentation

| | |
|---|---|
| [Usage](docs/USAGE.md) | Every screen, with screenshots |
| [Install](docs/INSTALL.md) | One-click stores, updating, HTTPS, external DB |
| [Desktop app](docs/DESKTOP.md) | Uchiyomi Desktop for Windows and macOS (beta): on your computer, or a window onto your server |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and source paths |
| [Extensions](docs/extensions.md) | Adding an extension repository, step by step; the Mihon / Tachiyomi engine |
| [API](docs/api.md) | REST reference |
| [Migrating](docs/MIGRATING.md) | Moving between layouts and versions |
| [Comparison](docs/COMPARISON.md) | How it differs from Komga, Kavita, Mihon and Suwayomi |

## Translations

The interface ships in **English, Spanish, French, German, Portuguese (Brazil), Russian, Japanese, Chinese
and Arabic**, with right-to-left layout for Arabic. Pick one under **Profile → Settings → Language**; the choice
follows your account to other devices.

**Everything except English is machine-assisted and has not been checked by a native speaker.** If something
reads wrong, it is one JSON file per language in [`web/public/locales/`](web/public/locales) and the keys are
the English source strings — edit a value, open a pull request, done. A missing key falls back to English
rather than showing a blank or a placeholder, so a partial translation is always safe to ship.

Adding a language: copy `en` semantics into `web/public/locales/<code>.json`, add the code to `LOCALES` in
`web/lib/i18n.ts`, and set `dir` if it is right-to-left.

## Roadmap

Actively developed. On deck:

- 🧭 **Per-source genre browsing** — browsing one source's newest and popular titles already works; genres
  are the part still missing.
- 📱 **Native App Store and Play builds** — the PWA installs on both today; wrapping it properly is planned.

Everything already shipped is in the **[changelog](CHANGELOG.md)**.

## Support

Uchiyomi is free and open-source. If it's useful to you, you can help fund continued development:

**[☕ Buy me a coffee on Ko-fi →](https://ko-fi.com/angeloshaheen)**

You'll also find a **♡ Sponsor** button at the top of this repo's GitHub page, and a **Support Uchiyomi** link inside
the app on the **Profile** rail.

## Contributors

Uchiyomi is built and maintained by [@AngeloSha](https://github.com/AngeloSha). Pull requests, bug reports, and
feature ideas are all welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md), or open an
[issue](https://github.com/AngeloSha/uchiyomi/issues).

- 💬 **[Discussions](https://github.com/AngeloSha/uchiyomi/discussions)** — questions, ideas, and what you've built with it
- 📜 **[Releases](https://github.com/AngeloSha/uchiyomi/releases)** / **[Changelog](CHANGELOG.md)** — watch the repo to hear about new ones
- 🔒 **[Security policy](SECURITY.md)** — please report vulnerabilities privately

Thanks to everyone who has helped build Uchiyomi:

[![Uchiyomi contributors](https://contrib.rocks/image?repo=AngeloSha/uchiyomi)](https://github.com/AngeloSha/uchiyomi/graphs/contributors)

That image is drawn from GitHub's contributors graph, which only counts the author of a commit. Some help
arrives as a report or a diagnosis that lands as someone else's commit, and is invisible there — so it is
named here instead:

- **Unraid install instructions, and a template that installs** — [@hawwwwwk](https://github.com/hawwwwwk),
  who spotted that Unraid had removed the *Template repositories* field the docs told people to use, and
  opened pull requests against both this repo and [`unraid-templates`](https://github.com/AngeloSha/unraid-templates);
  then came back with [PR #50](https://github.com/AngeloSha/uchiyomi/pull/50), which found that the very
  fix for that report had left the template invalid XML (a `--` inside a comment, so nothing could install
  it), fixed it, and laid this repository out as the Community Applications template repository
  (`templates/uchiyomi.xml`, `ca_profile.xml`). `unraid-templates` is now only a pointer here.
- **The scanner finding zero series in a Tranga library** — [@ThomasRunting](https://github.com/ThomasRunting),
  who did not stop at the bug report: they read the scanner, found the early return that made a cover image
  turn a whole series folder into a "chapter of the root", proved it against their own 38-series library,
  and proposed the one-line fix ([#34](https://github.com/AngeloSha/uchiyomi/issues/34)).

## License

[MPL-2.0](LICENSE). Source plugins are **not** part of this repository; they fetch from third-party sites and
are your responsibility to use in line with those sites' terms and your local law.
