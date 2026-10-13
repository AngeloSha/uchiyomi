# How Uchiyomi compares

> 🌐 The same comparison with a paragraph on each project: [uchiyomi.com/vs](https://uchiyomi.com/vs)

Checked on **2026-10-14** against Uchiyomi v0.61.2,
[Komga 1.29.0](https://github.com/gotson/komga/releases/tag/1.29.0),
[Kavita 0.9.1.4](https://github.com/Kareadita/Kavita/releases/tag/v0.9.1.4),
[Suwayomi-Server v2.4.2366](https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.4.2366) and
[Mihon 0.21.2](https://github.com/mihonapp/mihon/releases/tag/v0.21.2), from each project's own docs, release
notes and code ([sources](#sources) below). It is written by Uchiyomi's maintainer, which is why the rows Uchiyomi
loses are in it too. All five projects move quickly: if a row is wrong or out of date,
[open an issue](https://github.com/AngeloSha/uchiyomi/issues) and it gets fixed here and on the site.

## The short version

- **Komga** is the most mature library server, and the one to run if you read on a **Kobo**. It does not fetch
  chapters.
- **Kavita** is a library server for comics, manga *and* novels, with saved smart filters and a next-chapter
  forecast. Tracker sync is part of the paid Kavita+. It does not fetch chapters.
- **Suwayomi** is the server that runs Mihon's extensions, with its own web UI. It is also the extension engine
  inside Uchiyomi. Accounts for several people are in its preview builds.
- **Mihon** is the Android app the extensions come from. Excellent on one phone, with nothing for the rest of the
  house.
- **Uchiyomi** is a library server and a downloader in one, with a webtoon-first reader that installs and reads
  offline on any device, for a household with separate accounts.

Every server here reads CBZ, CBR, PDF and image EPUB, serves OPDS, can be read from Mihon on a phone, and has a
[Homepage](https://gethomepage.dev) dashboard widget, so those rows are left out.

## Row by row

✅ yes · ◐ partly (the note says how) · ❌ no · – doesn't apply

| | Uchiyomi | Komga | Kavita | Suwayomi | Mihon |
| --- | :---: | :---: | :---: | :---: | :---: |
| **Shape** | | | | | |
| A server for several people, each with their own progress | ✅ | ✅ | ✅ | ◐ preview builds | ❌ one user |
| Installs as an app and reads offline | ✅ any device | ◐ no offline | ◐ no offline | ◐ no offline | ◐ Android only |
| Desktop app for Windows and Mac | ✅ | ✅ | ❌ | ✅ | ❌ |
| **Fetching** | | | | | |
| Fetches new chapters by itself | ✅ | ❌ you add files | ❌ you add files | ✅ | ✅ |
| Runs Mihon / Tachiyomi extensions | ✅ | ❌ | ❌ | ✅ | ✅ |
| Adds a site from its address, no extension needed | ✅ | – | – | ❌ | ❌ |
| Prefers or blocks scanlation groups | ✅ library-wide | – | – | ◐ per series | ◐ per series |
| Keeps a chapter that is missing a page, then repairs it | ✅ | – | – | ❌ | ❌ |
| Estimates when the next chapter is due | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Reading** | | | | | |
| Scrolls straight on into the next chapter | ✅ | ❌ one book at a time | ◐ replaces the strip | ✅ | ✅ |
| Skips credit and repeated pages | ✅ files untouched | ◐ deletes them from files | ❌ | ❌ | ❌ |
| **Household and access** | | | | | |
| Two-factor sign-in | ✅ | ❌ | ❌ | ❌ | – |
| Login lockout, audit log, session list | ✅ | ◐ login log | ◐ lockout | ❌ | – |
| Single sign-on (OIDC) | ✅ | ✅ | ✅ | ❌ | – |
| API tokens scoped to read, write or admin | ✅ | ◐ unscoped keys | ◐ unscoped keys | ❌ | – |
| Age ratings with a limit per member | ✅ | ✅ | ✅ | ❌ | – |
| An 18+ library hidden until a member asks for it | ✅ | ❌ | ◐ a role to raise it | ❌ | – |
| **Library care** | | | | | |
| Syncs progress to AniList / MyAnimeList / Kitsu | ✅ | ❌ | ◐ Kavita+, paid | ✅ | ✅ |
| Imports your AniList / MyAnimeList / Kitsu list | ✅ | ❌ | ◐ Kavita+, paid | ❌ | ❌ |
| Imports a Mihon backup | ✅ | ❌ | ❌ | ✅ | ✅ |
| Smart lists (saved filters) | ✅ | ❌ | ✅ | ❌ | ❌ |
| Finds chapter gaps and bad downloads, and fixes them | ✅ | ◐ broken files | ◐ broken files | ◐ gap markers | ◐ gap markers |
| Backs itself up on a schedule | ✅ | ❌ | ✅ | ✅ | ✅ on the phone |
| **Where Uchiyomi loses** | | | | | |
| Reads text ebooks (reflowable EPUB) | ❌ on purpose | ✅ | ✅ | ❌ | ❌ |
| Kobo device sync | ❌ | ✅ | ❌ planned | ❌ | ❌ |
| KOReader progress sync | ❌ | ✅ | ✅ | ✅ | ❌ |

**What the partial marks mean**

- **Installs, no offline:** Komga, Kavita and Suwayomi's web UI can be added to a home screen, but none of them keeps
  chapters on the device to read without a connection.
- **Replaces the strip:** Kavita's webtoon reader loads the next chapter when you scroll past the end, in place of
  the one you were reading rather than below it. Komga's stops at the end of each book.
- **Deletes them from files:** Komga can hash the first and last pages of each CBZ, list exact duplicates, and
  delete them from your files. Uchiyomi folds them away in the reader and leaves the files alone.
- **Per series:** Mihon and Suwayomi can hide a scanlator in one series' chapter list. Uchiyomi can also prefer,
  block or wait for a group across the library, and swap in your group's version when it arrives.
- **Gap markers / broken files:** Mihon and Suwayomi mark missing chapter numbers in a series' list; Komga and
  Kavita list files that would not open. Uchiyomi's Health also finds short chapters, bad downloads, duplicates and
  failing sources, and fixes what it can.
- **Preview builds:** Suwayomi merged user accounts on 2026-09-30, after its latest stable release.

## Other projects

| Project | What it is | Latest release | Status, 2026-10-14 |
| --- | --- | --- | --- |
| [Stump](https://github.com/stumpapp/stump) | Comics, manga and book server with OPDS, Kobo and KOReader sync, and OIDC. No downloads. | v0.1.10, 2026-09-21 | active |
| [KamiYomu](https://github.com/KamiYomu/KamiYomu) | Manga reader and downloader in .NET, with plug-in sources and one admin login. | 1.4.0, 2026-09-01 | active |
| [Tranga](https://github.com/C9Glax/tranga) | Downloader that watches series and tells Komga or Kavita to scan. No login. | 1.5, 2023-06-20 | active, last commit 2026-09-21 |
| [Mangarr](https://github.com/KiranTheRam/mangarr) | Sonarr-style downloader writing CBZ for Komga or Kavita. No reader. | v0.1.1, 2026-07-12 | active, new in 2026 |
| [LANraragi](https://github.com/Difegue/LANraragi) | Archive manager and reader for manga and doujinshi. | v0.9.81, 2026-07-06 | active |
| [Codex](https://github.com/ajslater/codex) | Comic archive browser and reader with OPDS. | v2.5.4, 2026-10-08 | active |
| [Tanoshi](https://github.com/luigi311/tanoshi) | Web manga reader with source extensions, continued as a fork. | v0.39.4, 2026-09-30 | active fork |
| [kaizoku](https://github.com/oae/kaizoku) | Downloader built on mangal. No reader. | v1.6.1, 2023-02-07 | **archived** 2025-02-03 |
| [Mango](https://github.com/getmango/Mango) | Manga server and web reader in one binary. | v0.27.0, 2022-07-31 | **archived** 2025-03-23 |
| [Teemii](https://github.com/dokkaner/teemii) | Manga reader and downloader. | none | no commits since 2024-03-08 |

An older, unrelated [Mangarr](https://github.com/donderjoekel/Mangarr) was archived on 2025-04-30.

## Against a do-it-yourself stack

The other way to get a library that fills itself is to assemble one from the tools above: a library server, a
downloader that watches for releases, a Cloudflare solver and a tracker. Uchiyomi does those jobs in one app, from
one compose file.

| The usual stack | In Uchiyomi |
| --- | --- |
| **Komga or Kavita** to serve and read | The library server, the household and the reader, installable and offline |
| **Suwayomi, Mangarr or Tranga** to watch and grab | Follow a series; the scheduler fetches new chapters, estimates when the next is due, and can check quiet series less often |
| **A download folder** shared between the two | Its own downloads, saved as CBZ with ComicInfo, beside your library rather than inside it |
| **FlareSolverr** for Cloudflare | Included in the compose file and wired in; a second solver can take over when the first fails |
| **A tracker app** for AniList or MyAnimeList | Progress sync and list import built in |

The difference is more than tidiness. A downloader that shares a database with the reader knows which chapters you
have read, which group you prefer and which pages came down broken, so it can tell you what is missing, wait for
your translation, and repair a chapter instead of leaving it half-downloaded.

## Sources

**Komga 1.29.0:** [desktop app](https://komga.org/docs/installation/desktop) ·
[what it does](https://komga.org/docs/introduction) ·
[next book in the webtoon reader](https://github.com/gotson/komga/issues/780) ·
[duplicate pages](https://komga.org/docs/guides/duplicate-pages) ·
[install as an app (1.29.0)](https://github.com/gotson/komga/releases/tag/1.29.0) ·
[accounts, age ratings and roles](https://komga.org/docs/guides/user-accounts) ·
[two-factor request](https://github.com/gotson/komga/issues/160) ·
[OAuth2 / OIDC](https://komga.org/docs/installation/oauth2) ·
[API keys (1.20.0)](https://github.com/gotson/komga/releases/tag/1.20.0) ·
[saved filters request](https://github.com/gotson/komga/issues/200) ·
[tracker sync FAQ](https://komga.org/docs/faq) ·
[media analysis](https://komga.org/docs/guides/scan-analysis-refresh) ·
[backups removed (v0.48.0)](https://github.com/gotson/komga/releases/tag/v0.48.0) ·
[EPUB reader](https://komga.org/docs/guides/webreader-epub) ·
[Kobo sync](https://komga.org/docs/guides/kobo) ·
[KOReader sync](https://komga.org/docs/guides/koreader)

**Kavita 0.9.1.4:** [native install](https://wiki.kavitareader.com/installation/native) ·
[webtoon reader (v0.9.0)](https://github.com/Kareadita/Kavita/releases/tag/v0.9.0) ·
[install as an app, and Kobo planned (v0.9.1.0)](https://github.com/Kareadita/Kavita/releases/tag/v0.9.1.0) ·
[lockout](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Extensions/IdentityServiceExtensions.cs) ·
[Kavita+ audit log](https://wiki.kavitareader.com/kavita+/audit) ·
[OIDC](https://wiki.kavitareader.com/guides/admin-settings/open-id-connect) ·
[auth keys](https://wiki.kavitareader.com/guides/user-settings/3rdpartycilents) ·
[users and age ratings](https://wiki.kavitareader.com/guides/admin-settings/users) ·
[smart filters](https://wiki.kavitareader.com/guides/features/filtering) ·
[Kavita+ progress sync](https://wiki.kavitareader.com/kavita+/progress-sync) and [price](https://www.kavitareader.com/) ·
[Kavita+ smart collections](https://wiki.kavitareader.com/kavita+/smart-collections) ·
[media issues](https://wiki.kavitareader.com/guides/admin-settings/mediaissues) ·
[scheduled backups](https://wiki.kavitareader.com/guides/admin-settings/tasks) ·
[EPUB reader](https://wiki.kavitareader.com/guides/readers/epub) ·
[KOReader](https://wiki.kavitareader.com/guides/3rdparty/koreader) ·
[next-chapter forecast (v0.7.10)](https://github.com/Kareadita/Kavita/releases/tag/v0.7.10)

**Suwayomi v2.4.2366:** [README](https://github.com/Suwayomi/Suwayomi-Server) ·
[changelog](https://github.com/Suwayomi/Suwayomi-Server/blob/master/CHANGELOG.md) ·
[user accounts PR](https://github.com/Suwayomi/Suwayomi-Server/pull/623) ·
[web UI caching, images only](https://github.com/Suwayomi/Suwayomi-WebUI/blob/master/vite.config.ts)

**Mihon 0.21.2:** [tracking](https://mihon.app/docs/guides/tracking) ·
[Upcoming](https://mihon.app/docs/faq/updates/upcoming) ·
[reader settings](https://mihon.app/docs/guides/reader-settings) ·
[backups](https://mihon.app/docs/guides/backups)
