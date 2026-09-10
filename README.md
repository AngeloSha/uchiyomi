# Uchiyomi

*A self-hosted manga and manhwa reader that also keeps up with new chapters: one installable PWA, true-black OLED, webtoon-first.*

[![CI](https://github.com/AngeloSha/uchiyomi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AngeloSha/uchiyomi/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/AngeloSha/uchiyomi?label=release&color=7c5cff)](https://github.com/AngeloSha/uchiyomi/releases/latest)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)
[![Container images](https://img.shields.io/badge/ghcr.io-amd64%20%2B%20arm64-2496ED?logo=docker&logoColor=white)](https://github.com/AngeloSha?tab=packages&repo_name=uchiyomi)

### 🌐 [**uchiyomi.com**](https://uchiyomi.com) · 🐙 [GitHub](https://github.com/AngeloSha/uchiyomi) · ☕ [Ko-fi](https://ko-fi.com/angeloshaheen) · 📜 [Changelog](CHANGELOG.md)

A self-hosted, installable (PWA) manga / manhwa reader with a true-black OLED interface and a vertical-scroll
webtoon reader as the centerpiece. Point it at your own CBZ library and read on any device.

[![Uchiyomi — a walk through the app](docs/shots/tour.webp)](https://uchiyomi.com)

Uchiyomi is a **bring-your-own-library reader** first: like Komga / Kavita / Calibre-web, it reads comics *you*
supply, and the library and reader work on nothing but files you already own.

**It also fetches**, by two routes, and both ship in the default install. **Mihon / Tachiyomi extensions**: a
browsable catalogue of ~1,400 community extensions, installed with **one click** in the admin panel and
searchable immediately, run by a bundled engine that starts with the stack. And **generic engines** for the
common manga-site families, where you paste a site's URL yourself. Plus **MangaDex**, via its official public
API.

No source is enabled until you choose one, and nothing is compiled into the image. But the catalogue arrives
wired up and one click away, so calling this a reader alone would undersell what it does. You pick what to
enable, and you are responsible for using it in line with those sites' terms and your local law.

> 📖 **[Full usage guide →](docs/USAGE.md)**: every screen walked through with screenshots (library, reader,
> Discover, admin, security, offline).
## Features

- **Webtoon-first reader** — vertical scroll or paged, RTL, double-page spreads, per-series settings.
- **Skips the pages that are not the story** — the scanlator credit page that opens every chapter is
  found by repetition and left out of the flow, with a tap to bring it back.
- **True-black OLED interface**, built for a phone and installable as a PWA.
- **Offline downloads** — save chapters to the device and read them with no connection at all.
- **Your own library** — CBZ, CBR, PDF, image EPUB or a folder of images, in any folder layout.
- **Also fetches** — ~1,400 Mihon / Tachiyomi extensions installable in one click, generic engines for
  common site families, and MangaDex. Nothing is enabled until you choose it.
- **Discover** — what your sources just published, grouped by language, plus search across every source.
- **Multi-user** — accounts, per-user progress and favourites, age ratings, per-member library access.
- **Library management** — several libraries, filters, bulk actions, editable metadata that survives a
  rescan, series merge, delete and restore.
- **Moments** — star a page and it lands on its own screen as the panel itself, with notes.
- **Reading Studio & Wrapped** — a year heat-map, chapters by month and weekday, your top series and genres.
- **Push notifications** when a followed series gets a new chapter.
- **OPDS** — read from Panels, Chunky or KOReader, page by page over OPDS-PSE.
- **Progress sync** to AniList, MyAnimeList and Kitsu.
- **Nothing phones home.** An update check reads GitHub's public releases page and sends nothing about your
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

## Documentation

| | |
|---|---|
| [Usage](docs/USAGE.md) | Every screen, with screenshots |
| [Install](docs/INSTALL.md) | One-click stores, updating, HTTPS, external DB |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and source paths |
| [Extensions](docs/extensions.md) | The Mihon / Tachiyomi engine |
| [API](docs/api.md) | REST reference |
| [Migrating](docs/MIGRATING.md) | Moving between layouts and versions |
| [Comparison](docs/COMPARISON.md) | How it differs from Komga, Kavita, Mihon and Suwayomi |

## Translations

The interface ships in **English, Spanish, French, German, Portuguese (Brazil), Russian, Japanese, Chinese
and Arabic**, with right-to-left layout for Arabic. Pick one under **Profile → Language**; the choice follows
your account to other devices.

**Everything except English is machine-assisted and has not been checked by a native speaker.** If something
reads wrong, it is one JSON file per language in [`web/public/locales/`](web/public/locales) and the keys are
the English source strings — edit a value, open a pull request, done. A missing key falls back to English
rather than showing a blank or a placeholder, so a partial translation is always safe to ship.

Adding a language: copy `en` semantics into `web/public/locales/<code>.json`, add the code to `LOCALES` in
`web/lib/i18n.ts`, and set `dir` if it is right-to-left.

## Roadmap

Actively developed. On deck:

- 🧭 **Per-source genre & popular browsing** — rounding out the newest-releases rails.

Everything already shipped is in the **[changelog](CHANGELOG.md)**.

## Support

Uchiyomi is free and open-source. If it's useful to you, you can help fund continued development:

**[☕ Buy me a coffee on Ko-fi →](https://ko-fi.com/angeloshaheen)**

You'll also find a **♡ Sponsor** button at the top of this repo's GitHub page, and a **Support Uchiyomi** card inside
the app under **Profile** and **Admin → Settings**.

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

- **Unraid install instructions** — [@hawwwwwk](https://github.com/hawwwwwk), who spotted that Unraid had
  removed the *Template repositories* field the docs told people to use, and opened pull requests against
  both this repo and [`unraid-templates`](https://github.com/AngeloSha/unraid-templates).

## License

[MPL-2.0](LICENSE). Source plugins are **not** part of this repository; they fetch from third-party sites and
are your responsibility to use in line with those sites' terms and your local law.
