# Changelog

## v0.9.8 — 2026-08-27

### Sources are now checked for you

A source that dies quietly stays dead. It answers with an empty page, throws no error, records nothing, and
goes on reporting itself healthy. One install ran six weeks that way: its main site, holding 189 of 215
series, had its domain quietly repurposed into an unrelated website, and the only symptom was that some dots
on Discover looked wrong.

There is now a daily check. It asks each site directly, exercises the source end to end, and writes down
what it finds. Two things it fixes by itself, because both have exactly one correct answer and both can be
verified before committing to them:

- **A site that has moved** is followed to its new address, but only after the new address proves it can
  still search, list chapters and serve pages. If it cannot, the change is rolled back. This matters more
  than it sounds: on the install this was built for, one dead site redirected to a chat community and
  another to a page serving "404 Not Found" with a success code. Both would have looked like moves.
- **Extensions with an update available** are updated.

Everything else is reported rather than acted on: a site refusing the server, a listing that has changed
shape, a host that has gone. Those need a judgement call, and disabling a source over what turns out to be a
two-hour outage is worse than leaving it be. Admins get a notification when something needs them, and
Admin, Sources, Providers has a **Check all now** button that runs the identical sweep on demand.

### Two sources repaired

Manganato-engine sites had stopped listing anything. The path the engine asked for, `/genre-all`, now
answers successfully with a page containing no series at all, which is exactly the silent failure above. It
now asks for the current listing path and keeps the old one as a fallback for sites that still serve it.

## v0.9.7 — 2026-08-27

### The trending hero shows the slides it has

v0.9.6 took the hero from five titles to ten and then hid the fact. Its position dots are drawn as a sliding
window, capped so that a long carousel cannot push the row off the side of a phone, and that cap was applied
at every screen size. The row therefore looked identical whether it held five slides or ten.

The overflow it guards against was only ever a phone problem. The window now follows the space available:
every dot on a desktop, the compact window on a phone.

## v0.9.6 — 2026-08-27

### Failing sources now say what is wrong, and what to do about it

Discover showed a dot beside each source: green when it came back with covers, grey when it did not. Grey
turned out to mean four unrelated things, and the two worth knowing about were invisible.

A source serving out a cooldown is never asked at all, so it returns an empty list and looks exactly like a
healthy source with nothing new. And an empty answer was recorded nowhere: a Cloudflare check served as an
ordinary page, or a site that had changed its layout, produced no error, so nothing was ever written down.
A source could be broken for weeks while looking merely quiet.

Both are now visible. An empty answer is counted without being treated as a failure, which matters: several
sites answer a failed check with an empty page rather than an error, and treating that as success would wipe
a cooldown that was recorded for good reason. A source that keeps answering with nothing is marked as such,
sorted below the ones that work, and says so on Discover with an estimate of when it will be tried again.

Admin, Sources, Providers gains a **Test** button. It goes and looks at the site right now, deliberately
without the Cloudflare solver in the way, then exercises the source end to end and reports which step failed.
That distinction is the whole point: a site that answers this server directly while the solver is failing is
a solver problem, not a site problem, and those two were indistinguishable before.

The reason is written in plain language with a suggested fix, rather than as the raw recorded error. Five
different faults used to record the single word "timeout".

Custom sites can finally have their address changed. Previously the only options were add and delete, and
deleting loses the link to every series that came from that source, so following a site to a new domain
meant orphaning your library.

### The Cloudflare solver stops failing silently

Chrome cannot run in Docker's default 64 MB of shared memory. It was crashing mid-check, and the app
faithfully reported that as the *sites* blocking us. The solver also leaks memory, reaching 2.5 GB after two
months here, and a bloated one fails in that same misleading way.

It now gets the memory it needs, a cap so a leak restarts it instead of degrading it, and a health check, so
"running" and "working" stop being the same thing. The health page carries it as its own line and points at
it directly when several sources fail at once and all of them blame it.

Also fixed: the health page's count of how many series depend on a source, which compared a display name to
an id and so always reported zero.

### More on the Discover hero

The trending hero rotates through ten titles instead of five, a little quicker, and preloads the next one.

Raising the number alone would have done nothing on a large library. The hero only used titles with wide
banner art, and of forty trending titles only sixteen have any; on a 215-series library just seven survived
the filter for things you do not already own. It now fills the remaining slots from titles with ordinary
cover art, which it already knew how to display.

## v0.9.5 — 2026-08-27

### Discover no longer stalls, and the language chips are gone

Switching language before the wall had finished loading left covers stuck loading, sometimes for the rest of
the session. That was a bug, not slowness.

Each source on the wall reports back when it settles. The report fires on a change, and a source that
appeared under both the old and the new language never changed: it kept its place, kept its cached answer,
and so never reported again — while the page had just forgotten it. The wall was then permanently waiting on
a source that had already answered, which is why the loading tiles never resolved, the progress bar stuck,
and scrolling for more stopped working.

Two things made it worse. Switching could fire ten requests at once instead of four. And nothing was
cancelled, so every abandoned request still cost the server its full eight-second budget — and a request that
times out puts that source on a cooldown for the next five to thirty minutes. Clicking impatiently actively
made the wall emptier.

**The language chips are removed.** They were the trigger, and the thing they were solving is better solved
by ranking: healthy sources first, then the ones your library actually came from. The source chips above the
wall are the filter now, and they still show which sources are being asked and how each one answered.

The causes are fixed separately from the trigger, since the same failure would return the moment anything
else restarted the wall. Requests are now cancelled when abandoned, so changing your mind no longer costs a
source its availability for half an hour.

Also fixed: with the add dialog open on the hero, every source that finished loading refired a search across
every source — a fan-out with a 25-second timeout each, over and over, while the wall filled in behind it.

### A sharper sign-in wall on high-DPI screens

The cover wall behind the sign-in screen looked soft on a 2K display. A screen at that pixel ratio asks for
5120 pixels of image and was handed 2560, then stretched them. There is a larger twin now, and the page picks
it only on screens that can use it — an ordinary display still takes the small one.

## v0.9.4 — 2026-08-26

### A wall of covers behind the sign-in screen

The login screen sat on a single piece of key art. It now sits behind a tilted grid of cover tiles, which is
what a manga library should look like before you have signed into it.

The tiles are cut from the art Uchiyomi already ships — the twelve genre backdrops plus the login, splash,
wrapped, hero and section pieces — at several crop positions each, because at wall scale a different crop of
one image reads as a different book. Seventeen sources give fifty-nine tiles. `scripts/login-wall.py`
composes them and is seeded, so it rebuilds the same wall every time.

**It is deliberately not your library.** The sign-in screen is pre-authentication, so anything on it is
visible to anyone who can reach your server. Feeding it real covers would serve titles and art straight past
per-library access, per-user age caps and the 18+ hide, and the service worker would then keep those covers
in a cache that survives signing out on a shared device. The wall is generated art, and the sign-in screen
still requests no images from your library at all.

Also fixed: the backdrop's entrance animation ignored `prefers-reduced-motion`. The CSS rule that handles
this everywhere else cannot reach a JavaScript animation, so that screen never honoured the setting.

## v0.9.3 — 2026-08-25

### The dependency tree answers for itself

Turning on GitHub's vulnerability alerts surfaced **49 findings** across the two lockfiles, four of them
critical. This release clears them.

**The ones that were real.** The API ran `fast-jwt` 4 — the library that verifies every login token — which
has since accumulated three critical advisories (auth bypass via an empty HMAC secret with async key
resolvers, cache confusion that can return one token's claims for another, and an algorithm-confusion fix
bypass). None of the three is reachable with Uchiyomi's configuration, which uses a static HS256 secret and
no RSA — but "not reachable today" is not an argument for keeping a known-broken verifier under the auth
system. Alongside it: `@fastify/static` (route-guard bypass via path traversal — it serves the web app in
the single container), `fastify` itself (a Content-Type parsing quirk that bypasses body validation),
`sharp` (inherited libvips CVEs — it processes untrusted images downloaded from sources), and `adm-zip`
(a crafted ZIP forcing a 4 GB allocation — it opens CBZs fetched from sources).

All of those fixes live on the far side of a framework major, so the whole family moved together:
**Fastify 4 → 5** with `@fastify/jwt` 10 (carrying `fast-jwt` 6.3), `@fastify/static` 10, and new majors of
compress, helmet, cors, cookie and rate-limit; plus `sharp` 0.35 and `adm-zip` 0.6. The entire 476-test
suite, the mounted-route wiring tests and the browser end-to-end pass unchanged on the new major — and
tokens signed by the old verifier still verify under the new one (and vice versa), so **nobody is signed
out by upgrading**, or by rolling back.

**The ones that were theoretical.** Thirty findings pointed at Next.js. The web app is a **static export**:
there is no Next server, no middleware, no Server Actions and no image optimizer running anywhere in
production, so none of those advisories was reachable. They are cleared anyway — **Next 14 → 15, React
18 → 19** — because an install page full of open advisories makes a reader do the reachability analysis
themselves. Next also vendors its own old copy of `postcss`; an override pins the patched one everywhere.

One finding remains open by necessity: `extract-zip`, a development-only dependency of the browser-test
harness, has no patched release to move to. It never ships in any image.


### The repo now runs what it ships

Cloning the repo and running `docker compose up -d` gave you the deprecated two-container split, while every
document told you the install is one container. `scripts/setup.sh` did the same, and the README offered it as
a normal alternative to the browser setup step without saying which layout it started.

`docker compose up -d` now builds **`yomi-app`** from `Dockerfile.aio` — the same single container the
released image ships and the only layout the end-to-end tests drive. The split is still there and still
buildable from source, because its images are still published on every release; it moved behind a profile:

```bash
docker compose --profile split up -d     # yomi-bff + yomi-web, on SPLIT_WEB_PORT (8081)
```

It gets its own port on purpose: the profile adds services rather than replacing them, so both would
otherwise fight over the same one.

`setup.sh` follows, and gained a guard — it refuses to run in a checkout whose `docker-compose.override.yml`
manages a service it does not, so it can no longer rebuild and restart a server's live install from the
working tree. It also chowns volumes to the configured `PUID`/`PGID` instead of a hardcoded 10002, which was
already wrong for anyone running as the owner of their library.

**`WEB_PORT` is 8080 everywhere now.** It was 3000 in the development stack and 8080 in the shipped one, and
`.env.example` hard-set the development values while `docs/USAGE.md` tells you to copy that file to point
`LIBRARY_PATH` at your library — so following the docs moved the app off the port the same page had just
told you to open, and left `PUBLIC_ORIGIN` pointing somewhere else again. Both are now commented out in
`.env.example`, so the compose default wins unless you deliberately change them.

## v0.9.2 — 2026-08-25

### The single container could not back itself up, and said nothing

**If you run the all-in-one image, your backups have been empty since v0.9.0.** `Dockerfile.aio` never
installed the Postgres client, so `pg_dump` was not in the image. `bff/Dockerfile` installs it and always
has, with a comment saying it is there for the backup task; the line was simply never carried across when
the single-container image was written.

Nothing about it was visible. The task wrote a 20-byte empty archive into a directory that looks like a
backup, logged nothing at all, and left `backup_last_result` untouched — so the admin Tasks panel kept
reporting the last run that *had* worked. On an install migrated from the split layout, that was a real
backup written by the old containers, which is about the most convincing way to be told everything is fine.

Three things changed, because the missing package was only the first of them:

- The runtime installs `postgresql16-client`, exactly as the split image does.
- **A failed dump is now recorded as a failure.** The Tasks panel shows the error, and the manual
  Backup button no longer discards it. A run that fails also deletes its own directory, so rotation cannot
  count empty archives as backups and push the last good one out of retention.
- `pg_dump` missing by name gets a message that says so, instead of an ENOENT.

The dump helper also resolved too early: an empty pipe closes cleanly and gzip still emits its header, so
"the file finished writing" was treated as "the dump succeeded". It now requires the process to have exited
0 as well.

`bff/test/aioParity.test.ts` — which exists for exactly this, "the split image did something and the single
one quietly stopped" — now holds all of it. Worth saying that the first version of that guard did not work:
both Dockerfiles *explain* why the client is installed, so searching the file matched the comment that
survives deleting the instruction. It reads only what Docker executes now.

**Check your own install:** `docker exec <container> pg_dump --version`. No output means every backup you
have taken since v0.9.0 is empty. Compare the sizes in your backup directory — a real dump is megabytes, a
broken one is 20 bytes.

### Reading progress for a chapter that no longer resolves

`PUT /api/books/:id/progress` answered **500** when it could not look the chapter up. The route fell back to
a placeholder series id, and migration `0004` had since given `read_progress` a foreign key to `lib_series` —
so that fallback could only ever violate the constraint.

The client that reaches it is the offline outbox replaying a queued page for a series deleted or merged in
the meantime. A 500 is retried forever; a **404** lets the queue drop the entry, which is what it now gets.

### One container is the install now

The docs used to present two layouts as equals, which meant three published images and a reader having to
pick before they knew anything. The single container is now the only one the instructions describe, and the
default filename went with it: `deploy/docker-compose.yml` is the single container, and the two-container
split moved to `deploy/docker-compose.split.yml`.

**The split is deprecated, not removed.** Both images are still built and still published on every release.
Nothing about a running install has stopped working, and there is no deadline. Unpublishing them while
leaving the packages in place would be the worst of both worlds: `docker compose pull` would keep succeeding
and silently freeze people on the last release with nothing to tell them, which is exactly the trap the old
`koryomi-*` packages caused.

**There is now a migration guide**, which there never was: `docs/MIGRATING.md`. Both layouts use the same
named volumes and the same Postgres image, so moving is four commands and no data is copied or converted.
The one step that is easy to miss is repointing a reverse proxy, because nothing errors: it was aimed at
`uchiyomi-web:80`, and that container no longer exists.

The CasaOS manifest ships the single container too, so its store tile stops naming a container that would
not exist. And the screenshot rig, the proxy helper and the container names in the backup-and-restore
instructions all follow the same layout the reader is being told to run.

## v0.9.1 — 2026-08-25

### The single container compresses again

Moving the web tier into the API process quietly dropped the one thing nginx was doing that nobody thinks of
as an application concern: it gzipped CSS, JS, JSON, SVG and the manifest, and because `application/json` was
in that list, every API response too. The all-in-one image had no compression plugin at all.

Measured against a real install: a cold load went from **261 KB of JS and CSS to 736 KB**. Nothing breaks, it
just gets slower, and only noticeably off your own network. Fixed with `@fastify/compress`, which also offers
brotli, which nginx never had here at all.

It also sends `Vary: Accept-Encoding`, which nginx did **not**: it ran `gzip on` with no `gzip_vary`, so a
shared cache in front of it could hand a gzipped body to a client that never asked for one. That is a real
hazard closed, not merely parity restored.

### A healthcheck that means liveness

`/healthz` runs `SELECT 1`, which is the right answer for "should traffic be sent here" and the wrong one for
a container healthcheck: the single container pointed at it, so one database blip marked the whole app
unhealthy. In the split layout nginx answered `/healthz` itself and stayed up through an outage, still
serving the shell so the app could render an error rather than the browser showing connection refused.

There is now a `/livez` that answers unconditionally, and the container healthcheck uses it. `/healthz` is
unchanged and still the readiness probe.

### Also

The repository root had no `.dockerignore`, and `Dockerfile.aio` builds from the root, so `COPY web/ ./` and
`COPY bff/ ./` copied the host's `node_modules` straight over the ones `npm ci` had just installed one layer
earlier, native modules included. Continuous integration never saw it, because a fresh checkout has none. Local
builds dragged around 790 MB of context and could produce a wrong build from a stale tree.

## v0.9.0 — 2026-08-24

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
*(That file is simply `deploy/docker-compose.yml` since 2026-08-25 — see the Unreleased section.)*

Measured against the split layout on the same host: **238 MB instead of 385 MB**, **33 MiB of memory instead
of 41**, one less network hop on every API call, and no redirect at all on deep links -- nginx answered
`/library` with a 301 and this answers it with the page. nginx serves a static file about 0.9 ms faster,
which is the only thing it wins.

**Nothing breaks if you are already running the split layout.** It is still built, still published, still
documented, and `deploy/docker-compose.yml` is unchanged. The single-container build is additive: the same
API image serves the web app only when `WEB_ROOT` points at it.

> **Correction, 2026-08-25.** Two thirds of that paragraph still hold and one no longer does. The split
> layout is still built and still published, and nothing about a running install has stopped working. It is
> no longer *documented as an equal option*: the docs now lead with the single container, and the file moved
> from `deploy/docker-compose.yml` to `deploy/docker-compose.split.yml` so the default name belongs to the
> layout the instructions actually describe. If you already downloaded the old file it keeps working — it
> pulls images by name, not by filename. See `docs/MIGRATING.md` when you want to move.

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

### An 18+ library stays off the shelf

Marking a library 18+ already capped who could open it. It now also decides what turns up unasked: such a
library is left out of the home rails, the library grid, search, browse-by-genre, collections, updates,
history, bookmarks and the OPDS feeds, and its tab is gone from the Library page. A **Show 18+** button beside
the sorts brings it back for as long as the browser is open, and hides it again by itself. The button appears
only for accounts that actually have such a library, and never for one whose own age limit is below 18.
Admins are not exempt, because this is about a tidy screen rather than about permission.

**It is not an access control**, and the distinction is the whole design. A link, a bookmark, an
offline-downloaded chapter, next-and-previous and reading progress all keep working while the library is
hidden. The alternative was tempting and wrong: the service worker flushes reading progress with the app
closed, an image tag carries no session, and an OPDS reader has no button to press, so folding this into the
access rule would have silently lost people's place in whatever they were reading.

Two long-standing gaps closed along the way. The library list had no notion of age limits at all, so a member
capped at 13 was shown the name of the 18+ shelf and a tab that could only ever be empty. And reading history
had no visibility rule whatsoever, so it kept listing the titles of series that had been deleted, merged away
or moved into a library that member no longer holds.

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
