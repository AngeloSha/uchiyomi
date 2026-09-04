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

## One app instead of a stack

Self-hosting manga the usual way means a pile of services: an indexer, a grabber that watches for new
releases, a download client, a Cloudflare solver, and a media server to read it all, so four or five containers
and a weekend of compose files. **Uchiyomi folds the whole pipeline (discover → grab → monitor → serve → read)
into a single image.** Point it at your library, install an extension or paste a site's URL, and it does the rest.

| The usual self-hosted stack | Uchiyomi, built in |
| --- | --- |
| **Prowlarr / Jackett** — indexers & search | ~1,400 Mihon/Tachiyomi extensions installable with one click, plus paste-a-URL generic engines and bundled MangaDex, all searchable in Discover |
| **Sonarr / Radarr** — grab + watch for new releases | Add to library, then a scheduled updater auto-grabs new chapters (per-series, configurable interval) |
| **qBittorrent** — download client | Built-in chapter downloader → CBZ, with offline PWA sync |
| **FlareSolverr** — Cloudflare solver | Bundled and wired in — nothing to configure |
| **Jellyfin / Plex** — multi-user server + apps | OLED PWA reader: per-user progress, household/leaderboard, offline, 2FA, a Jellyfin-style admin panel |

## Features

- **Vertical webtoon reader:** continuous multi-chapter scroll, pinch/double-tap zoom, AMOLED/sepia themes,
  per-series memory, auto-hiding chrome, keyboard nav on desktop — plus **double-page spreads** for classic
  manga (RTL-aware), a **page-preview scrubber**, and an end-of-series **Up Next** card with suggestions.

  <img src="docs/shots/reader.webp" alt="The Uchiyomi reader, mid-chapter" width="820">

- **Cinematic art everywhere:** real banner + cover art pulled from AniList / Kitsu / MangaDex with a one-click
  **backfill** and an admin **Art Review** picker; the home hero shows each series' actual art sharp,
  aspect-aware for phone and desktop, pre-warmed so it loads instantly.
- **Library:** fast scanner for **CBZ, CBR, PDF, image EPUB and loose image folders** (reads `ComicInfo.xml`), cover-art
  ambient theming, genres, an Updates feed with new-chapter badges, and discovery rails (For You / trending /
  similar / "because you read …").
- **Your library survives files moving:** chapters carry a content fingerprint taken from the archive itself
  rather than its path, so renaming a folder — or a source renaming it for you — matches back to the series
  you were already reading instead of importing a second copy with an empty progress bar.
- **Series management:** hide a series, restore it, or **merge** two that arrived from different sources into
  one. Hiding keeps every chapter, rating and reading-history row attached, so it is undoable. Merging moves
  everything across and deliberately keeps duplicate chapters rather than guessing which to drop, because
  folding two progress rows into one is how chapters silently become unread. Also: unfollow a single series,
  or check one for new chapters without waiting for the sweep.
- **Library management:** split your collection into **several libraries** and choose who can see each one;
  filter by read state, publication status, author and genre; select many series at once to mark read,
  favourite or file into a collection; edit a series' title, author, status, genres, cover and background, and
  correct a chapter's number when the filename lied about it. Metadata you edit survives every rescan. If you
  run it as the owner of your library (`PUID`), it can also rename folders and delete chapter files.
- **Command palette:** press **Ctrl+K** anywhere — instant series search, quick actions, recent items.
- **Collections:** hand-curated reading lists with accent colors, reorderable, surfaced on Home.
- **Discover:** a wall of **what your sources just published**, grouped by language and led by full-bleed key
  art for what the world is reading. Each source gets **eight seconds** and is cached, so one slow site cannot
  hold up the page, and the ones your library actually came from are asked first. Search is still there, across
  **every source at once** (one card per title; pick which provider to add from).

  <img src="docs/shots/discover.webp" alt="The Discover page: newest releases from your own sources" width="820">

- **Multi-user:** username + password accounts, per-user reading progress / favorites / history timeline,
  avatars, streaks, and a "household" leaderboard — with accurate completion tracking, mark-as-read
  anywhere, and bulk offline-download management.
- **Offline:** installable PWA with offline downloads + smart auto-sync of favorites.
- **Push notifications:** opt-in web push the moment a followed series gets a new chapter.
- **OPDS:** browse & read your Uchiyomi library from other reader apps (Panels, Chunky, KOReader, …) — page by page over OPDS-PSE, with sort / library / genre / status filters, and an 18+ switch per reader.
- **Mihon / Tachiyomi extensions:** browse and install the same ~1,400 extensions those apps use, from inside
  Uchiyomi's admin panel. Click Add and the source is searchable immediately. They run on a bundled
  [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) engine that starts with the stack and configures
  itself; Uchiyomi still owns the library, reader, downloads and updates. See
  [docs/extensions.md](docs/extensions.md).

  <img src="docs/shots/admin-extensions.webp" alt="Browsing and installing extensions from the admin panel" width="820">

- **Single sign-on:** optional OIDC login against Authentik, Authelia, Keycloak or anything else that speaks
  OpenID Connect, with optional group-to-admin mapping. Local accounts and 2FA keep working alongside it,
  so a provider outage can't lock you out. See [docs/api.md](docs/api.md#single-sign-on-oidc).
- **Scriptable:** long-lived, revocable API tokens with read / write / admin scopes, so a backup script or
  a cron job can talk to the API without a browser session. See [docs/api.md](docs/api.md), or the full
  reference the app serves itself at `/api/docs` (Swagger UI with try-it-out), which a test keeps in step
  with the routes.
- **AniList sync:** connect your account once and finishing a chapter updates your AniList list on its own.
  Progress is the highest chapter you've *finished*, so re-reading an old one never rewinds your list, and
  AniList being down or your token expiring can never block or slow down your reading.

  <img src="docs/shots/crop-anilist.webp" alt="Connecting an AniList account" width="820">

- **Security:** argon2id passwords, JWT + rotating refresh tokens, login lockout, an audit log,
  session/device management, and optional TOTP two-factor auth.
- **Bring your library with you:** import a **Mihon/Tachiyomi backup** (`.tachibk`) or a public **MangaDex
  list** — Uchiyomi reads the titles, shows you what it found (flagging what you already have), and adds the
  rest from your own sources. Pasting a plain list of titles works too.
- **Backups built in:** a nightly dump of the database + your config, rotated automatically, restorable with
  plain `psql` — point it at another disk with one env var. ([how to restore](docs/USAGE.md#12-backups--restore))
- **Admin:** a Jellyfin-style panel with members & permissions, provider health, scheduled tasks, activity feed,
  active sessions, and server settings (name, open registration, auto-update interval).

![Library](docs/shots/library.webp)

### On a phone

Installed to the home screen it's the same app, not a cut-down one — the reader, the library and offline
downloads all come along.

<p>
  <img src="docs/shots/phone-home.webp" alt="The Uchiyomi home screen on a phone" width="240">
  <img src="docs/shots/phone-library.webp" alt="The library on a phone" width="240">
  <img src="docs/shots/phone-reader.webp" alt="The webtoon reader on a phone, mid-chapter" width="240">
</p>

> 📸 Every screen, walked through with captions: **[docs/USAGE.md](docs/USAGE.md)**.

## Why Uchiyomi?

Most self-hosted manga tools make you pick a side. A **library server** (Komga, Kavita) reads files you supply
but can't fetch new chapters and ships a fairly utilitarian reader. A **source app** (Tachiyomi / Mihon,
Suwayomi) fetches chapters but is Android-only or wraps them in a basic web UI. Uchiyomi is the rare one that does
**both**, in a single app that's actually a pleasure to use:


  <img src="docs/shots/admin-health.webp" alt="The library health checks in the admin panel" width="820">

- **Server *and* sources in one.** Own your library *and* pull new chapters, with no Komga-plus-Suwayomi-plus-a-
  reader Frankenstein to stitch together.
- **A reader you'll actually want to open.** True-black OLED, with a **webtoon-first** vertical reader
  (continuous multi-chapter scroll, pinch-zoom, themes, per-series memory), not a long-strip mode bolted onto a
  page-turn comics viewer.
- **Installable, offline, every device.** A real PWA: add to home screen, read offline, no app store, on
  phone, tablet, or desktop from one codebase.
- **Built for a household.** Per-user progress, favorites, history, avatars, streaks, a leaderboard, plus the
  security most self-hosted manga tools skip: **TOTP two-factor**, login lockout, an audit log, and
  session/device management, all behind a Jellyfin-style admin panel.
- **Add a source by pasting a URL.** Auto-detect figures out the engine; no extension repos to wire up.

| | Uchiyomi | Komga / Kavita | Tachiyomi / Mihon | Suwayomi |
| --- | :---: | :---: | :---: | :---: |
| Self-hosted, multi-user server | ✅ | ✅ | ❌ *(Android app)* | ✅ |
| Fetches new chapters from sources | ✅ | ❌ *(you supply files)* | ✅ | ✅ |
| Webtoon-first reader (continuous vertical scroll) | ✅ | paged-first | ✅ *(Android)* | paged-first |
| Installable PWA + offline, any device | ✅ | partial | Android only | partial |
| Per-user progress + household | ✅ | ✅ | ❌ | limited |
| 2FA · lockout · audit log · session management | ✅ | partial | ❌ | ❌ |
| Add a source by pasting a URL | ✅ | — | extensions | extension repos |
| Automatic nightly backups | ✅ | ❌ | ❌ | ❌ |
| Finds chapter gaps & bad downloads | ✅ | partial | ❌ | ❌ |
| API tokens, scoped read / write / admin | ✅ | keys, unscoped | ❌ | ❌ |
| Single sign-on (OIDC) | ✅ | ✅ | ❌ | ❌ |
| Reaches Mihon's extensions | ✅ | ❌ | ✅ | ✅ |
| Reads CBZ / CBR / PDF / image EPUB | ✅ | ✅ | ✅ | ✅ |
| Runs in one container (+ a database) | ✅ | ✅ | ✅ *(an app)* | ✅ |
| Interface in 9 languages | ✅ | ✅ | ✅ | limited |
| Age ratings + per-member limit | ✅ | ✅ | ❌ | ❌ |
| Hide an 18+ library until asked for | ✅ | ❌ | ❌ | ❌ |
| Per-member permission to add series | ✅ | ❌ | ❌ | ❌ |
| Syncs to AniList / MAL / Kitsu | ✅ | Kavita+, paid | ✅ | ✅ |
| Reads text ebooks (reflowable EPUB) | ❌ *(on purpose)* | Kavita ✅ | ❌ | ❌ |
| Kobo device sync | ❌ | Komga ✅ | ❌ | ❌ |

<sub>Compiled 2026-08-24 from each project's own docs. These projects move fast and I do not run all of them
daily — if a row is wrong or out of date, [open an issue](https://github.com/AngeloSha/uchiyomi/issues) and I
will fix it.</sub>

The three built-in engines each cover a whole *family* of sites (most aggregators run Madara, MangaThemesia
or Manganato), so "add a source by URL" reaches far more than the engine count suggests. And the real edge is
the combination nobody else offers: one app that finds, fetches, tracks and reads, for a whole household,
with webtoons first-class.

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

## Architecture

*(Development stack — see [Install](#install) below for the container names `deploy/docker-compose.yml` uses.)*

| Service | What it is |
| --- | --- |
| `yomi-app` | The whole app in one container, built from `Dockerfile.aio` — the same topology the released image ships. This is what `docker compose up -d` starts |
| `yomi-bff` | Fastify + TypeScript API: auth, catalog over the CBZ library, disk image cache, the source loader. **Only under `--profile split`** |
| `yomi-web` | Next.js static-export PWA on nginx, reverse-proxying `/api`, `/auth`, `/img` to the BFF. **Only under `--profile split`** — the shipped image serves the PWA from the API process itself |
| `yomi-db` | Private Postgres (no host port) |
| `yomi-flaresolverr` | Optional headless-Chrome Cloudflare solver, used only by Cloudflare-protected source plugins |
| `yomi-suwayomi` | The extension engine that runs Mihon / Tachiyomi extensions — a JVM, ~800 MB; set `SUWAYOMI_URL=` empty to turn it off ([docs](docs/extensions.md)) |

## Install

**Requirements:** Docker + Docker Compose, and a manga library on disk, where each chapter is a `.cbz`, a
`.cbr`, or a folder of images (an archive may carry a `ComicInfo.xml` for metadata). **Any folder layout
works**: a directory is treated as a series when it directly contains chapters, at whatever depth. So
`One Piece/Chapter 1.cbz`, `Manga/One Piece/Chapter 1.cbz` and `Comics/Manga/Author/One Piece/Chapter 1.cbz`
are all read without rearranging anything.
Everything else runs in containers: no Node, no database, nothing to install on the host.

Grab one file and start it — this pulls prebuilt **multi-arch images (amd64 + arm64)**, so there's nothing to
compile and it comes up in seconds even on a NAS or a Raspberry Pi.

> **Don't clone the repo to install it.** The top-level `docker-compose.yml` builds from source and is the
> *development* stack. The one command below is the whole install.

```bash
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.yml
docker compose up -d
```

Then open **http://localhost:8080** and **create your admin account right in the browser**. There are no
secrets to generate and no config file to edit.

That is **Uchiyomi in one container, database included**: Postgres runs inside it, on a unix socket, in a
volume of its own, and there is nothing to configure. Two more are optional: a Cloudflare solver, which the
fetching half needs for most aggregators, and the extension engine, which is a JVM and costs about 800 MB.
Leave the extension engine out and it is two containers; only the first is Uchiyomi itself.

<details>
<summary>Prefer to run Postgres yourself?</summary>

Set `DATABASE_URL` and the same image talks to your database instead of starting its own; that one variable
is the whole switch. [`deploy/docker-compose.external-db.yml`](deploy/docker-compose.external-db.yml) is
that layout ready to use, with a Postgres container beside the app -- it is what the install instructions
used before v0.18.0, and an existing install keeps working on it unchanged. Moving between the two is a
dump and a restore, written down in both directions in **[docs/MIGRATING.md](docs/MIGRATING.md)**.
</details>

<details>
<summary>Already running the older two-container layout?</summary>

Uchiyomi used to ship as `uchiyomi-bff` + `uchiyomi-web`, with a separate nginx serving the web app. That
layout is **deprecated but not dead**: it is still built, still published and still works, and nothing about
your install has stopped functioning. You are not required to move.

It is deprecated because the single container measured better on the same host — **265 MB instead of
441 MB**, less memory, one less network hop on every API call, and no redirect on deep links — and because
the end-to-end tests only ever drive the single container, so it is the layout that is actually proven on
every commit.

Moving to the external-database layout is a compose swap, not a data migration: both use the **same named
volumes** and the same Postgres image. Four commands, in **[docs/MIGRATING.md](docs/MIGRATING.md)**. The
file itself is still there as [`deploy/docker-compose.split.yml`](deploy/docker-compose.split.yml).
</details>

To read a library you already have, point `LIBRARY_PATH` at it. By default Uchiyomi runs as its own user and
**cannot write to your files at all**; set `PUID`/`PGID` to your own ids (`id -u`, `id -g`) if you want it to
be able to rename folders and delete chapters:

```bash
echo "LIBRARY_PATH=/path/to/your/manga" > .env
docker compose up -d
```

**On CasaOS?** Use [`deploy/casaos/docker-compose.yml`](deploy/casaos/docker-compose.yml) instead — import it
as a custom app and it appears with an icon like any store app. That manifest leaves out the extension
engine, so Mihon/Tachiyomi extensions are off there; add `uchiyomi-suwayomi` from
[`deploy/docker-compose.yml`](deploy/docker-compose.yml) and set `SUWAYOMI_URL` if you want them.

**On Unraid?** Add `https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/unraid/uchiyomi.xml`
under *Docker → Add Container → Template repositories* (or install from Community Applications once it is
listed). One container, database included; set PUID/PGID to the owner of your library for renames.

**On Umbrel?** The app manifest lives at [`deploy/umbrel/uchiyomi`](deploy/umbrel/uchiyomi) and is
submitted to the Umbrel app store from there. It runs as Umbrel's own user with the database inside the
container; nothing to configure.

What you end up running:

| Container | Role |
|---|---|
| `uchiyomi` | the app: the API and the PWA it serves |
| `uchiyomi-db` | private Postgres (no published port — unreachable from outside the stack) |
| `uchiyomi-flaresolverr` | Cloudflare solver — **started automatically**; sources that need it use it with no config |
| `uchiyomi-suwayomi` | the extension engine, so Mihon / Tachiyomi extensions work ([docs](docs/extensions.md)) |

```bash
docker compose logs -f uchiyomi  # watch it boot
```

Cloning the repo and want a CLI-seeded admin instead of the browser setup step? `bash scripts/setup.sh`
generates the secrets, creates the admin from a password you type, fixes volume ownership, and starts the
development stack — which builds the **same single container** the install ships, so what you run matches
what you would have deployed. It refuses to run in a checkout whose `docker-compose.override.yml` manages a
service it does not, so it cannot restart a server install.

Change the port with `WEB_PORT` in `.env` (default `8080`; e.g. `WEB_PORT=9000` → http://localhost:9000).

### Updating

```bash
docker compose pull
docker compose up -d
```

**`docker compose up -d` on its own is not enough.** The images are pinned to `:latest`, and Docker reuses a
tag it already has rather than checking for a newer one — so without the `pull` you stay on whatever version
you first installed, indefinitely, with nothing to tell you. Watch
[releases](https://github.com/AngeloSha/uchiyomi/releases) to know when there is something to pull.

Upgrading in place is safe: accounts, reading progress, downloads and settings live in named volumes, and the
database migrates itself on boot.

> **Running the single container on v0.9.0 or v0.9.1? Your backups are empty. Upgrade.**
>
> Those two images were built without the Postgres client, so `pg_dump` was not present and the backup task
> wrote a 20-byte empty archive every night. It said nothing: no log line, and the admin Tasks panel kept
> reporting the last run that *had* worked — which, if you came from the split layout, was a real backup
> written by the old containers.
>
> ```bash
> docker compose exec uchiyomi pg_dump --version
> ```
>
> No output means the image cannot dump, whatever the panel says. Check the file sizes too — a real dump is
> megabytes, a broken one is 20 bytes. Fixed in **v0.9.2**, which also makes a failed backup report itself
> instead of leaving the last success standing. The split layout was never affected.

> **First installed before v0.5.1? Upgrading will not fix this — it needs one manual step.**
>
> Docker sets a volume up only at the moment it first creates it. A volume made by an old image keeps the
> ownership it was born with forever, no matter how many newer images you pull on top. So this is not
> something v0.6.0 can repair for you.
>
> Those old builds left the `config` and `downloads` volumes owned by root while the app runs as uid 10002,
> so chapter downloads failed, adding a site returned an error, and because the JWT secret could not be
> saved, **everyone was signed out on every restart**.
>
> Installed at v0.5.1 or later? None of this applies — your volumes were created correctly. To check either
> way, ask the app whether it can write:
>
> ```bash
> docker compose exec uchiyomi sh -c 'touch /config/.probe && echo OK && rm /config/.probe'
> ```
>
> If that prints `OK`, you are fine and can skip the rest. If it errors, fix it once:
>
> ```bash
> docker compose down
> # derive the real volume names -- they are prefixed with your folder, and naming them by hand is
> # how you end up chowning a brand new empty volume while the real one stays broken
> CFG=$(docker volume ls -q | grep -E '_?uchiyomi_config$')
> DL=$(docker volume ls -q | grep -E '_?uchiyomi_downloads$')
> echo "fixing: $CFG $DL"          # both must be non-empty before you run the next line
> docker run --rm -v "$CFG":/a -v "$DL":/b alpine chown -R 10002:10002 /a /b
> docker compose up -d
> ```

### Serving it on a domain (HTTPS)

The compose file is **standalone**: it publishes the app on a local port and creates its own private networks,
so a fresh install just works. To put it on a public domain with TLS, front the app with any reverse proxy
(Caddy, Traefik, Nginx Proxy Manager, …) and set `PUBLIC_ORIGIN` in `.env` to your URL.

If your proxy reaches containers over a shared Docker network, drop a `docker-compose.override.yml` next to the
compose file — Compose loads it automatically:

```yaml
# docker-compose.override.yml  (server-specific; keep it out of git)
networks:
  proxy:
    external: true
services:
  uchiyomi:
    networks: [uchiyomi_app, uchiyomi_internal, proxy]   # keep the first two: the solver, and the database
```

Point the proxy at **`uchiyomi` port 3000**. Once it reaches the app over a shared Docker network you no
longer need the published host port, and deleting the `ports:` entry stops the app also being served over
plain HTTP alongside your HTTPS domain.

> Using the development stack from a clone instead? Its services are named `yomi-*`, with networks
> `yomi_app` and `yomi_internal`.

## Sources (optional)

This section covers one of the two fetch routes: the **generic engines**. The other, and the one most people
will use, is the one-click extension catalogue described under
[Mihon / Tachiyomi extensions](#features) and in [docs/extensions.md](docs/extensions.md).

Uchiyomi bundles a few **generic engines** (parsers for the common manga-site families: Madara /
MangaThemesia / Manganato) but **no specific sites for them**. Along this route, nothing fetches anything
until *you* add a site:

**Admin → Providers → Add a site:** pick the engine, paste a site's homepage URL, done. It loads instantly
(no rebuild). The engines are generic parsers; you supply the URLs, and you're responsible for using them in
line with those sites' terms and your local law.

A handful of one-off, site-specific sources (e.g. an official API client) aren't engines and aren't bundled.
Nothing is published for you to drop in — the loader will register any compiled CommonJS plugin you build
yourself against the contract in [`bff/src/lib/sources/loader.ts`](bff/src/lib/sources/loader.ts), mounted
read-only:

```bash
# .env
SOURCES_PATH=/path/to/your/plugins/dist     # compiled .js plugins, mounted read-only at /sources
```

The reader scans `SOURCES_DIR` (`/sources`) at boot and registers every plugin it finds. Drop in or update a
plugin and hit **Admin → Providers → Reload** (`POST /api/admin/sources/reload`); no rebuild. With no sites
added, no extensions installed and no pack mounted, Uchiyomi is just a clean reader for the library you
already own.

## Configuration

Everything is in `.env` (see `.env.example`). Notably:

- `LIBRARY_BACKEND`: `owned` (read your CBZ library, default) or `komga` (read from a Komga server).
- `LIBRARY_PATH`: host path to your CBZ library (mounted at `/library`).
- `PUID` / `PGID`: run as the user that owns your library, so file operations work. Unset means the app runs
  as its own uid and treats your library as read-only.
- `SOURCES_PATH`: host path to a built source pack (empty by default = no sources).
- `WEB_PORT`: host port the app is published on — `8080` everywhere. (`SPLIT_WEB_PORT`, default `8081`, is
  the split's own port under `--profile split`, so both can run side by side.)
- `PUBLIC_ORIGIN`: the URL the app is served from (match your domain behind a reverse proxy).

## Roadmap

Actively developed. On deck:

- 🧭 **Per-source genre & popular browsing:** rounding out the newest-releases rails.

Recently shipped: 🔞 an 18+ library kept off every browsing surface until you ask for it, 🧒 age ratings with a
per-member limit, 🚫 a per-member permission to add series at all, 🧭 Discover rebuilt around what your sources
just published, 🌍 nine languages with right-to-left, 🔖 bookmarks, 📄 PDF and image EPUB, 📚 multiple libraries
with per-member access, 🔍 library filters and bulk actions, ✏️ editable series and chapter metadata that
survives a rescan, 📁 any folder layout, 🗂️ series delete / restore / merge, 🔎 content fingerprinting so renamed
folders are recognised, 🔗 progress sync to AniList, MyAnimeList and Kitsu, 🔔 push notifications, 📡 OPDS with
page streaming, facets and expiring links, browser-based first-run setup, and cross-source search.

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

## License

[MPL-2.0](LICENSE). Source plugins are **not** part of this repository; they fetch from third-party sites and
are your responsibility to use in line with those sites' terms and your local law.
