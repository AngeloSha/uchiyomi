# Uchiyomi — User Guide

Everything you can do in Uchiyomi, screen by screen. For install/configuration see the [README](../README.md).

- [1. First run & setup](#1-first-run--setup)
- [2. Signing in](#2-signing-in)
- [3. Your library](#3-your-library)
- [4. A series & its chapters](#4-a-series--its-chapters)
- [5. The reader](#5-the-reader)
- [6. Discover & add new series](#6-discover--add-new-series)
- [7. Sources: MangaDex + Add-a-site](#7-sources-mangadex--add-a-site)
- [8. The admin panel](#8-the-admin-panel)
- [9. Security: 2FA, sessions, password](#9-security-2fa-sessions-password)
- [10. Tracking: AniList sync](#10-tracking-anilist-sync)
- [11. Install as an app & offline](#11-install-as-an-app--offline)
- [12. Backups & restore](#12-backups--restore)
- [13. Troubleshooting & FAQ](#13-troubleshooting--faq)

---

## 1. First run & setup

```bash
docker compose up -d         # no config needed — secrets are generated automatically
```

> **Updating later:** run `docker compose pull` *before* `docker compose up -d`. Without the pull, Docker
> keeps using the `:latest` image it already has and you stay on your installed version silently.

Open the app at your `PUBLIC_ORIGIN` (e.g. `http://localhost:8080`) and **create your admin account in the
browser** on first run (the first account created becomes the server admin). To read an existing collection,
point `LIBRARY_PATH` at it first (`cp .env.example .env`, set `LIBRARY_PATH=/path/to/your/manga`, then
`docker compose up -d`). Your library can be laid out however you already keep it: a folder counts as a series when it directly
contains chapters, at any depth. Each chapter is a `.cbz`, a `.cbr`, or a folder of images (an archive may
carry a `ComicInfo.xml` for metadata).

Prefer a CLI-seeded admin? Run `bash scripts/setup.sh` from a clone instead — it generates the secrets, creates
the admin from a password you type, fixes volume ownership, and starts the development stack (`yomi-app`,
`yomi-db`, `yomi-suwayomi`, `yomi-flaresolverr`). `yomi-app` is the same single container the install ships,
built from source.

---

## 2. Signing in

![Login](shots/login.webp)

**Signing in with your own identity provider.** If the admin has configured OIDC, a **Continue with …** button
appears under the password form and you can sign in with Authentik, Authelia, Keycloak or anything else that
speaks OpenID Connect. Local accounts keep working alongside it, so a provider outage can never lock you out.
Setup is in [docs/api.md](api.md#single-sign-on-oidc).

![Continue with SSO](shots/login-sso.webp)

Log in with the username/password you set in `setup.sh` (the first account is `admin`). If you've turned on
two-factor auth, you'll be asked for your 6-digit code (or a recovery code) after the password.

---

## 3. Your library

![Library](shots/library.webp)

The **Library** tab is your whole collection. Tabs across the top sort it: **Curated**, **Newest**, **Most
read**. Each cover shows a **NEW** ribbon when there are unread chapters. Click a cover to open the series.

The top bar has **Home** (a daily-pick hero + "For you" rails), **Library**, **Browse** (by genre), and
**Discover**, plus search, the updates bell, a refresh button, and your profile.

### What counts as a chapter

Point `LIBRARY_PATH` at what you already have. A chapter can be any of:

| | |
|---|---|
| `.cbz` / `.zip` | the usual comic archive |
| `.cbr` / `.rar` | read with a pure-wasm unrar, no extra install |
| `.pdf` | pages are rendered at reading resolution, so a PDF behaves exactly like a CBZ |
| `.epub` | **image** EPUBs only, which is what manga bought from a store ships as |
| a folder of images | loose `.png` / `.jpg` / `.webp` / `.avif`, sorted naturally |

Two things worth knowing. **EPUB pages come out in spine order**, not filename order, because store-bought
manga routinely names its image files by an internal id that sorts wrong. And **a text ebook is not a
chapter**: a reflowable novel has no images in its spine, so it yields no pages and the scanner skips it
rather than adding something that opens to nothing. Uchiyomi is a manga reader, not an ebook library.

Any folder depth works, and `ComicInfo.xml` is read when an archive carries one.

---

## 4. A series & its chapters

![Series](shots/series.webp)

The series page shows the cover, an ambient backdrop, genres, description, and the **chapter grid**.

- **Start reading** jumps to where you left off (or chapter 1).
- **Favorite** (heart) adds it to your favorites + smart offline sync.
- **Download all** saves every chapter for offline reading.
- Click any chapter to read it; the ⬇ on a chapter downloads just that one. Toggle **Oldest/Newest** to flip
  the order.

Progress, favorites, and history are **per-user**, so each account has its own.

**Filtering the library.** The Library page has a **Filters** button: read state (not started / reading /
finished), publication status, and genres. Picking several genres means all of them. Active filters show as
chips under the header with a count, and they live in the URL, so the back button works and you can share a
filtered view.

**Doing something to many series at once.** Hit **Select** on the Library page, tap the ones you want, and the
bar at the bottom can mark them read or unread, favourite them, or file them into a collection. Marking a
backlog read deliberately does not count towards streaks or the household leaderboard, since you did not
read it this week.

**If you are an admin**, the series page also carries the controls for that series:

- **Edit** its title, author, publication status, genres, summary, cover and banner art. All of it applies
  everywhere (search, sorting, Browse, the recommendation rails, the reader header) and none of it touches
  your files. Anything you set here survives the next scan; anything you leave blank keeps following what
  the files say.
- **Edit a chapter** from its row menu, if its number came out wrong. Numbers are read from the filename by
  taking the first number in it, so `Vol 2 Ch 5.cbz` is read as chapter 2. Correcting it fixes the reading
  order and what gets reported to a connected tracker.
- **Auto-update** toggles whether the updater keeps checking this one for new chapters, and **Check now**
  runs that check immediately instead of waiting for the next sweep.
- **Delete** hides the series rather than erasing it. Chapters, ratings, favourites and everyone's reading
  history stay attached, so nothing is lost and it can be put back (see section 8). A hidden series stays
  hidden when the library is rescanned instead of reappearing as a new one.

---

## 5. The reader

![Reader](shots/reader.webp)

Tap the middle of the page to raise the top bar, then tap the **series name** on it to jump to that series.
The back arrow beside it does something different on purpose: it returns you to wherever you opened the
chapter from, which is often Home rather than the series.

The centerpiece: a smooth **vertical webtoon scroll**. It auto-appends the next chapter as you near the end, so
you keep scrolling through a series without interruption.

- **Tap** the middle to show/hide the chrome (top bar + controls).
- **Pinch / double-tap** to zoom (width multiplier).
- **Themes:** AMOLED black, sepia, or gray, from the reader settings.
- **Per-series memory:** your zoom/theme choices are remembered per title.
- **Desktop:** use `[` / `]` (or the chapter dropdown) to move between chapters; the page is centered with
  comfortable margins.

It remembers your scroll position, so closing and reopening drops you right back where you were.

---

## 6. Discover & add new series

![Discover](shots/discover.webp)

**Discover** is how you add new series to your library.

- **Trending** rail: popular manhwa you don't already have. Each card shows the description + chapter count.
- **Latest on …** rails: every source gets its own row of that site's newest releases, so you can browse
  what just came out without searching. The **✦ Newest** button (next to *Browse newest from*) opens a full
  grid of one source's latest.
- **Search:** type a title once and Uchiyomi searches **all your sources at the same time**. Results are
  de-duplicated into one card per title (a small badge shows how many sources carry it), and anything you
  already own is marked **✓ In library**.
- **Add:** tap a card and pick which source to add it from (skipped when only one has it). Choose **how many
  chapters** to download (All or first N), toggle **auto-update**, and add it. It downloads chapter 1
  immediately so the series shows up right away, then grabs the rest in the background (with a progress bar).

If you try to add a title you already have from another source, Uchiyomi warns you and lets you add a separate copy
or cancel. A heads-up appears if you queue a lot of chapters at once (sources can rate-limit heavy downloads).

---

## 7. Sources: MangaDex + Add-a-site

![Add a site](shots/admin-providers.webp)

**MangaDex works out of the box** (the official public API), with nothing to set up. Everything else you add
yourself in **Admin → Providers** by pasting a site's URL. Uchiyomi bundles generic **engines** for three common
manga-site families (**Madara**, **MangaThemesia**, and **Manganato**), and most manga sites run one of them.

### Add a site — step by step

1. Go to **Admin → Providers** (Profile → *Admin & server settings* → **Providers** tab).
2. In the **Add a site** box, leave the engine on **Auto-detect**.
3. Paste the site's **homepage URL**, the root only, e.g. `https://some-manga-site.com`. Not a deep link to a
   specific series or chapter.
4. Type a **Name** (any label you like; it's just what shows in your source list).
5. Click **Add**. Uchiyomi fetches the homepage, figures out the engine, and the source goes live **instantly, no
   restart**. It then appears in the list and is searchable from **Discover**.

### Will a site work?

Uchiyomi can read a site if it runs one of the three bundled engines. You don't need to know which (Auto-detect
handles it), but here's how to recognize them by their URLs/layout:

| Engine | Tell-tale signs |
| --- | --- |
| **Madara** | A WordPress manga theme. Series pages look like `…/manga/<name>/`, chapters like `…/manga/<name>/chapter-12/`. Extremely common for manhwa/manhua. |
| **MangaThemesia** | Series at `…/manga/<name>/` or `…/series/<name>/`; the homepage is a grid of cover "cards"; the reader is one long vertical scroll. |
| **Manganato family** | Big general-manga catalogs; the search page lives at `…/search/story/<query>`. |

Not sure? Just paste the URL and add it. Worst case, Auto-detect replies that it can't tell, and then you pick an
engine manually from the dropdown, or conclude the site isn't supported (next box).

### After you add a source

Open **Discover**, pick your new source in the dropdown (or use **Find & add** on a trending card), search a
title, and add it to your library (see [section 6](#6-discover--add-new-series)). New sources also join the
cross-source search there automatically.

### Managing sources

Each source shows a **health** badge: `ok`, `rate-limited`, `blocked`, or `off`. From the list you can:

- **Disable** / **Enable** a source,
- **Clear** a temporary block (if a site rate-limited you after heavy downloading),
- **Remove** a site you added (the built-in MangaDex can't be removed),
- **Reload sources** to re-scan after dropping a compiled source-plugin pack into `SOURCES_DIR`.

### When a site won't work

If Auto-detect can't identify it *and* no manually-picked engine returns search results, the site runs an engine
Uchiyomi doesn't support out of the box, typically an **API-only** site or a **JavaScript-rendered (SPA)** one.
Those need a code-level adapter (a source plugin); the three bundled engines cover the large majority of manga
sites, but not every one.

> **Cloudflare:** many sites sit behind Cloudflare. The bundled `yomi-flaresolverr` service handles that
> automatically; just make sure that container is running (it is, by default).

---

### Extensions (Mihon / Tachiyomi)

Beyond the built-in engines, Uchiyomi can use the **Mihon / Tachiyomi extension ecosystem** — around 1,400 of
them. Go to **Admin → Providers → Extensions**, add an extension repository you trust (once), then search and
click **Add**. Installing switches that extension's sources on straight away, so it is searchable from Discover
immediately.

Adult extensions are hidden until you tap **18+**. Full detail, including how it works and how to turn it off,
is in [docs/extensions.md](extensions.md).

![The extension browser](shots/admin-extensions.webp)

## 8. The admin panel

Reachable from **Profile → Admin & server settings** (admins only). Panels are grouped by what you are
doing rather than by what the code is called: **Server** (Overview, Tasks, Settings), **People** (Members,
Sessions, Activity), **Content** (Library, Health, Art) and **Sources** (Providers, Extensions).

**Server → Overview:** library stats + recent member activity.

![Members](shots/admin-members.webp)

### Health

**Content → Health** audits your library and tells you what is wrong before you run into it: series with missing
chapters, chapters that downloaded as one or two images, the same title sitting in the library twice, chapter
numbers that can't be real, and any source that is failing or blocked. Each check says what it found and what
it cannot see. Hit **Re-check** to run them again.

![Library health](shots/admin-health.webp)

**Content → Library** also lists every series you have deleted, with **Restore** to put one back exactly as
it was. Deleting happens on the series page itself (section 4); this is where hidden series go and how you
get them back.

### Renaming folders and deleting files

By default Uchiyomi never writes to your library: every edit you make -- titles, covers, chapter numbers --
is stored in its own database, and your files are left exactly as they are. Turning that off is deliberate
and takes one step, because it means handing the app write access to your collection:

```
PUID=1000    # id -u
PGID=1000    # id -g
```

Set those to the user that owns your library and restart. The startup log says which way it went, so
`docker compose logs uchiyomi` answers "why is the button missing" without you having to guess.

**Rename folder** is on the series page, under the admin actions next to *Edit details*. It moves the folder
on disk and rewrites the chapter paths, and it keeps chapter ids and everyone's reading progress, so nothing
is marked unread and nothing is re-downloaded. It refuses outright unless *every* folder the series occupies
is writable: a series often spans your library and Uchiyomi's own downloads folder, and renaming only one of
them would leave the old name in place for the next scan to pick up as a second, half-read copy.

**Delete files** is on **Content → Library**, and only for a series you have already removed. The reversible
step always comes first, and the irreversible one asks you to type the title. It deletes the chapter files
and keeps every chapter row and every progress row, so the record of having read something survives the
files.

**Merging duplicates** is on **Content → Health**, attached to the duplicate check that finds them: where it
reports the same title sitting in your library twice, **Merge** folds one into the other. Every chapter and
every progress row moves to the survivor. Chapters that look like duplicates are **kept**, not removed --
dropping one would mean folding two progress rows into one, and getting that wrong marks chapters unread and
then pushes that to your AniList account, where it cannot be undone.

**Libraries:** split one collection into several, then choose per member which ones they can open. This lives
on **Content → Library**.

A library is **a folder, plus any series you file into it by hand**. Give it a folder by browsing your
library root or typing the path, and the count of what it would hold appears before you commit.

Libraries are *declared*, not guessed. The obvious alternative -- treating every top-level folder as a
library -- would be wrong on most existing installs, because that level usually holds the source names the
downloader wrote. Uchiyomi still suggests folders it can see, at any depth, with the ones that look like
source names sorted last and flagged `source?`.

**Libraries may sit inside one another.** With `Manga` and `Manga/Seinen` both declared, a series under
`Manga/Seinen` belongs to the inner one: the most specific library wins. Removing the inner one hands its
series back to `Manga`, not to the default.

**Age rating.** A library can carry one, and everything in it inherits it, so marking a shelf 18+ is one
action rather than two hundred. A single title can still be rated differently from its own page, which is
what makes an exception possible. Unrated stays visible to everyone on purpose.

**A library rated 18+ is also kept off the shelf.** Not just from members with an age limit, but from
everybody, until somebody asks for it. It stays out of the home rails, the library grid, search, browse,
your collections, updates, history, bookmarks and the OPDS feeds, and its tab does not appear on the Library
page. (An OPDS reader has no button to press, so for it the choice sits on its own credential: **Profile →
External readers → Include 18+ libraries in this reader**, off by default.) A **Show 18+** button sits beside the sorts on the Library page and brings it all back; the reveal
lasts until you close the browser and then it hides itself again. The button only appears for accounts that
actually have such a library, and never for one whose age limit is below 18.

This is about what turns up unasked, not about access. A link, a bookmark, an offline download and reading
progress all keep working while the library is hidden, because losing your place is not tidying.

**Access.** **Access** on a library row lists who can open it. One thing worth knowing: a member with no
limits set can open every library, including ones you add later. Unticking them here is what turns that into
an explicit list -- so granting a library to an unrestricted member changes nothing, and revoking one is what
narrows them.

**Filing a series by hand.** Edit any series and set **Library**, or select several on the Library page and
use **Move to library**. A series filed by hand stays put: rescans, newly created libraries and re-pathing an
existing one all leave it alone. Set it back to **Automatic** to hand it to the folder rule again.

Nothing changes until you declare something. A fresh install and an upgraded one both start with a single
library covering the whole root, no reading progress moves, no files are touched, and removing a library
returns its series to whichever library still covers their folder.

![Libraries](shots/admin-libraries.webp)

Once you have more than one, the Library page grows a row of tabs to switch between them.

**Members:** create accounts (user or admin), reset passwords, and per-user controls: make admin/member,
disable, or allow/deny downloads. Each row shows whether the member has 2FA on.

Each member also has an **age limit**, next to their library access. Set one and anything rated above it
disappears from that account entirely: the library page, search, the reader, the offline downloads and any
external OPDS app. Admins are never limited.

Ratings themselves come from `ComicInfo.xml` when a chapter carries one, and you can set or correct any
series from its own page under **Edit details**. Your correction survives a rescan.

**A series with no rating stays visible to everyone.** That is deliberate: almost nothing in a real library
is rated, so hiding unrated content would empty a child's account rather than filter it, and would read as
the app losing the library. Rating a series opts *that title* in to being filtered — it never opts the rest
of the library out. This means an age limit is only as good as the ratings you have set, which is the honest
trade for not breaking every existing install.

Each member also has **library access**. The default is *all libraries*, which is the **absence** of any
restriction rather than a list of every library -- so a member set to "all" also sees libraries you create
later, without you having to remember to grant them. Restrict someone to a subset and the libraries they were
not granted disappear from their library page, search, the updater feed, OPDS, and the image server. There is
no route that answers for a library a member cannot open.

One limit worth knowing: restricting access applies immediately on the server, but chapters and images a
member already opened or downloaded may remain in that browser's own offline storage until they clear it.
The server cannot reach into a device it does not control.

**Providers:** the source health + Add-a-site controls from section 7. This tab also holds **Import a list**,
for moving a library over from another app:

- **Mihon / Tachiyomi backup** — pick your `.tachibk` (or `.proto.gz`) file. Only the titles are read; the
  file never leaves your server, and nothing about your Mihon sources or accounts is used.
- **MangaDex list** — paste the link to a **public** custom list. Private follows would need a MangaDex
  login, which Uchiyomi never asks for; make a list public and share that instead.
- **Paste titles** — one per line, from anywhere.

Whichever you use, the titles land in the box for you to review first. Anything already in your library is
removed from the list automatically, so you can delete lines you don't want before starting. Uchiyomi then
searches your configured sources for each title and adds the best match, showing live progress and a
per-title result (added / already had / not found / failed).

Importing hundreds of titles takes a while on purpose: downloads are paced so a big import doesn't hammer
the sites you're pulling from and get your server blocked.

**Tasks:** run the **library scan**, **check-for-new-chapters** or **extension updates** on demand, and see
when each last ran and what it did. Extension updates run every 6 hours on their own and can be switched
off in Settings; see [extensions.md](extensions.md).

**Activity:** the audit feed, every login (success and failure), user change, settings change, source action.

**Sessions:** every active session across all users, with one-click revoke.

![Settings](shots/admin-settings.webp)

**Settings:** server name, an **open-registration** toggle (let anyone sign up), and the **auto-update
interval** (how often Uchiyomi checks your library for new chapters).

---

## 9. Security: 2FA, sessions, password

![Security](shots/profile-security.webp)

In **Profile → Security** (every user has this):

- **Change password:** requires your current password; changing it signs out your other devices.
- **Two-factor authentication:** tap **Set up 2FA**, scan the QR with any authenticator app (Google
  Authenticator, Authy, 1Password…), enter a code to enable, and **save your recovery codes** (shown once).
  After that, logins ask for the 6-digit code. Disable it anytime by confirming your password.
- **Active sessions:** see every device you're signed in on (with IP + last-active), revoke any one, or
  **Log out others** in a single click.

Uchiyomi also locks an account after repeated failed logins and records everything in the admin audit feed.

---

### API tokens

A normal sign-in expires every 15 minutes, which is fine for a browser and useless for a script. Under
**Profile → Security → API tokens** you can create a long-lived token instead, scoped to **read**, **write** or
**admin**, with an optional expiry. The token is shown once, so copy it then, and you can revoke it at any time.

Scopes only ever restrict: a read-only token gets a 403 on anything that changes data, and an admin-scoped
token on a non-admin account still can't reach the admin API. See [docs/api.md](api.md) for the endpoints.

![API tokens](shots/crop-tokens.webp)

## 10. Tracking: AniList sync

Connect your AniList account once under **Profile → Progress tracking** and finishing a chapter here updates
your AniList list on its own.

Paste an access token from AniList's developer settings. Progress is the highest chapter you have **finished**,
so re-reading an old chapter never rewinds your list, and AniList being slow or down can never delay or block
your reading. If your token expires or is rejected, Uchiyomi disables the connection and says so rather than
failing silently. Disconnect at any time.

![AniList sync](shots/crop-anilist.webp)

## 11. Install as an app & offline

Uchiyomi is a **PWA**. In your browser's menu choose **Install app** (or "Add to Home Screen" on mobile) to get a
standalone, full-screen app icon.

**Offline:** favorite a series (or use **Download all** / a chapter's ⬇), and those chapters are stored on the
device for reading with no connection. The **Downloads** screen shows what's saved and a **Sync now** button;
with smart-offline on, your favorites' next unread chapters auto-download while you're online.

---

## 12. Backups & restore

Uchiyomi backs itself up. Every night (03:00 by default) it writes a compressed dump of the database plus an
archive of your config to `/backups`, keeping the most recent 14 runs. You can also run it on demand from
**Admin → Tasks → Backup database & config → Run now**, which shows the last run time and size.

> **If you are on v0.9.0 or v0.9.1 of the single container, your backups are empty.** Those images were
> built without the Postgres client, so the task produced a 20-byte file and still reported success. Update
> to v0.9.2 or later, then check: a real dump is megabytes.
>
> ```
> docker compose exec uchiyomi pg_dump --version
> ```
>
> No output means the image cannot dump, whatever the Tasks panel says.

**What's in a backup:** accounts and passwords, everyone's reading progress and history, favorites,
collections, ratings, the catalogue, your admin art overrides, and any custom sites you added.
**What isn't:** downloaded chapter files and the image cache — those are large and re-downloadable, so
including them would turn a 3 MB backup into a 70 GB one.

**Where they go.** By default a Docker volume. Point `BACKUP_PATH` at a host directory to put them somewhere
you control — ideally **a different physical disk than your Docker volumes**, so a failed drive doesn't take
the backups with it:

```
BACKUP_PATH=/mnt/backups/uchiyomi
```

The directory must be writable by uid `10002` (the app's user):
`docker run --rm -v /mnt/backups:/b alpine chown 10002:10002 /b/uchiyomi`

Tune with `BACKUP_KEEP` (how many runs to retain, default 14) and the backup hour in the database
(`server_settings.backup_hour`).

### Restoring

Each backup folder is named by timestamp and holds `db.sql.gz` and `config.tar.gz`. The dump is plain SQL, so
any `psql` can restore it — no matching tool versions required.

Restore the database into a **fresh, empty** database first and check it looks right before touching your real
one:

```
docker exec uchiyomi sh -c 'gunzip -c /backups/20260819-030000/db.sql.gz' | docker exec -i -e PGPASSWORD="$DB_PASSWORD" uchiyomi-db psql -U yomi -h 127.0.0.1 -d yomi
```

Then restore the config files (custom sites, uploaded cover art, the JWT secret):

```
docker exec -i uchiyomi sh -c 'tar -xzf - -C /config' < config.tar.gz
```

Restart the app afterwards (`docker compose restart uchiyomi`). If you restore the database *without* the
config archive, any admin-uploaded cover art will be missing even though the database still references it.

> Container names above are the shipped install: one app container named `uchiyomi`, plus `uchiyomi-db`.
> On the deprecated split layout the app container is `uchiyomi-bff`; if you cloned the repo and run the
> development stack, they are `yomi-bff` and `yomi-db`. Substitute accordingly.
> (The development stack also runs Postgres 15 rather than 16; the dumps are plain SQL, so they restore either
> way, but don't expect the two data directories to be interchangeable.)

> Test your restore at least once, into a scratch database, while nothing is on fire. An untested backup is
> a guess.

## 13. Troubleshooting & FAQ

**The app loads but my library is empty.** Point `LIBRARY_PATH` at your manga and restart: it mounts read-only
at `/library`, and any folder layout is read. If it is still empty, check that your chapters are `.cbz`,
`.cbr` or folders of images, and that they sit no more than six directories below the library root (raise
`LIBRARY_MAX_DEPTH` if your collection is nested deeper than that). New or changed files are picked up by the scheduled
scan; you can also force a rescan from the admin panel, or restart the stack.

**I never set an admin password / can't sign in.** If no users exist yet, just open the app and the first-run
screen lets you create the admin. If an admin already exists, reset the password under **Profile → Security**.

**A source/site won't add.** Paste the site's **base URL** (e.g. `https://example.com`), not a series page.
Uchiyomi auto-detects the engine (Madara, MangaThemesia, Manganato); Cloudflare-protected sites are handled
automatically by the bundled FlareSolverr. A ⛔/⚠ badge on a source means it's temporarily blocked or
rate-limited — wait a bit, or try another source.

**Behind a reverse proxy, login/cookies don't stick.** Set `PUBLIC_ORIGIN` to the exact public URL you use (e.g.
`https://manga.example.com`) so cookies and CORS match, and serve it over HTTPS.

**"Install app" / Add to Home Screen isn't offered.** PWAs need a secure context: serve Uchiyomi over HTTPS (or
`http://localhost`). On iOS, use Safari → Share → Add to Home Screen.

**I lost my 2FA device.** Enter one of the recovery codes (shown when you enabled 2FA) on the login screen instead
of the 6-digit code — that is the intended way back in, so keep them somewhere that is not the phone.

If the recovery codes are gone too, the account cannot be recovered from the UI: turning 2FA off is
self-service (**Profile → Security**) and needs the account's own password, and there is deliberately no admin
override. Someone with server access can clear it directly:

```bash
docker compose exec uchiyomi-db psql -U yomi -d yomi \
  -c "UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}' WHERE username = 'them';"
```

(The database user and database are both `yomi` in the shipped compose files, even on the install path.)

---

Questions or issues? Open an issue on the repo.
