import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Every chapter this server downloads, whatever started it -- so a person can see what is coming in.
 *
 * The downloads pill only ever knew the jobs a button started (an add from Discover, a Fetch). Everything else
 * that brings chapters in was invisible: a source followed from "Find missing chapters" downloads at the
 * series' next check, the nightly sweep downloads for every series, Check now, the repair, a bulk "Fetch
 * newest" -- all through updateSeries or the repair, none of it through a job. Recording at `downloadChapter`
 * (lib/downloader.ts), the one function every path ends in, is what makes this complete by construction
 * rather than by remembering to register each new path.
 *
 * What started it travels in an AsyncLocalStorage (`withOrigin`) set at each entry point, so no signature
 * between the button and the downloader has to carry it. A download with no origin set says `server`.
 *
 * In memory, a day deep: what is downloading now and what came in since yesterday. What was added over a
 * longer stretch is the Updates page's job, which reads the library itself.
 */

/** What started a download. The web app words each one (web/lib/activity.ts). */
export type Origin = 'add' | 'fetch' | 'fill' | 'check' | 'sweep' | 'repair' | 'bulk' | 'refetch' | 'server';

export type ActivityStatus = 'queued' | 'downloading' | 'done' | 'partial' | 'failed';

export interface ActivityEntry {
  id: number;
  /** The series folder, relative to the download root: the key lib_series.folder holds. */
  folder: string;
  title: string;
  number: number;
  source: string;
  origin: Origin;
  /** Who pressed the button, when a person did; null for the server's own runs. */
  by: string | null;
  status: ActivityStatus;
  startedAt: number;
  finishedAt?: number;
  pages?: number;
  /** Why it failed, or how many pages a partial chapter is missing. */
  reason?: string;
  /** Arrived incomplete, and the caller has not yet decided whether to keep it (`holdPartial`). */
  heldAt?: number;
}

const store = new AsyncLocalStorage<{ origin: Origin; by: string | null }>();

/** Run `fn` with every download it causes, however deep, attributed to `origin`. */
export function withOrigin<T>(origin: Origin, by: string | null, fn: () => T): T {
  return store.run({ origin, by }, fn);
}
export const currentOrigin = () => store.getStore() ?? { origin: 'server' as Origin, by: null };

/** How long a finished entry is kept, and how many at most: a big first sweep must not grow this forever. */
export const ACTIVITY_TTL_MS = 24 * 3600_000;
const MAX_FINISHED = 500;

/** How long an incomplete chapter may wait on its caller's decision before it counts as not kept. */
const HOLD_MS = 10 * 60_000;

let nextId = 1;
const live = new Map<number, ActivityEntry>();
const finished: ActivityEntry[] = [];

function prune(now = Date.now()) {
  for (const x of [...live.values()]) {
    if (x.heldAt && now - x.heldAt > HOLD_MS) endDownload(x.id, { status: 'failed', reason: `${x.reason}; not kept` });
  }
  while (finished.length && (finished.length > MAX_FINISHED || now - (finished[0].finishedAt ?? now) > ACTIVITY_TTL_MS)) finished.shift();
}

export function beginDownload(e: { folder: string; title: string; number: number; source: string }): number {
  const { origin, by } = currentOrigin();
  const id = nextId++;
  live.set(id, { id, ...e, origin, by, status: 'queued', startedAt: Date.now() });
  return id;
}
/** Past the source's gate: the pages are being fetched now. */
export function startedDownload(id: number): void {
  const x = live.get(id);
  if (x) x.status = 'downloading';
}
/**
 * The end of one download. `skipped` (the file was already there) leaves no trace: nothing came in, and a
 * sweep over a full library would otherwise list every chapter it did not fetch.
 */
export function endDownload(id: number, outcome: { status: 'done' | 'partial' | 'failed'; pages?: number; reason?: string } | 'skipped'): void {
  const x = live.get(id);
  if (!x) return;
  live.delete(id);
  if (outcome === 'skipped') return;
  const { heldAt: _held, ...rest } = x;
  finished.push({ ...rest, ...outcome, finishedAt: Date.now() });
  prune();
}

/**
 * A chapter that arrived with pages missing. `downloadChapter` never writes it itself: the caller writes it
 * (the hold's `write()`) once no other source did better, or drops it. So the entry stays open until the
 * write, which ends it `partial`; one that is never written ends `failed` after HOLD_MS.
 */
export function holdPartial(id: number, hold: { missing: number[]; write: () => Promise<{ pages: number; missing: number[] }> }): void {
  const x = live.get(id);
  if (!x) return;
  x.heldAt = Date.now();
  x.reason = `arrived with ${hold.missing.length} page${hold.missing.length === 1 ? '' : 's'} missing`;
  const write = hold.write.bind(hold);
  hold.write = async () => {
    const w = await write();
    endDownload(id, { status: 'partial', pages: w.pages, reason: `saved with ${w.missing.length} page${w.missing.length === 1 ? '' : 's'} missing` });
    return w;
  };
}

/** Downloading or waiting for a slot now, oldest first; then what finished in the last day, newest first. */
export function listActivity(now = Date.now()): { active: ActivityEntry[]; recent: ActivityEntry[] } {
  prune(now);
  return {
    active: [...live.values()].sort((a, b) => a.startedAt - b.startedAt),
    recent: [...finished].reverse(),
  };
}

/** For tests. */
export function clearActivity(): void {
  live.clear();
  finished.length = 0;
}
