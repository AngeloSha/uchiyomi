// Is an online entry THIS series? The one title check for every match stored by title (v0.55.7, #168).
//
// AniList, MangaDex and Kitsu are asked by a title SEARCH, and a search answers with its best guess whatever it was
// asked: AniList's `sort: SEARCH_MATCH` gave a series called "No Direction" the Japanese "Dear Green: Hitomi no Ounowa",
// and two of Kedryn's four *Morgan Lost* comic folders -- a series with no online source at all -- a manga's cover and
// banner. What came back was stored with no look at its name: the cover and the banner (series_art), and the series'
// AniList link (series_trackers) -- which progress is pushed to, and which Health's "Duplicate series" groups by, so
// Fix everything could merge two unrelated series that were both given one wrong entry.
//
// THE RULE: an entry is this series when one of the names it goes by -- AniList's romaji, English and native titles and
// its synonyms; MangaDex's titles and alternative titles; Kitsu's -- IS one of the names the series goes by here (its
// title, an admin's display title, its other names, lib/altTitles.ts namesOf), once case, accents, bracketed asides
// and punctuation are set aside (titleKey). EXACT equality of the folded names, never containment and never word
// overlap: containment is what a spin-off or a sequel shares with its parent -- "Morgan Lost: Dark Novels" contains
// "Morgan Lost", "Tokyo Ghoul:re" contains "Tokyo Ghoul" -- and other-name lists are exactly where the novel, the
// anime and the spin-off sit beside the work (lib/altTitles.ts, the same rule for the same reason). A true match it
// misses costs a banner the series then makes from its own pages, and a link a tracker import makes by hand; a wrong
// one cost a stranger's cover on the shelf, progress pushed to another work and a merge.
//
// The search may be asked with a cleaned title (lib/anilist.ts drops "(Remake)" and a "- Season 2" tail before asking);
// the ANSWER must still name the series as it is called here. Pure, and importing nothing, so every side can use it:
// the art lookups, the add, the backfill and the direction and type signals.

/**
 * A title as a comparison key: accents, case, bracketed asides and punctuation set aside, any script kept.
 * ⚠️ Only the Latin combining block is stripped, then recomposed: dropping every mark after NFKD also dropped
 * Japanese voicing marks, so だ read as た (directionSignals.test.ts keeps a Japanese title whole).
 */
export function titleKey(t: string | null | undefined): string {
  return String(t ?? '').normalize('NFKD').replace(/[\u0300-\u036f]+/g, '').normalize('NFC').replace(/\([^)]*\)/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Does any name the entry goes by equal any name the series goes by, by titleKey? False when either side has no name
 * that folds to something: an empty key never equals another empty key. Reintroduce containment (`k.includes(w)`):
 * "a spin-off is not the work" in onlineMatch.test.ts accepts "Morgan Lost: Dark Novels" for "Morgan Lost".
 */
export function namesMatch(
  ours: Iterable<string | null | undefined> | string,
  theirs: Iterable<string | null | undefined> | null | undefined,
): boolean {
  const want = new Set([...(typeof ours === 'string' ? [ours] : ours)].map(titleKey).filter(Boolean));
  if (!want.size) return false;
  for (const t of theirs ?? []) {
    const k = titleKey(t);
    if (k && want.has(k)) return true;
  }
  return false;
}
