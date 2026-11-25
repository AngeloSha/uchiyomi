// A blocked group's chapters, taken off the shelf as though they had never been fetched (#396).
//
// Blocking a group hides, at once, every number only blocked groups released (lib/seriesListing.ts reapplyBlocklist),
// and nothing fetches one again. A chapter ALREADY downloaded from such a group stayed, though: a troll upload numbered
// 340 on a series at 240 sat at the top of the list, counted, and held its number. An admin may now remove those
// chapters completely, after being told how many there are -- the Sources & translations sheet and the Scanlation
// groups editor ask whenever there are any (blocking is still saved at once; removing is the confirmed second step).
//
//  - WHICH: rows in the download folder holding one chapter (never a range file, never a library built by hand), whose
//    override-aware number is either listed with every copy blocked (`series_listing.status = 'blocked'`) or listed by
//    nothing at all on a series that has a listing -- and whose file is that group's: the group stamped on the row
//    (lib_books.scanlator, written when the file landed) is blocked. A row stamped with no group goes only when the
//    listing proves every copy of its number is blocked; one stamped with an unblocked group never goes. Live files and
//    deleted chapters (tombstones) alike. The blocklist is the series' effective one: the server's and its own.
//  - NOTHING while the series' numbering is in question (a change pending or a renumber's journal): its numbers are
//    then not the listing's.
//  - WHAT GOES: what a removed source's leftovers lose (lib/sourceLeftovers.ts purgeBooks): the file, the row, its
//    reading progress, bookmarks and offline-download rows, and the by-number read marks and failure entries of each
//    number no other row still holds. reading_events stays, as it does there. Unblocking afterwards makes the number a
//    chapter the sources can fetch again, like any other not downloaded yet.
//  - CONFIRMED: the purge takes the ids the admin was shown and removes only those still eligible under the series'
//    writer claim and row locks, so nothing that changed since the count can go.
//  - MORE THAN ONE GROUP: a number every listed copy of which is a blocked group's is `blocked` however many groups
//    listed it, so a wrong number another group copied goes once each of them is blocked -- and not before, while one
//    unblocked group still lists it (a joint stamp, "A & B", counts only when both are blocked).
//  - FROM A CHAPTER: blockGroupsFor blocks the groups behind picked chapters for the series and names what that
//    block leaves to blocked groups alone; its preview is the same transaction, rolled back.
//  - NOT DOWNLOADED: a picked number with no file -- listed, its download failing (the source down, say) -- has no
//    file or row to remove. Once every copy of it is blocked it is off the series page and Mihon's list already;
//    what is left of it is its failure entry and the read marks on its number, and those are cleared too
//    (blockedNumbersOf / clearBlockedNumbers). The listing row stays, so unblocking makes it a chapter again.
import type { FastifyRequest } from 'fastify';
import { q, tx } from './db';
import { DL_ROOT } from './library';
import { groupsOf, mergePrefs, normGroup, type StoredPrefs } from './releases';
import { parseStored, readGlobalPrefs } from './scanlatorPrefs';
import { reapplyBlocklistInTransaction } from './seriesListing';
import { purgeBooks, purgeRefusal, type LeftoverBook, type PurgeResult } from './sourceLeftovers';
import { heldBy, holds } from './chapterRanges';
import { numKey } from './postingOrder';

type Query = typeof q;

/** One chapter a blocked group left on the shelf. */
export interface BlockedBook {
  id: string;
  seriesId: string;
  seriesTitle: string;
  /** The number the series shows it at (an admin's override, else the file's). */
  number: number;
  scanlator: string | null;
  pruned: boolean;
}

export interface BlockedChapters {
  books: BlockedBook[];
  /** Series with at least one such chapter. */
  series: number;
  /** Readers with progress on one of them. */
  readers: number;
}

interface Row {
  id: string; series_id: string; series_title: string; number: number; raw: number; override: number | null;
  scanlator: string | null; pruned: boolean; root: string; file: string; listed: string | null; series_prefs: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

/** A series' own blocked names as the release rules read them (lib/seriesListing.ts storedPrefs): tolerant. */
const ownPrefs = (v: unknown): StoredPrefs | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return { priority: strings(o.priority), blocked: strings(o.blocked), patienceDays: null };
};

/**
 * The chapters a blocked group left, in one series or (no `seriesId`) every series. Read-only. Candidates come from SQL
 * (one chapter per file, download folder, numbering settled, the number blocked or unlisted); the group test is the
 * release rules' own (groupsOf + normGroup over the series' effective blocklist), in JavaScript.
 */
export async function blockedChaptersOf(seriesId?: string | null, query: Query = q): Promise<BlockedChapters> {
  const rows = await query<Row>(
    `SELECT b.id, b.series_id, s.title AS series_title, COALESCE(ov.number, b.number)::float8 AS number,
            b.number::float8 AS raw, ov.number::float8 AS override, b.scanlator, (b.pruned_at IS NOT NULL) AS pruned,
            b.root, b.file, l.status AS listed, s.scanlator_prefs AS series_prefs
       FROM lib_books b
       JOIN lib_series s ON s.id = b.series_id
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
       LEFT JOIN series_listing l ON l.series_id = b.series_id AND l.number = COALESCE(ov.number, b.number)
      WHERE ($1::text IS NULL OR b.series_id = $1)
        AND b.root = $2 AND b.number_end IS NULL
        AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL
        AND (l.status = 'blocked'
             OR (l.series_id IS NULL AND b.scanlator IS NOT NULL
                 AND EXISTS (SELECT 1 FROM series_listing x WHERE x.series_id = b.series_id)))
      ORDER BY s.title, b.series_id, COALESCE(ov.number, b.number), b.file`,
    [seriesId ?? null, DL_ROOT],
  );
  if (!rows.length) return { books: [], series: 0, readers: 0 };
  const global = await readGlobalPrefs();
  const blockedFor = new Map<string, Set<string>>();
  const blockedOf = (r: Row) => {
    let set = blockedFor.get(r.series_id);
    if (!set) {
      set = new Set(mergePrefs(global, ownPrefs(r.series_prefs)).blocked.map(normGroup).filter(Boolean));
      blockedFor.set(r.series_id, set);
    }
    return set;
  };
  const books: BlockedBook[] = [];
  for (const r of rows) {
    const keys = groupsOf({ scanlator: r.scanlator ?? undefined }).map(normGroup).filter(Boolean);
    const blocked = blockedOf(r);
    const stampBlocked = keys.length > 0 && keys.every((k) => blocked.has(k));
    // Stamped with no group: the file is one of the listed copies, all blocked -- only when the listing says so.
    if (!(stampBlocked || (keys.length === 0 && r.listed === 'blocked'))) continue;
    books.push({ id: r.id, seriesId: r.series_id, seriesTitle: r.series_title, number: Number(r.number), scanlator: r.scanlator, pruned: !!r.pruned });
  }
  return summed(books, query);
}

/** The books with how many series they are in and how many readers have progress on one of them. */
async function summed(books: BlockedBook[], query: Query): Promise<BlockedChapters> {
  if (!books.length) return { books: [], series: 0, readers: 0 };
  const [readers] = await query<{ n: number }>(
    'SELECT count(DISTINCT user_id)::int AS n FROM read_progress WHERE book_id = ANY($1::text[])', [books.map((b) => b.id)]);
  return { books, series: new Set(books.map((b) => b.seriesId)).size, readers: Number(readers?.n) || 0 };
}

/** One group a block names, and whether it was blocked already -- for this series, or on the whole server. */
export interface BlockGroup {
  name: string;
  already: 'series' | 'server' | null;
}

export interface BlockOutcome extends BlockedChapters {
  /** Every group asked for, deduped by the server's group equality, in the order asked. */
  groups: BlockGroup[];
  /** The ones the block adds to the series' own list (the rest were blocked already). */
  added: string[];
  /** Of the picked numbers not downloaded, those every copy of which is then blocked: hidden, and cleared. */
  numbers: number[];
}

/**
 * Of `numbers`, those of a series listed with every copy blocked and held by no row here (a file, a deleted
 * chapter's tombstone or a range): a chapter that was never downloaded, only blocked groups' now. Sorted.
 */
export async function blockedNumbersOf(seriesId: string, numbers: readonly number[], query: Query = q): Promise<number[]> {
  const asked = [...new Set(numbers.filter((n) => Number.isFinite(n)))];
  if (!asked.length) return [];
  const rows = await query<{ number: number }>(
    `SELECT l.number::float8 AS number FROM series_listing l
      WHERE l.series_id = $1 AND l.number = ANY($2::real[]) AND l.status = 'blocked'
        AND NOT EXISTS (SELECT 1 FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
                         WHERE b.series_id = l.series_id AND ${holds('b', 'ov', 'l.number')})
      ORDER BY l.number`, [seriesId, asked]);
  return rows.map((r) => Number(r.number));
}

/**
 * Clear what is left of not-downloaded chapters only blocked groups list (see the header): of `numbers`, those still
 * eligible under the series row lock and its listing's, lose their failure entry and every reader's mark. Audited as
 * `series.blocked_purge` with `cleared`. Answers the numbers cleared.
 */
export async function clearBlockedNumbers(
  seriesId: string, numbers: readonly number[], o: { userId: string | null; req?: FastifyRequest },
): Promise<number[]> {
  if (!numbers.length) return [];
  return tx(async (qq) => {
    const [locked] = await qq<{ title: string }>('SELECT title FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!locked) return [];
    await qq('SELECT number FROM series_listing WHERE series_id = $1 FOR UPDATE', [seriesId]);
    const eligible = await blockedNumbersOf(seriesId, numbers, qq);
    if (!eligible.length) return [];
    const { numbers: gone } = await purgeBooks(seriesId, [], eligible, qq);
    await qq('INSERT INTO audit_log (user_id, event, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [
      o.userId, 'series.blocked_purge',
      JSON.stringify({ id: seriesId, title: locked.title, removed: 0, cleared: gone.slice(0, 50) }),
      o.req?.ip?.slice(0, 64) ?? null, String(o.req?.headers['user-agent'] ?? '').slice(0, 200) || null,
    ]);
    return gone;
  });
}

export class BlockRefused extends Error {
  constructor(public readonly reason: 'not_found' | 'too_many', message: string) { super(message); }
}

/** Thrown inside the preview's transaction so nothing it wrote commits; carries the answer out. */
class Rollback extends Error {
  constructor(public readonly value: BlockOutcome) { super('preview'); }
}

const MAX_BLOCKED = 200; // prefsSchema's ceiling (lib/scanlatorPrefs.ts)

/**
 * Block `names` for one series -- its own list, as Block under "Translated by" does: each is un-ranked and added to
 * the series' blocked groups -- and say which of its chapters the block leaves to blocked groups alone (#396). One
 * transaction: the series row locked, the chapters counted before, the preference written, the stored listing
 * re-resolved (reapplyBlocklistInTransaction), the chapters counted again. `books` is what the block MADE removable
 * plus any of `selected` (the chapters the admin picked it from) that are removable now, so a chapter of a group
 * blocked earlier and kept is offered again when it is the one asked about; chapters removable before for other
 * reasons stay with the standing question. `commit: false` is the preview: the same steps, rolled back, so the
 * answer is the release rules' own and not a second reading of them. Nothing is removed here: the caller purges the
 * ids it showed through purgeBlockedChapters, which re-checks each. `numbers` are picked chapters not downloaded:
 * `numbers` in the answer is those of them the block leaves to blocked groups alone (clearBlockedNumbers clears them).
 */
export async function blockGroupsFor(
  seriesId: string, names: readonly string[],
  o: { selected?: readonly string[]; numbers?: readonly number[]; commit: boolean },
): Promise<BlockOutcome> {
  const global = await readGlobalPrefs();
  const serverKeys = new Set(global.blocked.map(normGroup).filter(Boolean));
  const asked: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    const k = normGroup(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    asked.push(name);
  }
  const selected = new Set(o.selected ?? []);
  const run = async (qq: Query): Promise<BlockOutcome> => {
    const [s] = await qq<{ scanlator_prefs: unknown }>('SELECT scanlator_prefs FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!s) throw new BlockRefused('not_found', 'No such series.');
    const before = new Set((await blockedChaptersOf(seriesId, qq)).books.map((b) => b.id));
    const own = s.scanlator_prefs == null ? null : parseStored(s.scanlator_prefs, { priority: [], blocked: [], patienceDays: null });
    const ownKeys = new Set((own?.blocked ?? []).map(normGroup));
    const groups: BlockGroup[] = asked.map((name) => {
      const k = normGroup(name);
      return { name, already: serverKeys.has(k) ? 'server' : ownKeys.has(k) ? 'series' : null };
    });
    const added = groups.filter((g) => g.already === null).map((g) => g.name);
    if (added.length) {
      const addedKeys = new Set(added.map(normGroup));
      const blocked = [...(own?.blocked ?? []), ...added];
      if (blocked.length > MAX_BLOCKED) throw new BlockRefused('too_many', `A series can block at most ${MAX_BLOCKED} groups.`);
      const next = {
        priority: (own?.priority ?? []).filter((p) => !addedKeys.has(normGroup(p))),
        blocked,
        patienceDays: own?.patienceDays ?? null,
      };
      await qq('UPDATE lib_series SET scanlator_prefs = $2::jsonb WHERE id = $1', [seriesId, JSON.stringify(next)]);
      await reapplyBlocklistInTransaction(qq, [seriesId]);
    }
    const after = await blockedChaptersOf(seriesId, qq);
    const books = after.books.filter((b) => !before.has(b.id) || selected.has(b.id));
    const out: BlockOutcome = { ...(await summed(books, qq)), groups, added, numbers: await blockedNumbersOf(seriesId, o.numbers ?? [], qq) };
    if (!o.commit) throw new Rollback(out);
    return out;
  };
  try {
    return await tx(run);
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    throw e;
  }
}

export class BlockedPurgeRefused extends Error {
  constructor(public readonly reason: 'busy' | 'refused', message: string, public readonly fix?: string) { super(message); }
}

export interface BlockedPurgeResult extends PurgeResult {
  /** Series skipped because another task was changing them. */
  busy: string[];
}

/**
 * Remove the chapters of `bookIds` that are still a blocked group's (see the header). Per series: the caller's writer
 * claim, then one transaction that locks the series, its listing and its rows, re-reads eligibility and purges the
 * intersection. A series another task holds is skipped and named in `busy`. One audit line per series,
 * `series.blocked_purge`.
 */
export async function purgeBlockedChapters(
  bookIds: readonly string[],
  o: { userId: string | null; req?: FastifyRequest; claim: (seriesId: string, folder: string) => { release: () => void } | null },
): Promise<BlockedPurgeResult> {
  const out: BlockedPurgeResult = { removed: 0, bytes: 0, left: [], busy: [] };
  const wanted = new Set(bookIds);
  if (!wanted.size) return out;
  const series = await q<{ id: string; folder: string }>(
    `SELECT DISTINCT s.id, s.folder FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.id = ANY($1::text[]) ORDER BY s.id`, [[...wanted]]);
  for (const s of series) {
    const claim = o.claim(s.id, s.folder);
    if (!claim) { out.busy.push(s.id); continue; }
    try {
      const done = await tx(async (qq) => {
        const [locked] = await qq<{ folder: string; title: string }>('SELECT folder, title FROM lib_series WHERE id = $1 FOR UPDATE', [s.id]);
        if (!locked || locked.folder !== s.folder) return null;
        await qq('SELECT number FROM series_listing WHERE series_id = $1 FOR UPDATE', [s.id]);
        // Metadata edits and new read/bookmark rows do not claim the folder writer: lock the rows (and overrides), whose
        // FK parent locks then serialise new progress with the deletion -- as the source cleanup does (routes/admin.ts).
        await qq('SELECT id FROM lib_books WHERE series_id = $1 ORDER BY id FOR UPDATE', [s.id]);
        await qq(`SELECT ov.book_id FROM book_overrides ov JOIN lib_books b ON b.id = ov.book_id
                   WHERE b.series_id = $1 ORDER BY ov.book_id FOR UPDATE OF ov`, [s.id]);
        const eligible = (await blockedChaptersOf(s.id, qq)).books.filter((b) => wanted.has(b.id));
        if (!eligible.length) return null;
        const ids = eligible.map((b) => b.id);
        const rows = await qq<{ id: string; number: number; override: number | null; root: string; file: string; pruned: boolean }>(
          `SELECT b.id, b.number::float8 AS number, ov.number::float8 AS override, b.root, b.file, (b.pruned_at IS NOT NULL) AS pruned
             FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id WHERE b.id = ANY($1::text[]) ORDER BY b.id`, [ids]);
        const books: LeftoverBook[] = rows.map((r) => ({
          id: r.id, number: Number(r.number), override: r.override == null ? null : Number(r.override),
          end: null, root: r.root, file: r.file, pruned: !!r.pruned,
        }));
        const refusal = await purgeRefusal(books);
        if (refusal) throw new BlockedPurgeRefused('refused', refusal.reason, refusal.fix);
        // The marks of a number go only when no row left behind holds it (a live chapter by another group, say).
        const stays = await qq<{ number: number; override: number | null; end: number | null }>(
          `SELECT b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end
             FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
            WHERE b.series_id = $1 AND NOT (b.id = ANY($2::text[]))`, [s.id, ids]);
        const kept = heldBy(stays.flatMap((b) => [
          { number: Number(b.number), end: b.end == null ? null : Number(b.end) },
          ...(b.override == null ? [] : [{ number: Number(b.override), end: null }]),
        ]));
        const numbers = new Map<number, number>();
        for (const b of books) for (const n of [b.number, ...(b.override == null ? [] : [b.override])]) {
          if (!kept.has(n)) numbers.set(numKey(n), n);
        }
        const { out: purged, numbers: gone } = await purgeBooks(s.id, books, [...numbers.values()].sort((a, b) => a - b), qq);
        await qq('INSERT INTO audit_log (user_id, event, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [
          o.userId, 'series.blocked_purge',
          JSON.stringify({ id: s.id, title: locked.title, removed: purged.removed, bytes: purged.bytes, left: purged.left.length, numbers: gone.slice(0, 50) }),
          o.req?.ip?.slice(0, 64) ?? null, String(o.req?.headers['user-agent'] ?? '').slice(0, 200) || null,
        ]);
        return purged;
      });
      if (done) {
        out.removed += done.removed;
        out.bytes += done.bytes;
        out.left.push(...done.left);
      }
    } finally { claim.release(); }
  }
  return out;
}

