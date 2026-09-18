// Shapes for the reviewable import (backup / MangaDex list / paste → match review → add). Mirrors
// import_batches / import_candidates in bff/src/lib/migrate.ts field for field — these come straight off
// `SELECT *`, so the server sends its column names as-is (same convention as e.g. `u.display_name` in the
// admin members list) rather than translating to camelCase.
import { t as tr } from './i18n';
import { normTitle } from './normTitle';

export type ImportOrigin = 'backup' | 'mangadex' | 'paste';
export type ImportBatchState = 'resolving' | 'review' | 'importing' | 'done' | 'cancelled';
export type ImportDecision = 'unresolved' | 'auto' | 'manual' | 'skip';
export type MatchConfidence = 'same_source' | 'exact' | 'contains' | 'fuzzy';

export interface ImportBatch {
  id: string;
  user_id: string;
  origin: ImportOrigin;
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
}

/** One row of GET /api/admin/import/batches: enough to name a batch on the intake card and open it. */
export interface ImportBatchSummary {
  id: string;
  origin: ImportOrigin;
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
}

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

/** A row worth a second look: no match at all, or one uncertain enough that a person should confirm it. */
export function needsAttention(c: ImportCandidate): boolean {
  if (c.decision === 'skip') return false;
  if (c.decision === 'unresolved') return true; // once the batch is out of 'resolving', this means "no match found"
  if (c.decision !== 'auto') return false; // a manual pick was already looked at by a person
  if (c.confidence === 'fuzzy') return true;
  return c.confidence === 'contains' && containsDiverges(c.backup_title, c.match_title);
}

/**
 * Whether the review row should print the matched title on its own line. Hidden when it is the backup
 * title under another spelling -- case, punctuation -- so the line only ever says something the first line
 * does not, and a list of two hundred correct rows is not two hundred repeated titles.
 */
export const matchTitleDiffers = (c: ImportCandidate): boolean =>
  !!c.match_title && normTitle(c.match_title) !== normTitle(c.backup_title);

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

/** Where a batch came from, in words, for the "Open imports" list. */
export function batchOriginLabel(origin: ImportOrigin): string {
  switch (origin) {
    case 'backup': return tr('Backup file');
    case 'mangadex': return tr('MangaDex list');
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
export function runStatusLabel(status: string): string {
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
