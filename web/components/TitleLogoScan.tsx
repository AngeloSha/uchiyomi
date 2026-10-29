'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { untilText } from '@/lib/format';
import {
  TITLE_LOGO_SCAN_KEY, TITLE_LOGO_SCAN_URL, TITLE_LOGO_STATUS_URL, titleLogoNextAttempt, titleLogoScanPoll, titleLogoScanResumeDelay,
  type TitleLogoScanStatus,
} from '@/lib/titleLogoScan';

/** Kept under Automatic title logos: reading the overview never starts a search. */
export function TitleLogoScan({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const q = useQuery({
    queryKey: TITLE_LOGO_SCAN_KEY,
    queryFn: () => api<TitleLogoScanStatus>(TITLE_LOGO_STATUS_URL),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => titleLogoScanPoll(query.state.data, enabled, query.state.status === 'error'),
  });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!q.data) return;
    if (wasRunning.current && !q.data.running) {
      for (const key of ['featured', 'series']) void qc.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = q.data.running;
  }, [q.data, qc]);
  // A setting saved on this page can enable/resume work without starting it from this GET.
  const seenEnabled = useRef(enabled);
  useEffect(() => {
    if (seenEnabled.current === enabled) return;
    seenEnabled.current = enabled;
    void qc.invalidateQueries({ queryKey: TITLE_LOGO_SCAN_KEY });
  }, [enabled, qc]);
  useEffect(() => {
    const delay = titleLogoScanResumeDelay(q.data, enabled, q.isError, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => { void qc.invalidateQueries({ queryKey: TITLE_LOGO_SCAN_KEY }); }, delay);
    return () => clearTimeout(timer);
  }, [q.data, q.isError, enabled, qc]);
  const scan = async (retryMissing: boolean) => {
    if (!enabled || starting || q.data?.running) return;
    setStarting(true);
    setStartError(false);
    try {
      const result = await api<{ ok: true; status: TitleLogoScanStatus }>(TITLE_LOGO_SCAN_URL, {
        method: 'POST', json: { retryMissing },
      });
      qc.setQueryData(TITLE_LOGO_SCAN_KEY, result.status);
    } catch { setStartError(true); }
    finally { setStarting(false); }
  };
  return <TitleLogoScanProgress enabled={enabled} status={q.data} loading={q.isPending}
    failed={q.isError} starting={starting} startError={startError} onScan={scan} onRefresh={() => { void q.refetch(); }} />;
}

/** The states stay distinct: a title never searched online must not be presented as a completed no-match. */
export function TitleLogoScanProgress({ enabled, status, loading = false, failed = false, starting = false, startError = false, onScan, onRefresh }: {
  enabled: boolean;
  status?: TitleLogoScanStatus;
  loading?: boolean;
  failed?: boolean;
  starting?: boolean;
  startError?: boolean;
  onScan: (retryMissing: boolean) => unknown;
  onRefresh: () => unknown;
}) {
  const running = status?.running === true;
  const blocked = !enabled || status?.enabled === false || starting || running || !status || failed;
  const retryAt = status ? titleLogoNextAttempt(status, Date.now()) : null;
  return (
    <div className="mt-3 min-w-0 border-t border-ink-800 pt-3" data-title-logo-scan={running ? 'running' : 'idle'}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-key disabled:opacity-50" data-title-logo-action="scan"
          disabled={blocked} onClick={() => void onScan(false)}>{tr('Scan library')}</button>
        {!!status?.counts.missing && <button type="button" className="btn-key disabled:opacity-50" data-title-logo-action="retry"
          disabled={blocked} onClick={() => void onScan(true)}>{tr('Retry no matches')}</button>}
        {(starting || running) && <span className="text-[11px] text-accent" role="status">{tr('Checking title artwork…')}</span>}
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-fog-500">
        {enabled
          ? tr('Searches only titles with confirmed manga links and online lookups allowed. Your uploaded artwork and styled-title choices are kept.')
          : tr('Turn on automatic title logos to scan the library.')}
      </p>
      {loading && <p className="mt-2 text-[11px] text-fog-500">{tr('Loading…')}</p>}
      {failed && <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role="alert" className="text-[11px] text-rose-300">{tr('Could not load title artwork progress.')}</p>
        <button type="button" className="btn-key" onClick={() => void onRefresh()}>{tr('Try again')}</button>
      </div>}
      {startError && <p role="alert" className="mt-2 text-[11px] text-rose-300">{tr('Could not start the title artwork scan.')}</p>}
      {status && <>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Stat name="checked" label={tr('Checked online')} count={status.checked} />
          <Stat name="ready" label={tr('Automatic logos ready')} count={status.counts.ready} />
          <Stat name="missing" label={tr('No match found')} count={status.counts.missing} />
          <Stat name="error" label={tr('Waiting to retry')} count={status.counts.error} />
          <Stat name="unchecked" label={tr('Not checked yet')} count={status.counts.unchecked} />
          <Stat name="needsLink" label={tr('Needs a manga link')} count={status.counts.needsLink} />
        </dl>
        {(status.counts.libraryOptOut > 0 || status.counts.firstPage > 0) &&
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fog-500">
            {status.counts.libraryOptOut > 0 && <span>{tr('Online lookups off')}: {status.counts.libraryOptOut}</span>}
            {status.counts.firstPage > 0 && <span>{tr('Own pages only')}: {status.counts.firstPage}</span>}
          </p>}
        {status.counts.missing > 0 && <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
          {tr('No match means the search finished without suitable artwork. The styled title stays visible.')}
        </p>}
        {enabled && retryAt !== null && <p className="mt-2 text-[11px] text-fog-500">
          {tr('Next attempt: {time}', { time: untilText(retryAt - Date.now()) })}
        </p>}
      </>}
    </div>
  );
}

function Stat({ name, label, count }: { name: string; label: string; count: number }) {
  return <div data-title-logo-count={name}>
    <dt className="text-[11px] text-fog-500">{label}</dt>
    <dd className="mt-0.5 text-base font-semibold tabular-nums text-fog-200">{count}</dd>
  </div>;
}
