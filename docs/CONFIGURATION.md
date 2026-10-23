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
- `TRUST_PROXY`: which peers may tell the app the visitor's address in `X-Forwarded-For` (sign-in rate limits and
  the activity log use it). The default, `loopback, linklocal, uniquelocal`, trusts a proxy on this machine, in
  Docker or on your LAN: nginx, Nginx Proxy Manager, Caddy, Traefik, an Umbrel or CasaOS app proxy, a Cloudflare
  tunnel container. A proxy on a public address, or one that reaches the server over Tailscale (`100.x`), needs
  adding, with the default names kept so a hop between it and the app on this machine or in Docker stays trusted
  (`TRUST_PROXY=loopback, linklocal, uniquelocal, 203.0.113.9`, addresses or CIDR ranges). `true` trusts every
  peer, which lets anyone who can reach the port directly choose their own address. Behind Cloudflare's proxy (the
  orange cloud) the visitor reaches you through Cloudflare's own addresses: have your reverse proxy restore the real
  address from `CF-Connecting-IP`, or add Cloudflare's published ranges the same way, or the log shows Cloudflare's.
  The default trusts every device and container on those networks too. If someone you do not trust can reach the
  app's port directly, around your proxy (another device on the LAN, another container on its Docker network), set
  `TRUST_PROXY` to your proxy's own address, so only it can say who a visitor is (`TRUST_PROXY=172.18.0.5`), or to
  `false` when there is no proxy at all. Since v0.78.1 sign-in counts wrong passwords per address and name, so the
  address the app sees is worth getting right. An entry the app cannot read (a typo like `loopbak`, a range like
  `10.0.0.0/33`) stops it at start, with a `[net]` line in `docker logs uchiyomi` naming the entry; a stray comma is
  ignored. Two values that work but rarely mean what was meant are said in the same log at every start: `true`, and a
  bare number. Some guides spell "trust one proxy" as `TRUST_PROXY=1`, but here `1` is read as the address 0.0.0.1
  and trusts no proxy at all. Unset, it can be changed in Admin -> Settings -> Server -> Home network instead (see below).
- `LOCAL_NETWORKS`: your home network, as addresses or CIDR ranges (`LOCAL_NETWORKS=192.168.1.0/24`, an IPv6 range
  beside it if your devices use one), or `none`. Profiles without a password open from these networks only: from
  anywhere else, only an account with a password (or single sign-on) gets in, and a profile without one stops working
  on the next request once a phone leaves home. Unset, the home network is set in Admin -> Settings -> Server -> Home
  network, and its default is the private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, loopback,
  link-local and their IPv6 kin), as Sonarr and Radarr read "local addresses". One thing that default cannot see: a
  proxy or a NAT that hands the app every visitor as its own private address -- a reverse proxy that does not send
  `X-Forwarded-For`, Docker Desktop's port forwarding -- puts the whole internet at home. The same page lists the
  address the server sees for you and for every signed-in device, each marked at home or outside: if a phone on mobile
  data reads "at home", write your real network there, or `none`. Write the network, not a name (`uniquelocal` is
  refused), never `0.0.0.0/0`; the app stops at start on a value it cannot read, and refuses `LOCAL_NETWORKS` together
  with `TRUST_PROXY=true`, which would let anyone claim a home address (with `TRUST_PROXY=true` and no `LOCAL_NETWORKS`,
  nobody is at home).
- **Behind a reverse proxy, name it by address** (`TRUST_PROXY=loopback, 172.18.0.5`, or on the settings page's
  *Trusted proxies*): a request that comes through a proxy counts as at home only when every proxy on its way is written
  out by address or range. The default names (`loopback`, `linklocal`, `uniquelocal`) trust every private peer, which is
  right for the activity log and the sign-in limits, but a chain of private hops -- Docker Desktop's port forwarding, a
  proxy behind a router -- would then let a visitor write their own `X-Forwarded-For` and pick a home address. Reaching
  the app's port directly from home needs nothing. The settings page names the proxy you came through when it is not
  written out, with a key that trusts it alone.
- **Through Cloudflare, nobody is at home.** A request that crossed Cloudflare's edge -- a Cloudflare Tunnel, or its
  proxy -- carries `CF-Ray` and `CF-Connecting-IP`, and counts as outside whatever address the hops after it report:
  `cloudflared` runs at home, so to the proxy behind it every visitor looks like a home address. At home, reach the app
  by its local address, or by a local DNS name that points at your proxy. Another tunnel (Tailscale Funnel, ngrok, a
  WireGuard proxy) has no such mark: with one, write your real home network instead of the private-networks default, so
  the tunnel's own address is not home.
- **Set in the environment, either one wins**: the settings page shows its value and cannot change it, so what your
  compose file says is what runs. Saved on the page, a change is in force at the next request, with no restart.
- `LOG_LEVEL` (since v0.92.0): how much the server log says (`docker logs uchiyomi`). `info` by default, a line for
  every request; `warn` keeps only warnings and errors. `debug` adds, for each series a *Find other sources* run
  looks at, the names it searched each source under, what each source answered, which result it took, and why a
  match was refused, with the chapter numbers it compared: lines that start `[find]`. Since v0.96.0 it also adds, for
  each run of *Delete read chapters*, how many read chapters are due and how many each of its rules keeps, with a few
  by title: lines that start `[cleanup]`. A value it does not know means the default.
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
- `TRANSLATE_DIR`: where the optional translation engine goes when an admin downloads it (default
  `<CONFIG_DIR>/translate`). See [Translated pages](#translated-pages).


## What leaves your server

Two things can, they are separate switches, and they go to different places. Both live in
**Admin → Settings → Server** (`/admin/?tab=Settings`), each with a fold that spells out what it sends.

**Check for updates** — *on by default.* Once a day the server asks GitHub whether a newer Uchiyomi has been
released and shows the answer under Admin → Health. It is a `GET` of a public releases page: GitHub sees your
IP address, exactly as it would if you opened that page in a browser, and nothing else. Nothing about your
install is sent. Being a version behind is never treated as a fault — it will not turn anything amber.

When **Fix everything** has to try extensions (since v0.55.1), it ranks them by how often each is downloaded: at most
once a day it reads the public releases list of the repository your extensions come from on GitHub (Keiyoushi's puts
each extension's files there), the same kind of `GET` with nothing about your install in it. When GitHub cannot be
reached it uses the last answer, else each extension's version. Set `GITHUB_API_URL` to send both GitHub reads to a
mirror instead of `https://api.github.com` (the browser tests point it at a stand-in).

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

**Translate pages** — *off, and nothing downloaded, until an admin presses Download* (Admin → Settings → Server).
Download fetches the translation engine once: the pack from this project's GitHub releases (`translate-v1`) and the
model from Hugging Face, each file checked against a SHA-256 pinned in the app. Translating runs on your server: pages,
their text and the names it learns never leave it. See [Translated pages](#translated-pages).

### Progress trackers

The tracker calls are the only ones this server makes **with your token**: AniList, MyAnimeList, Kitsu and MangaUpdates,
each connected by you under **Profile → Connections → Progress tracking**, and only for reading your list (the
import, and since v0.71.0 Discover's *Recommended for you*), reporting what you finished, and asking MyAnimeList what its
readers recommend after a few titles of your own list (its API needs a token for that). Nothing carrying a token goes
to a tracker you have not connected.

**Recommended for you** (since v0.71.0) reads a person's connected lists when they open Discover, at most every 12
hours, and keeps the list in the database (`tracker_list_cache`, removed when they disconnect or sign in as someone
else). For up to eight titles of their AniList list and five of their MyAnimeList list, it asks what readers recommend
next: AniList **without** a token (public queries, the AniList ids of those titles), MyAnimeList with theirs, and, for
what MyAnimeList answers, one AniList query by those MyAnimeList ids for the age rating. Each title's answer is kept two
weeks for the whole server (`tracker_rec_cache`), so a title two people rated is asked once. Series of the library they
rated or read count too, but only ones they may open, in a library with *Look up art and metadata on AniList
automatically* on, through a checked link. An account that may not add series, or has no tracker connected, sends
nothing.

Two of those services are also asked **without** any token, by title, whether or not anyone has connected
them. By default, every series added gets its title sent to AniList (`graphql.anilist.co`) once, for banner and cover
art; a series with no art on record is looked up the same way the first time its art is requested, and that
match also records the AniList id progress sync writes against. The admin panel's **Cover & banner health**
card — its *Backfill*, and picking art for one series by hand — asks AniList again and, for wide cover art,
Kitsu (`kitsu.io`), and `POST /api/admin/trackers/relink` asks AniList for every unlinked series. Discover's
*Trending* rail is AniList's own trending list, fetched at most once every six hours. Since v0.73.0, with **Fill in
missing details** switched on (off by default), the nightly repair also asks AniList for the description and genres of
series linked there that have none — by AniList id, fifty to a request, never by title. These lookups carry
your server's IP address and the title or id asked for, and nothing else. Since v0.73.0 every AniList request the
server makes, these and the tracker pushes alike, is spaced to stay under the limit AniList states for your address, and
a request AniList asks to wait waits. Of the knobs below, only `ANILIST_API_URL`
moves them (AniList's, since v0.55.7); the other two point only the token-bearing tracker calls elsewhere.

Since v0.55.8 ([discussion #168](https://github.com/AngeloSha/uchiyomi/discussions/168)), each library — the default
one included — has **Look up art and metadata on AniList automatically** under Admin → Libraries. Switch it
off to prevent automatic art lookup, title/id matching, reading-direction/type repair, startup match checks and
scheduled enrichment for series currently in that library. Uchiyomi creates no negative lookup cache entry while it
is off, clears none of the art, links, type or direction it already learned, and applies the destination library's
policy when a series moves. Explicit Admin Art, Relink, Check online matches, tracker import/sync and Discover actions
remain available and can contact AniList because they are actions you asked for, rather than background enrichment.

Since v0.58.0, every six hours (the first time a few minutes after a start), the server asks AniList for the score and
popularity of the series it holds AniList ids for: a checked link only, never a guessed one, 50 ids to a request, and
only those missing or more than three days old. It sends the **AniList ids** and nothing else, skips the series of any
library with *Look up art and metadata on AniList automatically* off, and keeps the answers for the series page's
ratings panel and the *Most popular* and *Top rated* sorts. `ANILIST_API_URL` moves it with the rest.

Since v0.56.0, Discover asks which work each title it shows is, so that a series several sources name differently is
one card and one you already have stays out of the browsing views. Each name is asked once, in the background:
AniList first, then MangaDex (`api.mangadex.org`), then MangaUpdates (`api.mangaupdates.com`), and the answer is
kept. These carry your server's IP address and the title shown in Discover, nothing about your library. Switch them
off with **Match Discover titles online** under Admin → Settings; cards then fold by their names alone.
`MANGADEX_API_URL` and `MANGAUPDATES_API_URL` are test knobs like the ones below (defaults `https://api.mangadex.org`
and `https://api.mangaupdates.com/v1`); `MANGADEX_API_URL` moves every MangaDex request, the MangaDex sources' included.

`ANILIST_API_URL`, `MYANIMELIST_API_URL`, `KITSU_API_URL` and `MANGAUPDATES_API_URL` are **test knobs**: they point an adapter at a
stand-in server instead of the real service (the defaults are `https://graphql.anilist.co`,
`https://api.myanimelist.net/v2`, `https://kitsu.app/api/edge` and `https://api.mangaupdates.com/v1`). They exist so the browser tests can
drive a tracker import without a real account — and, `ANILIST_API_URL` since v0.55.7, check online matches
against a fake AniList, so it moves every AniList call, the title lookups above included. There is no reason to
set them on an install you read on — a wrong value here makes every tracker call fail, or worse, sends your token
somewhere else.

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

**Admin → Sources → Add sources → Add a site by address:** pick the engine, paste a site's homepage URL, done. It
loads instantly (no rebuild). The engines are generic parsers; you supply the URLs, and you're responsible for using
them in line with those sites' terms and your local law.

A handful of one-off, site-specific sources (e.g. an official API client) aren't engines and aren't bundled.
Nothing is published for you to drop in — the loader will register any compiled CommonJS plugin you build
yourself against the contract in [`bff/src/lib/sources/loader.ts`](../bff/src/lib/sources/loader.ts), mounted
read-only:

```bash
# .env
SOURCES_PATH=/path/to/your/plugins/dist     # compiled .js plugins, mounted read-only at /sources
```

The reader scans `SOURCES_DIR` (`/sources`) at boot and registers every plugin it finds. Drop in or update a
plugin and hit **Admin → Sources → Add sources → Reload sources** (`POST /api/admin/sources/reload`); no rebuild.
With no sites added, no extensions installed and no pack mounted, Uchiyomi is just a clean reader for the library
you already own.

**Progressive search.** A cross-source Discover search returns after `SEARCH_FIRST_ANSWER_MS` (default
`6000`) at the latest, or `SEARCH_GRACE_MS` (`1500`) after its first useful answer, while unfinished sources
keep filling the same cached entry. `SEARCH_SOURCE_MS` (`20000`, plus the solver allowance when needed) is
one source's budget; `SEARCH_CONCURRENCY` defaults to `SCAN_CONCURRENCY` (which defaults to
`SOLVER_CONCURRENCY=4`) in each of the solver and ordinary lanes. Entries live for `SEARCH_TTL_MS` (`300000`)
and the oldest is evicted above `SEARCH_CACHE_MAX` (`50`). A source detail lookup is cached for ten minutes.
These caches share network work, not authorisation: results are filtered to the account on every response.

**Library scans that take minutes.** *Scan library now* answers within `REFRESH_FIRST_ANSWER_MS` (default `15000`)
since v0.55.6; a scan that takes longer goes on, and the page follows it to its end with how far it has got. Keep the
value under the timeout of any proxy in front of the server (nginx 60 s, Cloudflare 100 s).

`FAKE_SOURCE_URLS=name=http://host:port,name2=http://host:port` registers deterministic HTTP adapters used
by the release test harness. It is empty in every shipped deployment and is not a production source
configuration. `FAKE_SOURCE_NSFW=name` (since v0.42.0) makes the named ones — a comma-separated list of
ids from that same list — declare themselves adult, which is the only way to drive the 18+ rules without a
real adult extension; it does nothing at all while `FAKE_SOURCE_URLS` is unset, which is every shipped
deployment. `FAKE_SOURCE_CLOUDFLARE=name` (since v0.55.3) puts the named ones behind a fake Cloudflare: they ask the
Cloudflare solvers for every page and send a solver's cookie with their images, which is how the harness drives the
backup solver end to end; the same, it does nothing while `FAKE_SOURCE_URLS` is unset.

The shared source-work limits are `SOLVER_CONCURRENCY` (default `4`) and `SOLVER_BUDGET_MS` (default
`90000`) for Cloudflare-backed work; `SCAN_CONCURRENCY` defaults to that solver slot count, while
`SCAN_ENOUGH` (default `3`) is how many matching candidates make a missing-chapter scan stop widening.
`SCAN_FIRST_ANSWER_MS` (default `2500`, since v0.48.4) is how long Find missing chapters waits before showing
what has arrived; the rest comes in as each source answers, so no request waits on the slowest source.

**Testing a source.** `SOURCE_TEST_TIMEOUT_MS` (default `45000`, 1000–120000) is how long one **Test** in Admin →
Sources or Health, and each source in the daily check or *Test all*, may take end to end. Since v0.49.0 it
also bounds every call inside the test, and a test that runs out of it is reported as *could not finish in time*
rather than as a failure: raise it for extension sources behind a slow Cloudflare check that keep reading so. The
Test key counts against it, plus a few seconds of margin (*Testing… 0:12 of up to 0:53* at the default).
`SOURCE_LATEST_TIMEOUT_MS` (default `8000`) is how long a source's newest page may take before it counts as slow.
`SOURCE_LATEST_SOLVER_TIMEOUT_MS` (default `45000`, since v0.59.0) is the same for a site this server opens through the
Cloudflare solver (below): the first page of the day waits for a fresh solve, measured at 15–25 s, so the bare budget
lost exactly these sites. It is never less than `SOURCE_LATEST_TIMEOUT_MS`. Only a source's first page counts
toward *slow*; later pages, asked while you scroll, never do.

## The Cloudflare solver

Most manga sites sit behind Cloudflare, so the built-in engines fetch them through a **solver**: a real browser in a
container of its own that gets past the check and hands back the page, its cookies and its user agent; images are
then fetched directly with that cookie and user agent. Uchiyomi speaks FlareSolverr's `/v1` API, so any solver that
speaks it works. (Extension sources are fetched by the extension engine, which has its own solver setting: below.)

- `FLARESOLVERR_URL`: the **main** solver. Every shipped compose file runs [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
  as `uchiyomi-flaresolverr` and points this at it, so there is nothing to do.
- `FLARESOLVERR_FALLBACK_URL` (since v0.55.3; empty by default, which means none): a **backup** solver. A request the
  main does not answer with a page — it cannot be reached, it runs out of time, it answers with an error, an empty
  page or something that is not its JSON, or it stays busy — is sent once, unchanged, to the backup. The solver that
  answered a site last is asked first for that site for the next six hours, so a site the main cannot get past does
  not wait for the main to fail every time (a solver that was only busy keeps its sites); after that the main is asked
  first again and gets its sites back. Cookies
  and the user agent are kept per solver and site, and a site's images go with the pair of the solver that solved it
  (a `cf_clearance` cookie only works with the user agent that earned it).
- A solver that answers **HTTP 429 itself is busy**, not the site refusing: trawl does that when every browser it has
  is in use. Uchiyomi asks it again twice, 3 and 6 seconds apart, then the backup. It never puts the site in a
  cooldown or reads as the site asking for a pause; if every solver stays busy, the source's diagnosis says so and
  names the fix (more browsers, or a lower `SOLVER_CONCURRENCY`).
- `SOLVER_CONCURRENCY` (default `4`, above) is how many solves Uchiyomi asks for at once, whichever solver answers.

The solvers to choose from, all speaking the same API:

| Solver | What to know |
|---|---|
| [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | The default. Chrome, a fresh browser for every request; about 850 MB idle. Needs `shm_size: 1gb` (the shipped files set it). |
| [trawl](https://github.com/germondai/trawl) | Camoufox (a patched Firefox), and it keeps solved sessions, so a repeat visit to a site is quick: on one install's own sites, a median of 2 s against FlareSolverr's 12, and 316 MB idle against 865. Young (created June 2026): pin a version. Its pool holds one browser unless `BROWSER_POOL_SIZE` says more, and Uchiyomi asks for four solves at once: set 2 or more, or lower `SOLVER_CONCURRENCY`. `SESSION_CACHE_DRIVER=memory` runs it without Redis. AGPL-3.0, as its own container. |
| [Byparr](https://github.com/ThePhaseless/Byparr) | Says it is up at `/health` instead of its root; Uchiyomi reads both. |

**Admin → Health** names the solver by how it greets — FlareSolverr, trawl, or another — and compares FlareSolverr's
and trawl's version with their own latest release (any other solver's with nothing). With a backup the *Cloudflare
solver* card lists both, *Main solver* and *Backup solver*, each with its address: amber with *The main solver is not
answering; the backup is solving* while only the backup answers, amber while the backup does not answer, and the
usual *Not answering* when neither does. The nightly repair and **Fix everything** count the solver as up while either
answers, and **Reset the solver** clears what Uchiyomi remembers about both. Fix everything puts the solver under *Needs
you* only when neither answers: with one of the two down its end says so under what goes on by itself, since every
request is still solved.

The extension engine uses the **main** solver only: **Connect** points its own helper at `FLARESOLVERR_URL` (see
`FLARESOLVERR_ENABLED` / `FLARESOLVERR_URL` under [Downloading](#downloading), and [extensions.md](extensions.md)).

**trawl as the main solver, FlareSolverr kept as the backup** — in [`deploy/docker-compose.yml`](../deploy/docker-compose.yml),
point `FLARESOLVERR_URL` on the `uchiyomi` service at trawl, add `FLARESOLVERR_FALLBACK_URL` beside it, and add the
service below next to `uchiyomi-flaresolverr` (which stays as it is). The shipped files keep FlareSolverr alone; this is
a choice, not a default.

```yaml
services:
  uchiyomi:
    environment:
      # ...everything else as it is
      FLARESOLVERR_URL: http://uchiyomi-trawl:8191
      FLARESOLVERR_FALLBACK_URL: http://uchiyomi-flaresolverr:8191

  uchiyomi-trawl:
    image: ghcr.io/germondai/trawl:1.8.0   # pinned: it is young and changes quickly. 1.8.0 or later (below)
    container_name: uchiyomi-trawl
    restart: unless-stopped
    shm_size: 1gb
    mem_limit: 2g
    environment:
      SESSION_CACHE_DRIVER: memory   # keep solved sessions in memory, no Redis
      BROWSER_POOL_SIZE: "2"
    healthcheck:
      # /health answers 503 until a browser is up (15 to 30 s after a start).
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8191/health >/dev/null || exit 1"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 60s
    networks: [uchiyomi_app]
```

Then `docker compose up -d`. To go back, put `FLARESOLVERR_URL` back to `http://uchiyomi-flaresolverr:8191` and drop
the other line (and the service, if you like). The extension engine keeps the solver its own container names
(FlareSolverr, in the shipped files); for extension sources to go through trawl too, set `FLARESOLVERR_URL` on the
`uchiyomi-suwayomi` service to `http://uchiyomi-trawl:8191` as well. It has no backup of its own. That needs trawl
**1.8.0 or later**: the engine asks for a Madara site's lists and searches with a form post it sends without a
`Content-Type`, and trawl 1.7.0 refuses every one (HTTP 400, *body requires a Content-Type header to be set*), so those
lists fail on a Cloudflare-protected site. 1.8.0 sends the body as a form.

## Downloading

All optional; the defaults are what the live install runs. Adding a series and importing hundreds of
chapters both go through the same downloader, so these are the only knobs that decide how hard a site is
ever hit.

- `UPDATER_SWEEP_MAX` (default `150`): most chapter-fetch attempts in one scheduled sweep, so a backlog
  cannot occupy the whole night.
- `CHAPTER_RETRY_CAP` (default `3`): ordinary failures before a chapter is left as failed until a person
  explicitly retries it. A chapter a site refused (a 429 or a 403) gets `FINISH_DOWNLOADS_REFUSAL_CAP` tries instead
  while **Finish downloads on their own** is on.

**Finish downloads on their own** (Admin → Settings → Downloads, on by default) needs nothing set. Advanced,
rarely needed:

- `FINISH_DOWNLOADS_MINUTES` (default `15`, at least `5`): how often the series with chapters left are gone back to,
  or right after a site's cooldown ends if that comes first.
- `FINISH_DOWNLOADS_PER_SERIES` (default `10`) and `FINISH_DOWNLOADS_SWEEP_MAX` (default `60`): chapters one of those
  runs fetches for a series, and in all.
- `FINISH_DOWNLOADS_LANES` (default `3`, 1 to 6): series one of those runs works on at once, each on a different site.
- `FINISH_DOWNLOADS_REFUSAL_CAP` (default `12`): tries a chapter a site refused gets.
- `SCOUT_SEARCHES_PER_HOUR` (default `40`; `0` stops it looking for new sources on its own, and keeps the rest):
  searches it may make in an hour when it looks for a series on your other installed sources.
- `BACKUP_EXTENSIONS_MAX` (default `5`, the desktop app `3`; `0`: never): backup extensions -- the ones Uchiyomi
  installed by itself -- installed at once. One a series uses as its main source does not count. When it is full, the
  one needed longest ago is removed to make room, and one in use never is.

- `DOWNLOAD_CONCURRENCY` (default `2`): chapters downloaded at once, per source -- per rate key: the MangaDex languages
  share one, and since v0.55.3 so do sources whose pages come from one image server (Natomanga and Mangakakalot). One
  at a time while a 429 has raised that key's pace (see `DOWNLOAD_RESUME_WAIT_MS`).
- `DOWNLOAD_MIN_GAP_MS` (default `1200`): minimum gap between the starts of two chapter downloads from the same
  source, doubled for each pace level a 429 has earned it (1200 → 2400 → 4800 ms).
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
  Since v0.49.0 an engine that lacks the two settings can be fixed without touching its container: **Connect** —
  on the *Extension engine* row of **Admin → Health**, which says when it is needed, or in the *Cloudflare helper*
  cell of the strip at the top of **Admin → Sources** — sets the engine's own `flareSolverrEnabled` /
  `flareSolverrUrl` to Uchiyomi's `FLARESOLVERR_URL` over its API. Nothing restarts, and the engine keeps the value
  unless its container names another solver. It is only ever done on a press, and needs `FLARESOLVERR_URL` set on
  Uchiyomi. An engine too old to report the setting has to be given the two on its own container.
- `EXTENSION_ENGINE` (default `1`): the bundled extension engine's switch (v0.49.0). `EXTENSION_ENGINE=0` in `.env`,
  then `docker compose up -d`: Compose runs no engine container (its volume is kept) and Uchiyomi treats
  extensions as off. Delete the line, or set `1`, and run the same command to bring it back. **Compose only accepts
  `0` or `1`**: it is the engine's replica count, and any other value stops `docker compose up` for the whole stack.
  (The app itself also reads `off`, `false` and `no`, for setups that do not pass the line to Compose.) It only
  applies while `SUWAYOMI_URL` names the bundled container (`uchiyomi-suwayomi`, or `yomi-suwayomi` in the
  development stack): an engine you run yourself is never switched off by it. Needs the v0.49.0 compose files;
  an older file ignores the line. See [extensions.md](extensions.md#turning-it-off).
- `UCHIYOMI_PLATFORM` (optional): `compose`, `unraid`, `casaos` or `umbrel`. Only tells **Admin → Sources**
  which setup steps to open on; the CasaOS listing, the Unraid template and the Umbrel package set it, and Unraid's
  own `HOST_OS` and a v0.49.0 compose file's `EXTENSION_ENGINE` are read when it is absent. Nothing else depends
  on it.
- `SUWAYOMI_URL` (see [extensions.md](extensions.md#settings)): where the extension engine is; empty turns
  the feature off (in the v0.49.0 compose files and later: the older ones wrote `${SUWAYOMI_URL:-…}`, which put the
  default back for an empty value). A trailing slash (or two), a query string or a fragment on this value is ignored; the
  scheme, host, port and any sub-path are what count — the same normalised base is used for the covers the
  engine hands over and for the cover proxy's check of them, so a stray `//` no longer turns every
  extension cover into a placeholder.
- `SUWAYOMI_PAGE_CONCURRENCY` (default `4`, 1-8): pages fetched at once from the extension engine. An
  extension source's page URLs are the engine's own proxy paths, and the engine has its own client and its
  own rate limits towards the site, so the one-at-a-time pacing above was only slowing extension downloads
  down for nothing. The first 429 from the engine drops the chapter back to one page at a time for the rest
  of the download.
- `SUWAYOMI_MEM_LIMIT` (default `2048m`; `1536m` before [#275](https://github.com/AngeloSha/uchiyomi/issues/275)) and
  `SUWAYOMI_JAVA_OPTS` (default `-Xmx768m -XX:+UseSerialGC`): the extension engine's memory ceiling and its Java
  options. These are read by Docker Compose for the engine's own container, not by Uchiyomi. Without them a JVM sizes
  its heap from the host — a quarter of its memory — so they are set in every shipped compose file. The ceiling holds
  more than the heap: Java's own native memory and the Chromium and Xvfb the engine's image runs came to 770 MB beside
  a 630 MB heap on a server with 45 extensions. Keep the ceiling at least 1.25 GB above `-Xmx`, and raise `-Xmx` (and
  the ceiling by as much) only when the engine's log says `java.lang.OutOfMemoryError: Java heap space`. On a host
  without swap the ceiling is a hard wall: the kernel kills the engine there and Docker starts it again
  ([If the engine keeps restarting](extensions.md#if-the-engine-keeps-restarting)). The same container sets
  `MALLOC_ARENA_MAX=2`, which the C library reads.
- `DOWNLOAD_RESUME_WAIT_MS` (default `5000,10000,20000`): waits before the three attempts to resume a
  chapter after a 429. A source's longer `Retry-After` is always the floor. Every chapter on the source waits the same
  wait, not only the refused one. A 429 also raises that source's in-memory pace level (0–4): slowed levels download
  one chapter at a time, use one page worker and double gaps up to four seconds. Since v0.55.3 a level is held at least
  an hour, and comes off one step at a time only after ten chapters in a row came down whole without a 429 at it (a
  level nothing downloads through loses a step every three days); it was ten quiet minutes a step, and a site that
  kept refusing was asked at full speed again within the hour. Nothing persists: a restart starts at full speed.
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
- `REPAIR_GROUPS_MAX` (default `10`, 1–200): chapters one run may swap for a preferred group's copy, when
  group upgrades are switched on (step 6 below).
- `REPAIR_NAMES_MAX` (default `5`, 1–100): series one run may look for a chapter-name donor for, when name
  borrowing is switched on (step 7 below).
- `REPAIR_DIRECTIONS_MAX` (default `500`, 1–5000): series one run asks each service — MangaDex, then AniList —
  about their reading direction (step 8 below): at most five and ten requests a night at the default.
- `REPAIR_DETAILS_MAX` (default `15`, 1–200): series one run asks their own source and the ones they follow about a
  missing description, genres, author or cover, when Fill in missing details is switched on (step 9 below). AniList's
  part is one batched request per fifty series and has its own fixed ceiling of 500.
- `REPAIR_PACE_MS` (default `1500`, 0 or more): the pause between two series the repair's *Retry now* step
  re-checks. `0` is a legitimate value and means no pause at all. Fix everything paces every series of its
  failures, short and gap steps by it too.
- `AUTOFIX_MAX_MINUTES` (default `90`, 1–1440): how long one run of Health's **Fix everything** (since v0.55.0)
  may work through the network-heavy part -- Replace, the failures, short and gap steps, extensions -- before it
  stops at a safe point; what is left waits for the next run.
- `AUTOFIX_SEARCHES` (default `60`, 0–1000): searches of other sites one Fix everything run may start for short
  chapters and gaps, shared like the repair's five.
- `AUTOFIX_INSTALLS` (default: no cap; 0–100000): extensions one Fix everything run may install for series no source
  carries. Since v0.55.1 there is no cap unless you set one: the run tries extensions one at a time, the ones the
  series' translation groups name first, then the most downloaded, until the series are found or
  `AUTOFIX_MAX_MINUTES` is spent, and the next run continues down the list. `0` switches its extensions phase off. A
  package that carries none of the series it was searched for is removed again at once, and is not tried for those
  series again for a month.
- `MAX_FOLLOWED_SOURCES` (default `3`, 1 to 10): how many sources besides the main one a series may follow, by hand or
  automatically, until an admin picks a number. Since v0.89.0 that is a menu in the app, **Admin → Settings → Downloads
  → More options → Other sources per series** (1 to 10), and this is only its starting value. Each one is another
  chapter list read on every update. A source that is broken, switched off or no longer installed does not count
  toward it for the sources Uchiyomi adds on its own.
- `MIN_FREE_GB` (default `10`): refuse to start a download when the download disk has less than this free.
  `0` disables the floor. Fails open if free space cannot be measured.

An ordinary chapter failure may continue from as many of the sources already followed for that series as a series may
follow (**Other sources per series**, three by default), at most four. A copy explicitly picked by a person never switches. A 403/429 never becomes a
partial chapter; the refusing source cools down, while an already-followed copy can keep the queue moving. With
**Admin → Settings → Downloads → Finish downloads on their own** on (the default), Uchiyomi also finds and
follows a new source for a series its sources cannot serve. Title and 90%-chapter matching apply, and a clean series
never causes an adult source to be followed.

## The slow archive

Since v0.49.0 a series can be queued to come in a chapter at a time over nights or days
([USAGE §4](USAGE.md#fetching-a-whole-series-slowly-the-slow-archive)). Its pace is set in the admin panel, not
here — **Admin → Settings → Downloads → Slow archive**, and every change reaches the running archive at once, with no restart:

- *Slow archive* — on unless you pause it; off pauses every archive, and nothing queued is lost.
- *Chapters an hour, per source* — default `4`, 1–30. A break after each chapter is drawn at random around what is
  left of that chapter's share of the hour, never under 45 seconds, and one chapter in ten (fewer above about 8 an
  hour) is followed by a long break of 20 to 45 minutes on top, so the long-run rate comes out at the setting.
  At the fastest settings the 45-second floor sets the pace instead, and the row's help counts what really fits.
- *Only during set hours* — off by default; *From* and *Until* in the server's local time. 22 until 6 runs
  overnight, and the same hour at both ends means any time.
- *Stop when free space is below (GB)* — default `20`, 1–2000, measured under the download folder. It holds the
  archive only: a download a person asks for still stops at `MIN_FREE_GB` (above).

What no setting changes: a site that refuses a chapter (403 or 429) is left alone for 1 h, 3 h, 12 h, then a day
at a time, never less than its own cooldown; the archive waits for every sweep, repair and source check; and it
gives way to anybody else's download on the same site or series. Two environment variables shape it underneath, and a
normal install needs neither:

- `ARCHIVE_PAGE_GAP_MS` (default `1500,4000`): the pause between two pages of an archive chapter, drawn at random
  from this range for every page; one number is a fixed gap. Pages go one at a time. It never goes below the gap
  the source itself asks for, or the longer one a 429 has earned it, and a value that cannot be read means the
  default, never no gap at all.
- `ARCHIVE_MAX_SOURCES` (default `3`): how many sites may have an archive chapter in flight at once. Each has at
  most one, whatever this says.

`ARCHIVE_FIRST_RUN_MS`, `ARCHIVE_MIN_BREAK_MS` and `ARCHIVE_TICK_MS` exist for the end-to-end tests only: they
shorten the wait before the first look after a start (10 minutes, 3 on the desktop app), the 45-second minimum
break and the scheduler's one-minute look, so a test can watch a chapter land. Leave them unset.

## The nightly repair

On by default, under **Admin → Settings → Maintenance → Repair the library nightly**, and listed as
**Admin → Settings → Maintenance → Repair library**. Once every `REPAIR_HOURS` it does the six things that are reversible or
provable on their own, and two more only when you switch them on, in this order:

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
   `REPAIR_PACE_MS` apart; *Fix all issues* and, since v0.49.0, the *Fix all* on Health's *Chapters that would not
   download* card do every source's rows and re-check up to 10 series from the sources that can be asked now.
4. **Short chapters.** `REPAIR_SHORT_MAX` one- or two-page chapters Uchiyomi downloaded itself. One copy
   from each of up to 3 sources the series follows is asked how many pages it has, plus one search if none
   of them has more; the chapter is replaced only when a copy really is longer, and marked *confirmed
   short* only when every copy answered and none was silent, in a cooldown, left unasked by that cap, or
   answered with an empty page list — a page list that comes back empty is a site not answering, not a
   zero-page chapter. The copies come from the chapter listing the step refreshes before it asks anything,
   so a source that is in a cooldown at that moment offers no copy at all rather than one that stays
   silent; either way it is not part of a proof.
5. **Gaps.** `REPAIR_GAPS_MAX` series, the least recently checked first (since v0.55.0; before, the largest holes
   first, which searched the same unfillable ones every night), at most once a day each, and never one whose last
   search found nobody has its chapters while that answer is under a week old and nothing has landed since. Holes
   below a series' "Latest N" start are left alone: nothing fetches below it. A hole a followed
   source already lists is left to the chapter sweep, and only a hole nobody lists starts a search. A
   source is followed only under the same 90%-numbering rule as every other automatic follow, and at most
   20 chapters are fetched per series. A series the run has no searches left for is not marked as checked:
   it keeps its place and is looked at on the next run rather than skipped for a day. Since v0.49.0 a series whose
   every gap its slow archive is going to fetch is left to the archive, and is not marked as checked, so it comes
   back once the archive is done; *Fill now* on Health still fetches those chapters at once.
6. **Group upgrades** (since v0.47.0), **off** until **Admin → Settings → Downloads → Scanlation groups → Upgrade chapters to a
   preferred group** is switched on. `REPAIR_GROUPS_MAX` chapters Uchiyomi downloaded itself whose group
   ranks below one your release preferences name, when that group's copy is on a source the series follows:
   the listing is refreshed first, the preferred copy's page list is counted before anything is downloaded,
   and a copy with fewer pages than the file on disk, or one that arrives incomplete, never replaces it. A
   chapter someone picked a version for by hand is never touched, and one whose swap failed waits a week.
7. **Chapter names from another source** (since v0.47.0), **off** until **Admin → Settings → Series & chapters →
   Borrow chapter names from other sources** is switched on, or a series ticks the box on its own sheet.
   `REPAIR_NAMES_MAX` series that hold a chapter with no name: a donor is searched for across at most
   `HUNT_MAX_SOURCES` sources in the series' own language, and used only if it passes the same identity and
   numbering judgement an automatic follow must pass. Names are matched by exact number, written to the
   chapter name alone, and marked with the donor, so the chapter's own source replaces them the moment it
   supplies one and switching the setting off takes back exactly what was borrowed. A search that found no
   donor stands for a week. Nothing here is reported to source health: a lookup for names must never be what
   puts a source into a cooldown.
8. **Reading directions** (since v0.48.0). For series whose reading direction nothing has said yet, MangaDex is
   asked for the original language of the ones that follow it, then AniList for the country of origin of the ones
   linked there — at most `REPAIR_DIRECTIONS_MAX` series from each in a run, picked at random. Only the reading
   direction is ever written, and never over one set by hand.
9. **Missing details** (since v0.73.0), **off** until **Admin → Settings → Series & chapters → Fill in missing
   details** is switched on. A series with no description, genres or author of its own is given them: first by
   AniList, for series linked there with a checked link, in libraries whose AniList lookups are on, in English, at most
   500 a run in requests of fifty by id; then, for at most `REPAIR_DETAILS_MAX` series that are kept updated, by the
   series' own source and the ones it follows in its language, each lookup bounded by the source's own time budget and
   only of sources that are not off, failing or cooling down. A series with no chapters yet also gets a cover. What it
   finds is kept in a layer of its own (`series_auto_details`) that a series shows only where its own details and an
   admin's edit are both empty, so a scan never fights it and nothing is ever replaced; the 18+ filter judges the
   genres it adds. A series asked is left for 30 days. Nothing here is reported to source health. Switching it off
   deletes the layer and puts back any cover it set.

Fixed rather than configurable, because they are the blast radius rather than a preference: 5 searches for a
whole run, shared by steps 3–5, of which the short step may spend at most 2 — so a library full of short
chapters can no longer leave the gap step with nothing; 100 ledger rows, 10 series re-checked, 3 sources
asked per short chapter, 20 chapters per gap series, 8 archives opened at once, 7 days before a capped
chapter gets another chance, and 24 hours between two gap checks of one series. A knob that is missing,
unparseable or out of range falls back to its default and never to zero — `REPAIR_PACE_MS` included, where
only a deliberate `0` turns the pause off.

**Runs are kept** (since v0.49.0): every run, nightly or pressed on the Health page, is a row the Health page lists
under *Recent repairs* — the newest 50 and everything from the last 90 days are kept. Only a **full** run (the
nightly, or *Run now* on Maintenance) is the task's line and sets when the next nightly is due, so a fix pressed on one
Health row neither replaces that line nor moves the schedule. *Fill now* on one series looks at it even while its
automatic updates are off, and fetches the gap chapters a source it already follows lists (up to 20) instead of
leaving them to the sweep; the nightly's rule above is unchanged.

The repair and the chapter sweep never run at the same time — both download into the same folders — so
whichever starts second waits ten minutes. Switching the nightly off stops the **schedule only**: *Run now*
and the Health page's buttons keep working, because nothing the repair does deletes, merges or renumbers
anything. Duplicate series and impossible chapter numbers are never touched by it; they stay one-click
actions an admin confirms.

## Deleting chapters after they are read

Off, and there is deliberately **no environment variable that turns it on**. It is switched on in
**Admin → Settings → Downloads → Delete read chapters**, behind a confirmation, because an install that upgraded into a
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

## Translated pages

The optional translation engine (since v0.85.0; how readers use it is in
[USAGE §5](USAGE.md#translated-pages)). Nothing below exists until an admin presses **Download** under
**Admin → Settings → Server → Translate pages**.

**What Download fetches**, each file checked against its pinned SHA-256 and resumed if it stops part-way:

- The engine pack for your server's architecture (amd64 or arm64), about 100 MB: llama.cpp's `llama-server`, the OCR
  models (PaddleOCR) and their runtime, and the fonts.
- One translation model, picked by the server's memory: **Qwen3.6 35B-A3B** (17 GB, and 0.8 GB more that lets it look
  at pages) on a machine with 28 GB of memory or more, **Qwen3 4B** (2.3 GB) elsewhere. Both are Apache-2.0.

**Where it goes:** `TRANSLATE_DIR`, by default `translate/` in the config folder (`/config/translate`). The download
refuses to start without room for it plus 1 GB. On a small system disk, mount a folder on a big disk and point the
variable at it. The folder must be writable by the user the app runs as (`PUID`):

```yaml
services:
  uchiyomi:
    environment:
      TRANSLATE_DIR: /translate
    volumes:
      - /mnt/big-disk/uchiyomi-translate:/translate
```

**While it translates,** the engine runs as two processes beside the app (the model, and the OCR), at low priority. The
model takes about its own size in memory, so 19 GB for the large model and 3.3 GB for the small one. The engine won't
start a model that does not fit in the memory free at that moment, and says so under Translate pages. Both processes
stop after 10 minutes without a page.

| Variable | Default | What it does |
|---|---|---|
| `TRANSLATE_DIR` | `<CONFIG_DIR>/translate` | Where the engine is downloaded to. |
| `TRANSLATE_THREADS` | half the CPUs | CPU threads the model uses. The OCR uses at most 4. |
| `TRANSLATE_MODEL` | by memory | `large` or `small`, to pick the model yourself. |
| `TRANSLATE_ENGINE_URL` | none | Translate with a llama.cpp server you already run (a machine with a graphics card, say) instead of downloading a model. Download then fetches only the engine pack, for the OCR and the fonts. |

Not in Uchiyomi Desktop yet: its server runs inside the app, where the engine's processes cannot.
