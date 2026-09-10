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


## What leaves your server

Two things can, they are separate switches, and they go to different places. Both live in
**Admin → Settings**.

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
plugin and hit **Admin → Providers → Reload** (`POST /api/admin/sources/reload`); no rebuild. With no sites
added, no extensions installed and no pack mounted, Uchiyomi is just a clean reader for the library you
already own.

## Push notifications

Nothing to configure. The server generates a VAPID key pair on first boot and keeps it in `/config`, the
same way it does the session secret, so new-chapter notifications work on a stock install. Set
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

