# Changelog

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
