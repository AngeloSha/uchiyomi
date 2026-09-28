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
 * longer stretch is the Updates page's job, which reads the library itself. Since v0.49.0 what finished is
 * also written down (lib/activityLog.ts) and read back at boot, so a restart -- every release is one -- no
 * longer empties the day: the listener below is how, and this module itself still never touches the database.
 */

/**
 * What started a download. The web app words each one (web/lib/serverDownloads.ts). `archive` is the slow
 * archive (#117): its chapters trickle in for days, so they count against a cap of their own (FINISHED_CAP).
 */
export type Origin = 'add' | 'fetch' | 'fill' | 'check' | 'sweep' | 'repair' | 'bulk' | 'refetch' | 'server' | 'archive';

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
/**
 * The most finished entries kept, per class.
 *
 * One shared cap was right while every origin was a burst someone could see coming. The slow archive (#117) is
 * not: at its default pace it lands about a hundred chapters a day per source, and many more at its fastest, so
 * under a shared 500 it would push out the adds, the Fetches and the scheduled check's chapters -- the very entries
 * "Came in today" and Needs attention are for -- while its own series already carry their counts on the
 * archive's queue. So it keeps the latest of its own trickle, and nobody else's entries pay for it.
 * lib/activityLog.ts hydrates with the same caps, so a restart brings back the same mix.
 */
export const FINISHED_CAP = { main: 500, archive: 200 } as const;
export type CapClass = keyof typeof FINISHED_CAP;
export const capClass = (origin: Origin): CapClass => (origin === 'archive' ? 'archive' : 'main');

/** How long an incomplete chapter may wait on its caller's decision before it counts as not kept. */
const HOLD_MS = 10 * 60_000;

let nextId = 1;
const live = new Map<number, ActivityEntry>();
/** Oldest first, one list per cap class, so each class's front is what goes. */
const finished: Record<CapClass, ActivityEntry[]> = { main: [], archive: [] };

/** Told of every download that finished -- never a skip -- once it is listed. */
type FinishedListener = (e: Readonly<ActivityEntry>) => void;
const listeners: FinishedListener[] = [];

/**
 * Hear about each finished download (lib/activityLog.ts writes each one down). A listener that throws is
 * logged and ignored: it runs inside the download path, and a log that cannot be written must never fail a
 * chapter that landed. Returns the way to stop listening.
 */
export function onFinished(fn: FinishedListener): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

/** An incomplete chapter nobody wrote: how it ends, whether its caller said so (`drop`) or HOLD_MS ran out. */
const notKept = (x: ActivityEntry) => endDownload(x.id, { status: 'failed', reason: `${x.reason}; not kept` });

function prune(now = Date.now()) {
  for (const x of [...live.values()]) {
    if (x.heldAt && now - x.heldAt > HOLD_MS) notKept(x);
  }
  for (const k of Object.keys(finished) as CapClass[]) {
    const list = finished[k];
    while (list.length && (list.length > FINISHED_CAP[k] || now - (list[0].finishedAt ?? now) > ACTIVITY_TTL_MS)) list.shift();
  }
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
  const done: ActivityEntry = { ...rest, ...outcome, finishedAt: Date.now() };
  finished[capClass(done.origin)].push(done);
  for (const fn of listeners) {
    try { fn(done); } catch (e) { console.warn(`[activity] a finished-download listener threw: ${(e as Error)?.message || e}`); }
  }
  prune();
}

/**
 * Put back what finished before a restart (lib/activityLog.ts, once at boot). Each gets a fresh id -- ids are
 * this process's, and the web keys rows by them -- and takes its place by when it finished, so an entry that
 * lands while the log is still being read is not shuffled behind older ones. Then the usual day and caps.
 */
export function restoreFinished(entries: ReadonlyArray<Omit<ActivityEntry, 'id' | 'heldAt'>>): void {
  for (const e of entries) finished[capClass(e.origin)].push({ ...e, id: nextId++ });
  // Stable, so entries that finished in the same millisecond keep the order they were given in.
  for (const list of Object.values(finished)) list.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  prune();
}

/**
 * A chapter that arrived with pages missing. `downloadChapter` never writes it itself: the caller writes it
 * (the hold's `write()`) once no other source did better, or drops it. So the entry stays open until the
 * write, which ends it `partial`, or the drop (`drop()`), which ends it `failed` as not kept; one that is
 * neither ends the same way after HOLD_MS.
 */
export function holdPartial(id: number, hold: {
  missing: number[]; write: () => Promise<{ pages: number; missing: number[] }>; drop?: () => void;
}): void {
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
  // Ended when its caller settles on something else (lib/chapterFallback.ts): left to HOLD_MS, a copy that was not
  // kept read as a download still running for ten minutes after its chapter had landed whole from another source.
  // A no-op once the entry has ended (endDownload), so after a write too.
  hold.drop = () => notKept(x);
}

/** Downloading or waiting for a slot now, oldest first; then what finished in the last day, newest first. */
export function listActivity(now = Date.now()): { active: ActivityEntry[]; recent: ActivityEntry[] } {
  prune(now);
  return {
    active: [...live.values()].sort((a, b) => a.startedAt - b.startedAt),
    // The classes merged back into one timeline. A stable sort of lists that are each oldest first, reversed:
    // with no archive entries this is exactly the one list reversed, as it always was.
    recent: [...finished.main, ...finished.archive].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)).reverse(),
  };
}

/**
 * A series was renumbered (lib/numbering.ts, #116): what finished for its folder today now carries the number
 * the same post has in the new numbering, so "Came in today" does not name chapter 2 for the file that is
 * chapter 20 now. A number the map does not know keeps its old spelling: an entry is history, and dropping it
 * would hide a failure nobody has looked at yet. download_log is remapped in the same transaction as the files.
 */
export function renumberFinished(folder: string, map: ReadonlyMap<number, number>): void {
  const key = (n: number) => Math.round(n * 1000) / 1000;
  for (const list of Object.values(finished)) {
    for (const e of list) {
      const to = e.folder === folder ? map.get(key(e.number)) : undefined;
      if (to !== undefined) e.number = to;
    }
  }
}

/** For tests. Also a simulated restart's first half: lib/activityLog.ts's startActivityLog is the second. */
export function clearActivity(): void {
  live.clear();
  for (const list of Object.values(finished)) list.length = 0;
}
