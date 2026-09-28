// The other names a series goes by, and the one rule for when two names are the same name (v0.49.1).
//
// The idea, the name list and the parsing are @TIGamingTV's (PR #119), rebuilt on the server's own parts.
//
// A series is stored under ONE title. The same manhwa is "Solo Leveling" on one site, "Only I Level Up" on a
// second and "Na Honjaman Level Up" on a third, and a search for the first finds nothing on the other two. Most
// sources list the other names in their own description ("Alternative Titles: …", "Associated Names: …"), and a
// tracker import brings its synonyms (import_candidates.alt_titles), so the names are there to be kept: this
// file reads them, keeps them (series_alt_titles, migrate.ts) and hands them to every search that looks for a
// series on another source -- the Find other sources run (lib/findSources.ts), the add-time auto-follow and the
// nightly hunt (lib/autoFollow.ts, lib/sourceHunt.ts), borrowed chapter names (lib/borrowNames.ts) and the fill
// scan (routes/sources.ts).
//
// ⚠️ THE RULE IS EXACT. An other name matches when its normalised key EQUALS the candidate's -- never when one
// contains the other, never by word overlap. A containment is what a sequel shares with its parent ("Tokyo
// Ghoul:re" / "Tokyo Ghoul"), and other-name lists are exactly where spin-offs, the novel and the anime are listed
// beside the manhwa. A match through an other name is also held to the numbering check both ways (autoFollow.ts
// judgeCandidate), because an exact name is still only a name.
//
// Latin script only. Every other script normalises to the empty string under normTitle (letters and digits
// a-z0-9), so a Korean or Japanese name could never be compared anyway -- and an empty key must never be allowed
// to equal another empty key.
import { q } from './db';
import { normTitle } from './titleMatch';

/**
 * The shortest key an OTHER name may have. A bare "Hero" or "Level" in someone's list of names is a word, not an
 * identity. The same bound as trackerProviders.ts MIN_ALT_KEY, for the same reason. The main title is exempt:
 * "Ajin" is a real four-letter title, and it is judged by numbering like every other.
 */
export const MIN_ALT_KEY = 5;
/** How many names one description may contribute; a list longer than this is a tag cloud, not names. */
export const MAX_PARSED = 20;
/** The longest name kept: a "name" longer than this is a sentence the parser ran into. */
export const MAX_NAME_LEN = 200;
/**
 * How many stored names a search asks under, beside the title: every name is one more search per source that
 * does not carry the series, so the find run, the hunt and the fill scan stop at three (the import's own cap on a
 * tracker's synonyms, trackerProviders.ts titlesOf).
 */
export const SEARCH_NAMES = 3;

/** Where a stored name came from: a source's own description, an admin who typed it, a tracker import. */
export type AltOrigin = 'description' | 'admin' | 'import';

/**
 * The labels sources put in front of the other names. Each must be followed by a colon (or a dash): "also known
 * as" in running prose is a sentence, and reading the rest of it as a name is exactly the guess this file refuses
 * to make.
 */
const LABEL = /(?:alternative|alternate|alt\.?)\s+(?:titles?|names?)|associated\s+names?|other\s+(?:titles?|names?)|also\s+known\s+as|a\.k\.a\.?|synonyms?/i;
const LABEL_LINE = new RegExp(`^[\\s>*_#•\\-]*(?:${LABEL.source})[\\s*_]*(?:\\([^)]{0,20}\\))?[\\s*_]*[:：\\-–—][\\s*_]*`, 'i');
/** A line that starts a new labelled field ("Author: …", "Status: …"): the end of a name list. */
const FIELD_LINE = /^[\s>*_#•-]*[A-Za-z][A-Za-z .]{0,30}[:：]\s*/;
/**
 * A field label INSIDE one name: a description flattened to one line ran the list into "Status: Ongoing". Such a
 * name is dropped whole, never cut at the colon -- cutting "Solo Leveling: Ragnarok" there would MAKE the parent's
 * name out of the sequel's, and a wrong name is worse than a lost one.
 */
const FIELD_INSIDE = /\b(?:status|author|artists?|genres?|type|released?|year|rating|views|chapters?|summary|synopsis|description)\s*[:：]/i;
/** A trailing language or edition tag that says which name this is, not what it is. */
const LANG_TAG = /\s*[([](?:english|eng|en|korean|kr|ko|japanese|jp|ja|chinese|cn|zh|romanized|romanised|romaji|official|raw)[)\]]\s*$/i;

/** True when (nearly) every letter in the name is Latin script: English and romanised names. */
export function isLatinName(name: string): boolean {
  const letters = name.match(/\p{L}/gu);
  if (!letters?.length) return false;
  const latin = name.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters.length >= 0.9;
}

/** One name out of a list, trimmed of the bullets, quotes and tags around it; '' when nothing is left. */
function cleanName(raw: string): string {
  let s = raw.replace(/[*_]{2,}/g, '').trim();
  s = s.replace(/^[\s>*•·\-–—"'“”‘’«»]+/, '').replace(/[\s"'“”‘’«».,;]+$/, '').trim();
  for (let i = 0; i < 2; i++) s = s.replace(LANG_TAG, '').trim();
  return s;
}

/**
 * Split one list into names. The separator is chosen per list, strongest first: a list that uses `;`, `|`, a
 * bullet or line breaks is split on those only, so "Yes, My Lord" survives inside it; a " / " list on those; only
 * a list with nothing else is split on commas. A wrong split can only LOSE a name (the halves fall under
 * MIN_ALT_KEY or match nothing exactly) -- the safe direction for a rule whose failure mode is following the wrong
 * book.
 */
function splitList(text: string): string[] {
  if (/[;|•·\n]/.test(text)) return text.split(/[;|•·\n]+/);
  if (/\s\/\s/.test(text)) return text.split(/\s\/\s/);
  return text.split(/,\s*/);
}

/**
 * The other names a source's description lists, Latin script only, deduplicated by key, at most MAX_PARSED.
 * Nothing that is not introduced by a label at the start of a line is read: a description with no "Alternative
 * …:" line has no other names as far as this is concerned, however many titles its prose happens to mention.
 */
export function parseAltTitles(description: string | null | undefined): string[] {
  if (!description) return [];
  const lines = description.replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n').split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL_LINE.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m[0].length).trim();
    const chunk: string[] = rest ? [rest] : [];
    // The names may continue on the following lines (a bulleted list under the label): read them until a blank
    // line or the next labelled field. A label line that carried names of its own is continued only by bullets.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim() || LABEL_LINE.test(next) || FIELD_LINE.test(next)) break;
      if (rest && !/^\s*[•*\-]/.test(next)) break;
      chunk.push(next);
      i = j;
    }
    for (const part of chunk.flatMap(splitList)) found.push(cleanName(part));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of found) {
    if (!name || name.length > MAX_NAME_LEN || FIELD_INSIDE.test(name) || !isLatinName(name)) continue;
    const k = normTitle(name);
    if (k.length < MIN_ALT_KEY || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_PARSED) break;
  }
  return out;
}

/** Why a name an admin typed is not kept: no Latin letters to compare by, or a key under MIN_ALT_KEY. */
export type NameRefusal = 'non_latin' | 'too_short';

/**
 * The route's check on a typed name. Script first: a Korean name normalises to nothing, and "too short" would send
 * the admin looking for a longer spelling of it. A name with no letters at all (a numeric title) is judged by its
 * key alone.
 */
export function refuseName(title: string): NameRefusal | null {
  if (/\p{L}/u.test(title) && !isLatinName(title)) return 'non_latin';
  if (normTitle(title).length < MIN_ALT_KEY) return 'too_short';
  return null;
}

/**
 * The search hit that IS this other name: equal keys, never containment (the file's rule). The hit list is a
 * search for the name itself, so an exact hit is all there is to find; `null` when there is none.
 */
export function exactHit<T extends { title: string }>(list: T[], name: string): T | null {
  const k = normTitle(name);
  if (k.length < MIN_ALT_KEY) return null;
  return list.find((r) => normTitle(r.title) === k) ?? null;
}

// ---- storage ------------------------------------------------------------------------------------------

export interface AltTitleRow { title: string; norm: string; origin: AltOrigin; added_by: string | null; created_at: Date | string }

/** The series' own title as the database normalises it, for "a series' own title is not an OTHER name of it". */
const OWN_KEY = (param: string) =>
  `(SELECT regexp_replace(lower(s.title), '[^a-z0-9]+', '', 'g') FROM lib_series s WHERE s.id = ${param})`;

/**
 * Every stored name of a series. A person's word first -- a name an admin typed, then a tracker's synonyms, then
 * what a description listed -- because a search uses only the first few (SEARCH_NAMES), and a name somebody chose
 * must not lose its turn to the twentieth name a description listed.
 */
export async function altTitleRows(seriesId: string): Promise<AltTitleRow[]> {
  return q<AltTitleRow>(
    `SELECT title, norm, origin, added_by, created_at FROM series_alt_titles WHERE series_id = $1
      ORDER BY CASE origin WHEN 'admin' THEN 0 WHEN 'import' THEN 1 ELSE 2 END, created_at, norm`, [seriesId],
  );
}

/** The names a search may use, in altTitleRows' order; empty on any failure, so a search never fails over them. */
export async function altTitlesFor(seriesId: string, limit?: number): Promise<string[]> {
  const rows = await altTitleRows(seriesId).catch(() => [] as AltTitleRow[]);
  const names = rows.map((r) => r.title);
  return limit == null ? names : names.slice(0, limit);
}

/**
 * Keep names for a series. A name already stored keeps its row (its origin and who added it): a name an admin
 * typed is not demoted to "from a description" because a source also lists it. Names with a short key, no Latin
 * letters or the series' own title are dropped here too, so nothing reaches the table that the match rule would
 * refuse. Answers the names written.
 */
export async function recordAltTitles(
  seriesId: string,
  names: readonly string[],
  origin: AltOrigin,
  opts: { userId?: string | null; run?: typeof q } = {},
): Promise<string[]> {
  const run = opts.run ?? q;
  const rows = new Map<string, string>();
  for (const raw of names) {
    const title = String(raw ?? '').trim();
    const k = normTitle(title);
    if (!title || title.length > MAX_NAME_LEN || refuseName(title) || rows.has(k)) continue;
    rows.set(k, title);
  }
  if (!rows.size) return [];
  const written = await run<{ title: string }>(
    `INSERT INTO series_alt_titles (series_id, norm, title, origin, added_by)
     SELECT $1, x.n, x.t, $4, $5 FROM unnest($2::text[], $3::text[]) AS x(n, t)
      WHERE EXISTS (SELECT 1 FROM lib_series s WHERE s.id = $1) AND x.n IS DISTINCT FROM ${OWN_KEY('$1')}
     ON CONFLICT (series_id, norm) DO NOTHING RETURNING title`,
    [seriesId, [...rows.keys()], [...rows.values()], origin, opts.userId ?? null],
  );
  return written.map((r) => r.title);
}

/**
 * Read a source's description for names and keep them as the series' own (`description`). Best effort: a failure
 * here must never fail the add, the lookup or the search that called it, so it never throws.
 */
export async function learnAltTitles(seriesId: string, description: string | null | undefined): Promise<string[]> {
  const names = parseAltTitles(description);
  if (!names.length) return [];
  return recordAltTitles(seriesId, names, 'description').catch(() => []);
}

/**
 * A source's details were just read (routes/sources.ts seriesAndChapters): when that source and id are some
 * series' MAIN source, its description is that series' own, and its names are kept. Looked up only when the
 * description names anything, so the common read costs no query at all. Never throws.
 */
export async function learnFromMainSource(sourceId: string, sourceSeriesId: string, description: string | null | undefined): Promise<void> {
  if (!parseAltTitles(description).length) return;
  const rows = await q<{ id: string }>(
    'SELECT id FROM lib_series WHERE source_id = $1 AND source_series_id = $2', [sourceId, sourceSeriesId],
  ).catch(() => [] as { id: string }[]);
  for (const r of rows) await learnAltTitles(r.id, description);
}

/**
 * A merge: the absorbed row's names become the survivor's, and leave the absorbed row (lib/libraryAdmin.ts). The
 * survivor keeps its own row where both had a name, and a name that is the survivor's own title is not carried.
 */
export async function carryAltTitles(run: typeof q, fromId: string, intoId: string): Promise<void> {
  await run(
    `INSERT INTO series_alt_titles (series_id, norm, title, origin, added_by, created_at)
     SELECT $2, a.norm, a.title, a.origin, a.added_by, a.created_at FROM series_alt_titles a
      WHERE a.series_id = $1 AND a.norm IS DISTINCT FROM ${OWN_KEY('$2')}
     ON CONFLICT (series_id, norm) DO NOTHING`,
    [fromId, intoId],
  );
  await run('DELETE FROM series_alt_titles WHERE series_id = $1', [fromId]);
}

/** Forget one name. Idempotent: a name that is not there is simply not there afterwards either. */
export async function removeAltTitle(seriesId: string, norm: string): Promise<void> {
  await q('DELETE FROM series_alt_titles WHERE series_id = $1 AND norm = $2', [seriesId, norm]);
}
