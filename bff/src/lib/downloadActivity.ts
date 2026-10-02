import { AsyncLocalStorage } from 'node:async_hooks';
import { english, say, saids, type Part, type Said } from './said';

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
  /**
   * v0.49.1: `reason` as codes the web words (lib/said.ts `activity.*`) -- the pages a chapter arrived or was saved
   * without. A download's own error has none: those are the site's or the downloader's words, shown as sent.
   */
  reasonSaid?: Said[];
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

/** Told when a chapter that came in with pages missing is whole now (`healFinished`), as the folder and number. */
type HealedListener = (folder: string, number: number) => void;
const healedListeners: HealedListener[] = [];
/** Hear about each chapter healed (lib/activityLog.ts rewrites its rows). The same rules as onFinished. */
export function onHealed(fn: HealedListener): () => void {
  healedListeners.push(fn);
  return () => { const i = healedListeners.indexOf(fn); if (i >= 0) healedListeners.splice(i, 1); };
}

/** An incomplete chapter nobody wrote: how it ends, whether its caller said so (`drop`) or HOLD_MS ran out. */
const notKept = (x: ActivityEntry) => endDownload(x.id, { status: 'failed', ...reasonOf([...partsOf(x), say('activity.notKept')]) });

/** An entry's reason as parts again: its codes when it has them, else its English as sent. */
const partsOf = (x: Pick<ActivityEntry, 'reason' | 'reasonSaid'>): Part[] =>
  x.reasonSaid?.length === 1 && x.reason !== undefined ? [{ ...x.reasonSaid[0], text: x.reason }]
    : x.reason !== undefined ? [say('text', { text: x.reason })] : [];
/** A reason's English and its codes, as the entry carries them. */
const reasonOf = (parts: Part[]) => ({ reason: english(parts), reasonSaid: saids(parts) });

/**
 * The codes of a reason this module wrote, from its English: what activityLog.ts reads back after a restart, where
 * only the English was stored. Anything else -- a download's own error -- has none, and is shown as sent.
 */
export function reasonSaidOf(reason: string): Said[] | undefined {
  const m = /^(arrived|saved) with (\d+) pages? missing(; not kept)?$/.exec(reason);
  if (!m) return undefined;
  const n = Number(m[2]);
  return saids([say(m[1] === 'arrived' ? 'activity.arrived' : 'activity.saved', { n }), m[3] ? say('activity.notKept') : null]);
}

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
export function endDownload(
  id: number, outcome: { status: 'done' | 'partial' | 'failed'; pages?: number; reason?: string; reasonSaid?: Said[] } | 'skipped',
): void {
  const x = live.get(id);
  if (!x) return;
  live.delete(id);
  if (outcome === 'skipped') return;
  // The same chapter, whole this time: written over the file an earlier download left with holes in it.
  if (outcome.status === 'done') healFinished(x.folder, x.number);
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
  Object.assign(x, reasonOf([say('activity.arrived', { n: hold.missing.length })]));
  const write = hold.write.bind(hold);
  hold.write = async () => {
    const w = await write();
    endDownload(id, { status: 'partial', pages: w.pages, ...reasonOf([say('activity.saved', { n: w.missing.length })]) });
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

const numKey = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A chapter that came in with pages missing today is whole now: the completion pass filled its holes
 * (lib/partial.ts), or a later download wrote it whole (endDownload). Each entry of it that says `partial` ends as
 * landed, and loses the "saved with N pages missing" it no longer is: Came in today went on saying "1 chapter saved
 * with pages missing" after a repair had healed that chapter (v0.49.1). The rows in download_log follow
 * (lib/activityLog.ts). Returns how many entries changed.
 */
export function healFinished(folder: string, number: number): number {
  let n = 0;
  for (const list of Object.values(finished)) {
    for (const e of list) {
      if (e.status !== 'partial' || e.folder !== folder || numKey(e.number) !== numKey(number)) continue;
      e.status = 'done';
      // The codes go with the English (lib/said.ts): kept, they went on saying "saved with 1 page missing" to the
      // web beside an entry that says nothing.
      delete e.reason;
      delete e.reasonSaid;
      n++;
    }
  }
  if (n) {
    for (const fn of healedListeners) {
      try { fn(folder, number); } catch (err) { console.warn(`[activity] a healed-chapter listener threw: ${(err as Error)?.message || err}`); }
    }
  }
  return n;
}

/** Told when a folder's failed chapters were dismissed (`dismissFailed`): the folder, and whose (null: everyone's). */
type DismissedListener = (folder: string, by: string | null) => void;
const dismissedListeners: DismissedListener[] = [];
/** Hear about each dismissal (lib/activityLog.ts deletes its rows). The same rules as onFinished. */
export function onDismissed(fn: DismissedListener): () => void {
  dismissedListeners.push(fn);
  return () => { const i = dismissedListeners.indexOf(fn); if (i >= 0) dismissedListeners.splice(i, 1); };
}

/**
 * Dismiss a folder's chapters that could not be saved, from the day's feed (v0.50.0): what Dismiss on a Needs
 * attention card clears. Such a card is often only these entries -- the scheduled check's, a Check now's -- with no
 * job behind it, and a job's own failures are these entries too, which came back as a card of their own once the
 * job's card was dismissed. `by` keeps to one person's own downloads (a member's dismissal); null takes everyone's
 * (an admin's). The slow archive's are left alone: it retries its own, and they are never on that card. Their rows
 * in download_log follow (lib/activityLog.ts), so a restart does not bring the card back. Returns how many went.
 */
export function dismissFailed(folder: string, by: string | null): number {
  let n = 0;
  for (const list of Object.values(finished)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.folder !== folder || e.status !== 'failed' || e.origin === 'archive' || (by !== null && e.by !== by)) continue;
      list.splice(i, 1);
      n++;
    }
  }
  if (n) {
    for (const fn of dismissedListeners) {
      try { fn(folder, by); } catch (err) { console.warn(`[activity] a dismissal listener threw: ${(err as Error)?.message || err}`); }
    }
  }
  return n;
}

/**
 * A series was renumbered (lib/numbering.ts, #116): what finished for its folder today now carries the number
 * the same post has in the new numbering, so "Came in today" does not name chapter 2 for the file that is
 * chapter 20 now. A number the map does not know keeps its old spelling: an entry is history, and dropping it
 * would hide a failure nobody has looked at yet. download_log is remapped in the same transaction as the files.
 */
export function renumberFinished(folder: string, map: ReadonlyMap<number, number>): void {
  for (const list of Object.values(finished)) {
    for (const e of list) {
      const to = e.folder === folder ? map.get(numKey(e.number)) : undefined;
      if (to !== undefined) e.number = to;
    }
  }
}

/** For tests. Also a simulated restart's first half: lib/activityLog.ts's startActivityLog is the second. */
export function clearActivity(): void {
  live.clear();
  for (const list of Object.values(finished)) list.length = 0;
}
