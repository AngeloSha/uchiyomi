// What a removed source leaves behind.
//
// A source followed by mistake (the wrong series on the site, often one with MORE chapters than the real one) fetched
// chapters this series never had. Taking the source off used to leave them all: the files, their rows, their
// tombstones once deleted, and everyone's read marks. Each such row kept its number in the updater's have-set
// (lib/updater.ts reads it by number, from any source), so when the real series reached that number the sweep took it
// as held and never fetched it, and a reader's mark on the wrong chapter carried onto the real one.
//
// Explicitly cleaning up a source can take every chapter ONLY it lists, as though it had never been fetched:
// Removing a source alone always keeps downloaded chapters and progress.
//  - WHICH: rows of this series stamped with that source (lib_books.source_id, written when its file landed) whose
//    number -- the file's own and an admin's override, and every number of a range -- no source the series still
//    follows lists (series_listing, every copy of every row). Live chapters and tombstones alike: a tombstone is what
//    blocks the fetch. Only in the download folder; a library somebody assembled by hand is theirs.
//  - NOTHING when no other source is left (the admin's call: detaching a series' only source keeps its chapters, as a
//    site going down must not empty a shelf).
//  - WHAT GOES: the file (and a set-aside refetch copy), the row (book_overrides, page_hashes, comments, reactions,
//    spread marks and translations cascade), its reading progress, bookmarks and offline-download rows, and the
//    by-number read marks and failure entries of every number only that source listed. reading_events stays: it is
//    the append-only record of what was read (lib/migrate.ts), and counts nothing the sweep looks at.
//  - A row whose file cannot be removed (unreadable, its folder missing: an unmounted share) is left as it is.
//
// cleanupPreview proves eligibility from fresh remaining-source listings. purgeLeftovers executes a confirmed
// preview while the caller owns both the series writer claim and DB row lock.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import { getSource } from './sources';
import { bounded } from './autoFollow';
import { budgetFor } from './sources/budget';
import { standingRows } from './sourceStanding';
import { rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { q, tx } from './db';
import { DL_ROOT } from './library';
import { allWritable, containedPath, realContainedPath, statOrGone } from './fsGuard';
import { REFETCH_BAK } from './fsAtomic';
import { logAudit } from './audit';
import { heldBy } from './chapterRanges';
import { numKey } from './postingOrder';
import { MAX_RANGE } from './naming';
import { unnumberedOf } from './sources/types';

/** One chapter row a removed source supplied and nothing else lists. */
export interface LeftoverBook {
  id: string;
  /** The file's own number. */
  number: number;
  /** An admin's number for it, when there is one. */
  override: number | null;
  /** The end of the file's range, when it holds several chapters. */
  end: number | null;
  root: string;
  file: string;
  pruned: boolean;
}

export interface Leftovers {
  /** The sources the series keeps: main and followers, less the one going. Empty: nothing is purged. */
  others: string[];
  /** The rows that go. */
  books: LeftoverBook[];
  /** Every number only the removed source listed or held: read marks and failure entries on these go too. */
  numbers: number[];
  /** Readers with progress on a row that goes, or a read mark on a number that goes. */
  readers: number;
}

type Query = typeof q;

export class CleanupRefused extends Error {
  constructor(public readonly reason: 'not_found' | 'listing_unavailable' | 'numbering_pending' | 'preview_changed' | 'busy' | 'refused' | 'primary_source', message: string, public readonly fix?: string) { super(message); }
}

interface CleanupListing { sources: Array<{ source: string; ref: string }>; fresh: number[] }
interface CleanupPreview extends CleanupListing { left: Leftovers }

/**
 * Caller owns the folder writer. A cached absence is never permission to delete:
 * ask every remaining source now, require a nonempty answer and retain every number already known there.
 * A cooldown, failed extension, empty/short answer or uncertain numbering refuses cleanup, but not detach.
 */
async function cleanupSources(seriesId: string, sourceId: string, query: Query) {
  const [series] = await query<{ source_id: string | null; source_series_id: string | null; numbering: string | null; numbering_pending: string | null; renumber_plan: unknown }>(
    'SELECT source_id, source_series_id, numbering, numbering_pending, renumber_plan FROM lib_series WHERE id = $1', [seriesId]);
  if (!series) throw new CleanupRefused('not_found', 'The series is no longer available.');
  const followers = await query<{ source_id: string; source_series_id: string }>(
    'SELECT source_id, source_series_id FROM series_sources WHERE series_id = $1 ORDER BY source_id', [seriesId]);
  const sources = [
    ...(series.source_id ? [{ source: series.source_id, ref: series.source_series_id ?? '' }] : []),
    ...followers.map((f) => ({ source: f.source_id, ref: f.source_series_id })),
  ].sort((a, b) => a.source.localeCompare(b.source));
  if (series.source_id === sourceId && sources.length > 1) throw new CleanupRefused('primary_source', 'Make a replacement source main first. Then remove this source with cleanup. Detach alone keeps all downloads.');
  if (!sources.some((s) => s.source === sourceId)) throw new CleanupRefused('not_found', 'The source is no longer followed.');
  if (sources.length > 1 && (series.numbering === 'posting_order' || series.numbering_pending || series.renumber_plan)) {
    throw new CleanupRefused('numbering_pending', 'Chapter numbering must be settled before cleaning up downloads.');
  }
  return sources;
}

/** Network requests finish before taking a DB connection/row lock; otherwise parallel slow sources exhaust the pool. */
export async function prepareCleanup(seriesId: string, sourceId: string): Promise<CleanupListing> {
  const sources = await cleanupSources(seriesId, sourceId, q);
  const others = sources.filter((s) => s.source !== sourceId);
  if (!others.length) return { sources, fresh: [] };
  const standing = await standingRows(others.map((s) => s.source));
  const fresh = new Set<number>();
  for (const other of others) {
    const source = getSource(other.source);
    const health = standing.get(other.source);
    if (!other.ref.trim() || !source || health?.disabled || (health?.blocked_until && new Date(health.blocked_until).getTime() > Date.now())) {
      throw new CleanupRefused('listing_unavailable', 'Every remaining source must answer before downloads can be deleted. You can still remove the source and keep its downloads.');
    }
    const chapters = await bounded(Promise.resolve().then(() => source.listChapters(other.ref)), budgetFor(source, 20_000)).catch(() => null);
    // An adapter can explicitly report posts it dropped for lacking numbers. Neither that partial list nor
    // a malformed row is evidence that a retained source does not carry a chapter we are about to delete.
    if (!Array.isArray(chapters) || unnumberedOf(chapters) > 0 || chapters.some((c) =>
      !c || typeof c.number !== 'number' || !Number.isFinite(c.number) || c.number < 0)) {
      throw new CleanupRefused('listing_unavailable', 'A remaining source returned chapters without reliable numbers. Downloads have been kept.');
    }
    const numbers = new Set(chapters.map((c) => numKey(c.number)));
    const known = await listedBy(seriesId, [other.source]);
    if (!numbers.size || known.some((n) => !numbers.has(numKey(n)))) {
      throw new CleanupRefused('listing_unavailable', 'A remaining source returned an empty or incomplete chapter list. Downloads have been kept.');
    }
    for (const n of numbers) fresh.add(n);
  }
  const numbers = [...fresh].sort((a, b) => a - b);
  return { sources, fresh: numbers };
}

/** Re-read eligibility under the series row lock; any source/ref change since the network requests refuses cleanup. */
export async function cleanupPreview(seriesId: string, sourceId: string, query: Query, prepared: CleanupListing): Promise<CleanupPreview> {
  const sources = await cleanupSources(seriesId, sourceId, query);
  if (JSON.stringify(sources) !== JSON.stringify(prepared.sources)) {
    throw new CleanupRefused('listing_unavailable', 'The followed sources changed. Open the preview again.');
  }
  const known = await listedBy(seriesId, sources.filter((s) => s.source !== sourceId).map((s) => s.source), query);
  const fresh = new Set(prepared.fresh.map(numKey));
  if (known.some((n) => !fresh.has(numKey(n)))) throw new CleanupRefused('listing_unavailable', 'The remaining chapter listing changed. Open the preview again.');
  return { ...prepared, left: await leftoversOf(seriesId, sourceId, query, prepared.fresh) };
}

export interface CleanupIdentity { userId: string; seriesId: string; sourceId: string }
const CONFIRMATION_TYPE = 'source-cleanup-preview';
const CONFIRMATION_SECONDS = 300;
interface ConfirmationClaims {
  typ: string; aud: string; sub: string; seriesId: string; sourceId: string; snapshot: string; iat: number; exp: number;
}

/** An expiring, purpose-typed acknowledgement of the exact preview and acting account. It is never an access token. */
export function cleanupConfirmation(app: FastifyInstance, preview: CleanupPreview, identity: CleanupIdentity): string;
export function cleanupConfirmation(app: FastifyInstance, preview: CleanupPreview, identity: CleanupIdentity, confirmation: string): boolean;
export function cleanupConfirmation(app: FastifyInstance, preview: CleanupPreview, identity: CleanupIdentity, confirmation?: string): string | boolean {
  // This is a fingerprint of chapter/source state, not a credential hash. Account/series/source binding lives in
  // the signed JWT claims, alongside its purpose and expiry; API and image authentication refuse this token type.
  const snapshot = createHash('sha256').update(JSON.stringify(preview)).digest('base64url');
  if (confirmation === undefined) return app.jwt.sign({
    typ: CONFIRMATION_TYPE, aud: CONFIRMATION_TYPE, sub: identity.userId,
    seriesId: identity.seriesId, sourceId: identity.sourceId, snapshot,
  }, { expiresIn: CONFIRMATION_SECONDS });
  try {
    // Reject alternate base64 spellings of the same bytes too: acknowledgements have one canonical spelling.
    const parts = confirmation.split('.');
    if (parts.length !== 3 || parts.some((part) => !part || Buffer.from(part, 'base64url').toString('base64url') !== part)) return false;
    const claims = app.jwt.verify<ConfirmationClaims>(confirmation, { allowedAud: CONFIRMATION_TYPE });
    const now = Math.floor(Date.now() / 1000);
    return claims.typ === CONFIRMATION_TYPE && claims.sub === identity.userId && claims.seriesId === identity.seriesId
      && claims.sourceId === identity.sourceId && claims.snapshot === snapshot && Number.isInteger(claims.iat)
      && Number.isInteger(claims.exp) && claims.iat <= now && claims.exp > now
      && claims.exp > claims.iat && claims.exp - claims.iat <= CONFIRMATION_SECONDS;
  } catch { return false; }
}

const none = (others: string[] = []): Leftovers => ({ others, books: [], numbers: [], readers: 0 });

/** The sources a series follows: its main and every follower. */
async function sourcesOf(seriesId: string, query: Query = q): Promise<string[]> {
  const [s] = await query<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]);
  const f = await query<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]);
  return [...new Set([...(s?.source_id ? [s.source_id] : []), ...f.map((r) => r.source_id)])].sort();
}

/** Every number listed for the series by a source in `sources`: each copy of each row, or the row's own source. */
async function listedBy(seriesId: string, sources: readonly string[], query: Query = q): Promise<number[]> {
  if (!sources.length) return [];
  const rows = await query<{ number: number }>(
    `SELECT DISTINCT l.number::float8 AS number
       FROM series_listing l
       CROSS JOIN LATERAL (SELECT e ->> 'source' AS source
                             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.copies) = 'array' THEN l.copies ELSE '[]'::jsonb END) e
                           UNION SELECT l.source_id) c
      WHERE l.series_id = $1 AND c.source = ANY($2::text[])`, [seriesId, sources]);
  return rows.map((r) => Number(r.number)).filter(Number.isFinite);
}

/** Is any of `listed` (a held-by test over numbers) one of the numbers this book holds? */
function listedFor(b: LeftoverBook, listed: Set<number>, sorted: number[]): boolean {
  if (listed.has(numKey(b.number))) return true;
  if (b.override != null && listed.has(numKey(b.override))) return true;
  if (b.end != null && b.end > b.number && b.end - b.number <= MAX_RANGE) {
    return sorted.some((n) => n >= b.number && n <= b.end!);
  }
  return false;
}

/** Cleanup preserves every number a retained file can represent, including its raw range and an override. */
function cleanupHeld(books: ReadonlyArray<Pick<LeftoverBook, 'number' | 'end' | 'override'>>) {
  return heldBy(books.flatMap((b) => [
    { number: b.number, end: b.end }, ...(b.override == null ? [] : [{ number: b.override, end: null }]),
  ]));
}

/**
 * What removing `sourceId` from the series would take with it (see the header). Read-only. `sourceId` may already be
 * off the series (the route asks after a detach promoted a follower): the remaining sources are everything else.
 */
export async function leftoversOf(seriesId: string, sourceId: string, query: Query = q, freshNumbers?: number[]): Promise<Leftovers> {
  const others = (await sourcesOf(seriesId, query)).filter((s) => s !== sourceId);
  if (!others.length) return none();
  const elsewhere = freshNumbers ?? await listedBy(seriesId, others, query);
  const listed = new Set(elsewhere.map(numKey));
  const sorted = [...elsewhere].sort((a, b) => a - b);
  const rows = await query<{ id: string; number: number; override: number | null; end: number | null; root: string | null; file: string; pruned: boolean }>(
    `SELECT b.id, b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end,
            b.root, b.file, (b.pruned_at IS NOT NULL) AS pruned
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND b.source_id = $2
      ORDER BY b.number, b.file, b.id`, [seriesId, sourceId]);
  const books: LeftoverBook[] = rows
    // The download folder only: a file anywhere else arrived some other way, and is not this server's to delete.
    .filter((r) => r.root === DL_ROOT)
    .map((r) => ({
      id: r.id, number: Number(r.number), override: r.override == null ? null : Number(r.override),
      end: r.end == null ? null : Number(r.end), root: r.root as string, file: r.file, pruned: !!r.pruned,
    }))
    .filter((b) => !listedFor(b, listed, sorted));
  const goingIds = new Set(books.map((b) => b.id));
  // The numbers that go: what only this source lists, and what the going rows hold -- less anything another row keeps.
  const here = await listedBy(seriesId, [sourceId], query);
  const stays = await query<{ number: number; override: number | null; end: number | null }>(
    `SELECT b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND NOT (b.id = ANY($2::text[]))`, [seriesId, [...goingIds]]);
  const kept = cleanupHeld(stays);
  const numbers = new Map<number, number>();
  for (const n of here) if (!listed.has(numKey(n))) numbers.set(numKey(n), n);
  for (const b of books) {
    numbers.set(numKey(b.number), b.number);
    if (b.override != null) numbers.set(numKey(b.override), b.override);
  }
  const removed = cleanupHeld(books);
  const marks = await query<{ number: number }>(
    `SELECT number::float8 AS number FROM listing_progress WHERE series_id = $1
     UNION SELECT number::float8 AS number FROM chapter_failures WHERE series_id = $1`, [seriesId]);
  for (const mark of marks) if (removed.has(Number(mark.number))) numbers.set(numKey(Number(mark.number)), Number(mark.number));
  for (const k of [...numbers.keys()]) if (kept.has(numbers.get(k)!)) numbers.delete(k);
  const nums = [...numbers.values()].sort((a, b) => a - b);
  if (!books.length && !nums.length) return none(others);
  const [readers] = await query<{ n: number }>(
    `SELECT count(DISTINCT user_id)::int AS n FROM (
       SELECT user_id FROM read_progress WHERE book_id = ANY($2::text[])
       UNION SELECT user_id FROM listing_progress WHERE series_id = $1 AND number = ANY($3::real[])
     ) u`, [seriesId, [...goingIds], nums]);
  return { others, books, numbers: nums, readers: Number(readers?.n) || 0 };
}

/** What purgeLeftovers did. */
export interface PurgeResult {
  /** Rows taken off the list. */
  removed: number;
  /** Bytes of the files deleted with them. */
  bytes: number;
  /** Rows left as they are, and why. */
  left: Array<{ id: string; reason: 'unlink_failed' | 'outside_root' | 'unreachable' }>;
}

/** Whether the download folder may be written, when any of `books` still has a file. Null: yes, or nothing to write. */
export async function purgeRefusal(books: readonly LeftoverBook[]): Promise<{ reason: string; fix?: string } | null> {
  if (!books.some((b) => !b.pruned)) return null;
  const w = await allWritable([DL_ROOT]);
  return w.ok ? null : { reason: w.reason, fix: w.fix };
}

/**
 * Take the leftovers off the series (see the header). The file first, then the row: a file that could not be removed
 * keeps its row, so nothing on disk is ever unlisted. One audit line, `series.source_leftovers`.
 */
export async function purgeLeftovers(
  seriesId: string, sourceId: string, left: Leftovers, o: { userId: string | null; req?: FastifyRequest }, query?: Query,
): Promise<PurgeResult> {
  const out: PurgeResult = { removed: 0, bytes: 0, left: [] };
  if (!left.books.length && !left.numbers.length) return out;
  const root = resolve(DL_ROOT);
  const gone: string[] = [];
  for (const b of left.books) {
    const abs = containedPath(DL_ROOT, b.file);
    if (!abs || abs === root) { out.left.push({ id: b.id, reason: 'outside_root' }); continue; }
    // Tombstones can have a refetch backup, and an interrupted restore can even leave their original file.
    // They need the same real-path containment as live rows before either path can be touched.
    const looked = await statOrGone(abs);
    if (typeof looked === 'string') { out.left.push({ id: b.id, reason: 'unlink_failed' }); continue; }
    if (await realContainedPath(DL_ROOT, b.file) !== abs) { out.left.push({ id: b.id, reason: 'outside_root' }); continue; }
    if (!looked && !b.pruned && !(await stat(dirname(abs)).catch(() => null))) {
      // The file and its folder both absent: the volume is not there, not a chapter gone (deleteChapterFiles says why).
      out.left.push({ id: b.id, reason: 'unreachable' });
      continue;
    }
    // Refuse an unreachable/unremovable backup BEFORE deleting the original. Otherwise a failed backup unlink
    // silently leaves a copy which reapStaleTemp restores at boot after the row and source have been removed.
    const backup = `${abs}${REFETCH_BAK}`;
    if (await realContainedPath(DL_ROOT, `${b.file}${REFETCH_BAK}`) !== backup) {
      out.left.push({ id: b.id, reason: 'outside_root' }); continue;
    }
    try { await rm(backup, { force: true }); }
    catch { out.left.push({ id: b.id, reason: 'unlink_failed' }); continue; }
    if (looked) {
      if (await realContainedPath(DL_ROOT, b.file) !== abs) { out.left.push({ id: b.id, reason: 'outside_root' }); continue; }
      try { await rm(abs, { recursive: true, force: true }); }
      catch { out.left.push({ id: b.id, reason: 'unlink_failed' }); continue; }
      out.bytes += looked.size;
    }
    gone.push(b.id);
  }
  const keptIds = new Set(out.left.map((l) => l.id));
  // A number whose row could not go keeps its marks: they are still that row's.
  const keptNumbers = cleanupHeld(left.books.filter((b) => keptIds.has(b.id)));
  const numbers = left.numbers.filter((n) => !keptNumbers.has(n));
  const removeRows = async (qq: Query) => {
    if (gone.length) {
      // read_progress.book_id is ON DELETE RESTRICT (lib/migrate.ts): a read row would refuse the DELETE below.
      await qq('DELETE FROM read_progress WHERE book_id = ANY($1::text[])', [gone]);
      await qq('DELETE FROM bookmarks WHERE book_id = ANY($1::text[])', [gone]);
      await qq('DELETE FROM offline_downloads WHERE book_id = ANY($1::text[])', [gone]);
      const del = await qq<{ id: string }>('DELETE FROM lib_books WHERE series_id = $1 AND id = ANY($2::text[]) RETURNING id', [seriesId, gone]);
      out.removed = del.length;
    }
    if (numbers.length) {
      await qq('DELETE FROM listing_progress WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, numbers]);
      await qq('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, numbers]);
    }
  };
  if (query) await removeRows(query); else await tx(removeRows);
  if (out.removed) {
    // The rollups as a merge's clean-up puts them right (lib/extraCopies.ts): count, newest, and the lowest live cover.
    await (query ?? q)(
      `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
         FROM (SELECT count(*) n, max(mtime) mt FROM lib_books WHERE series_id = $1) c
        WHERE s.id = $1`, [seriesId]);
    await (query ?? q)(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`, [seriesId]);
  }
  const title = (await (query ?? q)<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [seriesId]))[0]?.title ?? null;
  const detail = { id: seriesId, title, source: sourceId, removed: out.removed, bytes: out.bytes, left: out.left.length, numbers: numbers.slice(0, 50) };
  if (query) {
    await query('INSERT INTO audit_log (user_id, event, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [o.userId, 'series.source_leftovers', JSON.stringify(detail), o.req?.ip?.slice(0, 64) ?? null, String(o.req?.headers['user-agent'] ?? '').slice(0, 200) || null]);
  } else await logAudit('series.source_leftovers', { userId: o.userId, detail, req: o.req });
  return out;
}

/**
 * Of the chosen chapters of a series, the ones no source it follows lists (series_listing, any copy): once deleted,
 * nothing can fetch them again. For the Delete from server confirmation's warning.
 */
export async function unlistedOf(seriesId: string, bookIds: readonly string[]): Promise<string[]> {
  if (!bookIds.length) return [];
  const sources = await sourcesOf(seriesId);
  const elsewhere = await listedBy(seriesId, sources);
  const listed = new Set(elsewhere.map(numKey));
  const sorted = [...elsewhere].sort((a, b) => a - b);
  const rows = await q<{ id: string; number: number; override: number | null; end: number | null }>(
    `SELECT b.id, b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND b.id = ANY($2::text[])`, [seriesId, [...new Set(bookIds)]]);
  return rows
    .map((r) => ({
      id: r.id, number: Number(r.number), override: r.override == null ? null : Number(r.override),
      end: r.end == null ? null : Number(r.end), root: '', file: '', pruned: false,
    }))
    .filter((b) => !listedFor(b, listed, sorted))
    .map((b) => b.id);
}
