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
// the art lookups, the add, the backfill, the recheck (lib/matchCheck.ts) and the direction and type signals.

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
 * A name as namesMatch compares it: its titleKey, with a leading English article set aside when what follows still says
 * something. "The God Game" and "God Game" are one name, on AniList and on the site a series came from: run over the
 * owner's library before release, the plain titleKey rule unlinked eight true matches over a "The" -- "Player Who Can't
 * Level Up" for AniList's "The Player Who Can't Level Up", "Boundless Necromancer" whose AniList entry goes by "The
 * Boundless Necromancer" -- beside the one wrong link it was for (Kaiju No. 8 → the spin-off "Kaiju No. 8: Relax").
 * Not when the rest is short (under six letters): "The One" is not "One". Reintroduce titleKey here: "a leading article
 * is not part of the name" in onlineMatch.test.ts unlinks The God Game.
 */
export function nameKey(t: string | null | undefined): string {
  const k = titleKey(t);
  const m = /^\s*(?:the|a|an)\s+(\S.*)$/is.exec(String(t ?? ''));
  if (!m) return k;
  const rest = titleKey(m[1]);
  return rest.length >= 6 ? rest : k;
}

/**
 * Does any name the entry goes by equal any name the series goes by, by nameKey? False when either side has no name
 * that folds to something: an empty key never equals another empty key. Reintroduce containment (`k.includes(w)`):
 * "a spin-off is not the work" in onlineMatch.test.ts accepts "Morgan Lost: Dark Novels" for "Morgan Lost".
 */
export function namesMatch(
  ours: Iterable<string | null | undefined> | string,
  theirs: Iterable<string | null | undefined> | null | undefined,
): boolean {
  const want = new Set([...(typeof ours === 'string' ? [ours] : ours)].map(nameKey).filter(Boolean));
  if (!want.size) return false;
  for (const t of theirs ?? []) {
    const k = nameKey(t);
    if (k && want.has(k)) return true;
  }
  return false;
}

/** An AniList media an image on its CDN belongs to: covers and banners carry the entry's id in their file name. */
export interface AniListMedia { type: 'MANGA' | 'ANIME'; id: number }

/**
 * The AniList entry a stored cover or banner came from, read off its URL, or null for anything else (another host, a
 * default picture with no id). `.../media/manga/cover/large/bx105398-b673Vt5ZSuz3.jpg` is manga 105398;
 * `.../media/anime/banner/16498-8jpFCOcDmneX.jpg` is anime 16498 -- the banner of an adaptation, which the art lookup
 * takes when the manga has none of its own (lib/anilist.ts).
 */
export function aniListMediaOf(url: string | null | undefined): AniListMedia | null {
  let u: URL;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (!/(^|\.)anilist\.co$/i.test(u.hostname)) return null;
  const m = /\/media\/(manga|anime)\/(?:cover\/[a-z]+|banner)\/[a-z]{0,2}(\d{1,10})(?=[-_.])/i.exec(u.pathname);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type: m[1].toLowerCase() === 'anime' ? 'ANIME' : 'MANGA', id } : null;
}

/** MangaDex's ids are UUIDs. */
const MANGADEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The MangaDex title a stored cover came from, read off its URL (`https://uploads.mangadex.org/covers/<id>/<file>`, the
 * shape the MangaDex adapter builds), or null for anything else.
 */
export function mangaDexIdOf(url: string | null | undefined): string | null {
  let u: URL;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (!/(^|\.)mangadex\.org$/i.test(u.hostname)) return null;
  const m = /^\/covers\/([^/]+)\//.exec(u.pathname);
  return m && MANGADEX_UUID.test(m[1]) ? m[1].toLowerCase() : null;
}
