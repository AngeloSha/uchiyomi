// The other names a series goes by, and the one rule for when two names are the same name.
//
// A series is stored under ONE title (lib_series.title, or the admin's override). The same manhwa is
// "Solo Leveling" on one site, "Only I Level Up" on a second and "Na Honjaman Level Up" on a third, and a
// search for the first finds nothing on the other two. Most sources list the other names in their own
// description ("Alternative Titles: …", "Associated Names: …"), so the names are there to be read -- this
// file reads them, keeps them (series_alt_titles, migrate.ts), and says when a candidate is ours by name.
//
// ⚠️ THE RULE IS EXACT. Two names are the same name when their normalised keys are EQUAL -- never when one
// contains the other, never by word overlap. A contains-match is what a sequel shares with its parent
// ("Tokyo Ghoul:re" / "Tokyo Ghoul"), and other-name lists are where spin-offs, the novel and the anime are
// most often listed beside the manhwa. Every match made here is then also held to the numbering check both
// ways (lib/linkBatch.ts), because an exact name is still only a name.
//
// Latin script only. Every other script normalises to the empty string under normTitle (letters and digits
// a-z0-9), so a Korean or Japanese name could never be compared anyway -- and an empty key must never be
// allowed to equal another empty key.
import { q } from './db';
import { normTitle } from './titleMatch';

/**
 * The shortest key an OTHER name may have. A bare "Hero" or "Level" in someone's list of names is a word, not
 * an identity, and would match every short title on every site. The same bound as trackerProviders.ts
 * MIN_ALT_KEY, for the same reason. The main titles are exempt: two sites that both call the work "Gosu"
 * are held to the numbering check like everyone else.
 */
export const MIN_ALT_KEY = 5;
/** How many names one description may contribute; a list longer than this is a tag cloud, not names. */
export const MAX_PARSED = 20;
/** The longest name kept: a "name" longer than this is a sentence the parser ran into. */
const MAX_NAME_LEN = 200;

/**
 * The labels sources put in front of the other names. Each must be followed by a colon (or a dash): "also
 * known as" in running prose is a sentence, and reading the rest of it as a name is exactly the guess this
 * file refuses to make.
 */
const LABEL = /(?:alternative|alternate|alt\.?)\s+(?:titles?|names?)|associated\s+names?|other\s+(?:titles?|names?)|also\s+known\s+as|a\.k\.a\.?|synonyms?/i;
const LABEL_LINE = new RegExp(`^[\\s>*_#•\\-]*(?:${LABEL.source})[\\s*_]*(?:\\([^)]{0,20}\\))?[\\s*_]*[:：\\-–—][\\s*_]*`, 'i');
/** A line that starts a new labelled field ("Author: …", "Status: …"): the end of a name list. */
const FIELD_LINE = /^[\s>*_#•-]*[A-Za-z][A-Za-z .]{0,30}[:：]\s*/;
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
 * Split one list into names. The separator is chosen per list, strongest first: a list that uses `;`, `|`,
 * a bullet or line breaks is split on those only, so "Yes, My Lord" survives inside it; a " / " list on
 * those; only a list with nothing else is split on commas. A wrong split can only LOSE a name (the halves
 * fall under MIN_ALT_KEY or match nothing exactly) -- the safe direction for a rule whose failure mode is
 * following the wrong book.
 */
function splitList(text: string): string[] {
  if (/[;|•·\n]/.test(text)) return text.split(/[;|•·\n]+/);
  if (/\s\/\s/.test(text)) return text.split(/\s\/\s/);
  return text.split(/,\s*/);
}

/**
 * The other names a source's description lists, Latin script only, deduplicated by key, at most MAX_PARSED.
 * Nothing that is not introduced by a label is read: a description with no "Alternative …:" line has no
 * other names as far as this is concerned, however many titles its prose happens to mention.
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
    // The names may continue on the following lines (a bulleted list under the label): read them until a
    // blank line or the next labelled field.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim() || LABEL_LINE.test(next) || FIELD_LINE.test(next)) break;
      // A line with a label of its own on the same line as the names ended the list above; a continuation
      // line only continues a list that had no names on the label line, or is a bullet.
      if (rest && !/^\s*[•*\-]/.test(next)) break;
      chunk.push(next);
      i = j;
    }
    for (const part of chunk.flatMap(splitList)) found.push(cleanName(part));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of found) {
    if (!name || name.length > MAX_NAME_LEN || !isLatinName(name)) continue;
    const k = normTitle(name);
    if (k.length < MIN_ALT_KEY || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_PARSED) break;
  }
  return out;
}

/** Which of our names met which of theirs. `main` is true when both are the two sides' main titles. */
export interface NameMatch { ours: string; theirs: string; main: boolean }

/**
 * The exact-name rule. `ours[0]` and `theirs[0]` are the two MAIN titles; everything after is an other name.
 * Two names match when their keys are equal and non-empty; a pair in which either side is an other name
 * must also have a key of at least MIN_ALT_KEY. The main-to-main pair is preferred when there is one, so
 * the caller knows whether the match rests on the titles themselves or on a list of names.
 */
export function exactNameMatch(ours: string[], theirs: string[]): NameMatch | null {
  const theirKeys = theirs.map((t) => normTitle(t));
  const ourKeys = ours.map((t) => normTitle(t));
  if (ourKeys[0] && ourKeys[0] === theirKeys[0]) return { ours: ours[0], theirs: theirs[0], main: true };
  for (let i = 0; i < ourKeys.length; i++) {
    const k = ourKeys[i];
    if (!k) continue;
    for (let j = 0; j < theirKeys.length; j++) {
      if (i === 0 && j === 0) continue;
      if (theirKeys[j] !== k) continue;
      if (k.length < MIN_ALT_KEY) continue;
      return { ours: ours[i], theirs: theirs[j], main: false };
    }
  }
  return null;
}

// ---- storage ------------------------------------------------------------------------------------------

export type AltOrigin = 'description' | 'admin' | 'confirmed' | 'merged';
export interface AltTitleRow { title: string; norm: string; origin: AltOrigin; source_id: string | null; created_at: string }

/** The admin switch (server_settings.alt_title_matching). An unreadable row is off. */
export async function altTitleMatchingOn(): Promise<boolean> {
  const r = await q<{ on: boolean }>('SELECT alt_title_matching AS "on" FROM server_settings WHERE id = 1').catch(() => []);
  return r[0]?.on === true;
}

/** Every stored name of a series, oldest first. */
export async function altTitleRows(seriesId: string): Promise<AltTitleRow[]> {
  return q<AltTitleRow>(
    'SELECT title, norm, origin, source_id, created_at FROM series_alt_titles WHERE series_id = $1 ORDER BY created_at, norm', [seriesId],
  ).catch(() => []);
}

/**
 * The names a search may use for a series. A name read out of a description only while the switch is on:
 * turning it off must stop the automatic names from being used at once, not only from being collected.
 * The names a person typed or confirmed always count -- they are a person's word, not a parse.
 */
export async function altTitlesFor(seriesId: string, opts: { includeDescription?: boolean } = {}): Promise<string[]> {
  const includeDescription = opts.includeDescription ?? await altTitleMatchingOn();
  return (await altTitleRows(seriesId))
    .filter((r) => includeDescription || r.origin !== 'description')
    .map((r) => r.title);
}

/**
 * Keep names for a series. A name already stored keeps its row (its origin and who added it): a name the
 * admin typed is not demoted to "from a description" because a source also lists it. Names with a short or
 * empty key are dropped here too, so nothing reaches the table that the match rule would refuse.
 */
export async function recordAltTitles(
  seriesId: string,
  names: string[],
  origin: AltOrigin,
  opts: { sourceId?: string | null; userId?: string | null; run?: typeof q } = {},
): Promise<number> {
  const run = opts.run ?? q;
  const rows = new Map<string, string>();
  for (const raw of names) {
    const title = raw.trim();
    const k = normTitle(title);
    if (!title || title.length > MAX_NAME_LEN || k.length < MIN_ALT_KEY || rows.has(k)) continue;
    rows.set(k, title);
  }
  if (!rows.size) return 0;
  const written = await run<{ norm: string }>(
    `INSERT INTO series_alt_titles (series_id, norm, title, origin, source_id, added_by)
     SELECT $1, n, t, $4, $5, $6::uuid FROM unnest($2::text[], $3::text[]) AS x(n, t)
      -- The series' own title is not an OTHER name of it.
      WHERE n IS DISTINCT FROM (SELECT regexp_replace(lower(s.title), '[^a-z0-9]+', '', 'g') FROM lib_series s WHERE s.id = $1)
     ON CONFLICT (series_id, norm) DO NOTHING RETURNING norm`,
    [seriesId, [...rows.keys()], [...rows.values()], origin, opts.sourceId ?? null, opts.userId ?? null],
  );
  return written.length;
}

/**
 * Read a source's description for names and keep them -- only while the switch is on. Best effort: a
 * failure here must never fail the add or the search that called it.
 */
export async function learnAltTitles(seriesId: string, description: string | null | undefined, sourceId: string | null): Promise<string[]> {
  if (!description || !(await altTitleMatchingOn())) return [];
  const names = parseAltTitles(description);
  if (names.length) await recordAltTitles(seriesId, names, 'description', { sourceId }).catch(() => 0);
  return names;
}

/** A merge: the absorbed row's names, and its own title, become the survivor's (lib/libraryAdmin.ts). */
export async function carryAltTitles(run: typeof q, fromId: string, intoId: string): Promise<void> {
  await run(
    `INSERT INTO series_alt_titles (series_id, norm, title, origin, source_id, added_by, created_at)
     SELECT $2, norm, title, origin, source_id, added_by, created_at FROM series_alt_titles WHERE series_id = $1
     ON CONFLICT (series_id, norm) DO NOTHING`,
    [fromId, intoId],
  );
  await run('DELETE FROM series_alt_titles WHERE series_id = $1', [fromId]);
  const absorbed = await run<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [fromId]);
  const into = await run<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [intoId]);
  const t = absorbed[0]?.title;
  if (t && normTitle(t) !== normTitle(into[0]?.title ?? '')) await recordAltTitles(intoId, [t], 'merged', { run });
}
