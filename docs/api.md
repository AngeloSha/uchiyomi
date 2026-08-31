# Uchiyomi API

Everything the web app does, it does over this API, so anything you can do in the browser you can script.

This page covers how to authenticate and the endpoints worth scripting. It is not an exhaustive dump of all
180 routes; the full list is at the bottom for reference.

## Authenticating

There are two ways in, and for scripts you want the second one.

**Session tokens** are what the web app uses: `POST /auth/login` returns a JWT that expires after 15 minutes,
refreshed with a rotating cookie. Fine for a browser, miserable for a cron job.

**API tokens** are long-lived, revocable, and scoped. Create one under **Profile → Security → API tokens**.
The token is shown once, so copy it then. It looks like `uy_` followed by random characters.

```bash
curl -H "Authorization: Bearer uy_your_token_here" https://your-server/api/home
```

### Scopes

| Scope | What it allows |
| --- | --- |
| `read` | `GET` requests only. Every token has this. |
| `write` | Anything that changes data: progress, favorites, adding series. |
| `admin` | The `/api/admin/*` endpoints. |

Scopes only ever *restrict*. An `admin`-scoped token belonging to a non-admin account still cannot reach the
admin API, and a token without `write` gets `403` on any non-`GET` request:

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
credentials it uses for the feed. `/opds/*` uses
HTTP Basic with your OPDS token as the password (**Profile → External readers**). Neither accepts API tokens.

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

`chapterCount` limits how many of the most recent chapters to grab (omit for all); `autoUpdate` enrols it in the
scheduled updater.

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
does not), and it updates extensions whose server reports an update. Everything else is reported with a
reason and a suggested fix, and admins get a push notification. Answers **409** while a sweep is running.

`PATCH /api/admin/sources/custom/:id` (admin) changes a custom site's `base` address and nothing else. The
source id is derived from its name and the library is keyed on that id, so editing in place is the only way
to follow a site to a new domain without orphaning every series that came from it.

`POST /api/sources/add` answers as soon as the outcome is decided and downloads afterwards. It used to hold
the request until the first chapter had been fetched, measured at 15 to 59 seconds on a real install.
Everything that decides the answer still happens inline and still gets its own status code: **403** disabled,
**404** `no_chapters`, **409** `duplicate` (with the "add anyway" message), and **200** with `chapters: 0`
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
rails, `POST /api/series/search`, genres, collections, favourites, updates, history, bookmarks, wrapped and
the OPDS feeds. Add `?adult=1` to a request to include it. Admins are not exempt, because this is about what
appears unasked rather than about permission -- `max_age_rating` is the permission and is unrelated.

It is deliberately **not** applied to endpoints that resolve one id you already hold: the series page, its
chapter list, `GET /api/books/:id`, its pages, the offline manifest, next/previous, `PUT
/api/books/:id/progress` and `/opds/book/:id/file` all work whether or not the library is hidden. A filter
that refused to record what you read would lose data rather than tidy a screen.

OPDS feeds have no way to pass the parameter and are always filtered. Chapter downloads still work.

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
GET    /api/offline/plan
```

### Sources
```
GET    /api/sources               GET    /api/sources/find
GET    /api/sources/detail        GET    /api/sources/search
GET    /api/sources/search-all    GET    /api/sources/latest
GET    /api/sources/jobs          POST   /api/sources/add
GET    /api/discover/trending     POST   /api/sources/fill/scan
POST   /api/sources/fill
```

**Filling a series' gaps.** `POST /api/sources/fill/scan` takes `{seriesId, altTitle?}` and answers with what
is missing, a short-lived `planId`, and every source that was checked — including the ones it refused, with
the reason and the measured overlap. `POST /api/sources/fill` then takes
`{planId, source, sourceSeriesId, numbers[]}`.

The split is deliberate. Chapter URLs never leave the server: the client names chapter NUMBERS, and only ones
that the quoted plan actually offered for that source. A chapter fetched from the wrong series would land as
`Chapter <n>.cbz` exactly where the right one belongs and look identical in every listing, so nothing is
fetched until a person has been shown which source, which title on it, and how many chapters.

```
```

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
GET    /api/notes/:seriesId       POST   /api/notes
PATCH  /api/notes/:id             DELETE /api/notes/:id
PUT    /api/ratings/:seriesId     DELETE /api/ratings/:seriesId
GET    /api/tokens                POST   /api/tokens
GET    /api/bookmarks             PUT    /api/bookmarks/:bookId/:page
DELETE /api/bookmarks/:bookId/:page
DELETE /api/tokens/:id            POST   /api/opds/token
GET    /api/opds/token            DELETE /api/opds/token
GET    /api/trackers              POST   /api/trackers/anilist
POST   /api/trackers/:provider/connect
POST   /api/trackers/anilist/backfill
POST   /api/trackers/:provider/resync/:seriesId
DELETE /api/trackers/:provider
GET    /api/push/key              POST   /api/push/subscribe
POST   /api/push/unsubscribe
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
GET    /api/admin/libraries       POST   /api/admin/libraries
GET    /api/admin/libraries/preview
GET    /api/admin/libraries/folders
PATCH  /api/admin/libraries/:id   DELETE /api/admin/libraries/:id
POST   /api/admin/series/:id/library
POST   /api/admin/series/library
GET    /api/admin/library/writable
POST   /api/admin/series/:id/delete-files
POST   /api/admin/series/:id/rename-folder
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

### Admin — extensions (Mihon / Tachiyomi)

Present only when an extension engine is configured; see [extensions.md](extensions.md).

```
GET    /api/admin/extensions/status      GET    /api/admin/extensions/catalog
POST   /api/admin/extensions/catalog/:pkgName
GET    /api/admin/extensions/repos       POST   /api/admin/extensions/repos
DELETE /api/admin/extensions/repos       POST   /api/admin/extensions/refresh
GET    /api/admin/extensions/sources     POST   /api/admin/extensions/sources/:id
```

### Images and OPDS
Cookie and HTTP Basic respectively, as described above.
```
GET    /img/series/:id/thumb      GET    /img/series/:id/backdrop
GET    /img/extensions/icon/:pkgName
GET    /img/books/:id/thumb       GET    /img/books/:id/page/:n
GET    /img/lib/series/:id/thumb  GET    /img/lib/books/:id/thumb
GET    /img/lib/books/:id/page/:n GET    /img/sources/cover
GET    /opds                      GET    /opds/series
GET    /opds/series/:id           GET    /opds/search
GET    /opds/opensearch.xml       GET    /opds/book/:id/file
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
- SSO sessions appear in **Profile → Security** as a device named "SSO" and can be revoked like any other.
- Signing in through SSO does not ask for a second factor here; your identity provider is responsible for
  that. Local password logins still use Uchiyomi's own 2FA.
