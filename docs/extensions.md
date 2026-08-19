# Extensions (Mihon / Tachiyomi sources)

Uchiyomi ships **generic engines** that reach whole families of manga sites by URL, which covers most sites
without any code. This page is about the other option: reading from the **Mihon / Tachiyomi extension
ecosystem**, which reaches far more sites than any set of engines can.

It is optional, off by default, and nothing about Uchiyomi changes until you turn it on.

## Why it needs a second container

Those extensions are Kotlin, compiled to Android bytecode and shipped as APKs. They cannot run in Uchiyomi's
Node server, and there is no converter — "porting" them would mean rewriting hundreds of them by hand.

[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) is the one project that solved this. It converts an
extension's Android bytecode to JVM bytecode and supplies a fake Android runtime so the extension believes it
is on a phone, right down to a headless browser for the ones that need to get past Cloudflare.

So Uchiyomi runs Suwayomi as an **extension engine** and nothing else. Uchiyomi keeps owning your library,
reader, downloads, updates, users and UI; Suwayomi only answers "search this", "list these chapters", "give me
this chapter's pages". You never need to open it except to install extensions.

The cost is honest: it is a JVM, so budget a few hundred MB of RAM.

## Turning it on

**1. Start the engine.** It is profile-gated, so it does not start unless you ask for it:

```bash
docker compose --profile extensions up -d
```

**2. Point Uchiyomi at it** in your `.env`, then restart the BFF:

```
SUWAYOMI_URL=http://yomi-suwayomi:4567
```

If your Suwayomi has authentication on (`AUTH_MODE=simple_login`), add `SUWAYOMI_USERNAME` and
`SUWAYOMI_PASSWORD` too. You can also point at a Suwayomi you already run — Uchiyomi does not care whose it
is, only that it can reach it.

**3. Install extensions in Suwayomi's own web UI.** Uchiyomi never fetches, lists or installs extension
packages, and ships no extension-repo URL; that is deliberate, see "Where the line is" below. Suwayomi needs
an extension repository configured before it will show you anything to install — that is its documentation's
territory, not ours.

**4. Switch on the sources you want**, in **Admin → Providers → Extensions**. Every source you enable becomes
an ordinary Uchiyomi source: it shows up in Discover, in cross-source search, and in the updater.

## Why sources are opt-in one at a time

A full extension set exposes several hundred sources. Uchiyomi's cross-source search queries **every**
enabled source each time you search, so enabling all of them would make search unusable and would hammer
several hundred sites at once. Enable the handful you actually read.

There is a hard ceiling too, `SUWAYOMI_MAX_SOURCES` (default 25). If you exceed it the extra sources are
skipped and the server log says exactly how many were dropped.

## How it behaves

- **Enabling a source tests it immediately** — search, series page, chapter list and pages — and shows you the
  result, so a source that cannot actually work says so now rather than looking empty later.
- **Uchiyomi does the downloading.** Chapters land in your own library as CBZ files, exactly like every other
  source, so there is one library, one updater and one set of files. Suwayomi is not a second library.
- **Cloudflare is Suwayomi's problem, not ours.** These sources skip Uchiyomi's FlareSolverr entirely.
- **If the engine is down, Uchiyomi is fine.** It boots normally, the built-in engines keep working, the admin
  panel says the server is unreachable, and extension-backed series simply do not update until it is back.
- **Series stay routed** by the source they were added from, so the scheduled updater keeps pulling new
  chapters for them with no further involvement from you.

One caveat worth knowing: a series added through an extension is routed using an id from Suwayomi's own
database. If you wipe that database, those series lose their routing and stop updating (they stay in your
library, and re-adding them repairs it). Back it up along with everything else, or don't delete its volume.

## Where the line is

Uchiyomi's published code contains **no scraper and no site name**, and this feature does not change that.
The bridge is an API client for a separate open-source server that *you* install, configure and populate.

Two deliberate limits keep it that way:

- **No extension store inside Uchiyomi.** It never downloads, lists or installs extension packages, and ships
  no default repository. Installing is a trip to Suwayomi's UI. Building the store is the step that would turn
  a reader into a distributor.
- **Nothing bundled by default.** The container is profile-gated and `SUWAYOMI_URL` is empty, so a fresh
  install starts no JVM and reaches no third-party site.

What you point it at, and whether that is lawful where you live, is your call and your responsibility.
