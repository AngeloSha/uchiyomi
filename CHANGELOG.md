# Changelog

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
- Private MangaDex follows are not supported: they need an account login, which Koryomi doesn't ask for.

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

## v0.2.1 — 2026-08-09

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

## v0.1.0 — 2026-07-19

Initial public release.
