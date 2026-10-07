// The durable Admin -> Library chapter cleanup. The worker belongs to the server; this file only describes
// what its status endpoint returns and remembers which run this browser was following. Keeping the id in
// localStorage is what lets a reload, a closed progress dialog, or a proxy timeout reattach instead of
// inviting the admin to submit the same destructive request again.

export type BulkChapterDeleteStatus = 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted';
export type BulkChapterDeleteReason =
  | 'not_found'
  | 'hidden'
  | 'merged'
  | 'busy'
  | 'nothing_to_delete'
  | 'refused'
  | 'cancelled'
  | 'failed';

export interface BulkChapterDeleteResult {
  id: string;
  title?: string;
  outcome: 'applied' | 'skipped' | 'failed';
  reason?: BulkChapterDeleteReason;
  message?: string;
  chapters: number;
  bytes: number;
  kept: number;
  paused: boolean;
  chapterSkips: Record<string, number>;
}

export interface BulkChapterDeleteSummary {
  applied: number;
  chapters: number;
  bytes: number;
  kept: number;
  paused: number;
  skipped: number;
  failed: number;
  chapterSkips: Record<string, number>;
}

export interface BulkChapterDeleteRun {
  id: string;
  status: BulkChapterDeleteStatus;
  startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  pause: boolean;
  total: number;
  done: number;
  summary: BulkChapterDeleteSummary;
  results: BulkChapterDeleteResult[];
  error: string | null;
}

export const BULK_CHAPTER_DELETE_POLL_MS = 1500;
export const BULK_CHAPTER_DELETE_RUN_KEY = 'uchiyomi.bulkChapterDeleteRun';

/** localStorage is optional in private/locked-down browser contexts; losing this hint never stops the job. */
export function rememberedBulkChapterDeleteRun(): string | null {
  try { return localStorage.getItem(BULK_CHAPTER_DELETE_RUN_KEY); } catch { return null; }
}

export function rememberBulkChapterDeleteRun(id: string): void {
  try { localStorage.setItem(BULK_CHAPTER_DELETE_RUN_KEY, id); } catch { /* the status endpoint still works */ }
}

/** Do not let an old dialog clear a newer run another tab has already stored. */
export function forgetBulkChapterDeleteRun(id: string): void {
  try {
    if (localStorage.getItem(BULK_CHAPTER_DELETE_RUN_KEY) === id) {
      localStorage.removeItem(BULK_CHAPTER_DELETE_RUN_KEY);
    }
  } catch { /* storage is only a reload hint */ }
}

export const bulkChapterDeleteFinished = (run: BulkChapterDeleteRun): boolean => run.status !== 'running';

/** A complete in-memory shape for the instant between POST 202 and the first status poll. */
export function startedBulkChapterDeleteRun(id: string, total: number, pause: boolean): BulkChapterDeleteRun {
  return {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancelRequested: false,
    pause,
    total,
    done: 0,
    summary: { applied: 0, chapters: 0, bytes: 0, kept: 0, paused: 0, skipped: 0, failed: 0, chapterSkips: {} },
    results: [],
    error: null,
  };
}
