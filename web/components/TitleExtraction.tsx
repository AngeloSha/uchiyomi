'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiResponse, ApiError } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import type { Series } from '@/lib/types';
import { useLayer } from '@/lib/layers';
import { sameCoverSelection } from '@/lib/coverTitleRegions';
import {
  EXTRACTION_CAPABILITIES_KEY, EXTRACTION_CAPABILITIES_URL, extractionActive, extractionCanApply, extractionPoll,
  extractionProblem, extractionRoot, type TitleExtractionCapabilities, type TitleExtractionJob,
} from '@/lib/titleExtraction';
import { OnBody } from './ui';
import { HeroTitle } from './HeroTitle';
import { ProgressRing } from './ProgressRing';
import { SwitchRow } from './settings';
import { CoverTitleRegions, type CoverTitleSelection } from './CoverTitleRegions';

export function useTitleExtractionCapabilities() {
  return useQuery({ queryKey: EXTRACTION_CAPABILITIES_KEY, queryFn: () => api<TitleExtractionCapabilities>(EXTRACTION_CAPABILITIES_URL),
    retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
}

export function AutomaticCoverTitles({ enabled, save }: { enabled: boolean; save: (next: boolean) => Promise<unknown> }) {
  const { data } = useTitleExtractionCapabilities();
  return <>
    <SwitchRow label={tr('Automatically extract cover titles')} on={enabled}
      disabled={!enabled && (!data?.available || !data.automaticAvailable || !data.automaticApplyAvailable)} onChange={save}
      help={tr('Off by default. Applies only when the full title and image pass checks. Other results wait for review. Your manual choices and existing title logos are kept.')} />
    {(!data?.available || !data.automaticAvailable || !data.automaticApplyAvailable) && <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
      {data?.available
        ? tr('Automatic cover titles are not available on this server yet. You can still create a preview or upload your own title artwork.')
        : tr('Cover title previews are not available on this server yet.')}
    </p>}
  </>;
}

export function TitleExtractionButton({ series, disabled, onSaved }: { series: Series; disabled?: boolean; onSaved: () => void }) {
  const q = useTitleExtractionCapabilities();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={button} type="button" className="btn-key" data-art-extract-cover disabled={disabled || !q.data?.available}
      onClick={() => setOpen(true)}>{tr('Extract from cover')}</button>
    {!q.isPending && !q.data?.available && <span className="basis-full text-[11px] text-fog-500" data-extract-unavailable>
      {tr('Cover title previews are not available on this server yet.')}
    </span>}
    {open && q.data?.available && <OnBody><TitleExtractionDialog series={series} capabilities={q.data}
      opener={button.current} onClose={() => setOpen(false)} onSaved={onSaved} /></OnBody>}
  </>;
}

const codeOf = (error: unknown): string | null => {
  try { return error instanceof ApiError ? JSON.parse(error.body)?.error ?? null : null; } catch { return null; }
};

/** Authenticated image bytes stay in memory, and every replaced/closed preview revokes its object URL. */
function useExtractionImage(path: string | null, attempt: number) {
  const [image, setImage] = useState<{ path: string; url: string; fingerprint: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setImage(null);
    if (!path) { setImage(null); return; }
    const controller = new AbortController();
    let url: string | null = null;
    void (async () => {
      try {
        const response = await apiResponse(path, { signal: controller.signal });
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.type.startsWith('image/') || blob.size === 0 || blob.size > 12 * 1024 * 1024) throw new Error('invalid preview');
        url = URL.createObjectURL(blob);
        setImage({ path, url, fingerprint: response.headers.get('x-cover-fingerprint') });
      } catch { if (!controller.signal.aborted) { setImage(null); setFailed(true); } }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [path, attempt]);
  return { image: image?.path === path ? image : null, failed };
}

/** A separate dialog keeps the cover selector comfortable without widening the existing details sheet. */
export function TitleExtractionDialog({ series, capabilities, opener, onClose, onSaved }: {
  series: Series; capabilities: TitleExtractionCapabilities; opener: HTMLElement | null; onClose: () => void; onSaved: () => void;
}) {
  useLayer('dialog', true, { navBandFree: true });
  const qc = useQueryClient();
  const panel = useRef<HTMLDivElement>(null);
  const root = extractionRoot(series.id);
  const [selection, setSelection] = useState<CoverTitleSelection>({ region: null, exclusions: [] });
  const [job, setJob] = useState<TitleExtractionJob | null>(null);
  const [operation, setOperation] = useState<'create' | 'apply' | 'cancel' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pollRound, setPollRound] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [previewDecoded, setPreviewDecoded] = useState(false);
  const closed = useRef(false);
  const applied = useRef(false);
  const jobRef = useRef<TitleExtractionJob | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  jobRef.current = job;
  const latest = useQuery({ queryKey: ['title-extraction-latest', series.id], queryFn: () => api<{ job: TitleExtractionJob | null }>(root),
    retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 });
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !latest.data) return;
    adopted.current = true;
    const candidate = latest.data.job;
    if (candidate && !['expired', 'applied'].includes(candidate.status)) {
      setJob(candidate); setSelection({ region: candidate.region, exclusions: candidate.exclusions });
    }
  }, [latest.data]);
  const progress = useQuery({ queryKey: ['title-extraction-job', series.id, job?.id], enabled: !!job,
    queryFn: () => api<{ job: TitleExtractionJob }>(`${root}/${encodeURIComponent(job!.id)}`), retry: false,
    refetchOnWindowFocus: false, gcTime: 0, refetchInterval: (query) => extractionPoll(query.state.data?.job ?? job, query.state.status === 'error', paused) });
  useEffect(() => {
    if (progress.data?.job && progress.data.job.id === job?.id) {
      if (extractionActive(job) && !extractionActive(progress.data.job)) {
        setSelection({ region: progress.data.job.region, exclusions: progress.data.job.exclusions });
      }
      setJob(progress.data.job);
    }
  }, [progress.data, job?.id]);
  useEffect(() => {
    setPaused(false);
    if (!job || !extractionActive(job)) return;
    const timer = setTimeout(() => setPaused(true), (Math.max(30, capabilities.timeoutSeconds) + 20) * 1000);
    return () => clearTimeout(timer);
  }, [job?.id, job?.status, capabilities.timeoutSeconds, pollRound]);
  const coverPath = job && !stale ? `${root}/${encodeURIComponent(job.id)}/cover` : `${root}/cover`;
  const cover = useExtractionImage(coverPath, attempt);
  const previewPath = job?.previewUrl && ['ready', 'rejected'].includes(job.status) && !stale ? `${root}/${encodeURIComponent(job.id)}/preview` : null;
  const preview = useExtractionImage(previewPath, attempt);
  useEffect(() => { setPreviewDecoded(false); }, [preview.image?.url]);
  const active = extractionActive(job);
  const busy = operation !== null;
  const changed = !!job && !sameCoverSelection(selection, { region: job.region, exclusions: job.exclusions });
  const canApply = extractionCanApply(job, changed, stale, previewDecoded && !!cover.image && !progress.isError, busy);

  const remove = useCallback(async (candidate: TitleExtractionJob | null) => {
    if (candidate && candidate.status !== 'applied') await api(`${root}/${encodeURIComponent(candidate.id)}`, { method: 'DELETE' });
  }, [root]);
  useEffect(() => {
    closed.current = false;
    const parent = opener?.closest<HTMLElement>('[role="dialog"]');
    const wasInert = parent?.inert ?? false, hidden = parent?.getAttribute('aria-hidden');
    if (parent) { parent.inert = true; parent.setAttribute('aria-hidden', 'true'); }
    panel.current?.focus();
    return () => {
      closed.current = true;
      if (!applied.current) void remove(jobRef.current).catch(() => {});
      if (parent) { parent.inert = wasInert; if (hidden === null) parent.removeAttribute('aria-hidden'); else if (hidden !== undefined) parent.setAttribute('aria-hidden', hidden); }
      opener?.focus();
    };
  }, [opener, remove]);
  const create = async () => {
    if (busy || active || !cover.image?.fingerprint) return;
    setOperation('create'); setProblem(null); setStale(false);
    try {
      await remove(job);
      setJob(null);
      const result = await api<{ job: TitleExtractionJob }>(root, { method: 'POST', json: {
        coverFingerprint: cover.image.fingerprint, ...(selection.region ? { region: selection.region } : {}), exclusions: selection.exclusions,
      } });
      if (closed.current) { await remove(result.job); return; }
      setJob(result.job); setPaused(false);
      qc.setQueryData(['title-extraction-job', series.id, result.job.id], result);
    } catch (error) {
      if (!closed.current) {
        setProblem(codeOf(error) ?? 'extract_failed');
        if (codeOf(error) === 'stale_cover') { setStale(true); setJob(null); setSelection({ region: null, exclusions: [] }); setAttempt((n) => n + 1); onSaved(); }
      }
    } finally { if (!closed.current) setOperation(null); }
  };
  const cancel = async () => {
    if (busy) return;
    setOperation('cancel'); setProblem(null);
    try { await remove(job); setJob(null); setStale(false); setAttempt((n) => n + 1); }
    catch { setProblem('extract_failed'); }
    finally { setOperation(null); }
  };
  const apply = async () => {
    if (!canApply || !job) return;
    setOperation('apply'); setProblem(null);
    try {
      await api(`${root}/${encodeURIComponent(job.id)}/apply`, { method: 'POST', json: {} });
      applied.current = true;
      onSaved();
      for (const key of [['series', series.id], ['featured'], ['admin-title-logo-scan'], ['title-extraction-latest', series.id]]) void qc.invalidateQueries({ queryKey: key });
      onClose();
    } catch (error) {
      setProblem(codeOf(error) ?? 'extract_failed');
      if (error instanceof ApiError && [404, 409, 410].includes(error.status)) { setStale(true); setSelection({ region: null, exclusions: [] }); onSaved(); }
    } finally { setOperation(null); }
  };
  const keyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (operation !== 'apply') closeRef.current(); }
    else if (event.key === 'Tab') {
      event.stopPropagation();
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (!panel.current?.contains(document.activeElement) || document.activeElement === panel.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const keyboard = useRef(keyDown);
  keyboard.current = keyDown;
  useEffect(() => {
    // A temporarily disabled Create button can drop focus to <body>. Capture there too, before Edit details'
    // document listener, so Escape closes only this top dialog and Tab returns to its own controls.
    const capture = (event: globalThis.KeyboardEvent) => keyboard.current(event);
    document.addEventListener('keydown', capture, true);
    return () => document.removeEventListener('keydown', capture, true);
  }, []);
  const errorMessage = problem !== null ? extractionProblem(problem) : job?.error ? extractionProblem(job.error)
    : job?.status === 'rejected' ? extractionProblem('rejected') : job?.status === 'expired' ? extractionProblem('expired') : null;
  return <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/80 p-3 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:px-6 lg:pb-28 lg:pt-[5.5rem]" onClick={() => { if (operation !== 'apply') onClose(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tr('Extract title from cover')} data-title-extraction-dialog
      data-lenis-prevent className="flex max-h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-950 outline-hidden lg:max-h-[calc(100dvh-13rem)]"
      onClick={(event) => event.stopPropagation()}>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-ink-800 p-4">
        <div className="min-w-0"><h2 className="text-lg font-semibold text-fog-100">{tr('Extract title from cover')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-fog-400">{tr('Your current artwork stays until you choose Apply.')}</p></div>
        <button type="button" className="btn-key shrink-0" aria-label={tr('Close')} disabled={operation === 'apply'} onClick={onClose}>×</button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4" data-extract-scroll data-lenis-prevent>
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-3 text-sm font-semibold text-fog-200">{tr('Choose the title')}</h3>
            {cover.image ? <CoverTitleRegions key={cover.image.url} src={cover.image.url} selection={selection} disabled={busy || active}
              maxExclusions={Math.min(8, capabilities.maxExclusions)} onChange={setSelection} />
              : <p className="text-xs text-fog-400">{cover.failed ? tr('The cover could not be loaded. Close this preview and try again.') : tr('Loading…')}</p>}
          </section>
          <section className="min-w-0" data-extract-result={job?.status ?? 'idle'}>
            <h3 className="mb-3 text-sm font-semibold text-fog-200">{tr('Preview the title')}</h3>
            {latest.isPending && <p className="text-xs text-fog-400">{tr('Checking for a saved preview…')}</p>}
            {(active || operation === 'create') && <div className="mb-4 flex items-center gap-3 text-sm text-fog-300" aria-live="polite">
              <ProgressRing progress="spin" /><span>{job?.status === 'queued' ? tr('Waiting to create your preview…') : tr('Creating your title preview…')}</span>
            </div>}
            {(progress.isError || paused) && <div className="mb-3 space-y-2">
              <p role="alert" className="text-xs text-amber-200">{tr('Progress could not be checked. Your current artwork is still kept.')}</p>
              <button type="button" className="btn-key" data-extract-check-progress onClick={() => { setPaused(false); setPollRound((n) => n + 1); void progress.refetch(); }}>{tr('Check progress again')}</button>
            </div>}
            {errorMessage && <p role="alert" className="mb-3 text-xs leading-relaxed text-amber-200" data-extract-error>{tr(errorMessage)}</p>}
            {job?.automatic && <p className="mb-3 text-xs text-fog-400">{tr('Prepared automatically for your review. Nothing has been applied.')}</p>}
            {preview.image ? <>
              <ExtractionHeroPreview series={series} url={preview.image.url} onDecoded={() => setPreviewDecoded(true)} />
              <p className="mt-3 text-xs leading-relaxed text-fog-300">{tr('Check that the whole title is present, with clean edges and no author names or volume numbers. A preview can miss letters; only apply it if it looks right.')}</p>
            </> : !active && <p className="text-xs leading-relaxed text-fog-400">{tr('Create a preview to see how the title looks on dark and light backgrounds.')}</p>}
            {preview.failed && <div className="mt-3 space-y-2"><p role="alert" className="text-xs text-amber-200">{tr('The title preview could not be loaded.')}</p>
              <button type="button" className="btn-key" onClick={() => setAttempt((n) => n + 1)}>{tr('Try again')}</button></div>}
            {changed && <p className="mt-3 text-xs text-amber-200">{tr('The selected areas changed. Create a new preview before applying.')}</p>}
          </section>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ink-800 bg-ink-950 p-3">
        <button type="button" className="btn-key" data-extract-discard disabled={operation === 'apply'} onClick={onClose}>{tr('Discard')}</button>
        {active && <button type="button" className="btn-key" data-extract-cancel disabled={busy} onClick={() => void cancel()}>{tr('Cancel preview')}</button>}
        <button type="button" className="btn-key" data-extract-create disabled={busy || active || latest.isPending || !cover.image?.fingerprint} onClick={() => void create()}>
          {job ? tr('Create a new preview') : tr('Create preview')}</button>
        <button type="button" className="btn-accent px-4 py-2 text-sm disabled:opacity-40" data-extract-apply disabled={!canApply} onClick={() => void apply()}>
          {operation === 'apply' ? tr('Applying…') : tr('Apply title artwork')}</button>
      </div>
    </div>
  </div>;
}

function ExtractionHeroPreview({ series, url, onDecoded }: { series: Series; url: string; onDecoded: () => void }) {
  return <div className="space-y-3" data-extract-hero-preview>
    <img src={url} alt="" className="hidden" onLoad={onDecoded} />
    {(['dark', 'light'] as const).map((surface) => <div key={surface}>
      <p className="mb-1 text-[11px] text-fog-400">{surface === 'dark' ? tr('On a dark background') : tr('On a light background')}</p>
      <div data-extract-surface={surface} className={`title-extraction-preview min-w-0 overflow-hidden rounded-xl border p-4 ${surface === 'dark' ? 'border-ink-700 bg-[#11121a]' : 'border-slate-300 bg-[#f1f2f6]'}`}>
        <HeroTitle as="div" series={series} previewUrl={url} />
      </div>
    </div>)}
  </div>;
}
