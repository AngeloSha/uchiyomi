# Logo options (kept in case we switch)

Uchiyomi's logo is the faceted **読 ("read")** kanji mark in violet→magenta. **Option 3** was chosen and is live
(generated into `web/public/icons/`). The rest are here for easy switching:

- `option-3-CHOSEN.png` — the live logo source (1024px)
- `option-1.jpg`, `option-2.png`, `option-4.jpg` — the other faceted-kanji takes
- `uchiyomi-master.png` — **the current mark** (faceted 読 under a roof), source for every shipped icon
- `previous-logo.svg` — the pre-Uchiyomi kanji mark

To switch: drop a new source over the icon set with
`docker run --rm -v $PWD/logo-options:/w yomi-bff:prod node -e '...sharp resize...'` then rebuild web.
