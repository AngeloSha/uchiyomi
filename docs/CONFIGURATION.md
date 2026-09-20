# Configuration

Every setting is an environment variable in `.env`, and `.env.example` is the authoritative list — if the two
ever disagree, `.env.example` is right and this page is stale.

## Environment variables

The ones worth knowing:

- `LIBRARY_BACKEND`: `owned` (read your CBZ library, default) or `komga` (read from a Komga server).
- `LIBRARY_PATH`: host path to your CBZ library (mounted at `/library`).
- `PUID` / `PGID`: run as the user that owns your library, so file operations work. Unset means the app runs
  as its own uid and treats your library as read-only.
- `SOURCES_PATH`: host path to a built source pack (empty by default = no sources).
- `WEB_PORT`: host port the app is published on — `8080` everywhere. (`SPLIT_WEB_PORT`, default `8081`, is
  the split's own port under `--profile split`, so both can run side by side.)
- `PUBLIC_ORIGIN`: the URL the app is served from (match your domain behind a reverse proxy).
- **Database** — `DATABASE_URL`, on the app container. **Unset** (the shipped one-container file leaves it
  unset on purpose): the container runs its own Postgres 16 in `/data/pg` (the `uchiyomi_data` volume), on a
  unix socket only — no network listener, no password — and the nightly task dumps it into `/backups` like
  any other. **Set**: the same image talks to the Postgres you name instead, and starts none of its own;
  [`deploy/docker-compose.external-db.yml`](../deploy/docker-compose.external-db.yml) is that layout ready
  to use, with a `uchiyomi-db` container beside the app (its password is `DB_PASSWORD`). That one variable
  is the whole switch; **Admin → Overview** says which is in use (*embedded database* / *external
  database*), and moving between the two is a dump and a restore, written down in both directions in
  [MIGRATING.md](MIGRATING.md). How to open a `psql` shell on either, and how to restore, is in
  [USAGE §12](USAGE.md#12-backups--restore).


## What leaves your server

Two things can, they are separate switches, and they go to different places. Both live in
**Admin → Settings → Server** (`/admin/?tab=Settings`), each with a fold that spells out what it sends.

**Check for updates** — *on by default.* Once a day the server asks GitHub whether a newer Uchiyomi has been
released and shows the answer under Admin → Health. It is a `GET` of a public releases page: GitHub sees your
IP address, exactly as it would if you opened that page in a browser, and nothing else. Nothing about your
install is sent. Being a version behind is never treated as a fault — it will not turn anything amber.

**Count this server in the anonymous install count** — *off by default.* Nobody can see how many people
self-host this, so nobody — including whoever wrote it — knows whether a release reached twenty people or two
hundred. If you turn this on, once a day your server sends this, and nothing else, to `uchiyomi.com`:

```json
{
  "id": "3f2a…",          // sha256(a secret that never leaves your server + the current month)
  "month": "2026-09",
  "version": "0.28.0",
  "arch": "arm64",         // amd64 or arm64
  "layout": "aio",         // the all-in-one image, or split containers
  "db": "embedded"         // the database the image runs itself, or one you supplied
}
```

The settings page shows you that exact object — produced by the same code that sends it — before you agree
to anything.

- **The id changes every month.** It is a hash of a per-install secret plus the month, and the secret stays
  on your server. Two pings in one month count as one install; two pings in different months cannot be
  connected to each other, by us or by anyone who obtained the data.
- **No library, no titles, no accounts, no address, no hostname.** The object above is the whole of it, and
  a test (`bff/test/installPing.test.ts`) fails the build if a field is ever added.
- **The collector stores no IP address and no clock time** — only the UTC date, and access logging is off for
  that endpoint precisely so there is no side channel that re-identifies a row. Months older than a year are
  deleted.
- **Turning it off** deletes the secret and asks the collector to forget the current month's id. If you ever
  turn it back on, a new id is made — it cannot resume the old one, which is the honest behaviour even though
  it means a returning install looks like a new one.
- `GET https://uchiyomi.com/api/hello` returns the running totals, so you can see what your ping became.

Set `UCHIYOMI_PING_URL` to point the count somewhere else — at your own collector if you run a fork — or to
an empty string to make sure it can never send anything regardless of the setting.

### Progress trackers

The tracker calls are the only ones this server makes **with your token**: AniList, MyAnimeList and Kitsu,
each connected by you under **Profile → Connections → Progress tracking**, and only for reading your list (the
import) and reporting what you finished. Nothing carrying a token goes to a tracker you have not connected.

Two of those services are also asked **without** any token, by title, whether or not anyone has connected
them. Every series added gets its title sent to AniList (`graphql.anilist.co`) once, for banner and cover
art; a series with no art on record is looked up the same way the first time its art is requested, and that
match also records the AniList id progress sync writes against. The admin panel's **Cover & banner health**
card — its *Backfill*, and picking art for one series by hand — asks AniList again and, for wide cover art,
Kitsu (`kitsu.io`), and `POST /api/admin/trackers/relink` asks AniList for every unlinked series. Discover's
*Trending* rail is AniList's own trending list, fetched at most once every six hours. These lookups carry
your server's IP address and the title asked for, and nothing else; they are not moved by the knobs below,
which point only the token-bearing tracker calls elsewhere.

`ANILIST_API_URL`, `MYANIMELIST_API_URL` and `KITSU_API_URL` are **test knobs**: they point an adapter at a
stand-in server instead of the real service (the defaults are `https://graphql.anilist.co`,
`https://api.myanimelist.net/v2` and `https://kitsu.app/api/edge`). They exist so the browser tests can
drive a tracker import without a real account, and there is no reason to set them on an install you read on
— a wrong value here makes every tracker call fail, or worse, sends your token somewhere else.

## Sources

This section covers one of the two fetch routes: the **generic engines**. The other, and the one most people
will use, is the one-click extension catalogue described under
[Mihon / Tachiyomi extensions](#features) and in [docs/extensions.md](extensions.md).

Uchiyomi bundles a few **generic engines** (parsers for the common manga-site families: Madara /
MangaThemesia / Manganato) but **no specific sites for them**. Along this route, nothing fetches anything
until *you* add a site:

**Admin → Providers → Add a site:** pick the engine, paste a site's homepage URL, done. It loads instantly
(no rebuild). The engines are generic parsers; you supply the URLs, and you're responsible for using them in
line with those sites' terms and your local law.

A handful of one-off, site-specific sources (e.g. an official API client) aren't engines and aren't bundled.
Nothing is published for you to drop in — the loader will register any compiled CommonJS plugin you build
yourself against the contract in [`bff/src/lib/sources/loader.ts`](../bff/src/lib/sources/loader.ts), mounted
read-only:

```bash
# .env
SOURCES_PATH=/path/to/your/plugins/dist     # compiled .js plugins, mounted read-only at /sources
```

The reader scans `SOURCES_DIR` (`/sources`) at boot and registers every plugin it finds. Drop in or update a
plugin and hit **Admin → Providers → Reload sources** (`POST /api/admin/sources/reload`); no rebuild. With no sites
added, no extensions installed and no pack mounted, Uchiyomi is just a clean reader for the library you
already own.

## Downloading

All optional; the defaults are what the live install runs. Adding a series and importing hundreds of
chapters both go through the same downloader, so these are the only knobs that decide how hard a site is
ever hit.

- `DOWNLOAD_CONCURRENCY` (default `2`): chapters downloaded at once, per source.
- `DOWNLOAD_MIN_GAP_MS` (default `1200`): minimum gap between chapter downloads from the same source.
- `DOWNLOAD_PAGE_GAP_MS` (default `250`): pause between page requests inside one chapter, for an engine or
  pack site. A chapter is 110-130 images; fetching them back to back at ~1.9 pages a second is exactly what
  earned the 429s on mangakakalot and natomanga, and a quarter second between pages costs about 30 seconds
  per chapter against a 75-minute cooldown. Extension sources ignore this: see the next knob.
- `FLARESOLVERR_ENABLED` / `FLARESOLVERR_URL` **on the extension engine's container** (not on Uchiyomi):
  the bundled Suwayomi has no browser of its own and cannot get past Cloudflare by itself; these two are
  Suwayomi-Server's own settings and point it at the bundled solver. Every compose file sets them on the
  engine service since v0.37.0 (`FLARESOLVERR_ENABLED: "true"`, `FLARESOLVERR_URL:
  http://uchiyomi-flaresolverr:8191` in the `deploy/` files, `http://yomi-flaresolverr:8191` in the
  development stack), so an upgrade that recreates the engine container is the fix for
  [#54](https://github.com/AngeloSha/uchiyomi/issues/54). If you run the engine yourself — an existing
  Suwayomi named in `SUWAYOMI_URL`, the Unraid template — set both on **that** container and recreate it, or
  every Cloudflare-protected extension source fails its search with `Cloudflare bypass currently disabled`.
  The admin *Test* button and Health then say, in these words: *The extension engine's own Cloudflare
  bypass is switched off. On the Suwayomi engine's container (uchiyomi-suwayomi in the shipped compose
  files) set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL to the same solver address Uchiyomi uses
  (http://uchiyomi-flaresolverr:8191 in the shipped files), then recreate it. The v0.37.0 compose files
  already set both, so an upgrade that recreates the engine is the fix there.* — the shipped names are
  examples; use whatever your engine's container and solver are called. Uchiyomi's own `FLARESOLVERR_URL`
  (in the tuning list of `.env.example`) is a different setting: it is the solver the built-in engines use.
- `SUWAYOMI_URL` (see [extensions.md](extensions.md#settings)): where the extension engine is; empty turns
  the feature off. A trailing slash (or two), a query string or a fragment on this value is ignored; the
  scheme, host, port and any sub-path are what count — the same normalised base is used for the covers the
  engine hands over and for the cover proxy's check of them, so a stray `//` no longer turns every
  extension cover into a placeholder.
- `SUWAYOMI_PAGE_CONCURRENCY` (default `4`, 1-8): pages fetched at once from the extension engine. An
  extension source's page URLs are the engine's own proxy paths, and the engine has its own client and its
  own rate limits towards the site, so the one-at-a-time pacing above was only slowing extension downloads
  down for nothing. The first 429 from the engine drops the chapter back to one page at a time for the rest
  of the download.
- `MIN_FREE_GB` (default `10`): refuse to start a download when the download disk has less than this free.
  `0` disables the floor. Fails open if free space cannot be measured.

## Deleting chapters after they are read

Off, and there is deliberately **no environment variable that turns it on**. It is switched on in
**Admin → Settings → Library housekeeping → Delete read chapters**, behind a confirmation, because an install that upgraded into a
file-deleting job because of a line in a compose file would be indefensible. See
[USAGE](USAGE.md#deleting-chapters-after-they-are-read) for what it will and will not touch.

- `CLEANUP_MAX_PER_RUN` (default `500`): most chapters one hourly run may delete. Not a performance limit —
  unlinking is cheap — but a blast radius. The first run after switching this on, on a library that has been
  read for years, is the one nobody has an intuition for; whatever is left over goes on the next run.

## Push notifications

Nothing to configure. The server generates a VAPID key pair on first boot and keeps it in `/config`, the
same way it does the session secret, so new-chapter notifications work on a stock install (the switch is
**Profile → Settings → This device → New-chapter alerts**). Set
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` yourself only if you already have a pair you want to keep —
explicit values always win.

⚠️ Before v0.25.0 those keys were only ever generated by `scripts/setup.sh`, which builds the *development*
stack. Anyone who followed the two-command install had push listed as a feature in the README and no way to
turn it on: the card simply did not appear.

## Matching a renamed folder back to its series

`LIBRARY_REMATCH` — `off` (default), `report`, or `apply`.

When a series folder is renamed or moved, the scanner normally sees a stranger and imports it as a new
series, leaving the old one empty. Uchiyomi can instead recognise it by the content of its chapters, using
the CRC-32 fingerprints the background job fills in.

- `off` — do not try. A renamed folder becomes a new series.
- `report` — log what it *would* match, change nothing. The safe way to find out whether it would help you.
- `apply` — actually re-attach the folder to its original series, keeping progress, ratings and favourites.

⚠️ The v0.6.0 changelog described this as simply how the scanner behaves. It is not: it has shipped
defaulting to `off` ever since, so on a default install a renamed folder has always become a stranger. It is
opt-in because getting a rematch wrong merges two series, and the guards that prevent that (a minimum book
count, a minimum overlap, exactly one candidate, and every book fingerprinted) are worth understanding
before you turn it on. Start with `report`.

