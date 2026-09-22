# How Uchiyomi compares

Moved out of the README, where it was the second thing every visitor read and the most likely thing to go
quietly out of date. It makes dated claims about five separate projects that are all still moving, so treat
it as a snapshot rather than a spec sheet, and check the other project's own docs before relying on a row.

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

## Why Uchiyomi?

Most self-hosted manga tools make you pick a side. A **library server** (Komga, Kavita) reads files you supply
but can't fetch new chapters and ships a fairly utilitarian reader. A **source app** (Tachiyomi / Mihon,
Suwayomi) fetches chapters but is Android-only or wraps them in a basic web UI. Uchiyomi is the rare one that does
**both**, in a single app that's actually a pleasure to use:


  <img src="shots/admin-health.webp" alt="The library health checks in the admin panel" width="820">

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
| Runs in one container, database included | ✅ | ❌ *(+ a database)* | ✅ *(an app)* | ❌ *(+ a database)* |
| Interface in 9 languages, right-to-left | ✅ | ✅ | ✅ | limited |
| Age ratings + per-member limit | ✅ | ✅ | ❌ | ❌ |
| Hide an 18+ library until asked for | ✅ | ❌ | ❌ | ❌ |
| Per-member permission to add series | ✅ | ❌ | ❌ | ❌ |
| Syncs to AniList / MAL / Kitsu | ✅ | Kavita+, paid | ✅ | ✅ |
| Prefer or block scanlation groups | ✅ | ❌ | per-source only | ❌ |
| Shows chapters the sources have that you don't | ✅ | ❌ | ✅ | ✅ |
| Reviews every match before an import lands | ✅ | ❌ | ❌ | ❌ |
| Imports an AniList / MAL / Kitsu list | ✅ | ❌ | ❌ | ❌ |
| Readable from Mihon (Komga-compatible API) | ✅ | Komga ✅ | n/a | ❌ |
| Keeps a part-downloaded chapter and repairs it | ✅ | n/a | ❌ | ❌ |
| Reads text ebooks (reflowable EPUB) | ❌ *(on purpose)* | Kavita ✅ | ❌ | ❌ |
| Kobo device sync | ❌ | Komga ✅ | ❌ | ❌ |

<sub>Compiled 2026-09-22 (Uchiyomi v0.40.0) from each project's own docs. These projects move fast and I do not run all of them
daily — if a row is wrong or out of date, [open an issue](https://github.com/AngeloSha/uchiyomi/issues) and I
will fix it.</sub>

The three built-in engines each cover a whole *family* of sites (most aggregators run Madara, MangaThemesia
or Manganato), so "add a source by URL" reaches far more than the engine count suggests. And the real edge is
the combination nobody else offers: one app that finds, fetches, tracks and reads, for a whole household,
with webtoons first-class.
