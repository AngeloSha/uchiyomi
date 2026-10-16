import { one, q } from './db';
import { eachPageBytes, LIBRARY_ROOT } from './library';
import { edgeProfile, joinsFor, JOIN_VERSION, type EdgeProfile } from './spreadJoin';

/**
 * Spread joining's measure (#229, opt-in: Reader settings -> Join split double pages): which pages of a chapter are one
 * double-page spread a source served as two files (lib/spreadJoin.ts), worked out in the background and kept on the
 * chapter's row, `lib_books.spreads`.
 *
 * ⚠️ Never on a request. Reading the seams decodes and resizes every portrait page of a chapter -- about 30 ms a page on
 * the server it was measured on, against well under a millisecond for the size read the page list makes -- so the page
 * list only READS the answer (`spreadsFor`, GET /api/books/:id/pages?spreads=1), and a chapter with none yet is queued
 * here and answered without joins until it has one. Only a reader who turned joining on asks, so a server where nobody
 * did measures nothing at all. One chapter at a time, newest asked first: the chapter being opened, or the one the
 * reader is about to append, comes before the ones behind it.
 *
 * ⚠️ An answer is written for EVERY chapter looked at, whatever was found: no spread, a PDF, an archive that cannot be
 * opened. That row is what "looked at" means, and whether to measure keys on it alone (the detector's version and the
 * file's mtime), so a chapter is measured once per file and per detector. As first written in #229 the measure ran on the
 * page-list request and wrote nothing for a chapter it could not re-read, or whose page count disagreed with the cached
 * sizes, so those chapters were measured again on every request, forever.
 * Reintroduce by writing only when something was found: spreadMeasure.int.test.ts "an unreadable chapter is looked at
 * once" fails.
 */

export interface SpreadAnswer {
  /** The detector's version (lib/spreadJoin.ts JOIN_VERSION): an answer an older one gave is measured again. */
  v: number;
  /** lib_books.mtime when measured: a file replaced since is measured again. */
  mtime: number;
  /** How many pages the file held. The page list carries the joins only while it lists as many pages. */
  pages: number;
  /** Each spread as [the page it starts on, which side the page after it is on] (spreadJoin.ts joinDirection). */
  joins: Array<[number, 'rtl' | 'ltr']>;
  /** The file could not be read: looked at all the same, and left until it changes. */
  unreadable?: true;
}

/** A stored answer, when it is one for this file as it is now and this detector; null when the chapter needs measuring. */
export function currentAnswer(raw: unknown, mtime: number): SpreadAnswer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Partial<SpreadAnswer>;
  if (a.v !== JOIN_VERSION || a.mtime !== Number(mtime) || !Number.isInteger(a.pages) || !Array.isArray(a.joins)) return null;
  return a as SpreadAnswer;
}

/**
 * The joins a page list of `count` pages carries, by page number: none when the file held another number of pages than
 * the list says (the sizes cached for the list are older than the file), since a join would then sit on the wrong pages.
 */
export function joinsByPage(a: SpreadAnswer, count: number): Map<number, 'rtl' | 'ltr'> {
  const out = new Map<number, 'rtl' | 'ltr'>();
  if (a.pages !== count) return out;
  for (const j of a.joins) {
    if (Array.isArray(j) && Number.isInteger(j[0]) && j[0] >= 1 && j[0] < count && (j[1] === 'rtl' || j[1] === 'ltr')) out.set(j[0], j[1]);
  }
  return out;
}

/** The spreads in one chapter file: its page count and each join, or null when the file cannot be read. */
export async function measureSpreads(abs: string): Promise<{ pages: number; joins: Array<[number, 'rtl' | 'ltr']> } | null> {
  const profiles: Array<EdgeProfile | null> = [];
  try {
    const pages = await eachPageBytes(abs, async (bytes) => { profiles.push(bytes ? await edgeProfile(bytes) : null); });
    const joins: Array<[number, 'rtl' | 'ltr']> = [];
    joinsFor(profiles).forEach((d, i) => { if (d) joins.push([i + 1, d]); });
    return { pages, joins };
  } catch {
    return null;
  }
}

/**
 * Measure chapter `id` unless it has a current answer, and keep what was found. Answers the stored answer, or null for a
 * chapter there is nothing to measure for (no such row in the built-in library, or its file was deleted).
 */
export async function measureBook(id: string): Promise<SpreadAnswer | null> {
  const r = await one<{ root: string | null; file: string; mtime: number; pruned_at: string | null; spreads: unknown }>(
    'SELECT root, file, mtime, pruned_at, spreads FROM lib_books WHERE id = $1', [id]);
  if (!r || r.pruned_at) return null;
  const have = currentAnswer(r.spreads, r.mtime);
  if (have) return have;
  const found = await measureSpreads(`${r.root || LIBRARY_ROOT}/${r.file}`);
  const answer: SpreadAnswer = found
    ? { v: JOIN_VERSION, mtime: Number(r.mtime), pages: found.pages, joins: found.joins }
    : { v: JOIN_VERSION, mtime: Number(r.mtime), pages: 0, joins: [], unreadable: true };
  // Onto the file it measured only: one replaced meanwhile has another mtime, and is measured when next asked for.
  await q('UPDATE lib_books SET spreads = $2 WHERE id = $1 AND mtime = $3', [id, JSON.stringify(answer), r.mtime]);
  return answer;
}

// ---- the queue ----

/** Chapters waiting, oldest first; the newest is measured next. Beyond this the oldest wait is dropped: asked again, it comes back. */
const MAX_WAITING = 64;
const waiting: string[] = [];
let busy: string | null = null;
let idle: Promise<void> = Promise.resolve();
let settle: (() => void) | null = null;

function pump(): void {
  if (busy || !waiting.length) {
    if (!busy && settle) { settle(); settle = null; }
    return;
  }
  const id = waiting.pop()!;
  busy = id;
  measureBook(id)
    .catch((e) => console.warn('[spreads] measure failed', id, (e as Error)?.message))
    .finally(() => { busy = null; setImmediate(pump); });
}

/** Put chapter `id` at the front of the measure's queue (once: asked again while it waits, it moves up). Never waits. */
export function requestSpreads(id: string): void {
  if (busy === id) return;
  const at = waiting.indexOf(id);
  if (at >= 0) waiting.splice(at, 1);
  waiting.push(id);
  if (waiting.length > MAX_WAITING) waiting.shift();
  if (!settle) idle = new Promise((r) => { settle = r; });
  pump();
}

/** Resolves once the queue has drained (tests). */
export function spreadsIdle(): Promise<void> {
  return busy || waiting.length ? idle : Promise.resolve();
}

/** Chapter `id`'s row as the readers below need it; null for a chapter this measure has nothing to do with. */
async function stored(id: string): Promise<{ mtime: number; spreads: unknown } | null> {
  const r = await one<{ mtime: number; pruned_at: string | null; spreads: unknown }>(
    'SELECT mtime, pruned_at, spreads FROM lib_books WHERE id = $1', [id]).catch(() => null);
  return r && !r.pruned_at ? r : null;
}

/**
 * What the page list says about chapter `id`'s spreads, for a page list of `count` pages: `done` with the joins (none,
 * often), `pending` once queued because it has no current answer, or `none` for a chapter this measure has nothing to do
 * with (not in the built-in library, its file deleted, a single page).
 */
export async function spreadsFor(id: string, count: number): Promise<{ state: 'done' | 'pending' | 'none'; joins: Map<number, 'rtl' | 'ltr'> }> {
  const none = new Map<number, 'rtl' | 'ltr'>();
  const r = count < 2 ? null : await stored(id);
  if (!r) return { state: 'none', joins: none };
  const a = currentAnswer(r.spreads, r.mtime);
  if (a) return { state: 'done', joins: joinsByPage(a, count) };
  requestSpreads(id);
  return { state: 'pending', joins: none };
}

/** The joins already found for chapter `id`, for a list of `count` pages; never queues a measure (the offline manifest). */
export async function storedJoins(id: string, count: number): Promise<Map<number, 'rtl' | 'ltr'>> {
  const r = count < 2 ? null : await stored(id);
  const a = r ? currentAnswer(r.spreads, r.mtime) : null;
  return a ? joinsByPage(a, count) : new Map();
}
