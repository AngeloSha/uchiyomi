# Extensions (Mihon / Tachiyomi sources)

Uchiyomi ships **generic engines** that reach whole families of manga sites by URL. On top of that it can use
the **Mihon / Tachiyomi extension ecosystem** — the same extensions those apps use, roughly 1,400 of them.

You browse and install them from **Admin → Providers → Extensions**. There is nothing to set up first.

## Using it

1. Open **Admin → Providers**. The Extensions panel says `ready`.
2. **Add a repository** (once). Uchiyomi doesn't host extensions, so you point it at a repository you trust —
   the same URL you would paste into Mihon. Open **Manage** in the Extensions panel and add it.
3. **Search and click Add.** The extension installs, its sources switch on straight away, and it is
   searchable from Discover immediately. No second step, no restart.

Adult extensions are hidden until you tap **18+**. Installed ones show **Remove**, and one with a newer
version shows **Update**.

## Why there is a second container

Those extensions are Kotlin, compiled to Android bytecode and shipped as APKs. They cannot run in Uchiyomi's
Node server, and there is no converter — "porting" them would mean rewriting hundreds by hand.

[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) is the one project that solved this. It converts an
extension's Android bytecode to JVM bytecode and supplies a fake Android runtime so the extension believes it
is on a phone, right down to a headless browser for the ones that need to get past Cloudflare.

So Uchiyomi runs Suwayomi as an **extension engine** and nothing else. It starts with the rest of the stack,
Uchiyomi configures itself to talk to it, and you never open it. Uchiyomi keeps owning your library, reader,
downloads, updates, users and UI; the engine only answers "search this", "list these chapters", "give me this
chapter's pages".

The cost is honest: it is a JVM and sits around 800 MB of RAM once running.

## How it behaves

- **Uchiyomi does the downloading.** Chapters land in your own library as CBZ files exactly like every other
  source, so there is one library, one updater and one set of files.
- **Cloudflare is the engine's problem, not ours.** These sources skip Uchiyomi's FlareSolverr entirely.
- **If the engine is down, Uchiyomi is fine.** It boots normally, the built-in engines keep working, the panel
  says it is unreachable, and extension-backed series simply do not update until it is back.
- **Series stay routed** by the source they came from, so the scheduled updater keeps pulling new chapters.

Two things worth knowing:

- A series added through an extension is routed using an id from the engine's own database. Wiping that
  database loses the routing for those series (they stay in your library; re-adding repairs it). Don't delete
  its volume.
- Every source you enable is queried on every cross-source search. Installing a handful is fine; installing
  hundreds would make search slow and hammer a lot of sites at once. `SUWAYOMI_MAX_SOURCES` (default 25) is a
  backstop, and it logs what it skipped rather than silently dropping it.

## Turning it off

Set `SUWAYOMI_URL=` (empty) in `.env` and restart the BFF; the panel disappears and nothing else changes. To
reclaim the RAM as well, `docker compose stop uchiyomi-suwayomi` (`yomi-suwayomi` in the development stack).

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SUWAYOMI_URL` | the bundled engine | Where the extension engine is. Empty turns the feature off. |
| `SUWAYOMI_USERNAME` / `SUWAYOMI_PASSWORD` | empty | Only if your engine has authentication enabled. |
| `SUWAYOMI_MAX_SOURCES` | `25` | Ceiling on how many extension sources register at once. |

You can point `SUWAYOMI_URL` at a Suwayomi you already run instead of the bundled one; Uchiyomi doesn't care
whose it is.

The image is pinned rather than tracking `:stable`, because `:stable` is older than the extension API today's
repository indexes require and would show an empty catalogue.

## Where the line is

Uchiyomi's code contains **no scraper, no site name, and no repository URL**. The catalogue you browse comes
from repositories *you* add, and the engine does the fetching and installing. Uchiyomi never hosts or
redistributes an extension, and ships no default repository — so nothing is fetched from anywhere until you
choose a source for it.

What you point it at, and whether that is lawful where you live, is your call and your responsibility.
