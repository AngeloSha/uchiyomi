// Posting-order numbering, applied (#116): where lib/postingOrder.ts decides, this module persists and renames.
//
// A series numbered by posting order is numbered so at EVERY place a listing enters the app -- the updater's
// loop, the add, the add dialog's detail, the preview, the fill scan's own source and (through the updater's
// refresh) a manual fetch -- and nowhere else. Everything downstream of a listing (chooseReleases, the stored
// series_listing, ghosts, versions, the downloader's `Chapter N.cbz`, fill, floors, read marks, trackers)
// then sees one set of numbers without knowing numbering exists. Applying it inside the adapter was the other
// choice, and the wrong one: an adapter has no series, so it cannot know the per-series switch, the stored
// assignment or a pending review, and its detail cache is shared by every viewer.
//
// The assignment is STABLE (series_post_numbers): a post keeps its number for good, a deleted post leaves a
// hole, an inserted one takes a midpoint. Recomputing positions on every check would shift every later file,
// mark and tracker number the day a creator deletes one post.
//
// A series ALREADY in a library is never renamed unattended (the owner's decision for v0.49.0). The detector
// firing on it sets `numbering_pending`; the series then downloads nothing and keeps its listing as it was
// until an admin reviews the exact plan and confirms it (requestNumbering). The only apply that needs nobody
// is one with nothing to rename: a series with no chapter rows at all. New adds are numbered at once, because
// nothing is on disk yet.
//
// The apply, when it runs: scans held (library.ts withScansHeld), the folder busy for every other writer, a
// journal (lib_series.renumber_plan) written BEFORE the first rename, renames in two phases (every file to a
// temporary name, then every file to its final one, so two files trading numbers never meet), and ONE
// transaction for every row: lib_books updated in place -- ids, and with them read progress, bookmarks, notes
// and offline copies, are kept -- then marks, floors, failures, overrides, the archive's boundary and today's
// download log moved through the same map. The transaction clears the journal; a journal still there on the
// next check is finished from where it stopped (resumeRenumber), and until then the scan leaves the folder
// alone (library.ts).
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { q, one, tx } from './db';
import type { SourceChapter } from './sources/types';
import { getSource, withTimeout } from './sources';
import { budgetFor } from './sources/budget';
import { isSwAdapterId, SW_PREFIX } from './sources/suwayomi/sources';
import {
  detectSharedNumbering, postingSequence, assignPostingNumbers, planRenumber, numKey, EXTRA_PREFIX,
  type SharedNumbering, type PostNumber, type PlanBook, type PlanPost, type PlanMove, type RenumberMode,
  type RenumberPlan, type PostingAssignment,
} from './postingOrder';
import { withScansHeld } from './library';
import { renameRetry } from './fsAtomic';
import { containedPath, writePreflight } from './fsGuard';
import { busyFolders } from './bulkNewest';
import { listActivity, renumberFinished } from './downloadActivity';
import { chooseReleases } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { logAudit } from './audit';
import { updateSeries, runsInside } from './updater';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { say, saidOf, type Part, type Said } from './said';

/** How a series' chapters are numbered: by the source, or by posting order. NULL in the row is "automatic". */
export type NumberingMode = 'source' | 'posting_order';
/** What an add or an admin asks for: `auto` lets the detector decide. */
export type NumberingChoice = 'auto' | NumberingMode;

/** The numbering columns of a lib_series row (lib/migrate.ts, v0.49.0). */
export interface NumberingRow {
  numbering: NumberingMode | null;
  numbering_by: 'auto' | 'manual' | null;
  numbering_source: string | null;
  numbering_pending: RenumberMode | null;
  numbering_note: NumberingNote | null;
  renumber_plan?: unknown;
}

/** The detector's last word on a series' numbering source, kept so the series page and Health can say why. */
export interface NumberingNote {
  verdict: SharedNumbering['verdict'];
  reason?: 'no_order';
  ordered: boolean;
  posts: number;
  numbers: number;
  extras: number;
  biggest: SharedNumbering['biggest'];
  examples: string[];
  source: string;
  at?: string;
}

export const NUMBERING_COLUMNS = 'numbering, numbering_by, numbering_source, numbering_pending, numbering_note, renumber_plan';

const noteOf = (d: SharedNumbering, source: string): NumberingNote => ({
  verdict: d.verdict, ...(d.reason ? { reason: d.reason } : {}), ordered: d.ordered, posts: d.posts, numbers: d.numbers,
  extras: d.extras, biggest: d.biggest, examples: d.examples, source,
});
const sameNote = (a: NumberingNote | null | undefined, b: NumberingNote): boolean => {
  if (!a) return false;
  const { at: _at, ...rest } = a;
  return JSON.stringify(rest) === JSON.stringify(b);
};

// ---- the listing layer ----------------------------------------------------------------------------------

/**
 * A listing numbered for someone who has no series row yet: the add dialog's detail, a preview, an add. `auto`
 * numbers by posting order only on the detector's STRONG verdict (which requires the source's own order);
 * `posting_order` is a person's explicit choice and applies to any listing. The result is 1..K -- what the
 * same listing gets as its first stored assignment, so the add's numbers are the ones the series keeps.
 */
export function numberingFor<T extends SourceChapter>(raw: readonly T[], want: NumberingChoice = 'auto'):
  { chapters: T[]; detect: SharedNumbering; applied: NumberingMode; assignment?: PostingAssignment<T> } {
  const detect = detectSharedNumbering(raw);
  const posting = raw.length > 0 && (want === 'posting_order' || (want === 'auto' && detect.verdict === 'strong'));
  if (!posting) return { chapters: [...raw], detect, applied: 'source' };
  const assignment = assignPostingNumbers(postingSequence(raw));
  return { chapters: assignment.numbered, detect, applied: 'posting_order', assignment };
}

const isoOf = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The stored assignment of one series on one source, holes and reserved slots included. */
export async function storedPosts(seriesId: string, sourceId: string, run: typeof q = q): Promise<PostNumber[]> {
  const rows = await run<{ post_id: string; url: string | null; number: number; source_number: number | null; title: string | null; published_at: Date | null; gone_at: Date | null }>(
    `SELECT post_id, url, number::float8 AS number, source_number::float8 AS source_number, title, published_at, gone_at
       FROM series_post_numbers WHERE series_id = $1 AND source_id = $2`, [seriesId, sourceId]);
  return rows.map((r) => ({
    postId: r.post_id, url: r.url, number: numKey(Number(r.number)),
    sourceNumber: r.source_number == null ? null : numKey(Number(r.source_number)),
    title: r.title, publishedAt: isoOf(r.published_at), gone: r.gone_at != null,
  }));
}

/**
 * The stored assignment a series' files were numbered by, when it is kept under another source than `sourceId`: the
 * series was added back from a different source (an extension reinstalled under a new id). The source with the
 * most stored posts is the one; an apply keeps one source's rows (commit), so there is normally one.
 */
async function priorPosts(seriesId: string, sourceId: string): Promise<PostNumber[]> {
  const prior = await one<{ source_id: string }>(
    `SELECT source_id FROM series_post_numbers WHERE series_id = $1 AND source_id <> $2
      GROUP BY source_id ORDER BY count(*) DESC, source_id LIMIT 1`, [seriesId, sourceId]).catch(() => null);
  return prior ? storedPosts(seriesId, prior.source_id) : [];
}

const sig = (r: PostNumber): string => JSON.stringify([
  numKey(r.number), r.url ?? null, r.sourceNumber == null || !Number.isFinite(r.sourceNumber) ? null : numKey(r.sourceNumber),
  r.title ?? null, isoOf(r.publishedAt), !!r.gone,
]);

/**
 * Persist an assignment: only the rows that changed, so a quiet check of a 226-post series writes nothing. A
 * post found again under a new id (assignPostingNumbers' `rekeyed`) loses its old key first, or it would stay
 * behind as a second, gone copy of itself holding its own number. `gone_at` is kept from the first time a post
 * was missed -- the hole's age is the one fact a hole has.
 */
export async function savePostNumbers(
  run: typeof q, seriesId: string, sourceId: string, rows: readonly PostNumber[],
  stored: readonly PostNumber[] = [], rekeyed: ReadonlyArray<{ from: string; to: string }> = [],
): Promise<void> {
  const moved = rekeyed.map((r) => r.from).filter((id) => !rows.some((x) => x.postId === id && !x.gone));
  if (moved.length) await run('DELETE FROM series_post_numbers WHERE series_id = $1 AND source_id = $2 AND post_id = ANY($3)', [seriesId, sourceId, moved]);
  const before = new Map(stored.map((r) => [r.postId, sig(r)]));
  const changed = rows.filter((r) => before.get(r.postId) !== sig(r));
  for (let i = 0; i < changed.length; i += 500) {
    const params: unknown[] = [seriesId, sourceId];
    const tuples = changed.slice(i, i + 500).map((r) => {
      params.push(r.postId, r.url ?? null, numKey(r.number),
        r.sourceNumber == null || !Number.isFinite(r.sourceNumber) ? null : r.sourceNumber, r.title ?? null, isoOf(r.publishedAt), !!r.gone);
      const b = params.length - 7;
      return `($1, $2, $${b + 1}, $${b + 2}, $${b + 3}::real, $${b + 4}::real, $${b + 5}, $${b + 6}::timestamptz, now(), CASE WHEN $${b + 7}::boolean THEN now() END)`;
    });
    await run(
      `INSERT INTO series_post_numbers (series_id, source_id, post_id, url, number, source_number, title, published_at, seen_at, gone_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (series_id, source_id, post_id) DO UPDATE SET
         url = EXCLUDED.url, number = EXCLUDED.number, source_number = EXCLUDED.source_number, title = EXCLUDED.title,
         published_at = EXCLUDED.published_at,
         seen_at = CASE WHEN EXCLUDED.gone_at IS NULL THEN now() ELSE series_post_numbers.seen_at END,
         gone_at = CASE WHEN EXCLUDED.gone_at IS NULL THEN NULL ELSE COALESCE(series_post_numbers.gone_at, EXCLUDED.gone_at) END`,
      params as any[],
    );
  }
}

/**
 * One source's listing in the numbering the series keeps for it: the stored assignment extended by whatever
 * is new (max + 1 at the tail, a midpoint for an insert, a hole for a deletion), persisted when `persist` --
 * the updater's check, which is the one writer; a fill scan reads without writing. Every chapter carries
 * `sourceNumber`, the number the source gave it, and a title without the extension's " (ch. N)".
 */
export async function numberedChapters<T extends SourceChapter>(
  ctx: { seriesId: string; sourceId: string; persist?: boolean }, raw: readonly T[],
): Promise<T[]> {
  const stored = await storedPosts(ctx.seriesId, ctx.sourceId);
  const a = assignPostingNumbers(postingSequence(raw), stored);
  if (ctx.persist) {
    await savePostNumbers(q, ctx.seriesId, ctx.sourceId, a.rows, stored, a.rekeyed)
      .catch((e) => console.warn(`[numbering] ${ctx.seriesId}: the posting numbers were not saved: ${(e as Error)?.message || e}`));
  }
  return a.numbered;
}

/** Is this series numbered by posting order: the refusals (hunt, auto-follow, borrowed names, follow) ask it. */
export async function postingOrderSeries(seriesId: string): Promise<boolean> {
  const r = await one<{ numbering: string | null }>('SELECT numbering FROM lib_series WHERE id = $1', [seriesId]).catch(() => null);
  return r?.numbering === 'posting_order';
}

/**
 * The sentence every refusal gives. Another site numbers the same posts its own way -- usually the way this
 * series was renumbered to get away from -- so its chapter 20 is not ours, and nothing that lines two sources
 * up by number (a follower, a hunt, a borrowed name, a fill from elsewhere) can work.
 */
export const POSTING_ORDER_REFUSAL =
  'This series is numbered by posting order, so another source’s chapter numbers do not line up with it.';

// ---- deciding --------------------------------------------------------------------------------------------

/**
 * The detector's verdict on a series' numbering source, from a fresh listing: `numbering_note` refreshed when it
 * changed, and a series left to the detector (numbering NULL, never set by hand) marked for review when the
 * verdict turns STRONG -- or unmarked when a verdict it was marked for has gone away before anyone confirmed it.
 * A manual choice is never overridden: an admin who kept the source's numbers has said so.
 */
export async function decideNumbering(s: { id: string } & NumberingRow, sourceId: string, raw: readonly SourceChapter[]): Promise<NumberingRow> {
  const d = detectSharedNumbering(raw);
  const note = noteOf(d, sourceId);
  const next: NumberingRow = { ...s };
  let dirty = false;
  if (!sameNote(s.numbering_note, note)) { next.numbering_note = { ...note, at: new Date().toISOString() }; dirty = true; }
  const free = s.numbering == null && s.numbering_by !== 'manual';
  if (free && !s.numbering_pending && d.verdict === 'strong') {
    next.numbering_pending = 'posting_order';
    next.numbering_source = sourceId;
    dirty = true;
  } else if (free && s.numbering_pending === 'posting_order' && d.verdict !== 'strong') {
    next.numbering_pending = null;
    dirty = true;
  }
  if (dirty) {
    await q('UPDATE lib_series SET numbering_note = $2::jsonb, numbering_pending = $3, numbering_source = $4 WHERE id = $1',
      [s.id, JSON.stringify(next.numbering_note), next.numbering_pending, next.numbering_source]).catch(() => {});
  }
  return next;
}

// ---- the plan -------------------------------------------------------------------------------------------

/** Anything else writing into a folder that this module cannot see from a lib (the routes' job cards). */
const busyProbes: Array<(folder: string) => boolean> = [];
/** routes/sources.ts registers its job map here: a Fetch, fill or add running for the folder. */
export function registerBusyProbe(fn: (folder: string) => boolean): void { busyProbes.push(fn); }
/**
 * Told after a renumber commits, with the old -> new map: a failed job card's Try again list moves with it, and the
 * slow archive forgets the numbers it remembered for the series (lib/archive.ts).
 */
const renumberListeners: Array<(folder: string, map: ReadonlyMap<number, number>, seriesId: string) => void> = [];
export function onRenumbered(fn: (folder: string, map: ReadonlyMap<number, number>, seriesId: string) => void): void { renumberListeners.push(fn); }
/**
 * Asked before a series' plan reads its books: whoever holds chapters of it on disk that the library has not scanned
 * yet starts scanning them in, and answers true (the slow archive scans what it lands in batches, lib/archive.ts). A
 * plan is built from lib_books, so a file with no row yet would keep its old name through the renumber and be scanned
 * in afterwards under a number that is another post's by then: until the scan is done the plan is `busy`, shown and
 * never applied. The scan is not waited for. It is a walk of the whole library, and a plan or a confirmation that
 * waited on one inside its request could outlive the proxy on a large library, or on a network share, and read as
 * failed (integration-2 review). Reintroduce by waiting: "a plan does not wait for the library scan" in
 * archive.int.test.ts.
 */
const beforePlanHooks: Array<(seriesId: string) => boolean> = [];
export function onBeforeRenumberPlan(fn: (seriesId: string) => boolean): void { beforePlanHooks.push(fn); }
function beforePlan(seriesId: string): boolean {
  let waiting = false;
  for (const fn of beforePlanHooks) {
    try { if (fn(seriesId)) waiting = true; } catch (e) { console.warn(`[numbering] ${seriesId}: ${(e as Error)?.message || e}`); }
  }
  return waiting;
}

/** A download running into the folder, whoever started it: a rename now would race the file it is writing. */
export function folderBusy(folder: string): boolean {
  if (busyFolders.has(folder)) return true;
  if (listActivity().active.some((e) => e.folder === folder)) return true;
  return busyProbes.some((p) => { try { return p(folder); } catch { return false; } });
}

interface SeriesForPlan extends NumberingRow {
  id: string;
  title: string;
  folder: string;
  chapter_floor: number | null;
}

interface Built {
  plan: RenumberPlan;
  /** The assignment to persist with a posting-order apply (every post, hole and reserved slot). */
  rows: PostNumber[] | null;
  /** Old number -> new number for every post whose old number is known, for floors the plan does not own. */
  pairs: Array<[number, number]>;
  /** What the row says once the plan is applied. */
  after: { numbering: NumberingMode | null; by: 'auto' | 'manual' | null; source: string | null };
  tracker: boolean;
  sourceId: string;
}

/**
 * Every fact planRenumber needs, gathered for one series: its books (the raw number the file carries; for the
 * undo, the number an unwritable root keeps in its override), the posts of the numbering they move to, and the
 * context -- audited Replace… picks, the listing's chosen posts, the floor, which roots can be renamed in, a
 * tracker link, a running download. `waiting`: chapters of the series are still being scanned in (beforePlan), so
 * the plan is busy too.
 */
async function buildRenumber(s: SeriesForPlan, sourceId: string, raw: readonly SourceChapter[], mode: RenumberMode, waiting = false): Promise<Built> {
  const books = await q<{ id: string; root: string; file: string; number: number; ov: number | null; title: string | null; chapter_name: string | null;
    chapter_name_source: string | null; published_at: Date | null; source_chapter_id: string | null; picked_at: Date | null; pruned_at: Date | null }>(
    `SELECT b.id, b.root, b.file, b.number::float8 AS number, o.number::float8 AS ov, b.title, b.chapter_name, b.chapter_name_source,
            b.published_at, b.source_chapter_id, b.picked_at, b.pruned_at
       FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id WHERE b.series_id = $1`, [s.id]);
  // Tried, not trusted from permission bits: a share can report writable and refuse the rename (lib/fsGuard.ts).
  const roots = new Map<string, boolean>();
  for (const b of books) if (!roots.has(b.root)) roots.set(b.root, (await writePreflight(b.root).catch(() => ({ ok: false }))).ok);
  const writable = (root: string) => roots.get(root) === true;

  let posts: PlanPost[] = [];
  let rows: PostNumber[] | null = null;
  let after: Built['after'];
  let keep: Map<number, string> | undefined;
  // Whether the stored listing may vouch for a book's post (planRenumber's weakest pass): not when it is written in
  // numbers the files are not in.
  let listingSpeaks = true;
  if (mode === 'remap' && s.numbering === 'posting_order') {
    // A posting-order series whose numbering source changed under its files (#116 review): added back from another
    // source -- an extension reinstalled under a new id, or another site -- while its files keep the posting
    // numbers of the source they were numbered by. The target is the numbering source's OWN posting assignment,
    // seeded from the stored one the files are in, so a post found again by url, or by title and day, keeps the
    // number it had and a file of it renames nothing. Every post is a candidate for every book, as in any remap.
    // ⚠️ Never the source's raw numbers: the row stays numbered by posting order, and its next check lists 1..K.
    // Reintroduce by planning a remap from `raw` alone: "added back from another source" in numbering.int.test.ts
    // renames the files to the source's own numbers.
    let stored = await storedPosts(s.id, sourceId);
    if (!stored.length) stored = await priorPosts(s.id, sourceId);
    const a = assignPostingNumbers(postingSequence(raw), stored);
    const fresh = new Set(a.added.map((r) => r.postId));
    rows = a.rows;
    posts = a.rows.map((r) => ({
      postId: r.postId, number: r.number, from: fresh.has(r.postId) ? null : r.number, title: r.title, publishedAt: r.publishedAt,
    }));
    after = { numbering: 'posting_order', by: s.numbering_by, source: sourceId };
    // The add wrote the listing in the new source's raw numbers; the files are in posting numbers.
    listingSpeaks = false;
  } else if (mode === 'posting_order') {
    const stored = await storedPosts(s.id, sourceId);
    const a = assignPostingNumbers(postingSequence(raw), stored);
    rows = a.rows;
    posts = a.rows.map((r) => ({ postId: r.postId, number: r.number, from: r.sourceNumber ?? null, title: r.title, publishedAt: r.publishedAt }));
    after = { numbering: 'posting_order', by: s.numbering_by === 'manual' ? 'manual' : 'auto', source: sourceId };
  } else if (mode === 'source') {
    // Back to the source's numbers: each stored post to the number the source gives it NOW (or gave it, for a
    // post it no longer lists), each parked book to the number its file had before it was parked.
    const stored = await storedPosts(s.id, sourceId);
    const live = new Map(raw.map((c) => [c.sourceId, c]));
    posts = stored.map((r) => {
      const now = r.postId.startsWith(EXTRA_PREFIX) ? undefined : live.get(r.postId)?.number;
      const to = Number.isFinite(now) ? now! : r.sourceNumber ?? r.number;
      return { postId: r.postId, number: numKey(to), from: r.number, title: r.title, publishedAt: r.publishedAt };
    });
    for (const c of raw) if (!stored.some((r) => r.postId === c.sourceId)) posts.push({ postId: c.sourceId, number: numKey(c.number), from: null, title: c.title, publishedAt: c.publishedAt });
    // Several posts land back on one number: the one the chooser would take keeps `Chapter N.cbz`.
    const prefs = await effectivePrefsFor(await readSeriesPrefs(s.id).catch(() => null), 0);
    keep = new Map(chooseReleases(raw.map((c) => ({ ...c, source: sourceId })), prefs).releases.map((c) => [numKey(c.number), c.sourceId]));
    after = { numbering: 'source', by: 'manual', source: null };
  } else {
    posts = raw.map((c) => ({ postId: c.sourceId, number: numKey(c.number), from: null, title: c.title, publishedAt: c.publishedAt }));
    after = { numbering: s.numbering, by: s.numbering_by, source: s.numbering_source };
  }

  // `chapterNameSource` says where a chapter name came from when it is not the file's own (fixL2): a name borrowed
  // from another source, or one the listing healed onto the book (lib/seriesListing.ts, HEALED_NAME). Neither is
  // the name pass's exact evidence. Reintroduce by leaving it out: "a healed name chooses a post but never makes a
  // plan clean" in numbering.int.test.ts reads a clean plan.
  const planBooks: PlanBook[] = books.map((b) => ({
    id: b.id, root: b.root, file: b.file,
    number: mode === 'source' && b.ov != null && !writable(b.root) ? Number(b.ov) : Number(b.number),
    title: b.title, chapterName: b.chapter_name, chapterNameSource: b.chapter_name_source, publishedAt: isoOf(b.published_at),
    sourceChapterId: b.source_chapter_id, pickedAt: isoOf(b.picked_at), pruned: b.pruned_at != null,
  }));
  // Replace… with a named copy is audited with the post it wrote (routes/admin.ts); the latest pick of a book wins.
  const picks = new Map<string, string>();
  const audits = await q<{ picks: Array<{ bookId?: string; source?: string; sourceId?: string }> | null }>(
    `SELECT detail->'picks' AS picks FROM audit_log WHERE event = 'series.chapters_refetch' AND detail->>'id' = $1 ORDER BY at, id`, [s.id]).catch(() => []);
  for (const a of audits) for (const p of a.picks ?? []) if (p?.bookId && p.sourceId && (!p.source || p.source === sourceId)) picks.set(p.bookId, p.sourceId);
  const listing = new Map<number, string>();
  if (listingSpeaks) {
    for (const r of await q<{ number: number; cid: string | null; source_id: string }>(
      `SELECT number::float8 AS number, chosen->>'sourceId' AS cid, source_id FROM series_listing WHERE series_id = $1`, [s.id]).catch(() => [])) {
      if (r.cid && r.source_id === sourceId) listing.set(numKey(Number(r.number)), r.cid);
    }
  }
  const tracker = !!(await one<{ n: number }>('SELECT 1 AS n FROM series_trackers WHERE series_id = $1 LIMIT 1', [s.id]).catch(() => null));
  const plan = planRenumber(planBooks, { mode, posts }, {
    picks, listing, keep, writable, tracker, busy: waiting || folderBusy(s.folder),
    floor: s.chapter_floor == null ? null : Number(s.chapter_floor),
    // A posting assignment is persisted with the apply: the parked books' numbers are reserved in it.
    reserveParked: rows != null,
  });
  const pairs: Array<[number, number]> = posts.filter((p) => p.from != null && Number.isFinite(p.from))
    .map((p) => [numKey(p.from!), numKey(p.number)] as [number, number]);
  return { plan, rows: rows ? [...rows, ...plan.extras] : null, pairs: pairs.length ? pairs : plan.markMap, after, tracker, sourceId };
}

/**
 * A floor-like number (chapter_floor, the archive's boundary) in the new numbering: the first post at or above
 * it. Above everything stays above everything, as planRenumber keeps a Nothing-yet floor.
 */
function floorThrough(x: number, pairs: ReadonlyArray<[number, number]>): number {
  const f = numKey(x);
  const at = pairs.filter(([from]) => from >= f).map(([, to]) => to);
  if (at.length) return Math.min(...at);
  return numKey(Math.max(0, ...pairs.map(([, to]) => to)) + 0.001);
}

// ---- applying -------------------------------------------------------------------------------------------

/** The journal of an apply in flight: everything the transaction needs, so a resume needs no listing. */
interface Journal {
  v: 1;
  id: string;
  mode: RenumberMode;
  /** rename: files may still be at their old names. final: every file is at a temporary name or its final one. */
  phase: 'rename' | 'final';
  folder: string;
  sourceId: string;
  after: Built['after'];
  moves: PlanMove[];
  newFloor: number | null;
  markMap: Array<[number, number]>;
  pairs: Array<[number, number]>;
  rows: PostNumber[] | null;
  at: string;
}

/**
 * Test seams: a throw in `afterFirstPhase` is a crash with every file at its temporary name; in
 * `afterSecondPhase`, a crash with every file at its new name and every row still at its old one.
 */
export const renumberHooks: { afterFirstPhase?: () => void | Promise<void>; afterSecondPhase?: () => void | Promise<void> } = {};

const exists = (p: string) => stat(p).then(() => true, () => false);
const TMP = (j: Journal) => `.renumber-${j.id}`;
const baseTitle = (file: string) => file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1).replace(/\.(cbz|cbr|zip|rar|pdf|epub)$/i, '');

/** Where a move's file is, was and passes through; null when a path would leave its root (never renamed). */
function pathsOf(j: Journal, m: PlanMove): { from: string; tmp: string; to: string } | null {
  const from = containedPath(m.root, m.fromFile);
  const to = containedPath(m.root, m.file);
  return from && to ? { from, tmp: from + TMP(j), to } : null;
}

/** An apply refused before it renamed anything: its sentence, with the code the web words it by (lib/said.ts). */
class RenumberRefused extends Error {
  constructor(public said: Part) { super(said.text); }
}

/** Nothing the plan does not own may be overwritten: a file already at a target name that no move vacates. */
async function checkTargets(j: Journal): Promise<void> {
  const renames = j.moves.filter((m) => m.via === 'rename');
  const vacated = new Set(renames.map((m) => `${m.root}\u0000${m.fromFile}`));
  for (const m of renames) {
    const p = pathsOf(j, m);
    if (!p) throw new RenumberRefused(say('renumber.leavesRoot', { file: m.fromFile }));
    if (!vacated.has(`${m.root}\u0000${m.file}`) && await exists(p.to)) throw new RenumberRefused(say('renumber.onDisk', { file: m.file }));
  }
}

async function firstPhase(j: Journal): Promise<void> {
  const done: Array<{ from: string; tmp: string }> = [];
  try {
    for (const m of j.moves) {
      if (m.via !== 'rename') continue;
      const p = pathsOf(j, m)!;
      if (await exists(p.tmp)) continue;
      try { await renameRetry(p.from, p.tmp); done.push(p); } catch (e) {
        // A file already gone is a row that moves without one, as a tombstone does.
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    }
  } catch (e) {
    // A refusal half-way (a read-only file, a lock) is put back as it was and reported, not left for a resume
    // that would only meet the same refusal: the series goes on in its old numbering.
    for (const p of done.reverse()) await renameRetry(p.tmp, p.from).catch(() => {});
    throw e;
  }
}

async function secondPhase(j: Journal): Promise<void> {
  for (const m of j.moves) {
    if (m.via !== 'rename') continue;
    const p = pathsOf(j, m)!;
    if (!(await exists(p.tmp))) continue;
    await renameRetry(p.tmp, p.to);
  }
}

/** Every row the apply changes, in one transaction that ends by clearing the journal. */
async function commit(seriesId: string, j: Journal): Promise<void> {
  const markMap = new Map(j.markMap);
  await tx(async (qq) => {
    const moved = j.moves.filter((m) => m.via === 'rename' || m.via === 'row');
    if (moved.length) {
      // Away from their old names first: two books trading numbers would otherwise meet on the (root, file) index.
      await qq('UPDATE lib_books SET file = file || $2 WHERE id = ANY($1)', [moved.map((m) => m.bookId), TMP(j)]);
      for (let i = 0; i < moved.length; i += 1000) {
        const params: unknown[] = [];
        const values = moved.slice(i, i + 1000).map((m) => {
          params.push(m.bookId, m.to, m.file, baseTitle(m.file), m.postId && !m.postId.startsWith(EXTRA_PREFIX) ? m.postId : null);
          const b = params.length - 5;
          return `($${b + 1}::text, $${b + 2}::real, $${b + 3}::text, $${b + 4}::text, $${b + 5}::text)`;
        });
        await qq(
          `UPDATE lib_books b SET number = v.n, file = v.f, title = v.t, source_chapter_id = COALESCE(v.c, b.source_chapter_id), updated_at = now()
             FROM (VALUES ${values.join(',')}) AS v(id, n, f, t, c) WHERE b.id = v.id`, params as any[]);
      }
      // A number an admin set by hand described the file's old place; the file is at its right number now.
      await qq('UPDATE book_overrides SET number = NULL, updated_at = now() WHERE book_id = ANY($1) AND number IS NOT NULL', [moved.map((m) => m.bookId)]);
    }
    // An unwritable root cannot be renamed in: the override carries the new number instead, and the have-sets
    // read it (override-aware in posting mode).
    for (const m of j.moves.filter((x) => x.via === 'override')) {
      await qq(`INSERT INTO book_overrides (book_id, number) VALUES ($1, $2::real)
                ON CONFLICT (book_id) DO UPDATE SET number = EXCLUDED.number, updated_at = now()`, [m.bookId, m.to]);
    }
    const stamped = j.moves.filter((m) => (m.via === 'none' || m.via === 'override') && m.postId && !m.postId.startsWith(EXTRA_PREFIX));
    if (stamped.length) {
      await qq(`UPDATE lib_books b SET source_chapter_id = v.c FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS c) v
                 WHERE b.id = v.id AND b.source_chapter_id IS DISTINCT FROM v.c`, [stamped.map((m) => m.bookId), stamped.map((m) => m.postId)]);
    }
    // Failures were counted against the old numbers: chapter 2's three failures are not post 20's.
    await qq('DELETE FROM chapter_failures WHERE series_id = $1', [seriesId]);
    // Read marks on chapters this server does not hold follow their post; one with no post to follow goes.
    const marks = await qq<{ user_id: string; number: number; completed_at: Date; source: string }>(
      'SELECT user_id, number::float8 AS number, completed_at, source FROM listing_progress WHERE series_id = $1', [seriesId]);
    if (marks.length) {
      const out = new Map<string, { user_id: string; number: number; completed_at: Date; source: string }>();
      for (const m of marks) {
        const to = markMap.get(numKey(Number(m.number)));
        if (to === undefined) continue;
        const k = `${m.user_id}\u0000${to}`;
        const had = out.get(k);
        if (!had || new Date(m.completed_at) < new Date(had.completed_at)) out.set(k, { ...m, number: to });
      }
      await qq('DELETE FROM listing_progress WHERE series_id = $1', [seriesId]);
      const list = [...out.values()];
      for (let i = 0; i < list.length; i += 1000) {
        const params: unknown[] = [seriesId];
        const values = list.slice(i, i + 1000).map((m) => {
          params.push(m.user_id, m.number, m.completed_at, m.source);
          const b = params.length - 4;
          return `($${b + 1}::uuid, $1, $${b + 2}::real, $${b + 3}::timestamptz, $${b + 4})`;
        });
        await qq(`INSERT INTO listing_progress (user_id, series_id, number, completed_at, source) VALUES ${values.join(',')}`, params as any[]);
      }
    }
    if (j.newFloor != null) await qq('UPDATE lib_series SET chapter_floor = $2 WHERE id = $1 AND chapter_floor IS NOT NULL', [seriesId, j.newFloor]);
    // The slow archive (#117) owns listed numbers below its boundary: moved through the same rule as the floor,
    // or the sweep would skip posts 1..8 and the archive fetch the wrong ones.
    const aq = await qq<{ boundary: number | null; floor_at_start: number | null }>(
      'SELECT boundary::float8 AS boundary, floor_at_start::float8 AS floor_at_start FROM archive_queue WHERE series_id = $1', [seriesId]);
    if (aq.length) {
      const b = aq[0].boundary == null ? null : floorThrough(Number(aq[0].boundary), j.pairs);
      const f = aq[0].floor_at_start == null ? null : floorThrough(Number(aq[0].floor_at_start), j.pairs);
      await qq(`UPDATE archive_queue SET boundary = $2, floor_at_start = $3,
                  note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('renumbered', now()) WHERE series_id = $1`, [seriesId, b, f]);
    }
    if (j.markMap.length) {
      const params: unknown[] = [j.folder];
      const values = j.markMap.map(([from, to]) => { params.push(from, to); return `($${params.length - 1}::real, $${params.length}::real)`; });
      await qq(`UPDATE download_log d SET number = v.t FROM (VALUES ${values.join(',')}) AS v(f, t) WHERE d.folder = $1 AND d.number = v.f`, params as any[]);
    }
    if (j.rows) {
      // The assignment the files are in now, and only that one: another source's rows (the one a series added back
      // from a new source was numbered by) described the files until this commit, and a later re-add from that
      // source would apply them to files that are no longer in its numbers.
      await qq('DELETE FROM series_post_numbers WHERE series_id = $1 AND source_id <> $2', [seriesId, j.sourceId]);
      await savePostNumbers(qq as typeof q, seriesId, j.sourceId, j.rows, await storedPosts(seriesId, j.sourceId, qq as typeof q));
    } else if (j.mode === 'source') {
      await qq('DELETE FROM series_post_numbers WHERE series_id = $1', [seriesId]);
    }
    // The listing is written again by the check that follows, in the new numbers; ignoring a gap was about
    // numbers that no longer mean what they did.
    await qq('DELETE FROM series_listing WHERE series_id = $1', [seriesId]);
    await qq(`DELETE FROM health_ignored WHERE check_id = 'chapter-gaps' AND item_key = $1`, [`series:${seriesId}`]);
    // numbering_changed_at is when the NUMBERING changed (Health lists a series numbered by posting order on its own
    // for two weeks after it): a remap keeps the numbering it had, and moves it only by re-matching files.
    await qq(
      `UPDATE lib_series SET numbering = $2, numbering_by = $3, numbering_source = $4, numbering_pending = NULL, renumber_plan = NULL,
              numbering_changed_at = CASE WHEN numbering IS DISTINCT FROM $2 THEN now() ELSE numbering_changed_at END WHERE id = $1`,
      [seriesId, j.after.numbering, j.after.by, j.after.source],
    );
  });
  const map = new Map(j.markMap.map(([a, b]) => [numKey(a), numKey(b)] as [number, number]));
  renumberFinished(j.folder, map);
  for (const fn of renumberListeners) { try { fn(j.folder, map, seriesId); } catch { /* a card is not worth a renumber */ } }
  // The Health page's numbering finding (and the header's mark with it) is about a series that is no longer held.
  scheduleHealthSummaryRefresh();
}

/**
 * Renames and rows, from a journal already in lib_series.renumber_plan. Scans held, the folder busy. False when a
 * resume found nothing left to finish.
 *
 * ⚠️ A RESUME RUNS THE JOURNAL AS IT STANDS ONCE IT HOLDS THE SCANS, never the copy it read before it waited for them.
 * It waits behind whoever holds them -- the confirmed apply that wrote this very journal (a check that starts while
 * one runs finds its journal on the row), or another resume of it -- and by then the journal may be finished and
 * cleared, replaced, or carried into its second phase. Run again from the stale copy, the first phase moved whatever
 * sat at a move's old name -- in a chain (1 -> 2, 2 -> 21), post 2's freshly renamed file -- to its temporary name,
 * the second phase renamed it over post 21's file, and the commit remapped every read mark a second time, deleting
 * each one the map has no entry for (integration-2 review, a blocker).
 * Reintroduce by running the copy that was read before the wait (drop the read below): "a check that starts while a
 * confirmed renumber applies" in numbering.int.test.ts finds post 21's file overwritten. Drop only `j = now` (the
 * phase the journal has reached): "a resume that waited behind another" there finds it overwritten too.
 */
async function runJournal(seriesId: string, j: Journal, fresh: boolean): Promise<boolean> {
  const mine = !busyFolders.has(j.folder);
  if (mine) busyFolders.add(j.folder);
  try {
    return await withScansHeld(async () => {
      if (!fresh) {
        const now = (await one<{ plan: Journal | null }>('SELECT renumber_plan AS plan FROM lib_series WHERE id = $1', [seriesId]))?.plan;
        if (!now || now.id !== j.id) return false;
        j = now;
      }
      if (j.phase === 'rename') {
        try {
          await firstPhase(j);
        } catch (e) {
          if (fresh) await q('UPDATE lib_series SET renumber_plan = NULL WHERE id = $1', [seriesId]).catch(() => {});
          throw e;
        }
        await renumberHooks.afterFirstPhase?.();
        j.phase = 'final';
        await q(`UPDATE lib_series SET renumber_plan = jsonb_set(renumber_plan, '{phase}', '"final"') WHERE id = $1`, [seriesId]);
      }
      await secondPhase(j);
      await renumberHooks.afterSecondPhase?.();
      await commit(seriesId, j);
      return true;
    });
  } finally {
    if (mine) busyFolders.delete(j.folder);
  }
}

async function applyRenumber(s: SeriesForPlan, built: Built): Promise<void> {
  const { plan } = built;
  const j: Journal = {
    v: 1, id: randomBytes(6).toString('hex'), mode: plan.mode, phase: 'rename', folder: s.folder, sourceId: built.sourceId,
    after: built.after, moves: [...plan.moves, ...plan.parked], newFloor: plan.newFloor, markMap: plan.markMap,
    pairs: built.pairs, rows: built.rows, at: new Date().toISOString(),
  };
  await checkTargets(j);
  // Written BEFORE the first rename: from here on a crash leaves a journal the next check finishes.
  await q('UPDATE lib_series SET renumber_plan = $2::jsonb WHERE id = $1', [s.id, JSON.stringify(j)]);
  await runJournal(s.id, j, true);
  await logAudit('series.renumber', {
    detail: {
      id: s.id, title: s.title, mode: plan.mode, numbering: built.after.numbering, source: built.sourceId,
      moved: plan.moves.filter((m) => m.via !== 'none').length, parked: plan.parked.length, collisions: plan.collisions.length,
      reasons: plan.reasons,
    },
  });
}

/**
 * Finish an apply a crash interrupted. Idempotent: a file already at its final name is left there, one at its
 * temporary name is moved on, one still at its old name (the crash came mid-way through the first phase) is
 * moved through both. The rows follow from the journal alone. False when there was nothing to finish: no journal,
 * or one another run finished while this one waited (runJournal).
 */
export async function resumeRenumber(seriesId: string): Promise<boolean> {
  const r = await one<{ renumber_plan: Journal | null }>('SELECT renumber_plan FROM lib_series WHERE id = $1', [seriesId]);
  const j = r?.renumber_plan;
  if (!j || j.v !== 1) return false;
  if (!(await runJournal(seriesId, j, false))) return false;
  console.log(`[numbering] ${seriesId}: finished a renumber a restart had interrupted`);
  return true;
}

/** What settleNumbering did. `needs_review` and `busy` leave the series held: no downloads, its listing kept. */
export type SettleState = 'none' | 'applied' | 'needs_review' | 'busy';
export interface Settled {
  state: SettleState; numbering: NumberingRow; plan?: RenumberPlan; tracker?: boolean; error?: string;
  /** v0.49.1: `error` as a code the web words (lib/said.ts `renumber.*`). */
  errorSaid?: Said;
}

/** One settle per series at a time, in this process. */
const settling = new Set<string>();

/** Why a renumber waits for another run inside its series (lib/updater.ts runsInside). */
export const CHECKING_NOW = 'This series is being checked right now. Try again when that ends.';

/**
 * Carry out a pending numbering change, when it may be carried out: with a person's confirmation, or with no
 * chapter row to move at all. Otherwise the plan is answered and nothing changes.
 */
export async function settleNumbering(
  s: SeriesForPlan, sourceId: string, raw: readonly SourceChapter[], opts: { confirm?: boolean } = {},
): Promise<Settled> {
  const mode = s.numbering_pending;
  if (!mode) return { state: 'none', numbering: s };
  if (mode !== 'remap' && s.numbering === mode) {
    await q('UPDATE lib_series SET numbering_pending = NULL WHERE id = $1', [s.id]).catch(() => {});
    return { state: 'none', numbering: { ...s, numbering_pending: null } };
  }
  if (settling.has(s.id)) return { state: 'busy', numbering: s };
  // Another run inside the series (the sweep, a check, Fill) read its listing and have-set in today's numbers and
  // would fetch into them after the renames: the renumber waits for it, and the series stays held meanwhile. The
  // confirmation route refuses first (routes/numbering.ts); this covers the moment between its test and this run.
  // Reintroduce by dropping it: "a renumber waits for a check inside the series" in numberingRoutes.int.test.ts
  // finds the files renamed under the check.
  if (runsInside(s.id) > 1) return { state: 'busy', numbering: s, error: CHECKING_NOW, errorSaid: saidOf(say('renumber.checking')) };
  settling.add(s.id);
  try {
    // Chapters still coming into the library hold it like a download into the folder does: `busy`, and the scan
    // that lets it through has been started.
    const built = await buildRenumber(s, sourceId, raw, mode, beforePlan(s.id));
    if (built.plan.reasons.includes('busy')) return { state: 'busy', numbering: s, plan: built.plan, tracker: built.tracker };
    const rows = built.plan.moves.length + built.plan.parked.length;
    // The owner's rule for v0.49.0: a series in a library is renamed only when an admin has seen the plan.
    // Reintroduce by applying without the confirmation: "an existing series is held for review, not renamed" in
    // numbering.int.test.ts reads outcome 'ok' ("held, whatever the plan").
    // One exception, because it renames nothing: a remap (the source's numbers moved under the files, or a series
    // came back from a new source) whose every book keeps its number, each matched by evidence of its own -- never
    // a date or the listing's guess, nothing parked, no collision; a tracker link does not matter when no number
    // moves. The numbering does not change; only which post each file is gets written down. Held for a
    // confirmation, it stopped every series of a source whose setting changed nothing for them until an admin
    // confirmed each one (#116 review). Reintroduce by holding it: "a remap that renames nothing settles by
    // itself" in numberingRoutes.int.test.ts reads renumber_pending.
    const noop = mode === 'remap' && built.plan.reasons.every((r) => r === 'tracker')
      && !built.plan.parked.length && built.plan.moves.every((m) => m.via === 'none');
    if (rows > 0 && !opts.confirm && !noop) return { state: 'needs_review', numbering: s, plan: built.plan, tracker: built.tracker };
    try {
      await applyRenumber(s, built);
    } catch (e) {
      if (!(e instanceof RenumberRefused)) throw e;
      return { state: 'needs_review', numbering: s, plan: built.plan, tracker: built.tracker, error: e.message, errorSaid: saidOf(e.said) };
    }
    const after = await one<NumberingRow>(`SELECT ${NUMBERING_COLUMNS} FROM lib_series WHERE id = $1`, [s.id]);
    return { state: 'applied', numbering: after ?? s, plan: built.plan, tracker: built.tracker };
  } finally {
    settling.delete(s.id);
  }
}

// ---- for the routes and Health --------------------------------------------------------------------------

const PLAN_LIST_TIMEOUT = 20_000;

/**
 * The plan a numbering change would carry out, from a fresh (bounded) listing of the numbering source, changing
 * nothing: what the series page and Health show before an admin confirms. Null when the series or its source
 * cannot be reached.
 */
export async function planFor(seriesId: string, mode: RenumberMode): Promise<{ plan: RenumberPlan; tracker: boolean } | null> {
  const s = await one<SeriesForPlan & { source_id: string | null; source_series_id: string | null }>(
    `SELECT id, title, folder, chapter_floor, source_id, source_series_id, ${NUMBERING_COLUMNS} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!s) return null;
  const sourceId = s.numbering === 'posting_order' && s.numbering_source ? s.numbering_source : s.source_id;
  const ref = sourceId === s.source_id ? s.source_series_id : (await one<{ source_series_id: string }>(
    'SELECT source_series_id FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, sourceId]))?.source_series_id;
  const adapter = sourceId ? getSource(sourceId) : null;
  if (!adapter || !ref) return null;
  const raw = await withTimeout(adapter.listChapters(ref), budgetFor(adapter, PLAN_LIST_TIMEOUT)).catch(() => null);
  if (!raw?.length) return null;
  // The plan an admin is shown is the one a confirmation would apply: while chapters on disk that no scan has taken
  // in yet are being scanned in, it says `busy`, as the confirmation would (settleNumbering).
  const built = await buildRenumber(s, sourceId!, raw, mode, beforePlan(seriesId));
  return { plan: built.plan, tracker: built.tracker };
}

/**
 * An admin's numbering choice for one series. `auto` hands the series back to the detector. `posting_order` and
 * `source` without `confirm` answer the plan and change nothing; with it, they are marked pending under the
 * admin's name (a manual choice, which the detector never undoes) and applied by a check run now. `pending`
 * means the check could not apply it yet (a download is running, the source did not answer): the series stays
 * held and the plan can be confirmed again.
 */
export async function requestNumbering(
  seriesId: string, mode: NumberingChoice | 'remap', opts: { confirm?: boolean; userId?: string | null } = {},
): Promise<{ state: 'applied' | 'pending' | 'needs_confirm' | 'unchanged'; plan?: RenumberPlan; tracker?: boolean; error?: string; errorSaid?: Said } | null> {
  const s = await one<NumberingRow & { source_id: string | null }>(`SELECT source_id, ${NUMBERING_COLUMNS} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!s) return null;
  // What a confirmed check did, as the POST answers it. `pending` carries why when the check knows (#116 review): a
  // refusal's own words (`error`, e.g. "Chapter 21.cbz is already on disk") and the plan's reasons ('busy'), which
  // the page used to word as "the source may not have answered" and so sent an admin to retry forever.
  // Reintroduce by dropping `error`: "a stray file at a target name refuses the apply" in numbering.int.test.ts
  // finds no reason in the answer.
  const confirmed = async (): Promise<{ state: 'applied' | 'pending'; plan?: RenumberPlan; tracker?: boolean; error?: string; errorSaid?: Said }> => {
    const r = await updateSeries(seriesId, 0, { confirmRenumber: true });
    await logAudit('series.numbering', { userId: opts.userId ?? null, detail: { id: seriesId, mode, state: r.renumber?.state ?? r.outcome } });
    scheduleHealthSummaryRefresh();
    return {
      state: r.renumber?.state === 'applied' ? 'applied' : 'pending',
      ...(r.renumber?.plan ? { plan: r.renumber.plan, tracker: r.renumber.tracker } : {}),
      ...(r.renumber?.error ? { error: r.renumber.error, ...(r.renumber.errorSaid ? { errorSaid: r.renumber.errorSaid } : {}) } : {}),
    };
  };
  if (mode === 'remap') {
    // The source's own numbers moved under the files (an extension setting changed, routes/numbering.ts): the
    // numbering is the same, only the matching is new, so a remap is confirmed as it stands and never chosen.
    if (s.numbering_pending !== 'remap') return { state: 'unchanged' };
    if (!opts.confirm) {
      const p = await planFor(seriesId, 'remap');
      return { state: 'needs_confirm', ...(p ? { plan: p.plan, tracker: p.tracker } : {}) };
    }
    return confirmed();
  }
  if (mode === 'auto') {
    await q(`UPDATE lib_series SET numbering_by = NULL,
                    numbering = CASE WHEN numbering = 'source' THEN NULL ELSE numbering END,
                    numbering_pending = CASE WHEN numbering_pending = 'source' THEN NULL ELSE numbering_pending END
              WHERE id = $1`, [seriesId]);
    scheduleHealthSummaryRefresh();
    return { state: 'unchanged' };
  }
  if ((s.numbering ?? 'source') === mode) {
    // Already numbered that way: the choice is recorded as the admin's, and a renumber the detector proposed is
    // dropped -- "keep the source's numbers" on a series waiting for review. A remap is not a proposal: the
    // source's own numbers moved under the files, and it stays.
    await q(`UPDATE lib_series SET numbering = $2, numbering_by = 'manual',
                    numbering_pending = CASE WHEN numbering_pending = 'remap' THEN 'remap' ELSE NULL END WHERE id = $1`, [seriesId, mode]);
    // Health's numbering finding for it is gone, and the header's mark with it (lib/healthSummary.ts).
    scheduleHealthSummaryRefresh();
    return { state: 'unchanged' };
  }
  if (!opts.confirm) {
    const p = await planFor(seriesId, mode);
    return { state: 'needs_confirm', ...(p ? { plan: p.plan, tracker: p.tracker } : {}) };
  }
  await q(`UPDATE lib_series SET numbering_pending = $2, numbering_by = 'manual',
                  numbering_source = COALESCE(numbering_source, source_id) WHERE id = $1`, [seriesId, mode]);
  return confirmed();
}

/** What the series page says about a series' numbering (the listing route's `numbering`). */
export async function numberingSummary(seriesId: string): Promise<{
  mode: NumberingMode | null; by: string | null; pending: RenumberMode | null; note: NumberingNote | null;
  changedAt: string | null; sourceName: string | null; extSourceId?: string;
} | null> {
  const r = await one<NumberingRow & { source_id: string | null; source: string | null; numbering_changed_at: Date | null }>(
    `SELECT source_id, source, numbering_changed_at, ${NUMBERING_COLUMNS} FROM lib_series WHERE id = $1`, [seriesId]).catch(() => null);
  if (!r) return null;
  const src = r.numbering_source ?? r.numbering_note?.source ?? r.source_id;
  // The name a person knows: the loaded adapter's, else -- an extension the engine is not serving right now -- the
  // name the series was added under, when this is its own source. The raw id ("sw:2522335540328470744 gives many
  // different posts...") only when there is nothing better (#116 review).
  const sourceName = src ? getSource(src)?.name ?? (src === r.source_id && r.source ? r.source : src) : null;
  return {
    mode: r.numbering, by: r.numbering_by, pending: r.numbering_pending, note: r.numbering_note,
    changedAt: isoOf(r.numbering_changed_at), sourceName,
    ...(src && isSwAdapterId(src) ? { extSourceId: src.slice(SW_PREFIX.length) } : {}),
  };
}

// ---- the add ----------------------------------------------------------------------------------------------

/** What an add decided about numbering, and what it writes onto the row once there is one. */
export interface AddNumbering {
  numbering: NumberingMode | null;
  by: 'auto' | 'manual' | null;
  source: string | null;
  pending: RenumberMode | null;
  note: NumberingNote;
  /** The assignment to persist, for a series numbered by posting order. */
  rows?: PostNumber[];
  stored?: PostNumber[];
}

/**
 * Number an add's listing, and decide what the row records. A new series (nothing on disk under the folder) is
 * numbered at once. A folder that already holds books is never renamed blind: its files keep the numbers they
 * have, and the series is added for review instead (`pending`) -- unless the row already keeps an assignment for
 * this source, a series removed and added back, whose files are in posting numbers already. A manual choice on
 * a revived row outranks the detector, as it does in the updater.
 */
export async function addNumbering<T extends SourceChapter>(
  raw: readonly T[], want: NumberingChoice, ctx: { folder: string; sourceId: string; existingId?: string | null },
): Promise<{ chapters: T[]; applied: NumberingMode; decision: AddNumbering; detect: SharedNumbering }> {
  const detect = detectSharedNumbering(raw);
  const note = { ...noteOf(detect, ctx.sourceId), at: new Date().toISOString() };
  const row = ctx.existingId
    ? await one<NumberingRow>(`SELECT ${NUMBERING_COLUMNS} FROM lib_series WHERE id = $1`, [ctx.existingId]).catch(() => null) : null;
  const stored = ctx.existingId ? await storedPosts(ctx.existingId, ctx.sourceId).catch(() => []) : [];
  const books = !!(await one<{ n: number }>(
    'SELECT 1 AS n FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1 LIMIT 1', [ctx.folder]).catch(() => null));
  const posting = raw.length > 0 && (want === 'posting_order'
    || (want === 'auto' && (row?.numbering === 'posting_order' || (row?.numbering_by !== 'manual' && detect.verdict === 'strong'))));
  const kept = { numbering: row?.numbering ?? null, by: row?.numbering_by ?? null };
  if (posting) {
    if (books && (!stored.length || (row?.numbering_source && row.numbering_source !== ctx.sourceId))) {
      // Books on disk and no assignment of this source to read them by: renumbering them is a plan for an admin.
      const pending: RenumberMode = row?.numbering === 'posting_order' ? 'remap' : 'posting_order';
      return { chapters: [...raw], applied: 'source', detect, decision: { ...kept, source: ctx.sourceId, pending, note } };
    }
    const a = assignPostingNumbers(postingSequence(raw), stored);
    return {
      chapters: a.numbered, applied: 'posting_order', detect,
      decision: { numbering: 'posting_order', by: want === 'posting_order' ? 'manual' : (row?.numbering_by ?? 'auto'), source: ctx.sourceId, pending: null, note, rows: a.rows, stored },
    };
  }
  if (row?.numbering === 'posting_order' && books && stored.length) {
    // Asked for the source's numbers on a series whose files are in posting numbers: the undo is a plan.
    const a = assignPostingNumbers(postingSequence(raw), stored);
    return { chapters: a.numbered, applied: 'posting_order', detect, decision: { ...kept, source: row.numbering_source, pending: 'source', note } };
  }
  return {
    chapters: [...raw], applied: 'source', detect,
    decision: want === 'source'
      ? { numbering: 'source', by: 'manual', source: null, pending: null, note }
      : { ...kept, source: row?.numbering_source ?? null, pending: null, note },
  };
}

/** Write an add's decision onto its row (by id, or by folder before the id is known) and persist its numbers. */
export async function stampAddNumbering(where: { id: string } | { folder: string }, sourceId: string, d: AddNumbering): Promise<void> {
  const byId = 'id' in where;
  const rows = await q<{ id: string }>(
    `UPDATE lib_series SET numbering = $2, numbering_by = $3, numbering_source = $4, numbering_pending = $5, numbering_note = $6::jsonb,
            numbering_changed_at = CASE WHEN numbering IS DISTINCT FROM $2 THEN now() ELSE numbering_changed_at END
      WHERE ${byId ? 'id' : 'folder'} = $1 RETURNING id`,
    [byId ? where.id : where.folder, d.numbering, d.by, d.source, d.pending, JSON.stringify(d.note)],
  );
  if (d.rows) for (const r of rows) await savePostNumbers(q, r.id, sourceId, d.rows, d.stored ?? []);
}
