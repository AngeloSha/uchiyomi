import { q, one } from './db';
import { getSource, listSources, type SourceAdapter, type SourceChapter } from './sources';
import { budgetFor } from './sources/budget';
import { healthAll } from './sourceHealth';
import { scanOrder } from './scanOrder';
import { pickBest } from './titleMatch';
import { judgeCandidate, bounded, MIN_TRY_MS, type Judgement } from './autoFollow';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { MIN_HAVE } from './fill';
import { chapterName } from './library';
import { HEALED_NAME } from './naming';
import { HUNT_MAX_SOURCES, seriesIsAdult, sweepAllowedFor } from './sourceHunt';
import { visibleToAll } from './visibility';
import { altTitlesFor } from './altTitles';
// Whether a donor's text is in the language we want: lib/lang.ts's rule since v0.52.0, which is the one this file
// had (an unknown language is the unstated one, English by default) and also tells scripts apart: zh-Hant is not zh-Hans.
import { sameLanguage } from './lang';

/**
 * Name a chapter from ANOTHER source, when its own source only ever says "Chapter 12" (#85, @Squeaks72's idea,
 * rebuilt on the hunt's own parts).
 *
 * Plenty of sources publish no chapter titles at all while another has had "Romance Dawn" all along; the names
 * are the same work's names. ⚠️ THE HAZARD IS NUMBERING: past the point where two sources number a work
 * differently -- a side story counted, a chapter split -- every borrowed name is wrong, and wrong in the worst
 * way, because a plausible title is exactly what someone picks the next chapter by. So a donor must pass the
 * same identity judgement a source must pass before the server will FOLLOW it (autoFollow's judgeCandidate):
 * its own title is ours, and its numbering lines up both ways unless the title is exact on a long listing --
 * the rule that refuses "Tokyo Ghoul:re" for "Tokyo Ghoul". Names are then taken by EXACT number, never by a
 * floor, and only in the series' own language.
 *
 * What the first version got wrong, and this does not:
 *   - it searched through searchAll, which reports slow and failing sources to source health, so a lookup for
 *     names could put a series' own source into a cooldown and stop real downloads. Nothing here reports:
 *     each search and lookup is bounded and a failure is just a source that did not answer, as in the hunt;
 *   - donors were not filtered by the adult rule or by language (a Spanish "One Piece" matched, and named
 *     the chapters in Spanish); here the hunt's `sweepAllowedFor` applies, sources in another language are
 *     never asked, and a multi-language donor's chapters in another language are never used;
 *   - it had no search budget and trusted a remembered donor the admin had since disabled; here it is a
 *     nightly repair step with its own small budget, and a remembered donor is re-judged like any other.
 *
 * Everything it writes is marked: `lib_books.chapter_name_source` names the donor, the chapter's own source
 * always wins (seriesListing.ts's heal and library.ts setBookMeta replace a borrowed name with an own one), it
 * never writes `title`, and switching it off takes back exactly what it wrote. Off by default, per server and
 * per series, because it is traffic to sources that carry nothing else for you.
 */

/** A search that found no donor stands this long: a series nobody else carries is not searched for nightly. */
export const NAMES_RETRY_MS = 7 * 24 * 3600_000;
/** The whole search for one series. */
const NAMES_WALL_MS = 60_000;
const NAMES_SEARCH_MS = 20_000;

/** `posting_order`: the series is numbered by posting order (#116), so no donor's numbers name its chapters. */
export type BorrowWhy = 'off' | 'nothing_to_do' | 'too_few' | 'waiting' | 'no_donor' | 'no_names' | 'posting_order';
export interface BorrowResult { named: number; donor?: string; why?: BorrowWhy }

type NameDonor = { source?: string; sourceId?: string; none?: number };

/** Whether borrowing is on for this series: its own switch, else the server's. */
export async function borrowingOn(own: boolean | null): Promise<boolean> {
  if (own !== null) return own;
  const g = await one<{ borrow_names: boolean }>('SELECT borrow_names FROM server_settings WHERE id = 1').catch(() => null);
  return !!g?.borrow_names;
}

export async function borrowNamesFor(seriesId: string, opts: { now?: number; force?: boolean } = {}): Promise<BorrowResult> {
  const now = opts.now ?? Date.now();
  const s = await one<{ id: string; title: string; source_id: string | null; borrow_names: boolean | null; name_donor: NameDonor | null; numbering: string | null }>(
    `SELECT s.id, s.title, s.source_id, s.borrow_names, s.name_donor, s.numbering FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`,
    [seriesId]).catch(() => null);
  if (!s) return { named: 0, why: 'nothing_to_do' };
  // A donor lends a name by NUMBER, and under posting order no other site's chapter 20 is our chapter 20. The
  // series' own source names every post anyway: posting order is exactly the case where each has its own title.
  if (s.numbering === 'posting_order') return { named: 0, why: 'posting_order' };
  if (!(await borrowingOn(s.borrow_names))) return { named: 0, why: 'off' };

  // Only LIVE chapters with no name at all. A borrowed name counts as a name: re-deciding it every night would
  // let two donors fight over one row, and the chapter's own source replacing it is the heal's job.
  const books = await q<{ id: string; number: number; chapter_name: string | null }>(
    'SELECT id, number::float8 AS number, chapter_name FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL', [seriesId]).catch(() => []);
  const nameless = books.filter((b) => !b.chapter_name);
  if (!nameless.length) return { named: 0, why: 'nothing_to_do' };
  const listed = (await q<{ number: number }>('SELECT DISTINCT number::float8 AS number FROM series_listing WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => Number(r.number));
  const numbers = [...new Set([...books.map((b) => Number(b.number)), ...listed])].filter((n) => Number.isFinite(n));
  // Coverage against a handful of numbers proves nothing, whatever the donor says (the hunt's MIN_HAVE).
  if (numbers.length < MIN_HAVE) return { named: 0, why: 'too_few' };

  const own = s.source_id ? getSource(s.source_id) : null;
  const want = own?.lang ?? null;
  const allowed = await sweepAllowedFor(await seriesIsAdult(seriesId).catch(() => false));
  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h] as const));
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId).catch(() => null), 0);
  // The other names the series goes by (v0.49.1, lib/altTitles.ts): a donor that files the work under one of them
  // is this series by name -- exactly, never by containment, and then measured both ways (autoFollow.ts).
  const primary = { title: s.title, altTitles: await altTitlesFor(seriesId), numbers };
  const usable = (id: string) => {
    const src = getSource(id);
    if (!src || id === s.source_id || !allowed(id) || !sameLanguage(want, src.lang)) return null;
    const h = health.get(id);
    if (h?.disabled) return null;
    if (h?.blocked_until && new Date(h.blocked_until).getTime() > now) return null;
    return src;
  };

  let donor: Judgement | null = null;
  // The donor remembered from last time first, re-judged: a source the admin has since disabled, or one whose
  // numbering has drifted, is not trusted on the strength of having once been right.
  const remembered = s.name_donor?.source && s.name_donor.sourceId ? usable(s.name_donor.source) : null;
  if (remembered) {
    const j = await judgeCandidate(primary, { source: remembered.id, sourceId: s.name_donor!.sourceId! }, { prefs, health }).catch(() => null);
    if (j?.why === 'ok') donor = j;
  }

  const searchedRecently = !!s.name_donor?.none && now - s.name_donor.none < NAMES_RETRY_MS;
  if (!donor && searchedRecently && !opts.force) return { named: 0, why: 'waiting' };
  if (!donor) {
    // The hunt's order -- the series' own language first -- over the sources that may be asked at all.
    const order = scanOrder(listSources().filter((src) => !!usable(src.id)), own ? { id: own.id, lang: own.lang } : null)
      .slice(0, HUNT_MAX_SOURCES);
    const deadline = Date.now() + NAMES_WALL_MS;
    for (const id of order) {
      const left = deadline - Date.now();
      if (left < MIN_TRY_MS) break;
      const src = getSource(id);
      if (!src) continue;
      // Bounded, caught, and never reported: a source that does not answer a names search is not unhealthy.
      const hit = await bounded(src.search(s.title), Math.min(budgetFor(src, NAMES_SEARCH_MS), left))
        .then((results) => pickBest(results, s.title)).catch(() => null);
      if (!hit?.sourceId) continue;
      const j = await bounded(judgeCandidate(primary, { source: id, sourceId: hit.sourceId }, { prefs, health }), Math.max(MIN_TRY_MS, deadline - Date.now()))
        .catch(() => null);
      if (j?.why === 'ok') { donor = j; break; }
    }
  }
  if (!donor) {
    await q('UPDATE lib_series SET name_donor = $2::jsonb WHERE id = $1', [seriesId, JSON.stringify({ none: now })]).catch(() => {});
    return { named: 0, why: 'no_donor' };
  }
  // Remembered even when it has nothing for us: it is still the source whose numbering matched.
  await q('UPDATE lib_series SET name_donor = $2::jsonb WHERE id = $1',
    [seriesId, JSON.stringify({ source: donor.source, sourceId: donor.sourceSeriesId })]).catch(() => {});

  const donorSrc = getSource(donor.source) as SourceAdapter;
  const byNumber = new Map<number, string>();
  for (const c of (donor.chapters ?? []) as SourceChapter[]) {
    if (!Number.isFinite(c.number) || byNumber.has(c.number)) continue;
    if (!sameLanguage(want, c.lang ?? donorSrc?.lang)) continue;
    const name = chapterName(c.title, c.number);
    if (name) byNumber.set(c.number, name);
  }
  // EXACT numbers: 12.5 is not 12, and neither is 13 -- the floor the first version compared by is how a donor
  // one chapter off named every chapter after the one it was missing.
  const writes = nameless.map((b) => ({ id: b.id, name: byNumber.get(Number(b.number)) })).filter((w): w is { id: string; name: string } => !!w.name);
  if (!writes.length) return { named: 0, donor: donor.source, why: 'no_names' };
  const params: unknown[] = [donor.source];
  const tuples = writes.map((w) => { params.push(w.id, w.name); return `($${params.length - 1}, $${params.length})`; });
  const written = await q<{ id: string }>(
    `UPDATE lib_books b SET chapter_name = v.name, chapter_name_source = $1, updated_at = now()
       FROM (VALUES ${tuples.join(',')}) AS v(id, name)
      WHERE b.id = v.id AND b.chapter_name IS NULL
      RETURNING b.id`,
    params,
  );
  return { named: written.length, donor: donor.source };
}

/**
 * Take back borrowed names: exactly what this wrote, nothing else. The chapter's own source names it again at
 * its next check, if it has a name to give.
 *
 * `'following-server'` is the server switch going off: every series that follows it, and not one switched on
 * for itself.
 */
export async function clearBorrowedNames(scope: { seriesId: string } | 'following-server'): Promise<number> {
  // A name the listing healed (HEALED_NAME, lib/seriesListing.ts) is marked too, and is not a borrowed one: it is
  // the series' own source's name, and it stays. Reintroduce by clearing every marked name: "switching it off takes
  // back exactly what was borrowed" in borrowNames.int.test.ts takes the healed "Own Four" back too.
  const rows = scope === 'following-server'
    ? await q<{ id: string }>(
      `UPDATE lib_books b SET chapter_name = NULL, chapter_name_source = NULL, updated_at = now()
         FROM lib_series s
        WHERE s.id = b.series_id AND s.borrow_names IS NULL AND b.chapter_name_source IS NOT NULL AND b.chapter_name_source <> $1
        RETURNING b.id`, [HEALED_NAME])
    : await q<{ id: string }>(
      `UPDATE lib_books SET chapter_name = NULL, chapter_name_source = NULL, updated_at = now()
        WHERE series_id = $1 AND chapter_name_source IS NOT NULL AND chapter_name_source <> $2 RETURNING id`, [scope.seriesId, HEALED_NAME]);
  return rows.length;
}
