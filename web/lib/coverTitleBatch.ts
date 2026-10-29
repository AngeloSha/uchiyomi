export interface CoverTitleReview {
  id: string; title: string; jobId: string;
}
export interface CoverTitleBatchStatus {
  enabled: boolean; applyEnabled: boolean; available: boolean; checkedApplyAvailable: boolean; automaticApplyAvailable: boolean;
  running: boolean;
  schedule: { hour: number; timezone: string; nextRunAt: string | null };
  run: null | {
    id: string; origin: 'manual' | 'nightly'; status: 'running' | 'completed' | 'cancelled' | 'error';
    startedAt: string; finishedAt: string | null;
    counts: { total: number; pending: number; processing: number; ready: number; applied: number; skipped: number; failed: number; cancelled: number };
    currentSeries: { id: string; title: string } | null;
  };
  retentionDays: number; reviewCount: number; reviewSeries: CoverTitleReview[];
}
export const COVER_TITLE_BATCH_KEY = ['admin-cover-title-batch'] as const;
export const COVER_TITLE_BATCH_ROOT = '/api/admin/title-extraction/batch';

/** A manually requested run can be active with nightly generation off. Failed reads stop polling. */
export function coverTitleBatchPoll(status: CoverTitleBatchStatus | undefined, failed = false): number | false {
  return status?.running && !failed ? 2500 : false;
}

/** Idle settings pages sleep until the next nightly tick; neither this read nor the timer starts work. */
export function coverTitleBatchResumeDelay(status: CoverTitleBatchStatus | undefined, failed: boolean, now: number): number | null {
  if (!status?.enabled || status.running || failed || !status.schedule.nextRunAt) return null;
  const at = Date.parse(status.schedule.nextRunAt);
  return Number.isFinite(at) ? Math.min(2_147_483_647, Math.max(0, at + 31_000 - now)) : null;
}

/** These are disjoint server states. Cancelled work is finished, without being called checked or successful. */
export function coverTitleBatchFinished(run: NonNullable<CoverTitleBatchStatus['run']>): number {
  return Math.max(0, Math.min(run.counts.total, run.counts.total - run.counts.pending - run.counts.processing));
}
