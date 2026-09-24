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

### Notification targets

Since v0.43.0 an admin can add **notification targets** under **Admin → Settings → Notifications**: a
webhook, Home Assistant, ntfy or Discord. Nothing is sent anywhere until one is added, and then only to the
address it names: one message per library update listing the series that got chapters (their titles and
counts), and, if the target asks for them, the server-problem notices admins get as web push. There is no
environment variable for any of it; [USAGE §8](USAGE.md#notifications) has each kind's setup and the rules
in plain words.

- Addresses on your own network are allowed; cloud-metadata addresses are refused at save and at every send,
  on every address the name resolves to; a redirect is never followed; 10 s timeout, one retry.
- The addresses and tokens are encrypted in the database under a key derived from **`JWT_SECRET`** with a salt
  of their own (not the tracker tokens' key). A database dump alone does not reveal them. If `JWT_SECRET`
  changes — you set a new one, or a lost `/config` generated one — every target stops with *The stored address
  and token could not be read — enter them again*, and sends nothing until an admin types them in again, the
  same way connected trackers need reconnecting.

## Sources

This section covers one of the two fetch routes: the **generic engines**. The other, and the one most people
will use, is the one-click extension catalogue described under
[Mihon / Tachiyomi extensions](../README.md#features) and in [docs/extensions.md](extensions.md).

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

**Progressive search.** A cross-source Discover search returns after `SEARCH_FIRST_ANSWER_MS` (default
`6000`) at the latest, or `SEARCH_GRACE_MS` (`1500`) after its first useful answer, while unfinished sources
keep filling the same cached entry. `SEARCH_SOURCE_MS` (`20000`, plus the solver allowance when needed) is
one source's budget; `SEARCH_CONCURRENCY` defaults to `SCAN_CONCURRENCY` (which defaults to
`SOLVER_CONCURRENCY=4`) in each of the solver and ordinary lanes. Entries live for `SEARCH_TTL_MS` (`300000`)
and the oldest is evicted above `SEARCH_CACHE_MAX` (`50`). A source detail lookup is cached for ten minutes.
These caches share network work, not authorisation: results are filtered to the account on every response.

`FAKE_SOURCE_URLS=name=http://host:port,name2=http://host:port` registers deterministic HTTP adapters used
by the release test harness. It is empty in every shipped deployment and is not a production source
configuration. `FAKE_SOURCE_NSFW=name` (since v0.42.0) makes the named ones — a comma-separated list of
ids from that same list — declare themselves adult, which is the only way to drive the 18+ rules without a
real adult extension; it does nothing at all while `FAKE_SOURCE_URLS` is unset, which is every shipped
deployment.

The shared source-work limits are `SOLVER_CONCURRENCY` (default `4`) and `SOLVER_BUDGET_MS` (default
`90000`) for Cloudflare-backed work; `SCAN_CONCURRENCY` defaults to that solver slot count, while
`SCAN_ENOUGH` (default `3`) is how many matching candidates make a missing-chapter scan stop widening.

## Downloading

All optional; the defaults are what the live install runs. Adding a series and importing hundreds of
chapters both go through the same downloader, so these are the only knobs that decide how hard a site is
ever hit.

- `UPDATER_SWEEP_MAX` (default `150`): most chapter-fetch attempts in one scheduled sweep, so a backlog
  cannot occupy the whole night.
- `CHAPTER_RETRY_CAP` (default `3`): ordinary failures before a chapter is left as failed until a person
  explicitly retries it.

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
- `DOWNLOAD_RESUME_WAIT_MS` (default `5000,10000,20000`): waits before the three attempts to resume a
  chapter after a 429. A source's longer `Retry-After` is always the floor. A 429 also raises that source's
  in-memory pace level (0–4): slowed levels use one page worker and double gaps up to four seconds; ten
  quiet minutes lower the level by one. A successful slow chapter does not immediately reset it.
- `PARTIAL_CHAPTER_FLOOR` (default `0.8`): if an ordinary, non-refusal failure leaves at least this share of
  pages, save the chapter with indexed placeholders and repair evidence instead of discarding it. `0`
  disables partial chapters. A 403/429 is a refusal and is never saved partial.
- `PARTIAL_COMPLETE_MAX` (default `10`): most partial chapters the nightly completion pass tries to heal.
  It asks only for the missing page indices and removes the partial mark once every page is real; `0`
  disables the completion pass.
- `REPAIR_HOURS` (default `24`, 1–168): how often the nightly repair runs, counted from the END of the last
  completed run, with a floor of thirty minutes after a restart. See *The nightly repair* below.
- `REPAIR_COUNT_MAX` (default `2000`, 1–100000): chapter files whose pages one repair run counts.
- `REPAIR_SHORT_MAX` (default `20`, 1–500): one- or two-page chapters one run investigates.
- `REPAIR_GAPS_MAX` (default `5`, 1–100): series one run searches another source for.
- `REPAIR_PACE_MS` (default `1500`, 0 or more): the pause between two series the repair's *Retry now* step
  re-checks. `0` is a legitimate value and means no pause at all.
- `MIN_FREE_GB` (default `10`): refuse to start a download when the download disk has less than this free.
  `0` disables the floor. Fails open if free space cannot be measured.

An ordinary chapter failure may continue from up to two sources already followed for that series. A copy
explicitly picked by a person never switches. A 403/429 never becomes a partial chapter or starts a hunt;
the refusing source cools down, while an already-followed copy can keep the queue moving. The sweep can also
find a new matching source when **Admin → Settings → Updates & schedules → Look for failed chapters on other
sources** is on (the default): once per series per day, at most six candidates and five hunts per
sweep, with no more than two extra follows. Title and 90%-chapter matching apply, and a clean series never
causes an adult source to be followed. There is intentionally no environment variable for this switch.

## The nightly repair

On by default, under **Admin → Settings → Library housekeeping → Repair the library nightly**, and listed as
**Admin → Tasks → Repair library**. Once every `REPAIR_HOURS` it does the five things on the Health page that
are reversible or provable on their own, in this order:

1. **Cloudflare state.** If the solver answers *and* sources are blaming it, the remembered sessions and
   "could not be solved" marks are cleared and those sources come out of their cooldown; while the solver
   is down, nothing is cleared, because the cookies would have to be re-earned by a solve that cannot
   happen. Either way, any cooldown that lapsed more than 24 hours ago is cleared along with its escalation
   memory — a day, not "lapsed at all", so a source that refuses every night keeps what it has earned. No
   site is contacted.
2. **Page counts.** `REPAIR_COUNT_MAX` chapter files that nobody has opened, newest first. No site is
   contacted. A file that turns out to be unreadable keeps a count of 0 and is not opened again.
3. **Failed chapters.** Up to 100 ledger rows that hit `CHAPTER_RETRY_CAP` more than seven days ago have
   their attempt count cleared, so the sweep tries them again now the site has calmed down. *Retry now* on
   a source does that source's rows whatever their age and then re-checks up to 10 of its series,
   `REPAIR_PACE_MS` apart.
4. **Short chapters.** `REPAIR_SHORT_MAX` one- or two-page chapters Uchiyomi downloaded itself. One copy
   from each of up to 3 sources the series follows is asked how many pages it has, plus one search if none
   of them has more; the chapter is replaced only when a copy really is longer, and marked *confirmed
   short* only when every copy answered and none was silent, in a cooldown, left unasked by that cap, or
   answered with an empty page list — a page list that comes back empty is a site not answering, not a
   zero-page chapter. The copies come from the chapter listing the step refreshes before it asks anything,
   so a source that is in a cooldown at that moment offers no copy at all rather than one that stays
   silent; either way it is not part of a proof.
5. **Gaps.** `REPAIR_GAPS_MAX` series with the largest holes, at most once a day each: a hole a followed
   source already lists is left to the chapter sweep, and only a hole nobody lists starts a search. A
   source is followed only under the same 90%-numbering rule as every other automatic follow, and at most
   20 chapters are fetched per series. A series the run has no searches left for is not marked as checked:
   it keeps its place and is looked at on the next run rather than skipped for a day.

Fixed rather than configurable, because they are the blast radius rather than a preference: 5 searches for a
whole run, shared by steps 3–5, of which the short step may spend at most 2 — so a library full of short
chapters can no longer leave the gap step with nothing; 100 ledger rows, 10 series re-checked, 3 sources
asked per short chapter, 20 chapters per gap series, 8 archives opened at once, 7 days before a capped
chapter gets another chance, and 24 hours between two gap checks of one series. A knob that is missing,
unparseable or out of range falls back to its default and never to zero — `REPAIR_PACE_MS` included, where
only a deliberate `0` turns the pause off.

The repair and the chapter sweep never run at the same time — both download into the same folders — so
whichever starts second waits ten minutes. Switching the nightly off stops the **schedule only**: *Run now*
and the Health page's buttons keep working, because nothing the repair does deletes, merges or renumbers
anything. Duplicate series and impossible chapter numbers are never touched by it; they stay one-click
actions an admin confirms.

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

Web push reaches a browser that allowed it. For a phone app, Home Assistant, ntfy, Discord or a webhook,
use **Admin → Settings → Notifications** instead (since v0.43.0, see
[Notification targets](#notification-targets)); those work without VAPID keys too.

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
