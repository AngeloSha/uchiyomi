# Uchiyomi API

Everything the web app does, it does over this API, so anything you can do in the browser you can script.

This page covers how to authenticate and the endpoints worth scripting. It is not an exhaustive dump of all
169 routes; the full list is at the bottom for reference.

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

Responses worth handling: **200** with `message: "already in library"` if you have that exact series already,
and **409** `duplicate` if a series with the same title came from a *different* source — retry with
`"force": true` to add the second copy anyway. Adding can also be denied with **403** for a non-admin whose
`canDownload` permission is off.

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

## Rate limiting

The API isn't rate-limited for authenticated users, but the *sources* it fetches from are. Endpoints that
reach out to a manga site (`/api/sources/*`, `/api/admin/update`) queue behind a per-source limiter, so a
burst of requests will be slow rather than refused. Don't poll them in a tight loop.

## Full route list

Grouped by the module that serves them. Anything under `/api/admin/` needs an admin account **and** the
`admin` scope.

### Health
```
GET    /healthz
```
The only unauthenticated route, and what the container healthcheck polls. It answers before login exists, so
it is also the right thing to point a reverse proxy or an uptime monitor at.

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
GET    /api/libraries             GET    /api/updates
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
GET    /api/sources/status        GET    /api/sources/jobs
POST   /api/sources/add           GET    /api/discover/trending
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
GET    /api/admin/sources         POST   /api/admin/sources/:id/:action
POST   /api/admin/sources/reload  GET    /api/admin/sources/custom
POST   /api/admin/sources/custom  DELETE /api/admin/sources/custom/:id
PUT    /api/admin/series/:id/art  PUT    /api/admin/series/:id/meta
PATCH  /api/admin/series/:id      DELETE /api/admin/series/:id
GET    /api/admin/libraries       POST   /api/admin/libraries
GET    /api/admin/libraries/preview
PATCH  /api/admin/libraries/:id   DELETE /api/admin/libraries/:id
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

Then set these on the `uchiyomi-bff` container and restart it (`yomi-bff` if you run the development stack):

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
