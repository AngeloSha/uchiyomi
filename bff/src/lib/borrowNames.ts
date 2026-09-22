import { q, one } from './db';
import { getSource, listSources, type SourceAdapter, type SourceSeries } from './sources';
import { searchAll } from './searchAll';
import { healthAll, isDisabled } from './sourceHealth';
import { assess, verdict, followable } from './fill';
import { chapterName } from './library';
import { normTitle } from './titleMatch';
import { visibleToAll } from './visibility';

/**
 * Give a chapter its name from ANOTHER source, when its own source only ever says "Chapter 12".
 *
 * Plenty of sources publish no chapter titles at all -- some answer "Chapter 1", "Chapter 2" for
 * the whole of One Piece -- while another source has had "Romance Dawn" all along. The names are the same
 * work's names; only the source differs.
 *
 * ⚠️ THE HAZARD IS NUMBERING, NOT NAMES. Matching a name to a chapter by its number is only sound if both
 * sources number the work the same way, and they often do not: one counts a side story, another splits a
 * chapter, another starts after a prologue. Past the point where two sources diverge, EVERY borrowed name
 * is wrong -- and wrong in the worst possible way, because a plausible title is exactly what someone uses
 * to decide what to read next, and nothing on screen would look amiss.
 *
 * So this does not match by number. It reuses the one rule the app already applies before it will take
 * chapters from a second source (lib/fill.ts): at least 90 % of the numbers we hold are listed there, and
 * the verdict agrees the numbering lines up. A donor that fails is not used at all -- no names, rather
 * than names that might be shifted by one.
 *
 * Everything it writes is marked. `lib_books.title_source` records which source a borrowed name came from,
 * so a bad donor can be identified and cleared in bulk, and so nothing here can be mistaken for a name the
 * chapter's own source supplied. It never touches a chapter that already has a real name, and never one an
 * admin retitled.
 *
 * Off by default, per server and per series, because it is outbound traffic to a source that carries
 * nothing else for you. It runs after the listing is written on each source check (lib/updater.ts), and
 * costs nothing once every live chapter has a name: the early return below comes before any request.
 */

/** How many candidate donors are asked before giving up, per run. Outbound traffic to strangers. */
const MAX_DONORS = 4;
/** How long the discovery search may take. Generous: this runs on the sweep, not in a request. */
const SEARCH_WAIT_MS = 20_000;
/**
 * How long a search that found no donor stands before it is tried again. Without it a series nobody else
 * carries would be searched for across every source on every check -- every few hours, forever -- for an
 * answer that almost never changes. A week still notices a source that picks the work up later.
 */
const NO_DONOR_RETRY_MS = 7 * 24 * 3600_000;

export interface BorrowResult {
  filled: number;
  donor?: string;
  /** Why nothing was written, when nothing was. Never swallowed: this ends up in the sweep's log. */
  why?: 'off' | 'nothing_to_do' | 'no_donor' | 'no_names';
}

interface SeriesRow {
  id: string; title: string;
  source_id: string | null; source_series_id: string | null;
  borrow_names: boolean | null;
  /** The donor whose numbering matched, or `{ none: <epoch ms> }` after a search that found none. */
  name_donor: { source?: string; sourceId?: string; none?: number } | null;
}

/** A title that just restates its own number, in any of the usual spellings. */
const isBare = (title: string | null, number: number) => !chapterName(title, number);

async function enabledFor(s: SeriesRow): Promise<boolean> {
  if (s.borrow_names !== null) return s.borrow_names;
  const g = await one<{ borrow_names: boolean }>('SELECT borrow_names FROM server_settings WHERE id = 1')
    .catch(() => null);
  return !!g?.borrow_names;
}

/** Sources this viewer-less job may ask: everything registered, minus the series' own and anything disabled. */
async function donorPool(exclude: string | null): Promise<SourceAdapter[]> {
  const out: SourceAdapter[] = [];
  for (const src of listSources()) {
    if (src.id === exclude) continue;
    if (await isDisabled(src.id).catch(() => false)) continue;
    out.push(src);
  }
  return out;
}

/**
 * Does this candidate's numbering line up with ours closely enough to hang names off it?
 *
 * Returns the candidate's chapter list when it does, so the caller does not list it twice.
 */
async function aligned(src: SourceAdapter, theirSeriesId: string, have: number[]) {
  const theirs = await src.listChapters(theirSeriesId).catch(() => null);
  if (!theirs?.length) return null;
  const nums = theirs.map((c) => c.number).filter((n) => Number.isFinite(n));
  const a = assess(have, nums);
  if (!followable({ coverage: a.coverage, why: verdict(a, nums.length) })) return null;
  return theirs;
}

export async function borrowChapterNames(seriesId: string): Promise<BorrowResult> {
  const s = await one<SeriesRow>(
    // A hidden or merged-away series is not named: visibleToAll is the system-wide visibility rule, with
    // no viewer's library or age limit applied, because this job has no viewer.
    `SELECT s.id, s.title, s.source_id, s.source_series_id, s.borrow_names, s.name_donor
       FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [seriesId]).catch(() => null);
  if (!s) return { filled: 0, why: 'nothing_to_do' };
  if (!await enabledFor(s)) return { filled: 0, why: 'off' };

  // Only LIVE chapters, and only ones still named after their own number. A name already borrowed counts
  // as named: re-deciding it every night would let two donors fight over the same row forever.
  const books = await q<{ id: string; number: number; title: string | null }>(
    `SELECT id, number, title FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL`, [seriesId]).catch(() => []);
  if (!books.length) return { filled: 0, why: 'nothing_to_do' };
  const nameless = books.filter((b) => isBare(b.title, b.number));
  if (!nameless.length) return { filled: 0, why: 'nothing_to_do' };
  const have = books.map((b) => Number(b.number)).filter((n) => Number.isFinite(n));

  // The donor remembered from last time, first: discovery is a cross-source search, and repeating it every
  // night for a series whose donor has not changed is the expensive way to get the same answer.
  const tried = new Set<string>();
  let donor: { src: SourceAdapter; theirSeriesId: string; chapters: Awaited<ReturnType<SourceAdapter['listChapters']>> } | null = null;
  const remembered = s.name_donor?.source ? getSource(s.name_donor.source) : null;
  if (remembered && s.name_donor?.sourceId) {
    tried.add(remembered.id);
    const chapters = await aligned(remembered, s.name_donor.sourceId, have);
    if (chapters) donor = { src: remembered, theirSeriesId: s.name_donor.sourceId, chapters };
  }

  // Only a hit whose title matches ours EXACTLY once punctuation and case are folded away (normTitle, the
  // rule the rest of the app matches titles by). A title that folds to nothing -- one written entirely in
  // a non-Latin script -- would "match" every other such title, so it is not searched for at all.
  const want = normTitle(s.title);
  const searchedRecently = !!s.name_donor?.none && Date.now() - s.name_donor.none < NO_DONOR_RETRY_MS;
  if (!donor && want && !searchedRecently) {
    const pool = await donorPool(s.source_id);
    if (pool.length) {
      const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h] as const));
      const answer = await searchAll(s.title, pool, { waitMs: SEARCH_WAIT_MS, health }).catch(() => null);
      // A fuzzy match would be a second way to be wrong on top of the numbering, and the numbering check
      // cannot catch it: a different work with a similar name can easily number 1..N the same way.
      const cands: { source: string; sourceId: string }[] = [];
      for (const [sourceId, r] of answer?.per ?? new Map<string, { items?: SourceSeries[] }>()) {
        if (tried.has(sourceId)) continue;
        // `SourceSeries.sourceId` is the id WITHIN that source, which is what listChapters takes. Typing
        // this loosely once cost a silent no-op: `.id` is not a field, so every candidate was dropped and
        // the feature looked switched off.
        const hit = (r.items ?? []).find((it: SourceSeries) => normTitle(it.title) === want);
        if (hit?.sourceId) cands.push({ source: sourceId, sourceId: hit.sourceId });
      }
      for (const c of cands.slice(0, MAX_DONORS)) {
        if (tried.has(c.source)) continue;
        tried.add(c.source);
        const src = getSource(c.source);
        if (!src) continue;
        const chapters = await aligned(src, c.sourceId, have);
        if (chapters) { donor = { src, theirSeriesId: c.sourceId, chapters }; break; }
      }
    }
  }
  if (!donor) {
    // Remembered, so the next check does not repeat a cross-source search that just came back empty. A
    // remembered donor that stopped lining up lands here too, and is replaced by the marker.
    if (want && !searchedRecently) {
      await q('UPDATE lib_series SET name_donor = $2::jsonb WHERE id = $1',
        [seriesId, JSON.stringify({ none: Date.now() })]).catch(() => {});
    }
    return { filled: 0, why: 'no_donor' };
  }

  // One name per number, only where the donor actually has one worth taking.
  const byNumber = new Map<number, string>();
  for (const c of donor.chapters) {
    if (!Number.isFinite(c.number)) continue;
    const name = chapterName(c.title, c.number);
    if (name && !byNumber.has(c.number)) byNumber.set(c.number, name);
  }
  const writes = nameless
    .map((b) => ({ id: b.id, name: byNumber.get(Number(b.number)) }))
    .filter((w): w is { id: string; name: string } => !!w.name);

  // Remember the donor even when it had no names for us: it is still the source whose numbering matched,
  // and re-searching every night to rediscover that would be the whole cost for none of the benefit.
  await q('UPDATE lib_series SET name_donor = $2::jsonb WHERE id = $1',
    [seriesId, JSON.stringify({ source: donor.src.id, sourceId: donor.theirSeriesId })]).catch(() => {});

  if (!writes.length) return { filled: 0, donor: donor.src.id, why: 'no_names' };

  const params: any[] = [donor.src.id];
  const tuples = writes.map((w) => {
    params.push(w.id, w.name);
    return `($${params.length - 1}, $${params.length})`;
  });
  const written = await q<{ id: string }>(
    `UPDATE lib_books b SET title = v.name, title_source = $1, updated_at = now()
       FROM (VALUES ${tuples.join(',')}) AS v(id, name)
      WHERE b.id = v.id
        -- Still unnamed at the moment of writing: a copy that landed with its own name while the donor
        -- was being asked has the better claim.
        AND (coalesce(btrim(b.title), '') = ''
             OR b.title ~* ('^(ch(apter|\\.)?|episode|ep\\.?)?\\s*0*' || b.number || '\\s*$'))
      RETURNING b.id`,
    params,
  );
  console.log(`[names] "${s.title}": ${written.length} chapter name(s) from ${donor.src.name}`);
  return { filled: written.length, donor: donor.src.id };
}

/**
 * Undo borrowed names, back to the title the chapter's own file gives it -- the same derivation the scanner
 * uses (lib/library.ts persistScan), so the row reads exactly as if nothing had been borrowed.
 *
 * `'following-server'` is the server-wide switch going off: it takes back the names of every series that
 * follows that switch, and leaves alone a series that was switched on for itself.
 */
export async function clearBorrowedNames(scope: { seriesId: string } | 'following-server'): Promise<number> {
  const fromFile = `regexp_replace(regexp_replace(b.file, '^.*/', ''), '\\.(cbz|cbr|zip|rar|pdf|epub)$', '', 'i')`;
  const rows = scope === 'following-server'
    ? await q<{ id: string }>(
        `UPDATE lib_books b SET title = ${fromFile}, title_source = NULL, updated_at = now()
           FROM lib_series s
          WHERE s.id = b.series_id AND s.borrow_names IS NULL AND b.title_source IS NOT NULL RETURNING b.id`)
    : await q<{ id: string }>(
        `UPDATE lib_books b SET title = ${fromFile}, title_source = NULL, updated_at = now()
          WHERE b.series_id = $1 AND b.title_source IS NOT NULL RETURNING b.id`, [scope.seriesId]);
  return rows.length;
}
