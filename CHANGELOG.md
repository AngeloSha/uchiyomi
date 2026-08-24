# Changelog

## Unreleased

### Libraries you can actually build

A library is now **a folder, plus any series you file into it by hand**, and there is a way to pick that
folder: browse your library root at any depth, or type the path. Before, the only option was a list of
suggestions computed from the top level of the root — which on most installs holds the source names the
downloader wrote, so the only folders offered were the ones not to pick, and the one you wanted could not be
reached at all.

**Libraries may sit inside one another.** With `Manga` and `Manga/Seinen` both declared, the most specific
one wins. Removing the inner one hands its series back to `Manga`, not to the default library.

**An age rating on the library**, inherited by everything in it, so marking a shelf 18+ is one action rather
than two hundred. A single title can still be rated differently from its own page. Unrated stays visible to
everyone.

**Access from the library's side**: each row lists who can open it. Worth knowing, because it is the one way
to lock someone out by accident — a member with no limits set can open every library, including ones added
later, so granting them one changes nothing and unticking them is what narrows them to an explicit list.

**File a series by hand** from its own page, or select several on the Library page and use **Move to
library**. A series filed by hand stays put across rescans, across creating a library whose path contains it,
and across re-pathing that library. Set it back to **Automatic** to hand it to the folder rule again.

**A library's path can be edited** instead of only its name, and the Library page grows a row of tabs once
you have more than one.

No files move, nothing is deleted, and no reading progress changes. An install with one library behaves
exactly as before.

### Age ratings, so a household can include children

Mark a series with a minimum age and cap what a member's account may open. Ratings come from ComicInfo's
`AgeRating` during a scan and can be set or corrected on any series page.

**Series with no rating stay visible.** Almost nothing in a real library carries one, so hiding unrated
content would empty an account the first time you set a limit. Setting a rating opts one title *in* to being
filtered; it never opts the rest of your library out. An install with no ratings and no limits behaves
exactly as before.

### MyAnimeList and Kitsu

Alongside AniList, and you can connect more than one at a time — each syncs independently, with its own
errors and its own progress, so one service being down cannot stop another.

### Nine languages, and right-to-left

English, Spanish, French, German, Portuguese (Brazil), Russian, Japanese, Chinese and Arabic, chosen under
**Profile → Language** and remembered across your devices. Arabic mirrors the whole layout, not just the text.

Everything except English is machine-assisted and says so, in that language. Each is one JSON file with
English strings as the keys, so a correction is a one-line pull request and a missing entry falls back to
English rather than showing a placeholder.

### Bookmark a page

A star in the reader marks where you are, with a per-series list. Bookmarks are kept when a series is
hidden, the same way reading progress is: a bookmark records having read something, not where the bytes are.

### OPDS links expire

They never did. One token per account, valid forever unless you happened to regenerate it — and it is the
one credential that lives in a reader app on a phone and gets forgotten. They now last a year, the profile
page shows when one was last used, and you can revoke it.

**Existing links are not cut off.** They get a year from now, not from when they were issued.

### PDF and image EPUB

Both are read now, and both are treated as what they are: an ordered run of page images in a container, the
same as a CBZ. A PDF's pages are rendered at reading resolution, so it behaves exactly like any other
chapter -- thumbnails, the reader, offline downloads and OPDS all work without knowing the difference.

EPUB pages come out in **spine order** rather than filename order, because manga bought from a store names
its image files by an internal id that sorts wrong.

**A text ebook is still not a chapter**, and that now falls out rather than being a rule: a reflowable novel
has no images in its spine, so it yields no pages and the scanner skips it. Dropping one into your library
does nothing instead of adding something that opens to a blank screen. Uchiyomi is a manga reader, not an
ebook library, and Kavita is the better answer if you want one.

### One container

`deploy/docker-compose.aio.yml` runs Uchiyomi as a single container: the API serves the web app itself
instead of a second nginx doing it. It is now the install the README leads with.

Measured against the split layout on the same host: **238 MB instead of 385 MB**, **33 MiB of memory instead
of 41**, one less network hop on every API call, and no redirect at all on deep links -- nginx answered
`/library` with a 301 and this answers it with the page. nginx serves a static file about 0.9 ms faster,
which is the only thing it wins.

**Nothing breaks if you are already running the split layout.** It is still built, still published, still
documented, and `deploy/docker-compose.yml` is unchanged. The single-container build is additive: the same
API image serves the web app only when `WEB_ROOT` points at it.

### Discover, rebuilt

The page that adds new series was a search box on black with a ragged grid hanging off it. Production
disagreed with that design: in 48 hours there were 32 requests for "what's new on this source" and **zero**
searches. So the wall of what your sources just published is the page now, led by a full-bleed hero built
from the AniList key art the endpoint had been returning since it shipped and the page was rendering as a
144px thumbnail. Forty-five sources across thirty languages collapse to one remembered language chip. Search
survives as a field, with a way back out that it never had.

**It is also much faster.** `GET /api/sources/latest` was the only endpoint of its kind with no time limit of
its own: it inherited the adapter's, which is 30 seconds for an extension source and 95 for a site behind
FlareSolverr. The worst measured call took **63 seconds**. It is now capped at 8 seconds (`SOURCE_LATEST_TIMEOUT_MS`),
cached for ten minutes per source and page, and concurrent requests for the same page collapse into one
outbound fetch instead of six. A source that times out is recorded against its health, so it earns a cooldown
and stops being asked first. The six sources fetched are now ranked by what your library actually came from,
rather than alphabetically, which had been putting sources with no series behind them ahead of the one that
supplied 80% of the collection.

The horizontal rails have **a visible scrollbar and arrows**. They had neither, and smooth scrolling eats a
vertical wheel over a horizontal strip, so on a desktop mouse there was no way to move them at all.

### Adult sources, and who may open Discover

Two account settings that existed only in name now hold:

**A member whose age limit is below 18 cannot reach a source its extension declares adult.** It is absent
from their source list, and the server refuses it by id. The app is a static export, so hiding it in the UI
would have left the JSON one guessed URL away. This is not an edge case on a real install: on the one this
was written against, 36 of 44 enabled sources are adult. Sources that declare nothing (the built-in engines, source
packs, custom sites) count as not adult, the same way an unrated series stays visible.

**A member who may not add series no longer sees Discover.** `canDownload` was enforced on exactly one route,
the final POST, so a denied account could browse every source, search them and read full series detail, and
only met a wall on the last button. Every route behind the page refuses now, and the tab is gone.

### Also

MangaDex asks its API for English and nothing else, but declared no language, so it joined all thirty
language groups: choosing Japanese filled a third of the wall with English MangaDex rows. It declares English
now. The language chips also count **sites** rather than rows, so one site installed once per language stops
presenting itself as thirty separate choices.

Editing a series' metadata failed with "Could not save" for **every** field, not just the age rating that
made it noticeable: the statement asked for seven values and was given six, so Postgres refused it. Queries
now fail loudly at the call site when their placeholders and parameters disagree, which is how this was
found and how the next one will be.

The comparison table gained the two rows where something else does more: **reflowable EPUB**, which Kavita
reads and this deliberately does not, and **Kobo device sync**, which Komga has and this has no answer for.
An unlisted gap is worse than a listed one.

## v0.8.1 — 2026-08-23

**Upgrade if you are on v0.8.0.** Its library page listed nothing.

### The library, search and browse pages were empty

v0.8.0 made the view context the first argument of every backend method, so that a call site which forgets
it fails to compile. One call site was cast to `any` and kept the old argument order, which is the one thing
that turns that guarantee off. The arguments shifted by one, the page offset landed past the end of the
library, and the result came back empty while the total count stayed correct.

Nothing was lost and nothing needs re-scanning: the rows were always there, the query simply asked for a
page beyond them. The library, search and browse pages and the command palette all read from that one
endpoint, so all four listed nothing.

### Offline downloads, which had never worked

Downloading a chapter to read offline asks the server for a manifest first, and that route talked to Komga's
HTTP API rather than to your own library. There is no Komga in a self-hosted install, so it answered "not
found" for every chapter, from the first release onwards. It now reads your library, and refuses a series
the viewer is not allowed to see.

### Two of the three OPDS feeds

`/opds` offers "recently updated", "A–Z" and "recently added". The first and third sorted by columns the
v0.8.0 rewrite stopped selecting, so both answered a server error for everyone, admins included, and the
broken one was listed first. Only A–Z worked.

### Deep links on any port other than 80

nginx listens on port 80 inside the container, and built its own redirects from that, so visiting
`http://localhost:8080/library` was redirected to `http://localhost/library/` with the port dropped. 8080 is
the documented default. Moving around the app never noticed, because that happens in the browser, but a
bookmark, a shared link or a reload on any path landed nowhere. Redirects are now relative.

### Renaming a folder had no button

v0.8.0 added the ability to rename a series' folder on disk, documented it, and shipped no way to reach it
outside of `curl`. There is now a **Rename folder** action on the series page for admins, which shows the
server's own refusal when a folder cannot be moved, since that message names the fix.

### Also

A malformed request body returned 500 with the whole validation error, schema field names included, rather
than 400. The handler meant to prevent that was registered after the routes it was meant to cover, so it had
never applied to any of them; internal error messages were reaching clients the same way.

## v0.8.0 — 2026-08-23

**Read this one before upgrading.** The library mount changed, and a security fix closed three ways to read a
series you were not meant to see.

### Three ways to read a hidden series, closed

All three predate this release, and all three needed nothing but an id.

`/img/lib/books/:id/page/:n` resolved a file path from a book id with no join to the series at all, so a book
id alone returned **raw page bytes off disk**, including for a series that had been deleted. The OPDS
download resolved the same way. The image server verified your token and then discarded who you were, so no
image route could filter by anything. And the chapter query never referenced the series table, so a chapter
inherited no series-level rule and next/previous walked the rest of it.

The visibility rule now lives in exactly one place instead of the twenty-three hand-written copies it had
spread into, and three tests hold that line: one fails if a twenty-fourth appears, one fails if a call site
invents an all-seeing viewer, and one requires every image and OPDS route to state how it is gated.

### Several libraries, and who can see them

Split your collection into separate libraries, then choose per member which ones they can open. Libraries are
**declared, not guessed**: the obvious rule, "each top-level folder is a library", would have renamed a lot of
existing installs into libraries named after their download sources.

Nothing changes on upgrade. Everything starts in one library, no reading progress moves, and an account with
no restriction set keeps seeing everything, including libraries created later.

### It can now rename folders and delete files, if you let it

Uchiyomi can rename a series' folder and delete its chapter files. **It cannot do either unless you run it as
the user who owns your library**, which is opt-in:

```
PUID=1000    # id -u
PGID=1000    # id -g
```

Leave both unset and nothing changes: the app runs as its own uid, your library is effectively read-only, and
the startup log says so plainly along with the exact command to change it.

`PUID=1000` is the common case and works: the app does not renumber its own user, so it will not collide with
the uid the base image already uses.

Deleting a series' files requires hiding the series first, so the reversible step always happens before the
irreversible one, and it keeps every chapter row and everyone's reading progress. Renaming refuses outright
unless every folder the series occupies is writable: renaming only half of a series that spans your library
and your downloads folder would split it in two on the next scan.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

**The library mount is no longer `:ro`.** That alone grants nothing, because the app still runs as a uid that
cannot write your files, but if you relied on the read-only flag as a guarantee, add it back:

```yaml
      - ${LIBRARY_PATH:-./library}:/library:ro
```

**The container now starts as root and immediately drops privileges** to its own uid (or `PUID`). Previously
it never ran as root at all. That is the cost of being able to run as the owner of your library; the
alternative was asking you to hand your media collection over to uid 10002. The app itself never runs as
root, and `PUID=0` is refused.

One thing worth being straight about: restricting someone's library access applies immediately on the server,
but images and chapters they already viewed or downloaded may stay in their own browser's offline storage
until they clear it. The server cannot reach into a device it does not control.

## v0.7.0 — 2026-08-22

**Library management.** The honest caveat in the README used to open by conceding that Komga and Kavita were
further along here. This release is that gap, measured and closed.

### Any folder layout

The scanner read exactly two directories below your library root, so a series had to be at
`<group>/<series>/<chapter>`. Anything else was invisible: no error, no log line, just an app that started
fine and showed nothing. A folder is now a series when it directly contains chapters, at any depth, so
`One Piece/Chapter 1.cbz`, `Manga/One Piece/…` and `Comics/Manga/Author/One Piece/…` are all read without
rearranging anything.

Existing libraries are untouched. This was verified against a copy of a real 210-series, 40,506-chapter
install: zero series rows and zero chapter rows changed. Set `LIBRARY_MAX_DEPTH=2` to reproduce the old
behaviour exactly; the default is 6.

### Metadata you edit stays edited

Only title and summary could be edited. Author, publication status and genres were read from ComicInfo and
silently rewritten by every scan, and scans happen constantly. All of them are now editable and survive a
rescan, and because genres drive Browse and the recommendation rails, editing one steers those too.

Chapters can be corrected as well. Numbers are parsed from filenames by taking the first number found, so
`Vol 2 Ch 5.cbz` was chapter 2: it sorted between 1 and 3, and 2 is what a tracker was told. Numbers and
titles now have a per-chapter override.

### Filters that actually filter

The library had one filter, genre, and every other filter silently returned the entire library rather than
erroring. Read state, publication status, author and multi-genre now work, filters live in the URL so the
back button works and a view can be shared, and a filter the query cannot express says so instead of quietly
widening. The "Most chapters" sort is now "Most unread" and sorts by your real unread count.

### Bulk actions

Select several series on the Library page and mark them read or unread, favourite them, or file them into a
collection. Marking a backlog read deliberately does not write reading events, so it cannot inflate streaks,
the household leaderboard or Wrapped.

### Your tracker can no longer be walked backwards

AniList accepts a lower progress and rewrites the entry, with no undo. Anything that reduced your highest
completed chapter would quietly send the smaller number: merging two series, marking a batch unread, or
correcting a chapter number. Progress is now monotonic per series, and lowering it takes a deliberate resync
from the series page. This closed a hazard that already existed before any of the above.

### Also

The admin Art tab was broken in v0.6.0 by a query with its `WHERE` below its `ORDER BY`; fixed in v0.6.1 and
now covered by a test. Next and previous chapter compared numbers alone, so two chapters sharing a number
made "next" arbitrary and could return the chapter you were already reading.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The schema gains three tables and three columns on first boot, all additive. Nothing existing is rewritten,
and no scan re-mints anything.

## v0.6.1 — 2026-08-22

Two fixes for things a new install hits immediately.

**The admin Art tab was broken in v0.6.0.** The art overview query shipped with its `WHERE` written below
its `ORDER BY`, which Postgres rejects, so the endpoint returned a 500 and the whole Art Review gallery was
dead. It slipped out because the query lived inside a route handler and nothing in the test suite ever ran
it; it now lives in `lib/seriesArt` with a test that fails if the clause order is ever broken again.

**The documented library layout was wrong.** The README and USAGE told you to lay your library out as
`<series>/<chapter>`, but the scanner reads `<group>/<series>/<chapter>` — two levels below the library
root. Following the documentation gave you an app that started perfectly and showed an empty library, with
nothing to explain why. The docs now describe the layout the scanner actually reads, and the troubleshooting
section names this as the usual cause of an empty library.

So: `Manga/One Piece/Chapter 1.cbz` is found. `One Piece/Chapter 1.cbz` on its own is not. If your
collection is laid out the second way, wrapping it in a single folder is enough. A future release will read
any depth.

Nothing in this release changes the database.

## v0.6.0 — 2026-08-22

**Your library stops being a list of folders and starts being a list of series.** Until now a series was
whatever a folder was called, and its identity was derived from the path. Rename the folder, move it to
another disk, or let a source rename it for you, and Uchiyomi saw a brand new series: a second copy in the
library, an empty progress bar, and the one you had actually been reading stranded under a name that no
longer existed.

### Series management

- **Delete a series.** It hides rather than erases. Chapters, favourites, ratings, notes and above all your
  reading history stay attached to something real, so it is undoable and nothing silently rewrites your
  stats. A hidden series stays hidden across a rescan instead of reappearing under a new id.
- **Restore one**, exactly as it was.
- **Merge two into one**, for when the same series arrived twice from different sources. Everything the
  absorbed series held moves across, including every chapter and every progress row. Chapters that look
  like duplicates are deliberately **kept, not de-duplicated**: dropping one means folding two progress rows
  into one, and getting that wrong marks chapters unread and then syncs that outward to your AniList account,
  where it cannot be undone. Duplicate chapter numbers are untidy; lost reading progress is not recoverable.
- **Stop following a series**, or check one for new chapters on demand rather than waiting for the sweep.

### The library recognises files that moved

Chapters now carry a **content fingerprint** taken from the archive's index rather than its path, so a
renamed or relocated folder is matched back to the series it belongs to instead of being imported as a
stranger. Library ids are minted rather than derived from the path, which is what made the old behaviour
inevitable. Existing libraries are fingerprinted in the background, a slice at a time.

### Continue Reading offers the next chapter

Finishing a chapter used to remove the series from Continue Reading, and nothing put the next one in front
of you: you had to remember what you were reading and go find it, which is the one job that rail has. It now
shows the chapter you are part-way through, or the next one you have not read. A series you have finished
entirely still drops out. The rail also stopped being capped at 20, which was hiding most of a heavy
reader's list.

Also in the reader: **the manga name at the top is now a link to its series.** It was plain text, and the
back arrow beside it returns you to wherever you opened the chapter from, so from the home rail there was no
route to the series at all short of searching for it by name.

### Images stop waiting on things they already have

Covers were cached for five minutes, so most cover requests were round trips that returned a byte-identical
image. They are cached for a day now, which is safe because every way the art can change already busts the
url. Chapter thumbnails opened each archive twice, once to list it and once to read one page. Hero art warmed
one frame at a time. The disk cache walked every file every ten minutes to conclude it had nothing to do, and
its "least recently used" eviction sorted by *write* time, which a read never updates, so the first time it
filled it would have discarded the covers you look at daily and kept last night's page images.

### Your data now has referential integrity

Postgres enforces 14 foreign keys that were previously enforced by hope. Rows that already pointed at nothing
are copied into an `orphan_refs` table **before** being removed, so anything reclaimed is one `UPDATE` from
coming back rather than a restore from last night's dump.

`read_progress` deliberately does **not** cascade when a chapter is deleted. Nothing deletes chapters today,
but a cascade would have turned any future cleanup into silent, unrecoverable loss of reading history, so it
fails loudly instead and makes whoever writes that cleanup decide what should happen.

### Upgrading from v0.5.1

This release **migrates your database on first boot**, and the migration is one way. It adds columns and
foreign keys, and it moves rows that reference series or chapters which no longer exist into `orphan_refs`.
On the instance this was developed against that was 199 rows, none of them reading progress.

It is applied automatically and is safe to run, but it is the first release to change existing data rather
than only add to it, so taking a dump first is the cautious move:

```bash
docker compose exec -T uchiyomi-db pg_dump -U yomi yomi > uchiyomi-before-0.6.0.sql
docker compose pull
docker compose up -d
```

That dump contains password hashes and API tokens. Delete it once the upgrade looks right.

As always, `docker compose up -d` alone does **not** fetch a newer image. Without the `pull` you stay on the
version you already have.

## v0.5.1 — 2026-08-21

**A fresh install could not write two of its own volumes.** If you installed from
`deploy/docker-compose.yml`, this one matters and the upgrade note below is not optional.

The runtime image created and gave ownership of `/cache` and `/backups` to the app user, but not `/config`
or `/library-dl`. Docker seeds a new named volume from the image directory it covers, so a directory the
image never creates arrives owned by root — and Uchiyomi runs as an unprivileged user. Three things failed
because of it, and none of them said why:

- **every chapter download failed**, so "it also fetches new chapters" did not work at all on a first install
- **adding a site by URL returned a bare error**, because that writes `/config/sites.json`
- **the generated JWT secret could not be saved**, so a new one was made on each boot — which signed
  *everybody* out on every restart

The setup script had always fixed this itself, but it only runs if you clone the repo, which is explicitly
not the documented way to install. All four directories are now created and owned correctly in the image.

### If you installed before this release

A new image cannot fix a volume you already have: Docker never re-seeds one that exists. Do this once.

```bash
docker compose down
docker volume ls | grep uchiyomi        # confirm the names — they are prefixed by your folder
docker run --rm -v uchiyomi_config:/a -v uchiyomi_downloads:/b alpine chown -R 10002:10002 /a /b
docker compose pull
docker compose up -d
```

**On CasaOS**, the app directories are host bind mounts, which never inherit ownership from an image, so
this is a permanent requirement rather than a one-off:
`sudo chown -R 10002:10002 /DATA/AppData/uchiyomi`.

### Updating, in general

`docker compose up -d` on its own does **not** fetch a newer image — Docker reuses the `:latest` it already
has. Run `docker compose pull` first. This was never written down before, which means anyone who installed
earlier and tried to update has been sitting on their original version without knowing.

### Also

`JWT_SECRET` can now actually be set in `.env`; the install compose named it but never passed it through, so
setting it did nothing. `LIBRARY_BACKEND` had the same problem and is now a real setting rather than a
hardcoded value. And a pass over the documentation removed a set of claims that were simply untrue: an API
example that could never have worked, a 2FA recovery route that does not exist, a Node version the test suite
cannot run on, and a sources project that was never published. The route reference now matches the code
exactly — 142 documented, 142 real.

## v0.5.0 — 2026-08-20

The release that closes the gap with Mihon and Suwayomi, and one that finally shows the product.

**Mihon / Tachiyomi extensions.** Browse roughly 1,400 extensions from inside the admin panel and add one with
a click. They run on a bundled Suwayomi engine that starts with the stack and configures itself; installing an
extension switches its sources on straight away, so it is searchable from Discover immediately. Uchiyomi keeps
owning the library, reader, downloads and updates. It hosts nothing and ships no repository URL: you point it at
a repository you trust. The engine is a JVM and sits around 800 MB of RAM; set `SUWAYOMI_URL=` empty to turn the
whole feature off. See [docs/extensions.md](docs/extensions.md).

**Single sign-on.** Optional OIDC against Authentik, Authelia, Keycloak or anything else that speaks OpenID
Connect, with optional group-to-admin mapping. Strictly additional: local accounts, 2FA, lockout and session
revocation are untouched, so a provider outage cannot lock you out of your own server.

**AniList sync.** Connect your account once and finishing a chapter updates your list on its own. Progress is
the highest chapter you have *finished*, so re-reading an old one never rewinds your list, and AniList being
slow or down can never delay a page turn.

**Library health.** A new admin tab that audits the library: chapter gaps, chapters that downloaded as one or
two images, duplicate series, impossible chapter numbers, and failing sources. Each check reports what it cannot
see as well as what it found.

**Scoped API tokens.** Long-lived, revocable tokens with read / write / admin scopes, listed beside your active
sessions. An admin's token still needs the admin scope before it can touch the admin API. There is an API
reference now too, at [docs/api.md](docs/api.md).

**Also**

- Reader settings follow your account instead of the device you set them on.
- A pull-based install (`deploy/docker-compose.yml`) and a CasaOS app manifest.
- Screenshots are now generated by a committed rig (`scripts/shots/`), so they stop rotting.
- Fixed: pages served from URLs without a file extension were stored with the wrong one, which made a chapter
  download perfectly, contain every image, and read as **zero pages**. Nothing errored.
- Fixed: `migrate()` now takes an advisory lock, so two processes starting at once cannot collide.

**Nothing to migrate.** New tables and columns are created on boot. With `SUWAYOMI_URL` unset, nothing about an
existing install changes.

## v0.4.0 — 2026-08-19

**Koryomi is now Uchiyomi.**

The old name didn't work in Japanese: romanized, "Koryomi" reads as こ-りょ-み (ko-**ryo**-mi), because `ryo`
is a single mora りょ — so the よみ of 読み ("reading") never survived. That broke the link to Tachiyomi
(立ち読み) and Suwayomi that the name was meant to signal, and left the 読 mark claiming something the name
didn't say.

**Uchiyomi** (うちよみ, 内読み) keeps よみ intact and follows the convention the ecosystem already uses:
Tachiyomi is standing-reading, Suwayomi is sitting-reading, **Uchiyomi is reading at home** — which is what a
self-hosted reader is. The logo evolves to match: the same faceted 読, now sheltered under a roof.

### Nothing to migrate
Only the product name changed. `yomi` is the shared root of both names, so every stateful identifier is
untouched — the database and its volumes, the offline IndexedDB, auth cookies, saved reader preferences, OPDS
entry ids, and container names. **Existing installs upgrade in place: nobody is logged out, no reading
progress resets, no downloaded chapter is orphaned.**

### If you pull images
Images now publish to **`ghcr.io/angelosha/uchiyomi-bff`** and **`ghcr.io/angelosha/uchiyomi-web`**. GHCR does
not redirect renamed packages, so the old `koryomi-*` images stay published and keep working — update your
compose file when convenient. ~~The GitHub repo moved to `AngeloSha/uchiyomi`; the old URL redirects.~~ The
repo move is still true; the promise about the images is not.

> **Correction (2026-08-21): the `koryomi-*` packages have been deleted, and `docker pull` of them now fails.**
> Keeping them published turned out to be worse than removing them: releases only ever publish `uchiyomi-*`,
> so `koryomi-*:latest` sat frozen at v0.3.0 while still reading as "latest" to anyone running it. Point your
> compose file at `ghcr.io/angelosha/uchiyomi-bff` and `ghcr.io/angelosha/uchiyomi-web`.

## v0.3.0 — 2026-08-19

Groundwork release: don't lose your data, don't ship broken reading, and don't retype your library.

### Backups
- Nightly backup of the database and your config, rotated automatically (14 runs by default) and restorable
  with plain `psql` — no matching tool versions needed. Runs at a configurable hour, shows up in
  **Admin → Tasks** with its last run and size, and has a **Run now** button.
- Point `BACKUP_PATH` at a host directory — ideally on a different physical disk, so a dead drive doesn't
  take the backups with it. Downloaded chapters and the image cache are deliberately excluded: both are
  large and reproducible.
- Restore instructions in [docs/USAGE.md](docs/USAGE.md#11-backups--restore).

### Import
- Bring a library over from **Mihon / Tachiyomi** (`.tachibk` backup) or a **public MangaDex list**. Titles
  are parsed and shown for review first, with anything already in your library filtered out, before any
  importing starts. Pasting a plain list still works.
- Private MangaDex follows are not supported: they need an account login, which Uchiyomi doesn't ask for.

### Fixes
- **Downloads are now paced.** Every add previously spawned its own uncapped background download loop, so a
  large import meant hundreds of simultaneous downloads against a handful of sites — a good way to get your
  server blocked. All downloads now share a per-source concurrency limit and a politeness gap.
- Chapter dates: `"Chapter 12"` was being accepted as a date (December 2001) and could be stamped as a
  release date. Date parsing now requires text that actually looks like a date.

### Under the hood
- A test suite (30 tests) covering the logic that has actually broken before: the phantom-chapter guard,
  date parsing, volume vs chapter labelling, chapter ordering, hero art fitting, backup parsing, download
  pacing, and the reading-progress rules (run against a real Postgres, since they live in SQL). CI runs it
  on every pull request — previously a green build only proved the code compiled.
- Lockfiles added, so builds are reproducible.

## v0.2.1 — 2026-08-19

- Volume-based libraries read correctly: archives named as tomes (`Tome 01.cbr`, `Berserk T41`, `v01`) now
  label as **Vol. N** instead of Ch. N, and a mostly-volume series reports "N volumes". Chapter markers still
  win, so a release-version suffix like `Ch. 5 v2` stays a chapter.

## v0.2.0 — 2026-08-09

The "cinematic + convenient" release.

### Art & visuals
- Real banner art for the home hero: sharp, aspect-aware variants per device (`wide`/`tall` frames) —
  art close to the frame's shape is smart-cropped full-bleed; mismatched shapes render whole over an
  ambient blur of themselves. Pre-warmed server-side and preloaded client-side, so the hero loads instantly.
- Banner/cover backfill across the whole library from **AniList** (including banners from a manga's anime
  adaptation), **Kitsu** wide covers, and **MangaDex** high-res covers — plus an admin **Art Review** picker
  with per-series candidates.
- Hi-res cover pipeline (`?w=` variants) for detail posters and hero thumbs.

### Reader
- **Up Next**: finishing a series shows a card with related-series suggestions (both reading modes).
- **Double-page spreads** in paged mode — chapter covers solo, pairs after, RTL-aware for manga.
- **Page-preview scrubber**: dragging the progress slider shows a live thumbnail of the target page.
- Chapter dividers labeled "Up Next · {chapter}".

### Home & series
- Cinematic series page: title-over-art hero with author, status, chapter count, "Updated X ago", and
  rating badges; "More like this" rail; "Because you read {title}" rails on Home.
- Chapter release dates surfaced throughout (Updates feed sorts by them).

### Convenience
- **Ctrl+K command palette**: instant series search, quick actions, recents; live results in the top bar.
- **Collections**: create/reorder reading lists with accent colors; add from any series page; Home rail.
- **Reading history** timeline page.
- **Mark as read** (chapter / previous / whole series) and **bulk offline-download delete** (per series or all).

### Accuracy & robustness
- Chapter completions now record reliably (fast-scrolling past a last page used to miss them — this starved
  streaks and the leaderboard). Completion is retroactive on chapter-crossing, immediate on the last page,
  and server-enforced as a safety net. Re-reading a chapter no longer un-reads it.
- Offline reading progress syncs in the background; push subscriptions self-heal after browser rotation;
  the updater's first run respects the configured interval.

### Sources
- Madara engine: falls back to the manga page when a site's ajax chapter endpoint serves junk (fixes
  ManhuaPlus updates), on top of the earlier cross-title widget scoping fix.

## v0.1.0 — 2026-07-02

Initial public release.
