'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { relativeTime, untilText } from '@/lib/format';
import { COVER_TITLE_BATCH_KEY, COVER_TITLE_BATCH_ROOT, coverTitleApplyState, coverTitleBatchFinished, coverTitleBatchPoll, coverTitleBatchResumeDelay, requestCoverTitleBatch,
  type CoverTitleBatchStatus, type CoverTitleReview } from '@/lib/coverTitleBatch';

export function CoverTitleBatch({ enabled, applyEnabled, reviewing, reviewError, onReview }: {
  enabled: boolean; applyEnabled: boolean; reviewing?: string | null; reviewError?: boolean;
  onReview: (item: CoverTitleReview, opener: HTMLButtonElement) => void;
}) {
  const qc = useQueryClient();
  const [operation, setOperation] = useState<'run' | 'stop' | null>(null);
  const [problem, setProblem] = useState<'run' | 'stop' | null>(null);
  const q = useQuery({ queryKey: COVER_TITLE_BATCH_KEY, queryFn: () => api<CoverTitleBatchStatus>(COVER_TITLE_BATCH_ROOT + '/status'),
    retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
    refetchInterval: (query) => coverTitleBatchPoll(query.state.data, query.state.status === 'error') });
  const previousSettings = useRef([enabled, applyEnabled]);
  useEffect(() => {
    if (previousSettings.current[0] === enabled && previousSettings.current[1] === applyEnabled) return;
    previousSettings.current = [enabled, applyEnabled];
    void qc.invalidateQueries({ queryKey: COVER_TITLE_BATCH_KEY });
  }, [enabled, applyEnabled, qc]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!q.data) return;
    if (wasRunning.current && !q.data.running) {
      for (const key of ['featured', 'series', 'title-extraction-latest']) void qc.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = q.data.running;
  }, [q.data, qc]);
  useEffect(() => {
    const delay = coverTitleBatchResumeDelay(q.data ? { ...q.data, enabled } : undefined, q.isError, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => { void qc.invalidateQueries({ queryKey: COVER_TITLE_BATCH_KEY }); }, delay);
    return () => clearTimeout(timer);
  }, [q.data, q.isError, enabled, qc]);
  const act = async (kind: 'run' | 'stop', retryErrors = false) => {
    if (operation || !q.data || q.isError || (kind === 'run' ? q.data.running || !q.data.available : !q.data.running || !q.data.run)) return;
    setOperation(kind); setProblem(null);
    try {
      const result = await requestCoverTitleBatch(kind === 'run' ? { kind, retryErrors } : { kind, runId: q.data.run!.id });
      qc.setQueryData(COVER_TITLE_BATCH_KEY, result);
    } catch { setProblem(kind); void q.refetch(); }
    finally { setOperation(null); }
  };
  return <CoverTitleBatchProgress enabled={enabled} status={q.data} loading={q.isPending} failed={q.isError}
    operation={operation} problem={problem} reviewing={reviewing} reviewError={reviewError}
    onRun={(retry) => void act('run', retry)} onStop={() => void act('stop')} onRefresh={() => void q.refetch()} onReview={onReview} />;
}

export function CoverTitleBatchProgress({ enabled, status, loading = false, failed = false, operation = null, problem = null,
  reviewing, reviewError, onRun, onStop, onRefresh, onReview }: {
  enabled: boolean; status?: CoverTitleBatchStatus; loading?: boolean; failed?: boolean;
  operation?: 'run' | 'stop' | null; problem?: 'run' | 'stop' | null; reviewing?: string | null; reviewError?: boolean;
  onRun: (retry: boolean) => void; onStop: () => void; onRefresh: () => void;
  onReview: (item: CoverTitleReview, opener: HTMLButtonElement) => void;
}) {
  const run = status?.run;
  const running = status?.running === true;
  const blocked = !status || !status.available || running || operation !== null || failed;
  const next = status?.schedule.nextRunAt ? Date.parse(status.schedule.nextRunAt) : NaN;
  const nextOnline = status?.nextRetryAt ? Date.parse(status.nextRetryAt) : NaN;
  const waitingOnline = running && !run?.counts.processing && (status?.online?.waitingOnline ?? 0) > 0;
  const runLabel = waitingOnline ? tr('Waiting for online artwork') : tr('Creating title previews…');
  const applyState = status ? coverTitleApplyState(status) : null;
  const reviewReasons = status?.reviewReasons?.filter((reason) => reason.count > 0) ?? [];
  return <div className="mt-3 min-w-0 space-y-3 border-t border-ink-800 pt-3" data-cover-title-batch={running ? 'running' : 'idle'}>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-key h-auto min-h-8 max-w-full whitespace-normal py-1.5 disabled:opacity-50" data-cover-title-action="run" disabled={blocked} onClick={() => onRun(false)}>{tr('Run now')}</button>
      {!!run?.counts.failed && <button type="button" className="btn-key h-auto min-h-8 max-w-full whitespace-normal py-1.5 disabled:opacity-50" data-cover-title-action="retry" disabled={blocked} onClick={() => onRun(true)}>{tr('Retry failed titles')}</button>}
      {running && <button type="button" className="btn-key h-auto min-h-8 max-w-full whitespace-normal py-1.5 disabled:opacity-50" data-cover-title-action="stop" disabled={operation !== null || failed} onClick={onStop}>{tr('Stop this run')}</button>}
      {(running || operation === 'run') && <span role="status" className="text-[11px] text-accent">{runLabel}</span>}
    </div>
    {!enabled && <p className="text-[11px] leading-relaxed text-fog-500">{tr('With nightly runs off, Run now prepares previews only. Automatic applying needs both switches turned on.')}</p>}
    {loading && <p className="text-[11px] text-fog-500">{tr('Loading…')}</p>}
    {failed && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-[11px] text-rose-300">{tr('Could not load cover title progress.')}</p>
      <button type="button" className="btn-key" onClick={onRefresh}>{tr('Try again')}</button></div>}
    {problem && <p role="alert" className="text-[11px] text-rose-300">{problem === 'run' ? tr('Could not start cover title generation.') : tr('Could not stop cover title generation.')}</p>}
    {status && <>
      <div className="space-y-1 text-[11px] leading-relaxed" data-cover-title-apply-state={applyState}>
        <p className={applyState === 'on' ? 'font-medium text-accent' : 'text-fog-300'}>{applyState === 'on' ? tr('Automatic applying is on')
          : applyState === 'waiting' ? tr('Automatic applying is waiting for title checks') : tr('Automatic applying is off')}</p>
        <p className="text-fog-500">{tr('Previews that do not pass the title and image checks stay for review.')}</p>
      </div>
      <div className="space-y-1 break-words text-[11px] leading-relaxed text-fog-500" data-cover-title-schedule>
        <p>{enabled ? tr('Every night at {time} ({zone}).', { time: String(status.schedule.hour).padStart(2, '0') + ':00', zone: status.schedule.timezone }) : tr('Nightly runs are off.')}</p>
        {enabled && Number.isFinite(next) && <p>{tr('Next nightly run: {time}', { time: untilText(next - Date.now()) })}</p>}
      </div>
      {run && <div className="space-y-3" data-cover-title-run={run.id}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-fog-300">
          <span>{run.origin === 'nightly' ? tr('Nightly run') : tr('Manual run')} · {run.status === 'running' ? runLabel : run.status === 'completed' ? tr('Completed') : run.status === 'cancelled' ? tr('Cancelled') : tr('Failed')}</span>
          <span className="tabular-nums" data-cover-title-finished>{tr('Finished: {done} of {total}', { done: coverTitleBatchFinished(run), total: run.counts.total })}</span>
        </div>
        <p className="text-[11px] text-fog-500">{tr('Last started: {time}', { time: relativeTime(run.startedAt) })}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Count name="pending" label={tr('Queued')} value={run.counts.pending} />
          <Count name="processing" label={tr('Creating')} value={run.counts.processing} />
          <Count name="ready" label={tr('Ready')} value={run.counts.ready} />
          <Count name="applied" label={tr('Applied automatically')} value={run.counts.applied} />
          <Count name="skipped" label={tr('Skipped')} value={run.counts.skipped} />
          <Count name="failed" label={tr('Failed')} value={run.counts.failed} />
          <Count name="cancelled" label={tr('Cancelled')} value={run.counts.cancelled} />
        </dl>
        {running && run.currentSeries && <Link className="block text-xs text-accent hover:underline" href={`/series/?id=${encodeURIComponent(run.currentSeries.id)}`}>
          {tr('Creating a preview for {title}…', { title: run.currentSeries.title })}</Link>}
      </div>}
      {run && status.online && <div className="space-y-2 border-t border-ink-800 pt-3" data-cover-title-online>
        <p className="text-xs font-semibold text-fog-200">{tr('Online artwork checks')}</p>
        <p className="text-[11px] leading-relaxed text-fog-500">{tr('Online artwork is checked before cover extraction when a checked manga link and online lookups are available.')}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Diagnostic name="waitingOnline" label={tr('Waiting for online artwork')} value={status.online.waitingOnline} />
          <Diagnostic name="needsLink" label={tr('Needs a manga link')} value={status.online.needsLink} />
          <Diagnostic name="optedOut" label={tr('Online lookups off')} value={status.online.optedOut} />
        </dl>
        {status.online.waitingOnline > 0 && <p className="text-[11px] leading-relaxed text-fog-500">{tr('Waiting titles stay queued until their online artwork search can finish.')}</p>}
        {status.online.waitingOnline > 0 && Number.isFinite(nextOnline) && <p className="text-[11px] text-fog-500">{tr('Next attempt: {time}', { time: untilText(nextOnline - Date.now()) })}</p>}
        <p className="text-[11px] leading-relaxed text-fog-500">{tr('Manga without a checked link or with online lookups off can still get cover previews.')}</p>
        <p className="text-[11px] text-fog-500">{tr('These counts can overlap.')}</p>
      </div>}
      {status.reviewCount > 0 && <div className="space-y-2 border-t border-ink-800 pt-3" data-cover-title-review-list>
        <p className="text-xs font-semibold text-fog-200">{tr('Previews to review')}: {status.reviewCount}</p>
        {reviewReasons.length > 0 && <div className="space-y-2" data-cover-title-review-reasons>
          <p className="text-[11px] font-medium text-fog-300">{tr('Why previews need review')}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{reviewReasons.map((reason) =>
            <Diagnostic key={reason.code} name={reason.code} label={reviewReasonLabel(reason.code)} value={reason.count} review />)}</dl>
          <p className="text-[11px] text-fog-500">{tr('These counts can overlap.')}</p>
        </div>}
        <ul className="space-y-2">{status.reviewSeries.map((item) => <li key={item.jobId} className="flex min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 break-words text-xs text-fog-300">{item.title}</span>
          <button type="button" className="btn-key shrink-0 disabled:opacity-50" data-cover-title-review={item.jobId} disabled={!!reviewing}
            onClick={(event) => onReview(item, event.currentTarget)}>{reviewing === item.jobId ? tr('Loading…') : tr('Review')}</button>
        </li>)}</ul>
        {status.reviewCount > status.reviewSeries.length && <p className="text-[11px] text-fog-500">{status.reviewSeries.length === 1
          ? tr('Showing the latest 1 preview.') : tr('Showing the latest {n} previews.', { n: status.reviewSeries.length })}</p>}
        <p className="text-[11px] leading-relaxed text-fog-500">{tr('Previews are kept for {days} days. Open a manga’s Art settings and choose Extract from cover to review or fine-tune its title.', { days: status.retentionDays })}</p>
      </div>}
    </>}
    {reviewError && <p role="alert" className="text-[11px] text-rose-300">{tr('Could not open this title preview. Try again.')}</p>}
  </div>;
}

function Count({ name, label, value }: { name: string; label: string; value: number }) {
  return <div data-cover-title-count={name}><dt className="text-[11px] text-fog-500">{label}</dt><dd className="mt-0.5 text-base font-semibold tabular-nums text-fog-200">{value}</dd></div>;
}

function Diagnostic({ name, label, value, review = false }: { name: string; label: string; value: number; review?: boolean }) {
  return <div data-cover-title-online-count={review ? undefined : name} data-cover-title-review-reason={review ? name : undefined}>
    <dt className="break-words text-[11px] text-fog-500">{label}</dt><dd className="mt-0.5 text-sm font-semibold tabular-nums text-fog-200">{value}</dd>
  </div>;
}

function reviewReasonLabel(code: string): string {
  switch (code) {
    case 'title_not_verified': return tr('Title not verified');
    case 'text_unclear': return tr('Title text unclear');
    case 'lettering_incomplete': return tr('Lettering may be missing');
    case 'low_contrast': return tr('Low contrast');
    case 'checks_unavailable': return tr('Checks unavailable');
    default: return tr('Other checks need review');
  }
}
