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

**API tokens** are long-lived, revocable, and scoped. Create one under **Profile → Connections → API tokens → New token** (the form opens inline).
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
is enough for images. `/opds/*` uses HTTP Basic with your OPDS token as the password
(**Profile → Connections → External readers**) and does not accept API tokens. A disabled account's OPDS token is refused (**401**) on the feed
and on `/img/*` alike, like every other credential of a disabled account, and works again once the account
is re-enabled — the token itself is not revoked.

### The Komga-compatible surface

`/api/v1/*` and `/api/v2/*` (since v0.38.0) speak Komga's API for Mihon's Komga extension and its Komga
tracker, and take an API token three ways: `X-API-Key: uy_…` on every request (the extension's API key
field), `Authorization: Bearer uy_…` (the way the rest of the API takes it), or `Authorization: Basic` with
the token as the **password** and any username (what the extension sends after a 401 when no key is set) —
in that order of precedence, and any presented credential outranks a remembered cookie. No credential is
**401** with `WWW-Authenticate: Basic` — the extension's Basic authenticator fires on a 401 and on nothing
else. Account passwords are refused there on purpose, right or wrong: the protocol has no channel for a
two-factor code, and a password path would have walked around 2FA and the lockout. OPDS tokens and session
JWTs are refused too. Ten failed credentials from one address in five minutes (the budget `/auth/login`
has) and every further request from that address that presents a credential is **429** `too_many_requests`
with `Retry-After` until the window ends; a request with no credential and a cookie-only request are
neither counted nor blocked, and a valid key never counts. A credentialed request also sets an
`UCHIYOMI-SESSION` cookie, honoured **only by those routes**, for the tracker's requests, which carry no
credential at all; the cookie names the token row, which is re-read on every use, so revoking the token,
letting it expire or disabling the account ends the cookie on the next request, and signing out of the
web app (`POST /auth/logout`) clears it from a browser alongside the other cookies. Details under
[Komga-compatible API](#komga-compatible-api-mihons-komga-extension-and-tracker) in the route list.

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

`POST /api/admin/sources/:id/test` (admin) probes a source right now: for a source that has a homepage of
its own it fetches that homepage directly, without the Cloudflare solver, and then exercises the adapter
(search, series, chapters, pages), returning per-step `checks`, the `probe` result and a `diagnosis`.
Extension sources have no homepage to ask (the engine talks to the site, not this server), so for them the
homepage step is skipped and `probe` carries no `httpStatus`: only the adapter's own result. It ignores any cooldown, which is the
point, and it deliberately writes no health of its own: a diagnostic that changed the diagnosis would let
repeated clicks drive a source's cooldown to its ceiling. A pass reports `canClear` rather than clearing the
block itself, because the smoke test stops at listing page URLs and never fetches an image byte. The
`probe` is always present: `{httpStatus?, finalUrl?, transport?, looksHtml?, adapterOk, needsSolver}`,
where `httpStatus` is absent when no homepage request was made and `0` when one was made and no HTTP answer
came back — and a live `adapterOk: true` outranks whatever the stored error says, so an extension source
that passes its checks no longer carries a Cloudflare verdict from an earlier afternoon (PR #56). The same
rule reaches the Health page's *Source health* check: a stored error older than the source's last success is
history, not a fix to go and apply, and such a row shows only its live finding. A stored `Cloudflare bypass
currently disabled` diagnoses as `cf_challenge` (public `reason` *This source is protected by a check we
could not get past.*) with an admin `fix` that names the engine's own switch rather than Uchiyomi's solver,
by the names the shipped compose files use, never the development stack's: *The extension engine's own
Cloudflare bypass is switched off. On the Suwayomi engine's container (uchiyomi-suwayomi in the shipped
compose files) set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL to the same solver address Uchiyomi uses
(http://uchiyomi-flaresolverr:8191 in the shipped files), then recreate it. The v0.37.0 compose files
already set both, so an upgrade that recreates the engine is the fix there.* Since v0.37.0 this route and
the scheduled source check also read the source's slow streak, so `diagnosis.code` can be `too_slow`
(*This source answers, but more slowly than it is given.*) from both, not only from Discover's health view;
its `fix` names the configured `SOURCE_LATEST_TIMEOUT_MS` budget in seconds (*longer than 8s*).

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

The body may also name `alsoFollow: [{source, sourceId}]` (at most six): other sources the add dialog
already found carrying the title, to be followed for the new series when they qualify. **Admins only**: a
member's `alsoFollow` is dropped before the add, which then proceeds exactly as with none given (no
judgement, no card) — following is an admin act, as `POST /api/admin/series/:id/sources` is. No search runs
for them. Each is judged on the server once the listing exists — at once for a `chapterFrom: "none"` add,
after the first chapter lands on a download — by two rules that stand in for the plan's human
confirmation. The candidate's own title must match this series' (exact or containing, after normalisation,
alt titles included), else `title_differs`. Then its numbering: the primary must list at least three
numbers (`too_few_listed` otherwise); with an **exact** title and a primary listing at least ten, the
candidate must list at least 90% of the primary's numbers (the fill-scan rule — a copy that runs on past
the primary still qualifies); with a containing title, or a primary listing fewer than ten, the numbering
must agree **both ways** — at least 90% of the primary's numbers listed by the candidate and at least 90%
of the candidate's listed by the primary — else `numbering_differs`, so a sequel that continues past the
primary ("Tokyo Ghoul:re" 1..60 for "Tokyo Ghoul" 1..20) is refused although it lists every number, while
"(Official)" 1..22 for 1..20 (20 of 22 = 0.91) follows. The `coverage` reported for a two-way judgement is
the lower of the two shares. At most two sources are followed per series, in the order given; a follower
this path wrote has no author and reads `auto: true` on the series' sources. The results are not in the
add's answer: they land on the series' job card (below), which a `none` add gets minted for the purpose.

One response is deliberately gone: the **429** `blocked` for a source refusing downloads. That can only be
known after the download is attempted, so it now arrives as a failed job carrying its reason. This is also
strictly better than before, where the 429 came back only after the whole chapter attempt had burned its
budget.

`GET /api/sources/jobs` lists downloads in progress. A finished job is swept a few minutes after it ends; a
**failed** one is never swept, because it is the only record that the download did not work, and it carries
a `reason` naming the source and how far it got. `DELETE /api/sources/jobs/<folder>` dismisses a job that
has stopped, and answers **409** `running` for one still downloading — or one whose auto-follow judgement
is still running (`autoFollow.done === false`), since the follows would still land while the report they
belong to was gone. A card whose add named `alsoFollow` candidates carries `autoFollow: {done, results}` —
`done: false` with no results while the other sources are asked, then one entry per candidate in the order
given, `{source, name, theirTitle, followed, coverage, why}`, with `why` one of `followed`,
`numbering_differs` (under 90% of the primary's numbers listed there or, when judged both ways, under 90%
of its numbers listed here — the rule above), `title_differs`, `unreachable` (threw or timed out — never
mistaken for "lists nothing"), `too_few_listed` (the primary lists under three numbers; nothing was
asked), `not_tried` (the 90-second wall ran out first, or the judgement itself failed before any source
was asked — every candidate then reads so, rather than the card finishing with an empty list), `cap`
(already following two) or `unavailable` (the primary itself, disabled, in a cooldown, not loaded, or
outside the caller's age cap). A `none` add with candidates gets a card with `total: 0, status: "done"`
just to carry this; it lives a few minutes after the judgement ends, so a closed dialog loses nothing.

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
/api/opds/token { "showAdult": true }` (also a switch under **Profile → Connections → External readers**). Off by
default, per credential rather than per account, because the phone and the e-reader are different audiences.
Chapter downloads and page streaming work either way; the age cap is a permission and is unaffected.

`GET /api/libraries` reports `adult: true` for such a library so a client can offer the reveal, and drops
any library rated above the caller's own `max_age_rating` entirely.

The Komga-compatible API cannot pass the parameter either, so the same preference lives on the **API
token**: `POST /api/tokens { …, "showAdult": true }` (since v0.38.0; the *Include 18+ libraries* checkbox in
the mint dialog, off by default; `GET /api/tokens` rows carry `showAdult`). It decides whether 18+ libraries
appear in `/api/v1/libraries` and the series listings for that token; `/api/v1/series/:id`, its chapters,
pages and progress resolve by id whatever it says, and the age cap is a permission and is unaffected. The
flag changes nothing on `/api/*` proper, where `?adult=1` remains the reveal.

## Rate limiting

The API isn't rate-limited for authenticated users; the limits are on getting in. `POST /auth/login` takes
ten attempts per address per five minutes, `POST /api/setup` and `POST /auth/register` five per ten minutes,
and the Komga-compatible routes count failed credentials on the login budget — ten per address per five
minutes, then **429** `too_many_requests` `{message}` with `Retry-After` for every further request from that
address that presents a credential, until the window ends; requests with no credential, cookie-only
requests and valid keys are not counted. The *sources* the server fetches from are limited too: endpoints
that reach out to a manga site (`/api/sources/*`, `/api/admin/update`) queue behind a per-source limiter, so
a burst of requests will be slow rather than refused. Don't poll them in a tight loop.

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

**Two-factor enrolment is one way.** `POST /auth/totp/setup` writes a *pending* secret and answers
`{secret, otpauth, qr}`; nothing is enforced until `POST /auth/totp/enable` `{code}` confirms a code from
the app and answers the recovery codes once. While two-factor is already on, setup is **409**
`{error: 'totp_enabled', message}` and the row is not touched (since v0.39.0): the secret in the row is
the one the authenticator holds, and rotating it from a stale *Set up 2FA* button left the flag on and the
app's codes wrong. `POST /auth/totp/disable` `{password}` is the way back (**401** `wrong_password`), and
setup works again after it.

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
`{sourceId, name, sourceSeriesId, primary, checkedAt, chapters, registered, auto}`, where `registered` says
whether that adapter is loaded right now and `auto` whether the add-time auto-follow chose it rather than a
person (always `false` for the primary; a person confirming the same source through a plan turns it
`false`). Admins additionally get `scanlatorPrefs`: the series' own release
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
that series is running — since v0.37.0 that includes the series a bulk *Fetch newest* run is currently
inside, for that one series and only while the run is on it (the same test guards `/api/sources/fill` and
the admin `chapters/refetch`); the rest of the library is not locked — **404** for a series the caller
cannot see. Same permission gate as the fill:
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
POST   /api/library/bulk/newest   GET    /api/library/bulk/newest
```
The first three take `{ seriesIds: [...] }`, up to 500. An id that no longer exists is reported in `skipped`
rather than failing the batch. Marking read deliberately writes no reading events, so importing a backlog
does not inflate streaks or the leaderboard.

**Fetch newest** (since v0.37.0) is the one bulk action that fetches bytes from sources, so it is a detached
job rather than a request that waits, and it carries the download gate the whole of `/api/sources` sits
behind. `POST /api/library/bulk/newest {ids: [...]}` — 1 to 500 series ids of 1–64 characters, duplicates
counted once — starts it and answers **202** `{ok: true, total}` at once (`total` = distinct ids asked). A
member whose `canDownload` permission is off (or whose account row cannot be read — it fails closed; admins
are exempt, an absent permission allows) gets **403** `forbidden` *You don't have permission to download
chapters.*; a body that is not `ids` (the old `seriesIds` key included) is **400** `bad_request` *ids: one to
five hundred series ids.*; while a run is going, **409** `busy` *A Fetch newest run is already going. Wait
for it to finish.* — one run per server, never queued. Ids the caller cannot see (hidden, merged, in a
library they are not granted, nonexistent) are not an error: they go into the run as `skipped` *Not in your
library.* and count towards `total`. One `download.bulk_newest` audit row per start, `{count, asked}`. The
run is not refused while the nightly sweep is going (a sweep can take hours); the downloader skips a file
already on disk, so the worst overlap is one listing asked twice.

The rule, per series: take the **newest release the series' sources list** (the maximum across every
followed source, chosen by the release preferences) and nothing else. If a live row holds it the series is
`up_to_date`; if the shelf holds it only as a tombstone the read-chapter cleanup, *Delete from server* or
*Delete files* left (`pruned_reason` NULL or `'deleted'`, no live row beside it) the series is `skipped` —
those bytes went by someone's decision, and the reason names the way back — while a `'missing'` tombstone
from the verify task is not held and is fetched; otherwise that one number is fetched with the series'
*latest N* floor ignored for it alone (the floor is never moved, and nothing below it is fetched, so a
caught-up Latest-N series answers up to date rather than back-filling), the retry-cap ledger for that number
cleared first as the series page's *Fetch* does. A number held for a preferred group is honoured, not
overridden (a bulk button is not a per-copy pick); a source the account's age limit excludes, a source in a
cooldown, and a source listing nothing are each skipped with their reason. A source the admin disabled is
never asked for its listing: a series whose every source is disabled is skipped at once with no network
call, and one that also follows a live source is asked on that one only. A file already on disk without a
row is scanned in and reads up to date. Only after a source was actually asked does the job pause the
sweep's 1.5 s before the next series — ids not in the library, disabled sources and cooldowns are not
paced; one library scan runs at the end, then dates and provenance are stamped on every landed chapter.
While the run is inside a series, that series' folder reads busy to `POST /api/sources/fetch`,
`/api/sources/fill` and the admin `chapters/refetch` (**409** `busy`), and to nothing else.

`GET /api/library/bulk/newest` always answers **200** `{running, done, total, startedAt, results:
[{id, title, outcome, reason?}]}` — the current run, or the last one (in memory: a restart forgets it; before
any run everything is zero, `startedAt` null, `results` empty). `outcome` is `downloaded`, `up_to_date`,
`skipped` or `failed`; `reason` is a sentence, present on every outcome but `downloaded` (*Chapter 12 is
already here.* — a live row holds it; *Chapter 12 was already on disk and is in the library now.*; *Chapter
12 was deleted from this server on purpose. Fetch again on the series page brings it back.* — `skipped`, the
newest chapter is a cleanup or Delete-files tombstone with no live row, nothing is fetched and the tombstone
is untouched; *Chapter 12 is being held for the preferred group. Pick a copy on the series page to take it
now.*, *Its source is disabled by the admin.*, *That source is not available on this account.*, *Its source
lists no chapters.*, *No source is installed for this series.*, *Its source is in a cooldown. Try again
later.*, *Not in your library.*, *A download for that series is already running.*, *The server is shutting
down.*, *Its source did not answer.*, *Chapter 12 could not be saved. The Health page has the details.*, *The
library disk is full.*); `title` is `""` for an id outside the caller's library. `results` are in the order
the ids were given, which is the order they were started, and they are returned only to the account that
started the run and to admins — every other member gets the counts with `results: []`, since a title from a
library they were not granted must not leak through someone else's selection. A server shutdown ends the run
between series; the rest read `skipped` *The server is shutting down.*

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

**Progress trackers.** `GET /api/trackers` is the caller's own connections, every provider listed connected
or not; `POST /api/trackers/:provider/connect` takes a pasted token and `DELETE /api/trackers/:provider`
drops it. A push goes out for the caller alone when they finish a chapter of a linked series, never below
the floor `tracker_progress` holds for them (see the reviewable import under Admin, `/run`). Only a **401**
from the service — or AniList's "Invalid token" **400** — is a verdict on the token, and disables the
connection with `last_error` = `the tracker rejected the saved token -- reconnect to resume syncing`; a
**403** (Cloudflare in front of AniList, MyAnimeList's request block, a forbidden Kitsu action) is recorded
as a plain sync error and retried on the next chapter, the connection kept. A token past its `expires_at`
is not sent: `last_error` reads `the access token has expired -- reconnect to resume syncing`, connection
kept. `POST /api/trackers/:provider/resync/:seriesId` is the one deliberate way **down**: it deletes the
caller's floor for that series on **that provider** only (`anilist`, `myanimelist` or `kitsu` — any other
name is **404** `unknown_provider`) and pushes the current local count at once, lower or not. No web
control calls it; the app's own repair for a floor the tracker has since corrected is to read the list
again. A local count that drops below a number this app already sent is refused with `last_error` =
`not syncing: this series now works out to chapter N, below the M already sent. Import your list again under
Admin → Import (From your tracker) to take the tracker's current number, or ask an admin to.`

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
POST   /api/admin/series/bulk/hide
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
POST   /api/admin/series/:id/forget
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
GET    /api/admin/import/batches  POST   /api/admin/import/batches
GET    /api/admin/import/batches/:id DELETE /api/admin/import/batches/:id
POST   /api/admin/import/batches/:id/resume
POST   /api/admin/import/batches/:id/run
PATCH  /api/admin/import/candidates/:cid
```

**Server settings.** `GET /api/admin/settings` is the one row: `server_name`, `allow_registration`,
`updater_hours`, `extension_hours`, `extension_auto_update`, `update_check`, `install_ping`, `install_ping_last`,
`cleanup_read`, `cleanup_read_days`, `backup_hour`, `scanlator_prefs`, plus `extensions_configured` (computed). `PATCH
/api/admin/settings` takes any subset of `serverName` (1–64 chars), `allowRegistration`, `updaterHours`
(1–168), `extensionHours` (1–168), `extensionAutoUpdate`, `updateCheck`, `installPing`, `cleanupRead`,
`cleanupReadDays` (0–3650; 0 is a value, "at the next run"), `backupHour` (0–23, the local hour of the nightly
backup — the pending timer is re-armed at once, so the change applies to the next run rather than the one
after; `GET /api/admin/tasks` shows the backup's `schedule` as `daily at HH:00` from the same column) and
`scanlatorPrefs` (below). Each field is written on its own, an out-of-range value is a **400** and nothing is
written, and the audit row `settings.update` carries the body. The admin console's Settings tab sends one
row per PATCH as each row is changed (the read-chapter confirmation carries the day count with the switch).

The bulk importer's body takes `titles`, `autoUpdate`, `chapterCount` and `chapterFrom`, with the same
meaning as on `/api/sources/add` (`chapterFrom: "newest"` takes the latest N and floors the series; the
importer accepts `oldest` and `newest` only — `none` is the add dialog's).

**Reviewable import** (`/api/admin/import/batches*`, `/api/admin/import/candidates/:cid`) is the same idea
with a match-review step in between, and is what the admin UI uses — the plain importer above adds the
first cross-source hit with no review and stays for scripted callers. `POST .../batches` takes the same
`dataUrl`/`mangadexList`/`titles` intake as `/api/admin/import/parse`, starts matching in the background
(one batch resolves at a time server-wide) and returns `{batchId, total, truncated, skippedNovels}`. A
fourth intake, `{origin: 'tracker', tracker: 'anilist' | 'myanimelist' | 'kitsu', statuses?: ('reading' |
'plan_to_read' | 'completed' | 'on_hold' | 'dropped')[]}`, reads the requesting admin's OWN connected
account (the connection `GET /api/trackers` shows for them, never another member's; `statuses` defaults to
reading + plan_to_read) — up to 501 entries, of which the batch keeps 500 (`truncated` when the read hit the
cap); light novels are dropped and counted as `skippedNovels` — both figures are also stored on the batch
row, as `skippedNovels` and `truncated` on every batch `GET` returns; entries are deduped by their id and
by the normalised form of every name they go by, and each row carries `tracker`, `external_id`,
`alt_titles` (romaji and synonyms, at most three, never an abbreviation whose normalised form is shorter
than five characters — "AoT", "SnK", "MHA" — since such a term contains-matches almost any title) and
`progress`. The resolve pass searches the English search title on every source first, then the first
alternate on every source, and so on, so an exact hit for the title on a later source beats a weaker hit
for an alternate on an earlier one; a row matched under an alternate records it as `matched_via`. A
tracker row whose title the library already holds (under the search title or any alt — `matched_via` says
which alt, when one did) is linked at intake, for the requesting admin, and starts `decision: skip`,
`status: already`; a series that is deleted (`deleted_at`) never counts as held, for any intake, so such a
title resolves and `/run` puts the same series back — whereas a title merged into another **is** held,
under its survivor's id (since v0.37.0): the row reads `already`, and the tracker link and floor land on
the series that holds the chapters, not on the absorbed row. Merging is transitive — a title absorbed two
merges ago is re-pointed at the final survivor in the same transaction as the second merge — so a backup or
tracker entry with that spelling still reads `already` rather than being re-added via another source (a
survivor hidden since is the deleted case above under another name). Its errors: **404**
`not_connected` (no enabled connection to that tracker), **422** `token_expired` (the connection's
`expires_at` has passed: the service is not called, the connection stays enabled, and `last_error` on it
reads `the access token has expired -- reconnect to resume syncing`, the sentence a push leaves), **422**
`tracker_rejected` (the service refused the saved token; the connection is disabled with the same sentence
a rejected push leaves — 422 rather than 401 because a 401 is retried after a session refresh and would
then read `not_connected`; the same code, without disabling, when the stored token cannot be unsealed),
**502** `tracker_unavailable` (no answer; nothing changed — a 400 or a 403 from the service never disables
anything: only a 401, or AniList's "Invalid token" 400, is a verdict on the token).
`GET .../batches/:id` polls `{batch, items}` — each item's `decision` is `unresolved | auto | manual | skip`
and, once the batch leaves `resolving`, an `unresolved` row means "no match found" rather than "not looked
at yet"; a tracker row reads `linked: true` when a `series_trackers` row carries its id (read live, not
remembered). A row's
`confidence` is `same_source` only when the backup entry's own Mihon source is installed here (a Suwayomi
extension) and a hit's extension-relative path equals the url the backup stored -- Mihon's identity for a
manga, which survives a retitle -- otherwise `exact | contains | fuzzy` from the title alone; a title with no
confident hit anywhere stays `unresolved`, and the first search result is never taken. `PATCH
/api/admin/import/candidates/:cid` accepts `{decision:'manual', source, sourceId, title, coverUrl?}` to
override a pick — this clears `matched_via`, since a hand-picked match was found by nobody's alternate —
`{decision:'skip'}`, or `{decision:'auto'}` to restore the resolve pass's own suggestion after an override
(`matched_via` is left as it is, so an auto → manual → auto detour loses the note); skipping the last open
row of a batch a run has been through closes the batch (`done`).
`POST .../batches/:id/run` takes `{candidateIds?, autoUpdate?}` — with `candidateIds` it adds only those
rows (a skipped or still-unresolved id is silently left out rather than erroring; an entry that is not a
uuid, or more than 500 of them, is **400** `bad_request`), omitted means every eligible row in the batch.
Each row's `status` afterwards is `added`, `already` (the library has the title — the same folder, or the
same title from another source under a spelling the up-front `in_library` check missed) or the add's error
code (`no_title`, `no_chapters`, `disabled`, `blocked`, `undownloadable`, `disk_full`, `bad_request`, `error`);
`already` counts under the batch's `already`, an error code under `failed`. A tracker row that ends `added`
or `already` is linked to its tracker entry (`series_trackers`, `linked_by` = **the account whose list was
read**, the batch's `user_id` — batches are shared between admins, and whoever calls `/run`, the link and
the floor are the owner's; the caller appears only in the `import.batch.run` audit row, whose `detail`
carries `owner`) and the owner's `tracker_progress` for it is set to the entry's `progress` with
`pushed_at` NULL — set, not raised: every read of the list replaces the floor with the tracker's current
number and clears the stamp, whatever this app had pushed before, so re-reading the list is how a downward
correction made on the tracker reaches this app. A push then goes out once the local count **exceeds** the
floor; equal to an unstamped floor is skipped quietly (the tracker already holds that number, and a push
would say `CURRENT` over a `COMPLETED` entry), equal to a stamped one — a number this app sent — still
pushes. A `progress` of 0 seeds nothing. Every add is
"nothing yet": the
series is created and followed, no chapter is downloaded, matching the bulk-select UI's promise that "Import
selected" only moves titles into the library. Safe to call again later on the same batch — a row already
imported is never re-added, which is how importing the matched rows now and the rest (found by hand
afterwards) later both work; the batch state reads `review`, not `done`, while anything importable is still
waiting; the flip to `importing` is one conditional UPDATE, so two simultaneous calls import once (the other
answers **409** `busy`). `DELETE .../batches/:id` discards a batch outright and stops a resolve or add loop
still running for it before its next row; no batch is ever written as `cancelled`. A batch left `resolving`
by a server restart reads back with `stale: true`; `POST .../batches/:id/resume` restarts matching for
whatever is still unresolved (the progress counter restarts from the rows already settled) and takes the
one-batch guard before looking the batch up, so a `/resume` and a `POST .../batches` at the same instant
start one loop (the other answers **409** `busy`). One left `importing` by a restart is handed back on the
next GET -- `review` with its unreached rows still ready, or `done` when every row had been processed; a
`review` batch a run has been through with nothing left waiting (every remaining row skipped) is closed to
`done` on GET as well, while one nothing was ever imported through (every title already owned) stays
`review`. `GET /api/admin/import/batches` lists every batch newest first (`{content: [{id, origin, tracker,
state, total, resolved, added, already, failed, skippedNovels, truncated, created_at, updated_at, stale}]}`,
no rows; `tracker` names the service a tracker batch was read from, null otherwise; `skippedNovels` (the
novels a tracker read dropped, 0 for the other origins) and `truncated` (the intake kept 500 of a longer
list, or the tracker read hit its cap) are the intake's own answer, kept on the row so a later view of the
batch — `GET .../batches/:id` carries them on `batch` too — still shows them; `stale` as on the single
GET, so the "Open imports" card can call an interrupted batch interrupted rather than matching); a batch is
swept seven days after it last changed once `done`, thirty days while still open. A batch or candidate id
that is not a uuid answers **404**. A gzipped backup that inflates past 256 MB (no real one does) is
**422** `parse_failed` like any unreadable file.

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
onto the **same rows**, so progress stays attached. Only a row under the download folder (`not_owned`
otherwise — a read-library chapter is not Uchiyomi's to re-fetch, so a *Delete files* tombstone there has no
way back but a hand copy) at exactly the path the downloader writes (`Chapter <n>.cbz` in the series
folder; `not_ours` otherwise) is eligible, because only that path lands back on the same row. This is also
the only path back for a tombstoned chapter below a series' `chapter_floor`, which the sweep never wants
and *Fetch newest* takes only if it is the newest listed. The listing is refreshed first, as for `POST /api/sources/fetch`, so the copy is the
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

**Removing a series, and what each step keeps.** `DELETE /api/admin/series/:id` hides: `deleted_at` is set,
the tracker link dropped, and every chapter row, file, progress row, favourite and rating stays; **400**
`already_deleted` for a hidden one, **400** `merged` for a series merged into another (a merge is one-way —
there is no un-merge, and the absorbed row can neither be hidden nor have its files deleted; see
`/merge`). `POST /api/admin/series/:id/restore` undoes it. `POST /api/admin/series/bulk/hide {ids: [...]}`
(since v0.37.0; 1 to 500 ids of 1–64 characters, duplicates once) is that same single delete once per id —
the Library page's *Remove from library* over a selection — and **only** that: it never touches files. It
answers `{ok: true, hidden, skipped: [{id, reason}]}` with `reason` one of `merged`, `already_hidden`,
`not_found`; an id that cannot be hidden is skipped with its reason and the rest still apply. One
`series.delete` audit row per hidden series, carrying `{id, title, books}`, exactly as the single route
writes it, nothing for skipped ids; **400** `bad_request` *Which series should be removed?* for a body that
is not `ids`. `GET /api/admin/series/deleted` lists the hidden ones, newest first, and since v0.37.0 each row
carries `live_books` and `pruned_books` (counted from the chapter rows; `books_count` is the scan's figure
and may be stale) — `live_books === 0 && pruned_books > 0` is how the panel knows the files are already gone.

`POST /api/admin/series/:id/delete-files {confirm}` — `confirm` is the series' title, compared trimmed and
NFC-normalised on both sides (a macOS-written NFD title is confirmed by an NFC keyboard), **400**
`confirm_mismatch` otherwise — is the irreversible step and only ever after the hide: it removes the series'
chapter files from every root it occupies (the read library included, which is why it takes the typed
title) and keeps every row. Since v0.37.0 each row whose file it actually removed is marked
pruned with `pruned_reason = 'deleted'` — the same tombstone `chapters/delete` and the cleanup leave — so a
restore afterwards lists those chapters as `pruned` (*Deleted from the server*, where `chapters/refetch`
brings one back onto the same row — for the rows under the download folder; a read-library row is
`not_owned` there and its file is the admin's to put back) instead of as openable chapters that 404, the updater's have-set keeps
counting them as held, and `files` in the answer `{ok, files, bytes}` counts real unlinks, not rows (a
second call reports 0). A row whose file is already absent is reconciled only when the root is provably
mounted — `stat(root)` works, at least one chapter file of any series is present under it (a present folder
is not proof: the downloader `mkdir -p`s series folders on a bare mount point), and no more than 90 % of
what was looked at is absent, the verify task's own rule; up to 200 other series' live rows on the root are
stat'ed when none of this series' own is present. Under that proof a live row with no file is marked
`pruned_reason = 'deleted'` and a `'missing'` tombstone becomes `'deleted'`; on an unproven root every row
is left as it was, so an unmounted share leaves live rows, which Forget refuses on. `files` still counts
unlinks only, so a series whose folder was removed by hand answers `files: 0` and its Removed row then
offers Forget (`live_books` 0). Delete files on a merge survivor also removes the folders of the rows
merged into it, and every folder is resolved on every root before anything is unlinked. It refuses,
**409** `refused` `{message, fix}`, rather than half-applying: the series is not hidden yet, it has no
chapter rows on any root (*That series has no files on disk.*), a folder resolves outside the library, or a
root is not writable (`PUID`/`PGID` unset; `fix` names it). Nothing here deletes a series row or a chapter
row: `read_progress.book_id` is `ON DELETE RESTRICT` on purpose. The one route that does is the third step
below.

**Forget: Remove → Delete files → Forget.** `POST /api/admin/series/:id/forget {confirm}` (since v0.38.0;
`confirm` is the series' title, compared trimmed and NFC-normalised on both sides — **400**
`confirm_mismatch` *Type the series title exactly to confirm.* otherwise, **400** `bad_request` without a
body) is the only call that hard-deletes a
series row. It erases every member's progress, reading events, bookmarks, notes, ratings, favourites, tracker
floors and collection entries on it, so stats, streaks, the leaderboard and Wrapped change retroactively, and
answers `{ok: true, books, absorbed, users}` — chapter rows erased, series rows that had been merged into
this one and went with it, and distinct members who lose history: progress, reading events, bookmarks,
notes, favourites, ratings, collection entries, or a tracker floor that is erased rather than carried to a
merge survivor (opening the series page, the NEW-badge counter, does not count). Rows the series absorbed
by merge are forgotten with it in the same transaction (leaving them would flip them live: `merged_into` is `ON DELETE
SET NULL`). History on chapters that moved to a merge survivor is kept under the survivor: every per-user
table is re-pointed to the chapter's current series first, deletes are keyed on the chapter ids this series
actually owns, and if a progress row or bookmark on another series' chapter is still filed here after that
the whole transaction rolls back — **409** `refused` `stranded`, nothing changed. It refuses, **409**
`refused` `{message, fix}`, in exactly four other cases: `live`, while the series is still in the library
(*Remove the series first. Forgetting it is a third, separate step.*, fix *Content → Library → Remove, then
Delete files, then Forget.*); `live_books`, while any chapter row still claims a file (*N chapter row(s)
still claim(s) a file on disk. Delete the files first, or the next scan brings the series back under a new
id with none of its history.*, fix *Delete files, then Forget.*); `missing_files`, only for a root that
cannot be stat'ed (*<root> is not there right now, so nothing can be checked against it.*, fix *Mount the
library and delete the files first.*); and `folder_present`, while the folder still holds chapters under
any root (*The folder "…" still holds chapters under <root>. Forgetting the series now would only have the
next scan bring it back under a new id, with none of its history.*, fix *Delete files first, or remove the
folder by hand and rescan.* — an empty folder does not refuse, since the scanner never turns one into a
series). A `'missing'` tombstone from the verify task does not refuse: nothing in Uchiyomi marks a chapter
row whose file it cannot see — verify refuses a root with no present file, and Delete files reconciles only
under the same proof — so an unmounted share leaves every row live and the `live_books` refusal is what
stops it, whereas a `'missing'` mark means verify proved the root was mounted and the file was not on it.
There is no Put back. Audit row
`series.forget {id, title, folder, books, absorbed, absorbedIds, users, rowsByTable}`. Since the same
release, a merge also carries **bookmarks** to the survivor (they used to keep the absorbed id) and the
tracker floor keeps the higher of the two counts, so a merge made now never leaves history for Forget to
strand.

**Verify chapter files.** `POST /api/admin/tasks/verify/run` (since v0.37.0; the Tasks panel's *Verify
chapter files*) is the repair for a database restored without its chapter files. It is **detached**, like
`update` and `cleanup`: one stat per row over a network share is minutes on a large library, and a request
held open that long dies at the reverse proxy while the walk keeps going. It answers **200** `{ok: true,
started: true}` at once, or `{ok: false, error: 'busy'}` while a walk is already going; the counts are not in
the answer — they land on `GET /api/admin/tasks` (the panel polls every 5 s) as the `verify` entry's
`lastResult`, and in the audit row `library.verify {checked, missing, readLibraryMissing, unmounted, ms}`
written when the walk ends, beside the usual `task.run {task: 'verify'}` at the press. Per root it stats
every un-pruned row (both roots are walked and counted), but **only rows under the download folder**
(`/library-dl`) are marked, as pruned with `pruned_reason = 'missing'` (rows never deleted; the cover moves to
the lowest live chapter): a re-fetch lands there on the same row, whereas a read-library (`/library`) row
marked missing would be "fetched again" into a different row, the tombstone would never clear and the
number would be listed twice. A read-library row whose file is gone is counted in `readLibraryMissing` and
never marked — those files are the engine's or the admin's to put back. Per root, the **whole-batch rule**
from the read-chapter cleanup decides what a missing root means: a root where no checked row's *file* is
present — an empty folder is not proof of a mount, the downloader creates folders while a share is down —
or that cannot be read at all, is a volume that is not mounted (or an empty disk, which looks identical
from inside the container), so it marks nothing and is reported in `unmounted` as its bare path; and by
the **90 % rule** a root where more than nine rows in ten have no file is refused the same way, reported as
`"<root> (95 % of 20 chapter files missing)"`, so one stray download on a bare mount cannot turn "unmounted"
into "mark everything else" (exactly 90 % is still marked). `'missing'` is the one `pruned_reason` the
updater does **not** count as held (`pruned_at IS NULL OR pruned_reason IS DISTINCT FROM 'missing'`; NULL
is the cleanup and anything marked before v0.37.0, `'deleted'` is *Delete files*), so the next sweep — and
Fetch newest — download those chapters again onto the same rows and the scan clears the mark; a row below a
series' `chapter_floor` is outside the sweep's want-list and comes back through `chapters/refetch` only. A
row the cleanup already marked keeps its reason. It never runs at boot or on a schedule. `GET /api/admin/tasks`
always lists it: `{id: 'verify', name: 'Verify chapter files', schedule: 'on demand · after a database-only
restore', lastRun: number | null, lastResult: {ok: true, checked, missing, readLibraryMissing, unmounted:
string[], roots, ms, stopped?: 'shutdown'} | null, running}` — `checked` is rows whose file was looked for
under roots that were not skipped (both roots), `missing` the download-root rows marked this run. `lastRun`
and `lastResult` are persisted in `server_settings.verify_last_run` / `verify_last_result`, so a restart does
not turn the last run into "not run yet"; a run that threw stores a NULL result, so no stale healthy line
comes back. A shutdown stops it between batches; what it had marked stays marked, because it was true.

**Following a second source.** `POST /api/admin/series/:id/sources {planId, source, sourceSeriesId}` makes
the updater merge that source's chapter list with the primary's on every check; it answers `{ok, sources}`
with the series' full source list, primary first. The candidate must come from a `POST /api/sources/fill/scan`
plan for this series and the plan must have found it followable — at least 90% of the chapter numbers
already held listed there, with a verdict of `ok` or `nothing_to_fill`. There are two ways into a follow —
this route, and `alsoFollow` on `POST /api/sources/add`, both admin-only — and both make the "same series?"
judgement on the server, starting from that rule (`followable()` in `lib/fill.ts`): here from a plan, with
the admin looking at each candidate; there from the add's own listing plus the candidate's title, and the
numbering both ways unless the title is exact on a listing of at least ten (`lib/autoFollow.ts`, described
under the add route). Neither takes a bare pair on trust, which would let a client follow anything it
could name. Refusals: **409** `plan_stale` (scan again), `is_primary`, `source_unavailable` (adapter not
loaded or disabled); **400** `not_in_plan`, `not_followable` (with `reason` and `coverage`), or
`bad_request` when the plan belongs to another series; **404** for an unknown series. Following the same source again updates its
series id and coverage, and makes a follower the add-time path chose the confirming admin's (`auto:
false`). `DELETE /api/admin/series/:id/sources/:sourceId` stops following it (**404** when
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

**The cover proxy.** `GET /img/sources/cover?u=<url>&source=<id>&w=400|800|1600` fetches a remote cover
same-origin, resized to WebP, so a Discover tile never loads a third-party image in the browser. `u` is
caller-supplied and is fetched through the SSRF guard: a value that is not an `http(s)` URL, or that
resolves to a private, loopback, link-local or otherwise blocked address at any redirect hop (four at most),
is answered with the grey placeholder image (**200**, not cached) rather than an error, since a bad value
cannot be retried into working; a missing `u` is **400**; a genuine upstream failure is **502**, so the
client can retry the direct URL itself. The only URL fetched **without** that guard is the extension
engine's own thumbnail, `<SUWAYOMI_URL>/api/v1/manga/<id>/thumbnail` — the engine's origin is a private
address on purpose, and its covers are proxied through it. Since v0.37.0 that exemption is one path shape,
not one origin: the URL on the wire is rebuilt from the configured engine base plus the numeric manga id,
and it is fetched only if it round-trips to exactly the origin and path the caller named, so no other path
on the engine (and nothing on any other host) is ever fetched with the engine's credentials, and a redirect
from it is refused rather than followed.
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

### Komga-compatible API (Mihon's Komga extension and tracker)
```
GET    /api/v1/libraries          GET    /api/v1/series
GET    /api/v1/series/latest      GET    /api/v1/series/:id
GET    /api/v1/series/:id/books   GET    /api/v1/series/:id/thumbnail
GET    /api/v1/books              GET    /api/v1/books/:id
GET    /api/v1/books/:id/pages    GET    /api/v1/books/:id/pages/:n
GET    /api/v1/books/:id/thumbnail
GET    /api/v1/genres             GET    /api/v1/tags
GET    /api/v1/publishers         GET    /api/v1/authors
GET    /api/v1/collections        GET    /api/v1/collections/:id/series
GET    /api/v1/readlists          GET    /api/v1/readlists/:id
GET    /api/v1/readlists/:id/read-progress/tachiyomi
PUT    /api/v1/readlists/:id/read-progress/tachiyomi
GET    /api/v2/users/me
GET    /api/v2/series/:id/read-progress/tachiyomi
PUT    /api/v2/series/:id/read-progress/tachiyomi
```
Since v0.38.0. Enough of Komga's API for the keiyoushi **Komga** extension to browse and read this library
and for Mihon's **Komga tracker** to sync reading progress back — the set of `GET`s the current extension
actually calls (it uses none of Komga's newer `POST …/list` forms), plus the two tracker calls. How to set
the phone up, and what the sync can and cannot do, is in [USAGE.md](USAGE.md#the-other-direction-uchiyomi-inside-mihon-or-tachimanga)
and [extensions.md](extensions.md#komga-compatible-api); this is the wire contract.

**Authentication** is the one described under *The Komga-compatible surface* above: `X-API-Key`, then
`Authorization: Bearer`, then Basic with the token as the password, else the `UCHIYOMI-SESSION` cookie those
requests mint. Explicit beats remembered: a presented credential that does not resolve is **401** even
beside a valid cookie — `X-API-Key` *The API key is not a valid Uchiyomi API token.*, Bearer *The bearer
token is not a valid Uchiyomi API token. Account sessions are not accepted here.*, Basic *Use an Uchiyomi API
token as the password. Account passwords are not accepted here.*, any other `Authorization` scheme or no
credential *Send an Uchiyomi API token as X-API-Key, as a Bearer token, or as the HTTP Basic password.*; after
ten such failures from one address in five minutes every request from it that presents a credential is
**429** `too_many_requests` *Too many failed API keys from this address. Try again in a few minutes.* with
`Retry-After` until the window ends (no-credential and cookie-only requests are neither counted nor blocked).
A cookie that does not verify (a real Komga's `KOMGA-SESSION`, a tampered or expired value, any spelling other
than the one the server minted — `v1.<tokenId>.<exp>.<mac>`, decimal, no leading zeros) is simply "no
cookie", never a refusal on its own; a cookie that verifies but names a token that is gone — revoked,
expired, owner disabled — is **401** *This session's API token is no longer valid.* A token without `write`
browses and reads but gets **403** `forbidden` on the two `PUT`s, which is what a read-only token in the
extension looks like: nothing syncs in either direction, because Mihon retries a failed push a few times
with backoff, then gives up quietly until the next chapter read. Anything the token's account may not see
is **404**, never **403**. The cookie is set `HttpOnly; SameSite=Lax; Path=/`, `Secure` only over HTTPS (a
LAN install is plain HTTP and the WebView refuses a Secure cookie set over it), `Max-Age` = min(7 days, the
token's remaining life), no `Domain`; it is re-minted when absent, invalid, minted for another token (the
extension's key was changed to another account's — otherwise the tracker's credential-less `PUT` would keep
landing on the old account) or past half its life, and never on a 401. That re-mint needs a credentialed
request, which the API key field sends every time; with username/password the extension only presents the
password after a 401, so a changed password is not noticed while the previous cookie is valid (up to 7
days) — revoke the old token, or use the API key field. `POST /auth/logout` clears the cookie from a
browser too. Every JSON answer carries `Cache-Control: no-store`, because both clients send `max-age=600`
as a request directive against a disk cache and a cached progress `GET` could follow a `PUT`.

**Shapes.** Lists are Spring's page envelope with all nine keys — `content, empty, first, last, number`
(0-based)`, numberOfElements, size` (1–500, default 20)`, totalElements, totalPages` — because the Kotlin
client refuses a missing one, and `last` is true on the final page and on an empty one. Every DTO is padded
with every field Komga's classes declare without a default (the `*Lock` booleans, `titleSort`,
`fileLastModified`, `mediaProfile: 'DIVINA'`, …), and every string that could be null upstream is `''`:
one JSON `null` in a non-nullable field fails the decode of the whole list it sits in. On a chapter,
`sizeBytes` is the file's size on disk (`lib_books.size`; 0 when never stamped) and `size` is Komga's text
for it (`1.5 KiB`, `0 B`), which the extension shows in its default chapter name `{number} - {title}
({size})`.
Every date-time is `yyyy-MM-ddTHH:mm:ss` in UTC with no zone letter and no milliseconds — the extension
parses chapter dates strictly and a trailing `Z` or `.sss` would date every chapter at the epoch — a
required date that is not known is `1970-01-01T00:00:00`, and `releaseDate` is `yyyy-MM-dd` or null.
`metadata.status` maps the stored value, case-insensitively: *Completed*, *Complete*, *Finished*,
*Publishing finished* and *Ended* → `ENDED`; *Cancelled*, *Canceled*, *Dropped*, *Abandoned* → `ABANDONED`;
*On hiatus*, *Hiatus*, *Paused* → `HIATUS`; *Ongoing*, *Publishing*, *Releasing* → `ONGOING`; anything else
goes out upper-cased with spaces as underscores (empty stays empty), which the extension shows as *Unknown* —
never a guessed *Ongoing*. The `status` filter runs the same table the other way, so `status=ENDED` finds a
series stored as *Completed*. On a chapter, `number`, `metadata.numberSort` and
the progress endpoint's numbers are **one quantity**, the override-aware chapter number, unrounded: the
extension makes it the chapter number and Mihon compares and `PUT`s it back in that unit; `metadata.number`
is the display string. The scanlation group rides as an author with role `translator`, which the extension
turns back into the scanlator. `media.status` is `READY` for a chapter whose file is on the server and
`ERROR` for a tombstone (both `READY` under *ghost chapters* below). The full field lists are in [`openapi.yaml`](../bff/openapi.yaml) under
`KomgaSeries`, `KomgaBook`, `KomgaPageDto`, `KomgaReadProgressV2` and `KomgaUser`, and
`bff/test/komgaContract.test.ts` pins the required-field lists copied from the two clients' sources.

**Browsing.** `GET /api/v1/libraries` is the extension's log-in probe and its Libraries filter — the grants
and the age cap apply, and an 18+ library is listed only to a token minted with `showAdult` (`root` is empty,
`unavailable` false). `GET /api/v1/series` takes `search` (empty = none), `page` (0-based), `size`,
`unpaged`, `sort` (`metadata.titleSort | name | createdDate | lastModifiedDate | relevance | random`, then
`,asc|desc`; the extension's Popular is `metadata.titleSort,asc` and its Latest `lastModifiedDate,desc`;
`relevance` and anything unknown are title order), and the filters `library_id`, `status`, `genre`, `tag`,
`publisher` (the extension joins several values with commas in one parameter), `read_status`
(`UNREAD | IN_PROGRESS | READ`, repeated) and `author` (`name,role`, repeated) — both the comma-joined and
the repeated form are accepted for every one of them and flattened. `tag` filters genres and `publisher` the
author field, since that is where the DTO presents them; `status=ENDED` also matches *Completed* and
friends. A filter the query cannot express is **400** `unsupported_filter`, never silently widened.
`/api/v1/series/latest` is that list with the sort forced (PR #51 exposed it; the extension never calls it).
`GET /api/v1/series/:id` resolves by id — visible, not browsable, so a series in an 18+ library the token
does not list still answers — and carries the account's real `booksReadCount / booksUnreadCount /
booksInProgressCount`, which Mihon turns into *Unread / Reading / Completed*. `GET /api/v1/series/:id/books`
is the chapter list, ordered by the override-aware number then file; the extension asks
`unpaged=true&media_status=READY&deleted=false`, where `unpaged` is one page of everything — `size` is the
chapter count (at least 1), `number` 0, `first` and `last` true, `totalPages` 1 (0 for an empty series), and
no 500 cap, so a 600-chapter series comes back whole; the paged form (`page`, `size`) stays capped at 500 —
and `media_status=READY` leaves tombstones — chapters deleted from the server, whose page list is empty —
out of the **list** only; they still count for progress. `GET /api/v1/books/:id/pages`
numbers pages from **1**, as Komga does and as the extension puts them in the image URL, and
`GET /api/v1/books/:id/pages/:n` serves the original bytes (**400** `bad_page` below 1; `?convert=png` is
accepted and ignored), the same bytes and cache as `/img/lib/books/:id/page/:n`; the two thumbnails are the
same bytes as their `/img/lib/…/thumb` twins (`?w=800|1600` on the series cover). Every image is served
`Cache-Control: private` — the whole image cache is, since this release, because those bytes are authorised
per viewer and `public` told a shared proxy they were the same for everyone. `GET /api/v1/books` (the
extension's Books search type) is always an empty page: there is no chapter-level search. `genres` and
`authors` (each `{name, role: 'writer'}`) are real over the browsable series; `tags` and `publishers` are
`[]`; `collections`, `collections/:id/series` and `readlists` are **empty pages** on purpose — a collection
would name series this credential's cap or grants hide, and an id is a disclosure — and `readlists/:id` and
its progress are **404** in both directions. `GET /api/v2/users/me` is Komga's UserDto for the token's
account: `email` is the username, `roles` `['USER']` or `['ADMIN', 'USER']`, `sharedAllLibraries` /
`sharedLibrariesIds` from the grants, `ageRestriction` `{age, restriction: 'ALLOW_ONLY'}` from the cap or
null.

**Progress.** `GET /api/v2/series/:id/read-progress/tachiyomi` counts every chapter of the series (tombstones
included — members' history refers to them), reports `lastReadContinuousNumberSort`, the number of the last
chapter in the **leading** run of completed chapters ordered by the override-aware number (chapters 1, 2 and
4 read reports 2; nothing read reports 0, and so does a run that ends on — or starts with an unread —
number-0 chapter, which the protocol cannot express), and `maxNumberSort`, the highest chapter number;
**404** unless the series is visible to the token's account. `PUT` with `{"lastBookNumberSortRead": n}` (a
finite number from 0 to 1 000 000 000, else **400** `bad_request` *lastBookNumberSortRead must be a finite
number between 0 and 1000000000.* — the value is bound as a Postgres `real`, and 1e300 used to be a 500)
marks every not-yet-completed chapter whose number is ≤ n completed in one statement —
page moves to the chapter's page count and never backwards, chapters already completed are untouched and
nothing is ever un-marked, because the protocol has no unread — answers **204**, is idempotent, and pushes to
AniList / MyAnimeList / Kitsu once, only when something changed (Mihon `PUT`s on every bind and refresh, so a
library update of two hundred bound series would otherwise have been two hundred remote mutations). `n ≤ 0`
is a no-op **204**: a fresh bind sends `0.0`, and a chapter numbered 0 (*Extra*, *Oneshot* — any file without
a digit) must not be marked read by it; Mihon never reports a chapter it read as 0, so nothing is lost. The
first real sync (n ≥ 1) marks a number-0 chapter read on both sides, as Komga does; only the bind-time 0 is
ignored. No
reading event is written, so a sync from the phone does not count towards streaks, the leaderboard or
Wrapped, exactly like the app's own bulk mark-read. Needs the `write` scope.

**Ghost chapters** (opt-in, *Settings → Show missing chapters in Mihon*, `komgaGhostChapters`, off by
default). Mihon takes a series' chapter total from the list this API answers, so a library running the
read-chapter cleanup was telling the trackers a thousand-chapter manhwa had one chapter, and a followed
series nobody has fetched looked complete at zero. Turned on, `GET /api/v1/series/:id/books` also lists the
chapters this server does not hold: the **tombstones** it stops filtering out (`media_status=READY` no longer
excludes them), and the **ghosts** — numbers the sources listed at the last check with no chapter row at all,
from `series_listing`, whatever the reason they are absent, the chapter floor included. They are merged into
the ordinary chapter order by number, not appended.

A ghost's id is `g_<series id>_<number>` with the decimal point as `_` (chapter 10.5 is `g_s_…_10_5`); it
carries its series so the ordinary visibility gate applies to it, and a ghost id for a series the token
cannot see is **404**, like everything else. Both kinds report `media.status: READY` — the extension asks for
`READY` and filters nothing itself, so anything else would simply hide them — with `media.pagesCount` 0,
`sizeBytes` 0 and `size` the literal text **`not downloaded`**, which the default chapter-name template
`{number} - {title} ({size})` renders as *1041 - Chapter 1041 (not downloaded)* in the list, before anyone
taps it. They cannot be opened: `GET /api/v1/books/:id/pages` is `[]` for both (a tombstone's pages are gone
and a ghost never had any), so Mihon shows its own empty-chapter error, and a ghost's `pages/:n` and
`thumbnail` are **404**. Deliberately not a placeholder image — Mihon marks a chapter read once it is viewed,
which would corrupt the very progress this exists to fix.

The progress endpoint agrees with the list: a ghost counts in `booksCount`, `booksUnreadCount` and
`maxNumberSort` — that last one is the point, since it is the chapter total the tracker reports — but is
**skipped** when walking the leading run, never breaking it. It has no chapter row, so no `PUT` can ever mark
it; were it to break the run, one never-fetched chapter 5 would pin `lastReadContinuousNumberSort` at 4 for a
reader at chapter 1000 and drag the tracker back there on the next sync. Skipped, the server reports 1000 and
Mihon marks every local chapter at or below it read — the ghost rows included, which is how a chapter that is
listed but absent still shows as read on the phone. Tombstones are real rows with real progress attached and
were always counted correctly. Nothing outside `/api/v1` and `/api/v2` changes: the web app, OPDS and the
offline manifest list what is on disk exactly as before.

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
- SSO sessions appear in **Profile → Account → Active sessions** as a device named "SSO" and can be revoked like any other.
- Signing in through SSO does not ask for a second factor here; your identity provider is responsible for
  that. Local password logins still use Uchiyomi's own 2FA.
