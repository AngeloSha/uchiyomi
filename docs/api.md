# Uchiyomi API

Everything the web app does, it does over this API, so anything you can do in the browser you can script.

This page covers how to authenticate and the endpoints worth scripting. It is not an exhaustive dump of
every route; the full list is at the bottom for reference, and the complete, browsable reference is served
by the app itself at **`/api/docs`** (Swagger UI, with "try it out") from
[`bff/openapi.yaml`](../bff/openapi.yaml). Both this list and that file are checked against the registered
routes in both directions by `bff/test/openapiCoverage.test.ts`, so neither can silently fall behind.

## Authenticating

There are two ways in, and for scripts you want the second one.

**Session tokens** are what the web app uses: `POST /auth/login` returns a JWT that expires after 15 minutes,
refreshed with a rotating cookie. Fine for a browser, miserable for a cron job.

**API tokens** are long-lived, revocable, and scoped. Create one under **Profile → Account → API tokens** (tap **Manage**, then **New token**).
The token is shown once, so copy it then. It looks like `uy_` followed by random characters.

```bash
curl -H "Authorization: Bearer uy_your_token_here" https://your-server/api/home
```

### Scopes

| Scope | What it allows |
| --- | --- |
| `read` | `GET` requests, plus `POST /api/series/search` — a query whose input happens to be a body. Every token has this. |
| `write` | Anything that changes data: progress, favorites, adding series. |
| `admin` | The `/api/admin/*` endpoints. |

Scopes only ever *restrict*. An `admin`-scoped token belonging to a non-admin account still cannot reach the
admin API, and a token without `write` gets `403` on any non-`GET` request other than the library search:

```json
{ "error": "forbidden", "message": "This token is read-only." }
```

Give a token the least it needs. A backup script that only reads your library should be `read`, so that a
token accidentally committed to a repo cannot delete anything.

Tokens can be given an expiry, and revoking one takes effect on the next request. Both are managed in the
same panel as your active sessions.

### Images and OPDS

`/img/*` is authorised by the `yomi_img` cookie rather than a header, because `<img>` tags can't send one — it
also accepts an OPDS token over HTTP Basic, so an OPDS reader can load covers and pages with the same
credentials it uses for the feed, **and, since v0.29.0, an API token as a Bearer**, so a third-party client
such as the Mihon extension needs one credential for the JSON and the pictures alike. A `read`-scoped token
is enough for images. `/opds/*` uses HTTP Basic with your OPDS token as the password (**Profile → External
readers**) and does not accept API tokens.

## Conventions

- Base URL is your server's origin. All paths below are absolute.
- Request and response bodies are JSON; send `Content-Type: application/json` when posting.
- List endpoints return `{ "content": [...] }`.
- Errors return a non-2xx status with `{ "error": "<code>", "message": "<human sentence>" }`.
- IDs are strings. Series and book IDs are stable; don't parse them.

## Common tasks

**What am I in the middle of?**

```bash
curl -H "Authorization: Bearer $TOK" https://your-server/api/home
```

Returns the shelves the home screen is built from, including the on-deck books with their progress.

**Mark a chapter as read**

```bash
curl -X PUT -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"page": 20, "completed": true, "silent": true}' \
  https://your-server/api/books/BOOK_ID/progress
```

`silent: true` means "this is an explicit action, not organic reading": it writes exactly what you say
(including marking something *unread*) and stays out of your reading history and streaks. Leave it off and
the write can only ever move a chapter forward to completed, never back.

If you have a tracker connected, finishing a chapter this way syncs it like any other.

**Add a series**

Two steps: find it, then add the result. Adding takes a source and that source's own id for the series, not a
URL.

```bash
# 1. find it — searches your enabled sources in order and returns {source, sourceId, title, ...}
curl -H "Authorization: Bearer $TOK" "https://your-server/api/sources/find?q=solo+leveling"

# 2. add it
curl -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"source":"mangadex","sourceId":"32d76d19-8a05-4db0-9fc2-e0b0648fe9d0","chapterCount":10,"autoUpdate":true}' \
  https://your-server/api/sources/add
```

`chapterCount` limits how many chapters to grab (omit for all). It counts from the OLDEST unless
`chapterFrom: "newest"` is sent, and whichever end it counts from the selection is downloaded ascending, so
a partial add always reads as a coherent run. With `newest`, the chapters below the selection are left to
**Find missing chapters** rather than the updater: a chapter floor is set on the series so the scheduled
sweep fetches new releases only, instead of backfilling the whole back catalogue five per night with each
new chapter queued behind it. `autoUpdate` enrols it in the scheduled updater.

`chapterFrom: "none"` (since v0.34.0) adds the series with **no chapters at all** — the dialog's "Nothing
yet — pick chapters later". The row is created and followed, the listing is written so the series page can
show what the source has, nothing is downloaded, and the chapter floor is set just above the newest listed
number (`max + 0.001`: every number the source lists today is below it, the next release is not; no floor
when the source lists nothing), so auto-update takes only chapters released after the add. Older ones can
be fetched from the series page. The row is stamped as checked — the add just asked the source — so the
series' `checkedAt` and the source's chapter count are set from the start rather than after the first
sweep, and a series removed from the library and added back this way is revived under its old id (its
favourites, notes and read marks with it). `chapterCount` is ignored, and an empty listing is not
`no_chapters` — an announced title with nothing out yet is what this is for. The answer is `{ok, title,
folder, chapters: 0, started: false, nothing: true}`; `nothing` is what tells it from "already in library",
which also answers `chapters: 0`.

`GET /api/sources` lists what you can reach: each entry carries `id`, `name`, `lang` (null when the source
declares no single language, which means it belongs to every language group), `latest` (whether it can be
browsed without a query), `popular` (whether it can offer its own popularity ranking), `used` (how many
series in the library came from it), its health `status`, and `note`.

`status` is `ok`, `disabled`, or, while a cooldown is running, one of `rate_limited` / `blocked` / `down`.
It is also `quiet`, which means the source answers without error and returns nothing: a listing that has
stopped parsing never throws, so it never earns a cooldown, and before this existed such a source kept
reporting `ok` and kept being fetched first.

`note` is one sentence saying what is wrong, or `null` when nothing is. It is written for readers, so it
never contains a hostname, a component name or any part of the recorded error. The operator-facing half of
the diagnosis, which does name containers and config files, is only on the admin routes.

`POST /api/admin/sources/:id/test` (admin) probes a source right now: it fetches the site's own homepage
directly, without the Cloudflare solver, and then exercises the adapter (search, series, chapters, pages),
returning per-step `checks`, the `probe` result and a `diagnosis`. It ignores any cooldown, which is the
point, and it deliberately writes no health of its own: a diagnostic that changed the diagnosis would let
repeated clicks drive a source's cooldown to its ceiling. A pass reports `canClear` rather than clearing the
block itself, because the smoke test stops at listing page URLs and never fetches an image byte.

`POST /api/admin/sources/check` (admin) runs the source watchdog immediately instead of waiting for its
daily sweep. It probes every enabled source and smoke-tests its adapter, one at a time because they share a
single Cloudflare solver, then returns a verdict per source. It applies only the two fixes that are
verifiable: it follows a site to a new address **after** the new one passes a smoke test (rolling back if it
does not). Everything else is reported with a reason and a suggested fix, and admins get a push notification.
Answers **409** while a sweep is running. It no longer touches extensions -- that is its own scheduled task,
below, because the engine has to re-read its repositories before "an update is available" means anything.

`PATCH /api/admin/sources/custom/:id` (admin) changes a custom site's `base` address and nothing else. The
source id is derived from its name and the library is keyed on that id, so editing in place is the only way
to follow a site to a new domain without orphaning every series that came from it.

`POST /api/sources/add` answers as soon as the outcome is decided and downloads afterwards. It used to hold
the request until the first chapter had been fetched, measured at 15 to 59 seconds on a real install.
Everything that decides the answer still happens inline and still gets its own status code: **403** disabled,
**404** `no_chapters` (also the answer when every copy the source lists is from a group blocked
server-wide), **409** `duplicate` (with the "add anyway" message), and **200** with `chapters: 0`
for a title already in the library. A successful reply now carries `started: true`, which is what
distinguishes "downloading now" from "already had it" — previously only `chapters === 0` said so.

One response is deliberately gone: the **429** `blocked` for a source refusing downloads. That can only be
known after the download is attempted, so it now arrives as a failed job carrying its reason. This is also
strictly better than before, where the 429 came back only after the whole chapter attempt had burned its
budget.

`GET /api/sources/jobs` lists downloads in progress. A finished job is swept a few minutes after it ends; a
**failed** one is never swept, because it is the only record that the download did not work, and it carries
a `reason` naming the source and how far it got. `DELETE /api/sources/jobs/<folder>` dismisses a job that
has stopped, and answers **409** for one still running.

`GET /api/sources/popular?source=<id>&page=<n>` is the same listing sorted by the source's OWN popularity,
not by anything this server computes: it is the page each site already publishes, reached with a different
sort. Every guard on the newest listing applies identically. A source that cannot offer one reports
`popular: false` and is simply not asked. Note the two listings are cached separately, so asking for one
never serves the other, and an empty *popular* page is deliberately not treated as evidence that a source's
parser has drifted, the way an empty *newest* page is.

`GET /img/sources/icon/<id>` returns a source's own icon at 64px, resolved from the extension's declared
icon or, for a site added by URL, from the site's own favicon. A source with no findable icon gets a
lettered tile rendered here rather than a 404, so clients never need a fallback and a missing icon does not
log a console error in every visitor's browser. Either answer is cached, so a source without an icon costs
one lookup rather than one per page load.

`GET /api/sources/latest?source=<id>&page=<n>` is bounded at `SOURCE_LATEST_TIMEOUT_MS` (default 8000) per
source and cached server-side for ten minutes per source and page, with concurrent requests for the same page
collapsed into one outbound fetch. A source that times out is recorded against its health and earns a
cooldown, so it stops being picked first.

Responses worth handling: **200** with `message: "already in library"` if you have that exact series already,
and **409** `duplicate` if a series with the same title came from a *different* source — retry with
`"force": true` to add the second copy anyway.

**403 on the whole `/api/sources/*` surface.** Two account settings gate these routes, and both are enforced
server-side rather than only in the app:

* A non-admin whose `canDownload` permission is off is refused on **every** route in this group, not just
  `add` — listing sources, searching, browsing newest, series detail and the job list all return `403`.
* An account whose `max_age_rating` is set below 18 cannot reach a source its extension declares adult. Such
  a source is omitted from `GET /api/sources` entirely, refused with `403` by id on `latest`, `search`,
  `detail` and `add`, and silently dropped from the `find` and `search-all` fan-outs (a fan-out has no single
  source to refuse). Sources with no adult signal at all — built-ins, packs, custom sites — count as not
  adult, the same way an unrated series stays visible.

Because these responses differ per account, do not cache them in anything shared. The app's service worker
explicitly excludes `/api/sources*` for that reason.

To add a whole *site* rather than one series, that is `POST /api/admin/sources/custom` (admin scope).

**Search everything at once**

```bash
curl -H "Authorization: Bearer $TOK" "https://your-server/api/sources/search-all?q=solo+leveling"
```

**Check the library for problems** (admin scope)

```bash
curl -H "Authorization: Bearer $TOK" https://your-server/api/admin/health
```

Returns the same checks as the admin Health tab: chapter gaps, truncated downloads, duplicate series,
impossible chapter numbers, and failing sources. Each check reports `status` (`ok`, `warn`, `problem`), a
one-line `summary`, and the individual `items`. Useful as a nightly cron that emails you only when
`status` isn't `ok`.

**Trigger a library scan** (admin scope)

```bash
curl -X POST -H "Authorization: Bearer $TOK" https://your-server/api/admin/library/scan
```

## 18+ libraries

A library whose `age_rating` is 18 or higher is left out of every **listing** endpoint by default: the home
rails, `POST /api/series/search`, genres, collections, favourites, updates, history, bookmarks, notes,
wrapped and the OPDS feeds. Add `?adult=1` to a request to include it. Admins are not exempt, because this is about what
appears unasked rather than about permission -- `max_age_rating` is the permission and is unrelated.

It is deliberately **not** applied to endpoints that resolve one id you already hold: the series page, its
chapter list, `GET /api/books/:id`, its pages, the offline manifest, next/previous, `PUT
/api/books/:id/progress` and `/opds/book/:id/file` all work whether or not the library is hidden. A filter
that refused to record what you read would lose data rather than tidy a screen.

OPDS feeds cannot pass the parameter, so the preference lives on the OPDS token instead: `PATCH
/api/opds/token { "showAdult": true }` (also a checkbox under **Profile → External readers**). Off by
default, per credential rather than per account, because the phone and the e-reader are different audiences.
Chapter downloads and page streaming work either way; the age cap is a permission and is unaffected.

`GET /api/libraries` reports `adult: true` for such a library so a client can offer the reveal, and drops
any library rated above the caller's own `max_age_rating` entirely.

## Rate limiting

The API isn't rate-limited for authenticated users, but the *sources* it fetches from are. Endpoints that
reach out to a manga site (`/api/sources/*`, `/api/admin/update`) queue behind a per-source limiter, so a
burst of requests will be slow rather than refused. Don't poll them in a tight loop.

## Full route list

Grouped by the module that serves them. Anything under `/api/admin/` needs an admin account **and** the
`admin` scope.

### Health
```
GET    /livez                     GET    /healthz
```
The two unauthenticated routes. Both answer before login exists, and they mean different things:

- **`/livez`** answers `{"ok":true}` unconditionally — is the process alive. This is what the container
  healthcheck polls, so that a database blip does not mark the whole app unhealthy.
- **`/healthz`** runs `SELECT 1` and returns **503** when Postgres is unreachable — should traffic be sent
  here. This is the one for a load balancer or an uptime monitor that should page you.

Point a reverse proxy's own health check at `/livez` if you want it to keep serving the shell during a
database outage, and at `/healthz` if you want it to take the app out of rotation instead.

### Authentication and setup
```
GET    /api/setup/status          POST   /api/setup
GET    /auth/config               POST   /auth/login
POST   /auth/register             POST   /auth/refresh
POST   /auth/logout               POST   /auth/logout-all
GET    /auth/me                   POST   /auth/password
GET    /auth/sessions             DELETE /auth/sessions/:id
POST   /auth/totp/setup           POST   /auth/totp/enable
POST   /auth/totp/disable
GET    /auth/oidc/start             GET    /auth/oidc/callback
```

### Library and reading
```
GET    /api/home                  GET    /api/featured
GET    /api/foryou                GET    /api/trending
GET    /api/random                GET    /api/genres
GET    /api/genres/overview       GET    /api/libraries
GET    /api/updates
POST   /api/updates/seen          POST   /api/refresh
GET    /api/series/:id            GET    /api/series/:id/books
GET    /api/series/:id/similar    GET    /api/series/:id/color
POST   /api/series/search         GET    /api/leaderboard
GET    /api/books/:id             GET    /api/books/:id/pages
GET    /api/books/:id/next        PUT    /api/books/:id/progress
PUT    /api/books/:id/pages/:n/junk
GET    /api/offline/plan             GET    /api/series/:id/listing
GET    /api/series/:id/groups        GET    /api/series/:id/versions
```

**Where a series and its chapters came from.** `GET /api/series/:id` carries `sources`, primary first, then
any source the series has been followed on (`POST /api/admin/series/:id/sources`, below); each entry is
`{sourceId, name, sourceSeriesId, primary, checkedAt, chapters, registered}`, where `registered` says whether
that adapter is loaded right now. Admins additionally get `scanlatorPrefs`: the series' own release
preferences, or `null` when it has none and the server-wide ones apply. Every chapter object (this route's
`books`, `GET /api/books/:id`, `next`, the home shelves) carries `scanlator` — the group that released the
file on disk, as the source showed it, a joint release reading `"A & B"` — and `sourceId`, the adapter it was
downloaded from. Both are `null` for a chapter the scanner found rather than the downloader wrote, which
includes everything downloaded before v0.31.0. The same group name is written into the file's
`ComicInfo.xml` as `<Translator>`.

Two more flags on every chapter object since v0.32.0: `owned` — the file lives in the download directory,
so it is one this server fetched and could fetch again (the only chapters the delete and re-fetch actions
below will touch) — and `pruned` — the file was deleted by the read-chapter cleanup or by an admin, and the
row is a tombstone: reading progress is still attached, but there are no pages behind it. A pruned chapter
is listed by `GET /api/series/:id/books` (with the flag) and skipped everywhere a chapter is *served*:
`next`, Continue reading, the OPDS feed, the offline plan; its download manifest answers **410** `pruned`.

**Chapters the sources have that you don't.** `GET /api/series/:id/listing` answers
`{checkedAt, content: [Ghost]}`: every chapter number the series' sources listed at the last check (the
sweep, or **Check now**) that this server has no row for, each with the reason —
`Ghost = {number, title, publishedAt, scanlator, groups, sourceId, sourceName, why, attempts?, reason?,
waitingFor?, waitDaysLeft?}`, `why` one of `missing` (not fetched yet), `held` (waiting for a preferred
group under the release preferences), `failed` (the sweep gave up after the retry cap; `attempts` says how
many tries), `blocked` (only blocked groups have released it), `floor` (below the series' Latest-N floor).
A `held` ghost also carries `waitingFor` (since v0.34.0) — the effective first-choice group it is being
held for, the series' own priority over the global one, minus anything blocked — and `waitDaysLeft`, the
whole days until the patience window closes, counted as the sweep counts it: from the oldest hosted copy
that is not from a blocked group, under today's preferences (so it can read 0 on a row the last sweep held
before a preference change; both are absent when no priority group survives the blocklist). The listing is read from what the updater
persisted, never from the sources on a page open, so `checkedAt` is how old the answer is; a source that
failed to answer leaves the previous listing standing. `reason`, the downloader's last error text, is
present for admins only. A tombstone is a row, so it is never a ghost.

**Translated by.** `GET /api/series/:id/groups` answers `{checkedAt, content: [GroupStat]}`, one entry
per scanlation group, sorted by releases descending:
`GroupStat = {name, releases, first, last, lastReleaseAt, cadence: {kind, intervalDays, daysSince, quiet},
onDisk, chapters, langs, weeks}`. `releases` counts the chapters the group released — distinct numbers across every
followed source, so a second copy of a number (a follower listing it too, a re-upload) is not a second release,
while a joint release counts once for each of its groups; `chapters` are the numbers it released, ascending, with
`first`/`last` the ends of that list; `onDisk` is how many live chapters on this server are stamped with the
group; `langs` the languages its copies are in. `cadence.kind` comes from the median gap between the group's
last ten release *days* (a day with several chapters is one release day, so a group that ships two at a time
is weekly, not daily) — `daily` (≤ 1.5 days), `weekly` (≤ 9), `monthly` (≤ 40), `irregular`, or `unknown`
with fewer than two distinct dated days — and `quiet` is true when the silence since `lastReleaseAt` exceeds
three intervals (never less than 14 days), or 45 days when the rhythm is unknown. `weeks` (since v0.34.0)
is twelve booleans, oldest first, newest last — index 11 is the seven days ending now — true for each week
the group released in, from the same dates; the series page draws them as an activity strip. Groups are
merged by the same equality the release rules use; the name shown is the first spelling seen on disk, else
the first listed. Since v0.33.0 the listing keeps *every* copy the sources list, not only the chosen one,
and this is read from those copies plus the file stamps — never from the sources on a page open, so
`checkedAt` is how old the answer is. Any account that can open the series may read it; ranking and blocking
is the admin route below.

**Chapter versions.** `GET /api/series/:id/versions` answers `{checkedAt, content: [{number, copies: [Copy]}]}`
for every listed number, `Copy = {key, source, sourceName, groups, scanlator, lang, pages, publishedAt,
chosen, blocked, onDisk}` — `key` is `<source>:<sourceId>`; `chosen` marks the copy the release rules picked
at the last check; `blocked` means every group on the copy is blocked by the effective preferences (a copy
with no groups is never blocked); `onDisk` is best effort — a live chapter for the number came from the same
source with the same group stamp, or, for a file with no stamp, this is the chosen copy. A `source` and
`sourceId` from here make a *pick* (below). A number listed before v0.33.0 has `copies: []` until its next
check.

### Sources
```
GET    /api/sources               GET    /api/sources/find
GET    /api/sources/detail        GET    /api/sources/search
GET    /api/sources/search-all    GET    /api/sources/latest
GET    /api/sources/jobs          POST   /api/sources/add
GET    /api/discover/trending     POST   /api/sources/fill/scan
POST   /api/sources/fill          POST   /api/sources/fetch
```

**Filling a series' gaps.** `POST /api/sources/fill/scan` takes `{seriesId, altTitle?}` and answers with what
is missing, a short-lived `planId`, and every source that was checked — including the ones it refused, with
the reason and the measured overlap. `POST /api/sources/fill` then takes
`{planId, source, sourceSeriesId, numbers[]}`.

The split is deliberate. Chapter URLs never leave the server: the client names chapter NUMBERS, and only ones
that the quoted plan actually offered for that source. A chapter fetched from the wrong series would land as
`Chapter <n>.cbz` exactly where the right one belongs and look identical in every listing, so nothing is
fetched until a person has been shown which source, which title on it, and how many chapters.

The scan's answer also carries `following`: the source ids the series is already followed on, so a client
can mark a candidate as followed instead of offering to follow it twice (present on the `too_few_chapters`
early answer as well). Each candidate's `count`, `first` and `last` describe one copy per chapter number,
chosen under the series' release preferences with the patience switched off, so a fill of `[n]` lands one
file even when the source lists chapter `n` from three groups. `GET /api/sources/detail` counts the same
way, under the server-wide preferences, so the "120 chapters" the add dialog shows is the 120 the add would
land and not the 200 rows the source listed. Since v0.33.0 the detail also carries `groups: [GroupStat]`
(who translates it, from the same chapter list — no second source call, `onDisk` 0) and `versions`, how many
numbers the source lists in more than one copy. Its `summary` is plain text: HTML and Markdown are stripped
(MangaDex describes in Markdown), link text kept. The same strip is applied to the description an add
writes into the ComicInfo and, since v0.34.0, to every series' `metadata.summary` on the way out of
`GET /api/series/:id` and the listings — so a series added before v0.34.0 whose stored summary still holds
`**Year:** 1997 ---` reads clean without a migration.

**Fetching ghost chapters.** `POST /api/sources/fetch {seriesId, numbers?[], picks?[]}` (at least one of
the two, at most 300 combined; numbers 0–1,000,000) fetches chapters from the listing above. What authorises a fetch is the *listing*: a client
names chapter numbers, and only a number the sources list has anything to fetch from — the same footing
as the fill plan, and for the same reason (no chapter URL ever crosses the wire). The listing is refreshed
first (a check with no downloads), so what is fetched is the copy the release rules choose *now* — a group
ranked a minute ago counts; a source that does not answer leaves the last listing standing. A `held`
number is fetched regardless of patience, because a person clicking Fetch on a "waiting for group B" row
is saying they will take it, but the blocklist is never ignored — a `blocked` number has no copy to fetch;
unblock the group and check again. A manual fetch resets the chapter's retry cap. The answer is
`{ok, started, folder, total, skipped: [{number, reason}]}` with `reason` one of `not_listed` (run
**Check for new chapters** first), `blocked_group`, `already_here` (a live chapter, not a tombstone),
`source_unavailable` (adapter not loaded or disabled, or a source the series no longer follows), `cooldown`;
**409** `nothing_to_fetch` (with `skipped`) when nothing is fetchable, **409** `busy` while a download for
that series is running, **404** for a series the caller cannot see. Same permission gate as the fill:
`canDownload: false` is refused by the whole `/api/sources` surface, and a source outside the account's
age cap answers **403**. Progress is on `GET /api/sources/jobs` under the series' `folder`.

**Picks — fetching one specific version.** `picks: [{number, source, sourceId}]` names copies out of
`GET /api/series/:id/versions` instead of numbers. A pick is authorised by a matching entry among the
number's stored copies — `not_listed` otherwise, and the skipped entry then carries the `source` and
`sourceId` asked for — and its source must be followed and available (`source_unavailable`, `cooldown`)
exactly as for a number. What a pick does *not* go through is the group rules, **the blocklist included**:
the blocklist governs what the sweep takes on its own, the versions list labels a copy `blocked`, and a
person who taps Fetch on it anyway has chosen that one copy on purpose. What a pick never overrides is
`already_here`: a live chapter for the number is replaced by the admin's re-fetch, not by a member naming
another copy. A number named in both lists is fetched as its pick; a second pick for the same number is
skipped as `duplicate` (the first was handled, this one was not). The audit line (`series.chapters_fetch`)
carries `picks`.

### Bulk actions
```
POST   /api/library/bulk/read     POST   /api/favorites/bulk
POST   /api/collections/:id/items/bulk
```
Each takes `{ seriesIds: [...] }`, up to 500. An id that no longer exists is reported in `skipped` rather
than failing the batch. Marking read deliberately writes no reading events, so importing a backlog does not
inflate streaks or the leaderboard.

### Personal
```
GET    /api/favorites             POST   /api/favorites
DELETE /api/favorites/:seriesId   GET    /api/history
GET    /api/stats                 GET    /api/wrapped
GET    /api/settings              PUT    /api/settings
GET    /api/collections           POST   /api/collections
GET    /api/collections/:id       PATCH  /api/collections/:id
DELETE /api/collections/:id       POST   /api/collections/:id/items
PUT    /api/collections/:id/items DELETE /api/collections/:id/items/:seriesId
GET    /api/notes                GET    /api/notes/:seriesId
POST   /api/notes
PATCH  /api/notes/:id             DELETE /api/notes/:id
PUT    /api/ratings/:seriesId     DELETE /api/ratings/:seriesId
GET    /api/tokens                POST   /api/tokens
GET    /api/bookmarks             PUT    /api/bookmarks/:bookId/:page
DELETE /api/bookmarks/:bookId/:page
DELETE /api/tokens/:id            POST   /api/opds/token
GET    /api/opds/token            DELETE /api/opds/token
PATCH  /api/opds/token
GET    /api/trackers              POST   /api/trackers/anilist
POST   /api/trackers/:provider/connect
POST   /api/trackers/anilist/backfill
POST   /api/trackers/:provider/resync/:seriesId
DELETE /api/trackers/:provider
GET    /api/push/key              POST   /api/push/subscribe
POST   /api/push/unsubscribe
```

### Mihon Komga extension compatibility (Komga-shaped API)

Point the Mihon Komga extension at Uchiyomi's URL, and use a personal API token (`uy_...` from
Profile → Account → Tokens) as the API key. Auth is `X-API-Key` header or HTTP Basic.
```
GET    /api/v1/libraries
GET    /api/v1/series            GET    /api/v1/series/latest
GET    /api/v1/series/{id}
GET    /api/v1/series/{id}/books GET    /api/v1/series/{id}/thumbnail
GET    /api/v1/books/{id}        GET    /api/v1/books/{id}/pages
GET    /api/v1/books/{id}/pages/{page}
GET    /api/v1/books/{id}/thumbnail
GET    /api/v1/genres            GET    /api/v1/tags
GET    /api/v1/publishers        GET    /api/v1/authors
GET    /api/v1/collections       GET    /api/v1/collections/{id}/series
GET    /api/v1/readlists
GET    /api/v2/series/{id}/read-progress/tachiyomi
PUT    /api/v2/series/{id}/read-progress/tachiyomi
```

### Offline downloads
```
GET    /api/downloads             POST   /api/downloads
DELETE /api/downloads/:bookId     GET    /api/books/:id/download-manifest
```

### Admin
```
GET    /api/admin/stats           GET    /api/admin/health
GET    /api/admin/settings        PATCH  /api/admin/settings
GET    /api/admin/install-ping/preview
GET    /api/admin/users           POST   /api/admin/users
PATCH  /api/admin/users/:id       DELETE /api/admin/users/:id
GET    /api/admin/sessions        DELETE /api/admin/sessions/:id
GET    /api/admin/audit           GET    /api/admin/tasks
POST   /api/admin/tasks/:id/run   POST   /api/admin/library/scan
POST   /api/admin/update          POST   /api/admin/update/:id
GET    /api/sources/popular      GET    /img/sources/icon/:id
DELETE /api/sources/jobs/:folder
GET    /api/admin/sources         POST   /api/admin/sources/:id/:action
POST   /api/admin/sources/:id/test
POST   /api/admin/sources/check
POST   /api/admin/sources/reload  GET    /api/admin/sources/custom
POST   /api/admin/sources/custom  DELETE /api/admin/sources/custom/:id
PATCH  /api/admin/sources/custom/:id
PUT    /api/admin/series/:id/art  PUT    /api/admin/series/:id/meta
PATCH  /api/admin/series/:id      DELETE /api/admin/series/:id
GET    /api/admin/series/:id/scanlators GET    /api/admin/scanlators
POST   /api/admin/series/:id/sources DELETE /api/admin/series/:id/sources/:sourceId
GET    /api/admin/libraries       POST   /api/admin/libraries
GET    /api/admin/libraries/preview
GET    /api/admin/libraries/folders
PATCH  /api/admin/libraries/:id   DELETE /api/admin/libraries/:id
POST   /api/admin/series/:id/library
POST   /api/admin/series/library
GET    /api/admin/library/writable
POST   /api/admin/series/:id/delete-files
POST   /api/admin/series/:id/rename-folder
POST   /api/admin/series/:id/chapters/delete POST   /api/admin/series/:id/chapters/refetch
PUT    /api/admin/books/:id/meta
POST   /api/admin/series/:id/restore
POST   /api/admin/series/:id/merge
GET    /api/admin/series/deleted
POST   /api/admin/series/:id/check
GET    /api/admin/series/:id/check
GET    /api/admin/art/overview    GET    /api/admin/art/candidates/:id
POST   /api/admin/art/backfill    GET    /api/admin/art/backfill/status
POST   /api/admin/trackers/relink GET    /api/admin/trackers/relink/status
POST   /api/admin/import          POST   /api/admin/import/parse
GET    /api/admin/import/status
```

The bulk importer's body takes `titles`, `autoUpdate`, `chapterCount` and `chapterFrom`, with the same
meaning as on `/api/sources/add` (`chapterFrom: "newest"` takes the latest N and floors the series; the
importer accepts `oldest` and `newest` only — `none` is the add dialog's).

**Scanlation groups.** When a source lists the same chapter from more than one group (MangaDex does, and
so do extension sources that carry Mihon's scanlator column), the server keeps one file per number and the
choice is made by the release preferences: `{priority: [...], blocked: [...], patienceDays}`, group names
compared case-insensitively with spaces and punctuation ignored. The server-wide set is
`scanlator_prefs` on `GET /api/admin/settings`, written whole through `PATCH /api/admin/settings
{scanlatorPrefs}` (`priority` up to 50 names, `blocked` up to 200, `patienceDays` an integer 0–30 or
`null`; the default is nothing ranked, nothing blocked, two days). A series can carry its own through
`PATCH /api/admin/series/:id`, whose body is now `{autoUpdate?, scanlatorPrefs?}` — at least one, no other
fields, each written on its own, and `scanlatorPrefs: null` clears the series' set. The two merge:
**blocked is the union**, a series **priority replaces** the global list, and a series `patienceDays` of
`null` **falls back** to the global one. A copy whose known groups are all blocked is dropped before the
choice is made — a joint release survives while any group on it is unblocked, a copy naming no group is
never blocked — so a number that only blocked groups have released is absent from the list altogether:
neither fetched nor counted as missing. A series only ever *waits* for a group when its effective priority
list is non-empty: with none, the best available copy is taken at once, so a series from a source that
names no groups is never held.

`GET /api/admin/series/:id/scanlators` is what the series page's editor reads: `{checkedAt, prefs, global,
effective: {priority, blocked, patienceDays}, groups: [GroupStat & {listed}]}`, the groups gathered from the
live files on disk, from every copy in the listing the updater persisted at the last check (primary and
followed sources alike — never from the sources themselves on a page open, so `checkedAt` is how old the
figures are), and from the names already in the preferences (so a blocked group that has vanished from the
listing can still be unblocked — as a row of zeros), sorted by `onDisk + listed` and then by name. Each entry
carries exactly the figures `GET /api/series/:id/groups` answers (one aggregator over the same rows, so the
editor is the panel with buttons); `listed` is kept and equals `releases`.

`GET /api/admin/scanlators` is the library-wide version the Settings page's group picker reads:
`{content: [{name, onDisk, listed, series}]}`, every group this server knows of, busiest first — the names
gathered from the files on disk and from the persisted listings of every source (not from the sources
themselves; this is one call for the whole library), merged by the same group equality the release rules
use, `series` counting the series the group appears on. Memoised for 30 seconds.

**Deleting a chapter from the server, and fetching it again.** Both are admin actions on chosen chapters,
and both touch the download directory only: a chapter the scanner found in the read library is never
touched (`owned: false` on the Book), on the same footing as the read-chapter cleanup. Neither takes a
typed confirmation; the client confirms with the count.
`POST /api/admin/series/:id/chapters/delete {bookIds[]}` (1–500) deletes the files and keeps the rows as
tombstones, so reading history survives and the updater does not re-download them; the cover moves to the
lowest live chapter. A chapter somebody has a bookmark in is skipped (`bookmarked`), as the cleanup skips
it: a bookmark names a page inside the file. A chapter whose file *and* folder are missing is skipped
(`unlink_failed`) rather than marked — that is the download volume not being mounted, not a deleted
chapter. It answers `{ok, applied, bytes, skipped: [{id, reason}]}` with `reason` one of `not_found`,
`not_owned`, `already_pruned`, `bookmarked`, `outside_root`, `unlink_failed`, or **409** `refused` (with
`message` and `fix`) when the download directory is not writable.
`POST /api/admin/series/:id/chapters/refetch {bookIds?[], picks?[]}` (at least one, at most 300 combined)
downloads the chapters again as the copy the release rules choose *now* — after a change of priority, or a follow, that may be another group's —
onto the **same rows**, so progress stays attached. Only a file at exactly the path the downloader writes
(`Chapter <n>.cbz` in the series folder) is eligible (`not_ours` otherwise), because only that path lands
back on the same row. The listing is refreshed first, as for `POST /api/sources/fetch`, so the copy is the
one the rules choose *now*, with the same `not_listed` / `blocked_group` / `source_unavailable` (including
a source the series no longer follows) / `cooldown` skips; the old file is set aside until
the new one lands and put back if the download fails, so a failed re-download never costs the chapter that
was there. A chapter the cleanup deleted is eligible: this is how it comes back. Answers
`{ok, started, folder, total, skipped}`, **409** `nothing_to_fetch` / `busy` / `refused` as above.
`picks: [{bookId, source, sourceId}]` replaces a row's file with *one named copy* out of the number's
versions instead of the rules' choice ("this chapter, but group B's version"): the row's number selects
the listing row, the pick selects the copy in it (`not_listed` when none matches), and as on
`POST /api/sources/fetch` a pick ignores the group rules including the blocklist — an explicit choice. A row
named in both lists is fetched as its pick, a second pick for the same row is skipped as `duplicate`; the
audit line carries `picks`.

**Following a second source.** `POST /api/admin/series/:id/sources {planId, source, sourceSeriesId}` makes
the updater merge that source's chapter list with the primary's on every check; it answers `{ok, sources}`
with the series' full source list, primary first. The candidate must come from a `POST /api/sources/fill/scan`
plan for this series and the plan must have found it followable — at least 90% of the chapter numbers
already held listed there, with a verdict of `ok` or `nothing_to_fill` — because the plan is the only place
the "same series?" judgement is made, and a bare pair would let a client follow anything it could name.
Refusals: **409** `plan_stale` (scan again), `is_primary`, `source_unavailable` (adapter not loaded or
disabled); **400** `not_in_plan`, `not_followable` (with `reason` and `coverage`), or `bad_request` when the
plan belongs to another series; **404** for an unknown series. Following the same source again updates its
series id and coverage. `DELETE /api/admin/series/:id/sources/:sourceId` stops following it (**404** when
the series was not) and answers the remaining list; chapters already downloaded from it stay, but the
listing rows it carried go at once, so its ghosts leave the series page and nothing can be fetched through
it before the next check.

With a follower in place, the updater takes each missing number from whichever followed source offers the
best copy — a ranked group first, then a hosted copy over an external link, then the primary over the
followers in the order they were added, then the earliest release — and a series whose primary is in a
cooldown still updates from a follower that answers; it is `blocked` only when every followed source is.
`GET /api/admin/series/:id/check` now reports `waiting` alongside `added`: the number of missing chapters
held back for a ranked group (omitted when none). The `frozen-series` health check lists a series whose
primary is gone but which still follows a live source as information rather than a warning.

### Admin — extensions (Mihon / Tachiyomi)

Present only when an extension engine is configured; see [extensions.md](extensions.md).

Installed extensions are kept current by a scheduled task, `extensions`, which appears in
`GET /api/admin/tasks` and can be started with `POST /api/admin/tasks/extensions/run` (answers
`{ ok: false, error: 'busy' }` while one is running, `not_configured` when there is no engine). Its interval
and kill switch are `extensionHours` and `extensionAutoUpdate` on `PATCH /api/admin/settings`, whose
response also carries `extensions_configured` -- not a column, and the only field that says whether there is
an engine at all (`extension_hours` has a default, so it is set on every install either way).

Its stored result -- `extension_last_result`, returned as the task's `lastResult` -- carries `refreshed`
(false when the repositories could not be read, with `refreshError`), `updated`, `failed`, `obsolete`,
`updatesAvailable`, `newUpstream`, `removedUpstream`, `reposRestored`, `reinstalled`, `removedOutside` and
`deferred`. A check that could not refresh reports nothing else: it deliberately does not fall back to the
stale catalogue.

`POST /api/admin/extensions/update-all` re-reads the repositories first and then applies everything, which is
the same work the scheduled check does with `forceUpdate`. It answers **409** while a check is running.

`POST /api/admin/extensions/sources/bulk` takes `{ ids?, langs?, enabled }` (at least one selector) and
switches every matching source in one statement and one registry reload, answering `changed` (rows that
actually flipped), `hiddenLangs`, `registered` and `skipped`. `langs` also records the standing preference:
a hidden language stays off when the next extension is installed, until it is shown again. `ids` do not --
turning one source back on by hand is an exception to the preference, not a change of it. A row whose
language is null is reachable only by id. `GET /api/admin/extensions/sources` carries the per-language
overview as `langs` (sources, enabled, series that came from them, hidden), unaffected by its `q`/`lang`
filters, and `GET /api/admin/extensions/status` reports `registered`, `skipped` and `cap` so the
`SUWAYOMI_MAX_SOURCES` overflow is visible rather than a line in the boot log.

```
GET    /api/admin/extensions/status      GET    /api/admin/extensions/catalog
POST   /api/admin/extensions/catalog/:pkgName
POST   /api/admin/extensions/update-all
GET    /api/admin/extensions/repos       POST   /api/admin/extensions/repos
DELETE /api/admin/extensions/repos       POST   /api/admin/extensions/refresh
GET    /api/admin/extensions/sources     POST   /api/admin/extensions/sources/:id
POST   /api/admin/extensions/sources/bulk
```

### Images and OPDS
Cookie and HTTP Basic respectively, as described above.

The OPDS catalogue is 1.2 (Atom). Two extensions ride on it, both ignorable by a reader that does not know
them:

- **Page streaming (OPDS-PSE 1.1).** Every chapter entry carries a
  `rel="http://vaemendis.net/opds-pse/stream"` link whose `href` is a template,
  `/opds/book/:id/page/{pageNumber}?maxWidth={maxWidth}`, with `pse:count` (pages), and, when this reader
  has progress in the chapter, `pse:lastRead` and `pse:lastReadDate`. `{pageNumber}` is **zero-based**, per
  the spec and the same base as `read_progress.page`. Panels, Chunky and KOReader read page by page over
  this instead of downloading the CBZ; everything else keeps using the acquisition link. Without `maxWidth`
  the original bytes are served (shared cache with the web reader); with it, a JPEG no wider than asked
  (64–2000).
- **Facets (OPDS 1.2 §7).** `/opds/series` and `/opds/search` carry `rel="http://opds-spec.org/facet"`
  links in four `opds:facetGroup`s -- Sort, Library, Genre, Status -- each with `thresholdCount` (how many
  of *your* series it leaves) and `opds:activeFacet` on the one in force. The matching query parameters are
  `sort` (`updated|title|added`), `library`, `genre` (case-insensitive) and `status`; they combine with `q`
  and with each other, and `next` links carry them. Counts come from the same gated source as the listing,
  so a genre that exists only in a library you cannot open is not listed.

`<updated>` is honest: a series carries its newest chapter's time, a chapter its own, and a feed the newest
of its entries. It used to be "now" on every fetch, which defeated readers' change detection.
```
GET    /img/series/:id/thumb      GET    /img/series/:id/backdrop
GET    /img/extensions/icon/:pkgName
GET    /img/books/:id/thumb       GET    /img/books/:id/page/:n
GET    /img/lib/series/:id/thumb  GET    /img/lib/books/:id/thumb
GET    /img/lib/books/:id/page/:n GET    /img/sources/cover
GET    /opds                      GET    /opds/series
GET    /opds/series/:id           GET    /opds/search
GET    /opds/opensearch.xml       GET    /opds/book/:id/file
GET    /opds/book/:id/page/:n
```

---

# Single sign-on (OIDC)

Uchiyomi can sign people in through an identity provider you already run: Authentik, Authelia, Keycloak,
Pocket ID, Zitadel, or any other OpenID Connect provider.

SSO is **additional**, never a replacement. Local accounts, 2FA, lockout and session revocation all keep
working exactly as before, so you are not locked out if the identity provider is down.

## Setting it up

In your identity provider, create an OAuth2/OpenID Connect application with:

- **Redirect URI**: `https://your-server/auth/oidc/callback`
- **Grant type**: authorization code (PKCE is used automatically)
- **Scopes**: `openid profile email`

Then set these on the `uchiyomi` container and restart it (`yomi-bff` if you run the development stack):

```yaml
environment:
  OIDC_ISSUER: https://auth.example.com/application/o/uchiyomi/
  OIDC_CLIENT_ID: your-client-id
  OIDC_CLIENT_SECRET: your-client-secret
  OIDC_NAME: Authentik          # the name shown on the button
```

`OIDC_ISSUER` is the base URL that serves `/.well-known/openid-configuration`. If SSO doesn't appear on the
login screen, that URL is usually the reason: fetch it yourself and check it returns JSON.

A **Continue with …** button appears on the login screen once the issuer and client id are set. Nothing else
changes until someone uses it.

## Who is allowed in

By default, signing in through the identity provider only works for people who already have a linked account
here, which is the safe default but means nobody can get in yet. Pick one of these:

```yaml
  OIDC_LINK_BY_USERNAME: "true"   # adopt the existing local account with the same username
  OIDC_ALLOW_SIGNUP: "true"       # create an account the first time someone signs in
```

`OIDC_LINK_BY_USERNAME` is what you usually want on a server whose users already exist. The first time
someone signs in through SSO, their existing account is adopted: same account, same reading progress,
favorites and history, now reachable through the identity provider as well as their password. An account
already linked to a different SSO identity is never taken over.

Optionally map admin rights from a group:

```yaml
  OIDC_ADMIN_GROUP: uchiyomi-admins
```

When set, roles follow the identity provider on every sign-in: in the group means admin here, out of it means
an ordinary user. Leave it unset to keep managing roles in the admin panel.

## Notes

- Boolean settings read the actual word, so `"false"` means false.
- The ID token's signature is verified against the issuer's published keys on every sign-in, along with its
  issuer, audience, expiry and nonce.
- SSO sessions appear in **Profile → Account** as a device named "SSO" and can be revoked like any other.
- Signing in through SSO does not ask for a second factor here; your identity provider is responsible for
  that. Local password logins still use Uchiyomi's own 2FA.
