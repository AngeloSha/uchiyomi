import { api } from './api';

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
  /** Live diagnostics for the latest run; these overlap rather than partition its progress. */
  online?: { waitingOnline: number; needsLink: number; optedOut: number };
  nextRetryAt?: string | null; pausedReason?: string | null;
  /** Distinct ready previews per group; one preview may belong to several groups. */
  reviewReasons?: { code: string; count: number }[];
}
export const COVER_TITLE_BATCH_KEY = ['admin-cover-title-batch'] as const;
export const COVER_TITLE_BATCH_ROOT = '/api/admin/title-extraction/batch';

/** Both actions return the authoritative status itself, ready to replace the overview cache. */
export function requestCoverTitleBatch(action: { kind: 'run'; retryErrors: boolean } | { kind: 'stop'; runId: string }): Promise<CoverTitleBatchStatus> {
  return api<CoverTitleBatchStatus>(COVER_TITLE_BATCH_ROOT + (action.kind === 'run' ? '/run' : '/cancel'), {
    method: 'POST', json: action.kind === 'run' ? { retryErrors: action.retryErrors } : { runId: action.runId },
  });
}

/** A manually requested run can be active with nightly generation off. Failed reads stop polling. */
export function coverTitleBatchPoll(status: CoverTitleBatchStatus | undefined, failed = false): number | false {
  return status?.running && !failed ? 2500 : false;
}

/** Idle pages sleep until the next tick; overdue schedules back off while the worker cannot advance them. */
export function coverTitleBatchResumeDelay(status: CoverTitleBatchStatus | undefined, failed: boolean, now: number): number | null {
  if (!status?.enabled || status.running || failed || !status.schedule.nextRunAt) return null;
  const at = Date.parse(status.schedule.nextRunAt);
  if (!Number.isFinite(at)) return null;
  const remaining = at + 31_000 - now;
  return Math.min(2_147_483_647, remaining > 0 ? remaining : 60_000);
}

/** These are disjoint server states. Cancelled work is finished, without being called checked or successful. */
export function coverTitleBatchFinished(run: NonNullable<CoverTitleBatchStatus['run']>): number {
  return Math.max(0, Math.min(run.counts.total, run.counts.total - run.counts.pending - run.counts.processing));
}

/** Publishing needs both opt-ins and available title checks; a zero applied count is not a switch state. */
export function coverTitleApplyState(status: CoverTitleBatchStatus): 'on' | 'off' | 'waiting' {
  if (!status.enabled || !status.applyEnabled) return 'off';
  return status.available && status.checkedApplyAvailable ? 'on' : 'waiting';
}
