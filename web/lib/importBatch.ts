// Shapes for the reviewable import (backup / MangaDex list / paste / tracker list → match review → add).
// Mirrors import_batches / import_candidates in bff/src/lib/migrate.ts field for field — these come straight
// off `SELECT *`, so the server sends its column names as-is (same convention as e.g. `u.display_name` in
// the admin members list) rather than translating to camelCase.
import { t as tr } from './i18n';
import { normTitle } from './normTitle';

/** `tracker` (v0.36.0) is the reading list of an AniList / MyAnimeList / Kitsu account connected under Profile. */
export type ImportOrigin = 'backup' | 'mangadex' | 'paste' | 'tracker';
/** The tracker a `tracker` batch was read from; the same ids `GET /api/trackers` uses. */
export type TrackerId = 'anilist' | 'myanimelist' | 'kitsu';
export type ImportBatchState = 'resolving' | 'review' | 'importing' | 'done' | 'cancelled';
export type ImportDecision = 'unresolved' | 'auto' | 'manual' | 'skip';
export type MatchConfidence = 'same_source' | 'exact' | 'contains' | 'fuzzy';

export interface ImportBatch {
  id: string;
  user_id: string;
  origin: ImportOrigin;
  /** Which tracker a `tracker` batch came from; null on the other origins, absent from an older server. */
  tracker?: TrackerId | string | null;
  state: ImportBatchState;
  total: number;
  resolved: number;
  added: number;
  already: number;
  failed: number;
  created_at: string;
  updated_at: string;
  /** Computed by the GET route, not a DB column: `resolving` with nobody actually resolving it. */
  stale?: boolean;
  /**
   * What the tracker intake dropped or cut (v0.36.0), on the batch row so a reload or an Open-imports tap
   * still says "2 novels skipped (first 500 kept)" -- the intake's answer used to be the only carrier, and
   * a closed tab lost the note. Absent from an older server, 0 / false on the other origins.
   */
  skippedNovels?: number;
  truncated?: boolean;
}

/** One row of GET /api/admin/import/batches: enough to name a batch on the intake card and open it. */
export interface ImportBatchSummary {
  id: string;
  origin: ImportOrigin;
  tracker?: TrackerId | string | null;
  state: ImportBatchState;
  total: number;
  resolved: number;
  added: number;
  failed: number;
  created_at: string;
  /** Computed by the list route like the GET route's: `resolving` with nobody actually resolving it. */
  stale?: boolean;
}

/**
 * The batches worth listing under "Open imports": anything a person could still act on. A finished or
 * cancelled batch has nothing left to open -- the sweep clears it -- and listing it would make the card a
 * history log rather than the "you left this one half-way" reminder it is for.
 */
export const openBatches = (list: ImportBatchSummary[]): ImportBatchSummary[] =>
  list.filter((b) => b.state !== 'done' && b.state !== 'cancelled');

export interface ImportCandidate {
  id: string;
  batch_id: string;
  ord: number;
  backup_title: string;
  backup_source_id_unsigned: string | null;
  backup_source_id_signed: string | null;
  backup_url: string | null;
  in_library: boolean;
  decision: ImportDecision;
  confidence: MatchConfidence | null;
  match_source: string | null;
  match_source_id: string | null;
  match_title: string | null;
  match_cover: string | null;
  auto_source: string | null;
  auto_source_id: string | null;
  auto_title: string | null;
  auto_cover: string | null;
  auto_confidence: MatchConfidence | null;
  status: string | null;
  // ---- tracker rows (v0.36.0). Null on backup / MangaDex / paste rows; absent from an older server. ----
  /** The tracker this entry came from, and its id there -- what `/run` links the added series to. */
  tracker?: TrackerId | string | null;
  external_id?: string | null;
  /** The other spellings the tracker knows (romaji, synonyms; at most 3), searched when the title misses. */
  alt_titles?: string[] | null;
  /** The term the match was found under: the search title, or one of `alt_titles`. */
  matched_via?: string | null;
  /**
   * Set on an `in_library` row the intake linked to the tracker entry on the spot, so progress sync works
   * for the titles a person already holds -- the common case for an established library.
   */
  linked?: boolean | null;
}

/** Every spelling a row may legitimately have been matched under: the backup title first, then the tracker's alternates. */
const titleVariants = (c: ImportCandidate): string[] =>
  [c.backup_title, ...(c.alt_titles ?? [])].filter((t) => !!t && !!t.trim());

/**
 * The bits of a trailing qualifier that make it a DIFFERENT WORK rather than another spelling of the same
 * one: a digit ("Season 2", "Part 3", "Chapter 2"), or a word that names a sequel, a side story, a
 * novelisation or a companion book. Matched inside the normalised extra text, which `normTitle` has stripped of spaces and
 * punctuation, so these are substrings rather than words -- chosen so that "official", "colored", "manhwa",
 * "webtoon", "manga" and "comic", the suffixes apps hang off the SAME title, contain none of them. A roman
 * numeral counts only when it is the whole extra ("Title II"): "ii" or "iv" as bare substrings would fire
 * inside ordinary words.
 *
 * ⚠️ Reintroduce the bug by dropping this list: "Solo Leveling: Ragnarok" is then a calm close match for
 * "Solo Leveling", which is the wrong-work pick the Needs attention filter exists to surface.
 */
const SEQUEL_MARK = /\d|season|part|novel|ragnarok|super|arc|gaiden|sequel|prequel|spinoff|sidestory|next|before|after|chapter|vol|fanbook|anthology|artbook/;
const ROMAN_NUMERAL = /^(ii|iii|iv|vi|vii|viii|ix)$/;

/**
 * The qualifiers apps hang off the SAME title -- an edition, a format, a language -- which say nothing
 * about which work it is. Removed from the extra before the length rule in `containsDiverges`, because
 * "(Official Colored)" is longer than "Naruto" and the length rule alone read it as another title, the way
 * it reads "of Gluttony" hanging off "Berserk"; a residue of nothing means the extra was these words and
 * nothing else. Substrings of the normalised extra (no spaces or punctuation), and only ever tested for an
 * EMPTY residue, so "fan" eating the front of "fantasy" leaves "tasy" and changes nothing.
 *
 * ⚠️ Reintroduce the bug by dropping this strip: "Naruto (Official Colored)" is then flagged for a person to
 * look at, on a list where most rows are exactly that.
 */
const EDITION_WORD = /official|colou?red|colou?r|full|digital|manhwa|manhua|manga|webtoon|webcomic|comics?|edition|uncensored|fan|english|eng|hd|hq/g;

/**
 * Whether a `contains` hit differs from the backup title by more than a trailing qualifier.
 *
 * The server grants `contains` whenever one normalised title is a substring of the other, and shows it as a
 * calm "close match". That is right for the common case -- "Solo Leveling" against "Solo Leveling (Official)",
 * "One Piece" against "One Piece Colored" -- where an app spells the same title with a suffix. It is wrong
 * for three shapes in which a DIFFERENT title contains this one: extra words in front or on both sides
 * ("Naruto" inside "Boruto: Naruto Next Generations"), a "suffix" longer than the title it hangs off
 * ("Berserk" inside "Berserk of Gluttony"), and a short suffix that names a sequel, a season or a novel
 * ("Solo Leveling: Ragnarok", "Tower of God Season 2", "… (Novel)"). The third is the
 * commonest by far: a cross-source `contains` is reached only when that source does NOT carry the plain
 * title (`exact` is tried first), and a source that has the sequel almost always has the original too --
 * so a suffix-only hit is disproportionately the other work. Either title may be the one carrying the
 * suffix (a backup of "Tower of God Season 2" matched to "Tower of God" is the same wrong pick in reverse).
 * Those are the rows that deserve the Needs attention chip: a wrong add is a series a person has to find
 * and remove, a needless glance costs a second. The one thing that must stay calm at any length is an
 * edition qualifier -- "(Official Colored)", "(Full Color)", ": Digital Colored Comics" -- which is what
 * most `contains` rows on a real list are.
 */
export function containsDiverges(backupTitle: string, matchTitle: string | null): boolean {
  const a = normTitle(backupTitle);
  const b = normTitle(matchTitle || '');
  if (!a || !b || a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return true;
  const extra = long.slice(short.length);
  // Edition words first, whatever their length: "(Official Colored)" is the same title. Then a sequel
  // marker, whatever its length: ": Ragnarok" is another one. Only then does length decide.
  if (!extra.replace(EDITION_WORD, '')) return false;
  if (SEQUEL_MARK.test(extra) || ROMAN_NUMERAL.test(extra)) return true;
  return extra.length > short.length;
}

/**
 * A row worth a second look: no match at all, or one uncertain enough that a person should confirm it.
 *
 * A `contains` hit is judged against EVERY spelling the row carries and the calmest verdict wins. A tracker
 * row has the English title as `backup_title` and the romaji or synonyms in `alt_titles`; the server
 * searches the alternates when the title misses, and rightly grants `contains` for "Shingeki no Kyojin
 * (Official)" against the romaji. Judged against the English title alone that hit has no overlap at all,
 * so every alt-title match -- the feature's whole point -- landed under Needs attention, in amber.
 * ⚠️ Reintroduce by testing `containsDiverges(c.backup_title, c.match_title)` alone.
 */
export function needsAttention(c: ImportCandidate): boolean {
  if (c.decision === 'skip') return false;
  if (c.decision === 'unresolved') return true; // once the batch is out of 'resolving', this means "no match found"
  if (c.decision !== 'auto') return false; // a manual pick was already looked at by a person
  if (c.confidence === 'fuzzy') return true;
  return c.confidence === 'contains' && titleVariants(c).every((t) => containsDiverges(t, c.match_title));
}

/**
 * Whether the review row should print the matched title on its own line. Hidden when it is the backup
 * title under another spelling -- case, punctuation -- so the line only ever says something the first line
 * does not, and a list of two hundred correct rows is not two hundred repeated titles. A tracker row's
 * alternates count as its spellings too: "Attack on Titan → Shingeki no Kyojin · exact match" in bright
 * text read as a wrong pick, when it is the same title under the name the source uses; that row gets the
 * dim `matched under its other name` line instead (`matchedViaAlt`).
 */
export const matchTitleDiffers = (c: ImportCandidate): boolean =>
  !!c.match_title && !titleVariants(c).some((t) => normTitle(c.match_title!) === normTitle(t));

/**
 * Whether the match was found under one of the tracker's other spellings rather than the title on the
 * row. The server records the term that matched in `matched_via`; when it is the row's own title there is
 * nothing to say. Compared normalised, because the server may store the term as it searched it.
 *
 * Only for the automatic match: `matched_via` belongs to the pick the server made, and a hand-picked row
 * used to keep it, so "Attack on Titan → Berserk of Gluttony · matched under its other name · picked by
 * hand" explained a match that no longer existed as if it were a statement about the person's own pick.
 * The server clears the field on a manual pick too; an older server does not, hence the check here.
 */
export const matchedViaAlt = (c: ImportCandidate): boolean =>
  c.decision === 'auto' && !!c.matched_via && !!c.matched_via.trim() && normTitle(c.matched_via) !== normTitle(c.backup_title);

/**
 * How many rows the intake linked to their tracker entry without adding anything: an in-library title on a
 * tracker list gets its `series_trackers` row at intake, status `already`, and the run never touches it.
 * A batch of nothing but those closes to `done` on its first read, so the review row's "linked for progress
 * sync" is never seen -- the done card has to say it, or an established library that connects its tracker
 * reads "0 added · 5 already had · 0 failed" and concludes nothing happened.
 */
export const linkedCount = (items: ImportCandidate[]): number =>
  items.filter((c) => c.status === 'already' && !!c.linked).length;

/** The done headline's aside for `linkedCount`, singular by hand (the i18n layer has no plural rules); null for none. */
export function linkedLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? tr('1 linked for progress sync') : tr('{n} linked for progress sync', { n });
}

/** Where a batch stands, in words, for the "Open imports" list. Every call site passes a literal state. */
export function batchStateLabel(state: ImportBatchState): string {
  switch (state) {
    case 'resolving': return tr('Matching…');
    case 'review': return tr('Ready to review');
    case 'importing': return tr('Importing…');
    case 'done': return tr('Done');
    default: return tr('Cancelled');
  }
}

/**
 * Where a batch came from, in words, for the "Open imports" list. A tracker batch is named after its
 * tracker -- "AniList list", not "Tracker list" -- because a person with two connected may have started
 * one from each. Every branch is a literal, so the locale-parity test sees each label; the service names
 * are proper nouns and stay as they are in every language.
 */
export function batchOriginLabel(origin: ImportOrigin, tracker?: string | null): string {
  switch (origin) {
    case 'backup': return tr('Backup file');
    case 'mangadex': return tr('MangaDex list');
    case 'tracker':
      switch (tracker) {
        case 'anilist': return tr('AniList list');
        case 'myanimelist': return tr('MyAnimeList list');
        case 'kitsu': return tr('Kitsu list');
        default: return tr('Tracker list');
      }
    default: return tr('Pasted titles');
  }
}

/** Short label for the confidence chip. `keys()` isn't needed here — every call site passes a literal. */
export function confidenceLabel(c: MatchConfidence | null): string {
  switch (c) {
    case 'same_source': return tr('same source as before');
    case 'exact': return tr('exact match');
    case 'contains': return tr('close match');
    case 'fuzzy': return tr('possible match');
    default: return tr('unmatched');
  }
}

/**
 * What a row says once /run has been over it. `status` is either `added` / `already` or the `error` code
 * `addSeriesFromSource` (routes/sources.ts) answered with, written to the row verbatim -- so without this
 * table the row printed "Failed — duplicate" and "Failed — no_chapters" in red, a snake_case API token as
 * user-facing text. `duplicate` reads as "already in your library" because that is what it means: the
 * library holds the title under another spelling, which is not a failure the person can do anything
 * about. Codes this table does not know keep the generic line WITH the code, so a new one is at least
 * visible rather than silently "failed". Every branch passes a literal, like confidenceLabel above, so the
 * locale-parity test sees each sentence.
 */
export function runStatusLabel(status: string, linked = false): string {
  // ⚠️ An owned row of a tracker intake is written with status `already` the moment it is linked, so it
  // reaches THIS label, never the `decision === 'skip'` branch that spelled out the link. The release walk
  // caught the review row reading a bare "Already in your library" beside a series_trackers row that was
  // already there -- the one sentence the intake exists to say for those rows.
  if (status === 'already' && linked) return tr('Already in your library — linked for progress sync');
  switch (status) {
    case 'added': return tr('Added to your library');
    case 'already':
    case 'duplicate': return tr('Already in your library');
    case 'no_chapters': return tr('No readable chapters on this source');
    case 'disabled': return tr('That source is switched off');
    case 'blocked': return tr('The source is blocking us right now');
    case 'undownloadable': return tr('Nothing could be fetched from this source');
    case 'disk_full': return tr('Not enough disk space');
    case 'bad_request': return tr('The pick was incomplete — choose it again');
    case 'no_title': return tr('The source did not answer — try again');
    default: return tr('Failed — {reason}', { reason: status });
  }
}

/** Tailwind text colour for the run status: green for a new row, quiet for one the library already had. */
export function runStatusColor(status: string): string {
  switch (status) {
    case 'added': return 'text-emerald-400';
    case 'already':
    case 'duplicate': return 'text-fog-500';
    default: return 'text-red-400';
  }
}

/** Tailwind text colour for the confidence chip, matching the amber/emerald vocabulary used elsewhere
 *  (health status, chapter cadence) rather than inventing a third palette for this one screen. */
export function confidenceColor(c: MatchConfidence | null): string {
  switch (c) {
    case 'same_source':
    case 'exact': return 'text-emerald-400';
    case 'contains': return 'text-fog-400';
    case 'fuzzy': return 'text-amber-400';
    default: return 'text-amber-400';
  }
}
