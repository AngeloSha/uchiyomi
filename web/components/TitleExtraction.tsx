'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiResponse, ApiError } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import type { Series } from '@/lib/types';
import { useLayer } from '@/lib/layers';
import {
  EXTRACTION_CAPABILITIES_KEY, EXTRACTION_CAPABILITIES_URL, extractionActive, extractionCanApply, extractionPoll,
  extractionProblem, extractionRoot, extractionSelectionChanged, extractionJobSelection, extractionPreviewPath, extractionPreviewDecoded, type TitleExtractionCapabilities, type TitleExtractionJob,
} from '@/lib/titleExtraction';
import { OnBody } from './ui';
import { HeroTitle } from './HeroTitle';
import { ProgressRing } from './ProgressRing';
import { SwitchRow } from './settings';
import { CoverTitleRegions, type CoverTitleSelection } from './CoverTitleRegions';
import { CoverTitleMaskEditor, type TitleMaskDraft } from './CoverTitleMaskEditor';
import type { TitleMaskStroke } from '@/lib/titleMaskRaster';
import { CoverTitleBatch } from './CoverTitleBatch';
import { COVER_TITLE_BATCH_KEY, type CoverTitleReview } from '@/lib/coverTitleBatch';

export function useTitleExtractionCapabilities() {
  return useQuery({ queryKey: EXTRACTION_CAPABILITIES_KEY, queryFn: () => api<TitleExtractionCapabilities>(EXTRACTION_CAPABILITIES_URL),
    retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
}

export function AutomaticCoverTitles({ enabled, save, applyEnabled = false, saveApply }: {
  enabled: boolean; save: (next: boolean) => Promise<unknown>; applyEnabled?: boolean; saveApply?: (next: boolean) => Promise<unknown>;
}) {
  const { data } = useTitleExtractionCapabilities();
  const qc = useQueryClient();
  const [review, setReview] = useState<{ series: Series; jobId: string } | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState(false);
  const reviewOpener = useRef<HTMLButtonElement | null>(null);
  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: COVER_TITLE_BATCH_KEY }); }, [qc]);
  const openReview = async (item: CoverTitleReview, opener: HTMLButtonElement) => {
    if (reviewing) return;
    setReviewing(item.jobId); setReviewError(false); reviewOpener.current = opener;
    try { setReview({ series: await api<Series>(`/api/series/${encodeURIComponent(item.id)}`), jobId: item.jobId }); }
    catch { setReviewError(true); }
    finally { setReviewing(null); }
  };
  const capabilities: TitleExtractionCapabilities = data ?? {
    available: false, reason: 'worker_unavailable', automaticAvailable: false, automaticApplyAvailable: false,
    maxExclusions: 8, timeoutSeconds: 90,
  };
  return <>
    <SwitchRow label={tr('Automatically extract cover titles')} on={enabled}
      disabled={!enabled && !data?.available} onChange={save}
      help={tr('Off by default. Prepares title artwork from existing and new manga covers every night. No manga link is required to make a preview.')} />
    <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
      {tr('Your manual artwork, styled titles and original title logos are kept. Covers taken from chapter pages are skipped.')}
    </p>
    {!data?.available && <p className="mt-2 text-[11px] leading-relaxed text-fog-500">{tr('Cover title previews are not available on this server yet.')}</p>}
    {saveApply && <div className="mt-3 border-t border-ink-800 pt-3">
      <SwitchRow label={tr('Apply cover titles that pass checks')} on={applyEnabled}
        disabled={!applyEnabled && !data?.checkedApplyAvailable} onChange={saveApply}
        help={tr('Off by default. Applies results that pass the available title and image checks. Unlinked manga, unsupported languages, partial titles and uncertain results stay as previews for review.')} />
      {!data?.checkedApplyAvailable && <p className="mt-2 text-[11px] leading-relaxed text-fog-500">{tr('Title checks are not available on this server yet. You can still generate previews for review.')}</p>}
    </div>}
    <CoverTitleBatch enabled={enabled} applyEnabled={applyEnabled} reviewing={reviewing} reviewError={reviewError} onReview={openReview} />
    {review && <OnBody><TitleExtractionDialog series={review.series} initialJobId={review.jobId} capabilities={capabilities}
      opener={reviewOpener.current} onClose={() => setReview(null)} onSaved={refresh} onDiscarded={refresh} /></OnBody>}
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
export function TitleExtractionDialog({ series, capabilities, opener, onClose, onSaved, initialJobId, onDiscarded }: {
  series: Series; capabilities: TitleExtractionCapabilities; opener: HTMLElement | null; onClose: () => void; onSaved: () => void;
  initialJobId?: string; onDiscarded?: () => void;
}) {
  useLayer('dialog', true, { navBandFree: true });
  const qc = useQueryClient();
  const panel = useRef<HTMLDivElement>(null);
  const root = extractionRoot(series.id);
  const [selection, setSelection] = useState<CoverTitleSelection>({ region: null, exclusions: [] });
  const [job, setJob] = useState<TitleExtractionJob | null>(null);
  const [operation, setOperation] = useState<'create' | 'apply' | 'cancel' | 'mask' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pollRound, setPollRound] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [decodedPreviewPath, setDecodedPreviewPath] = useState<string | null>(null);
  const [maskEditing, setMaskEditing] = useState(false);
  const [maskDraft, setMaskDraft] = useState<TitleMaskDraft | null>(null);
  const [maskConflict, setMaskConflict] = useState(false);
  const [maskProblem, setMaskProblem] = useState<string | null>(null);
  const [maskSaved, setMaskSaved] = useState(false);
  const closed = useRef(false);
  const applied = useRef(false);
  const explicitlyRemoved = useRef(false);
  const jobRef = useRef<TitleExtractionJob | null>(null);
  const closeRef = useRef(onClose);
  const discardedRef = useRef(onDiscarded);
  discardedRef.current = onDiscarded;
  closeRef.current = onClose;
  jobRef.current = job;
  const latest = useQuery({ queryKey: ['title-extraction-latest', series.id, initialJobId ?? null],
    queryFn: () => api<{ job: TitleExtractionJob | null }>(initialJobId ? `${root}/${encodeURIComponent(initialJobId)}` : root),
    retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 });
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !latest.data) return;
    adopted.current = true;
    const candidate = latest.data.job;
    if (candidate && !['expired', 'applied'].includes(candidate.status)) {
      setJob(candidate); setSelection(extractionJobSelection(candidate));
    }
  }, [latest.data]);
  const progress = useQuery({ queryKey: ['title-extraction-job', series.id, job?.id], enabled: !!job,
    queryFn: () => api<{ job: TitleExtractionJob }>(`${root}/${encodeURIComponent(job!.id)}`), retry: false,
    refetchOnWindowFocus: false, gcTime: 0, refetchInterval: (query) => extractionPoll(query.state.data?.job ?? job, query.state.status === 'error', paused) });
  useEffect(() => {
    if (progress.data?.job && progress.data.job.id === job?.id) {
      if ((progress.data.job.mask?.revision ?? -1) < (job.mask?.revision ?? -1)) return;
      if (extractionActive(job) && !extractionActive(progress.data.job)) {
        setSelection(extractionJobSelection(progress.data.job));
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
  const changed = extractionSelectionChanged(job, selection);
  const previewPath = job && ['ready', 'rejected'].includes(job.status) && !stale && !changed ? extractionPreviewPath(series.id, job) : null;
  const preview = useExtractionImage(previewPath, attempt + previewAttempt);
  const active = extractionActive(job);
  const busy = operation !== null;
  const currentMaskDraft = maskDraft?.jobId === job?.id ? maskDraft : null;
  const maskDirty = !!currentMaskDraft && (currentMaskDraft.dirty || currentMaskDraft.drawing);
  const localPreview = maskDirty && currentMaskDraft?.valid ? currentMaskDraft.previewUrl : null;
  const displayedPreview = maskDirty ? localPreview : preview.image?.url;
  const canApply = extractionCanApply(job, changed, stale, !!preview.image && extractionPreviewDecoded(series.id, job, decodedPreviewPath) && !!cover.image && !progress.isError, busy)
    && !maskDirty && !maskConflict;
  const maskDraftChanged = useCallback((draft: TitleMaskDraft | null) => setMaskDraft(draft), []);
  useEffect(() => {
    setMaskEditing(false); setMaskDraft(null); setMaskConflict(false); setMaskProblem(null); setMaskSaved(false);
  }, [job?.id, changed]);

  const remove = useCallback(async (candidate: TitleExtractionJob | null) => {
    if (candidate && candidate.status !== 'applied') {
      await api(`${root}/${encodeURIComponent(candidate.id)}`, { method: 'DELETE' });
      discardedRef.current?.();
    }
  }, [root]);
  useEffect(() => {
    closed.current = false;
    const parent = opener?.closest<HTMLElement>('[role="dialog"]');
    const wasInert = parent?.inert ?? false, hidden = parent?.getAttribute('aria-hidden');
    if (parent) { parent.inert = true; parent.setAttribute('aria-hidden', 'true'); }
    panel.current?.focus();
    return () => {
      closed.current = true;
      // Automatic results are durable review items, including saved mask corrections. A normal X/Escape,
      // navigation or unmount must not throw them away. Manual scratch previews retain their old cleanup.
      if (!applied.current && !explicitlyRemoved.current && !jobRef.current?.automatic) void remove(jobRef.current).catch(() => {});
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
  const discard = async () => {
    if (busy) return;
    setOperation('cancel'); setProblem(null);
    try {
      await remove(jobRef.current);
      explicitlyRemoved.current = true;
      onClose();
    } catch { if (!closed.current) setProblem('extract_failed'); }
    finally { if (!closed.current) setOperation(null); }
  };
  const apply = async () => {
    if (!canApply || !job) return;
    setOperation('apply'); setProblem(null);
    try {
      await api(`${root}/${encodeURIComponent(job.id)}/apply`, { method: 'POST', json: job.mask ? { expectedMaskRevision: job.mask.revision } : {} });
      applied.current = true;
      onSaved();
      for (const key of [['series', series.id], ['featured'], ['admin-title-logo-scan'], ['title-extraction-latest', series.id]]) void qc.invalidateQueries({ queryKey: key });
      onClose();
    } catch (error) {
      if (codeOf(error) === 'stale_mask') {
        setMaskConflict(true); setMaskProblem(tr('This preview changed elsewhere. Reload it before editing again.'));
      } else {
        setProblem(codeOf(error) ?? 'extract_failed');
        if (error instanceof ApiError && [404, 409, 410].includes(error.status)) { setStale(true); setSelection({ region: null, exclusions: [] }); onSaved(); }
      }
    } finally { setOperation(null); }
  };
  const saveMask = async (strokes: TitleMaskStroke[]) => {
    if (!job?.mask || busy || maskConflict) return;
    setOperation('mask'); setMaskProblem(null); setMaskSaved(false);
    try {
      const result = await api<{ job: TitleExtractionJob }>(`${root}/${encodeURIComponent(job.id)}/mask`, {
        method: 'PATCH', json: { expectedRevision: job.mask.revision, strokes },
      });
      if (closed.current || jobRef.current?.id !== result.job.id) return;
      setJob(result.job); qc.setQueryData(['title-extraction-job', series.id, result.job.id], result); setMaskSaved(true);
    } catch (error) {
      if (codeOf(error) === 'stale_mask' || error instanceof ApiError && [404, 409, 410].includes(error.status)) {
        setMaskConflict(true); setMaskProblem(tr('This preview changed elsewhere. Reload it before editing again.'));
      } else setMaskProblem(tr('Could not save corrections. Your current artwork is unchanged.'));
    } finally { if (!closed.current) setOperation(null); }
  };
  const reloadMask = async () => {
    if (busy) return;
    setOperation('mask'); setMaskEditing(false); setMaskDraft(null); setMaskSaved(false);
    try {
      const result = await progress.refetch();
      if (result.data?.job && !result.error) { setJob(result.data.job); setMaskProblem(null); setMaskConflict(false); setPreviewAttempt((n) => n + 1); }
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
        <button type="button" className="btn-key shrink-0" data-extract-close aria-label={tr('Close')} disabled={operation === 'apply'} onClick={onClose}>×</button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4" data-extract-scroll data-lenis-prevent>
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-3 text-sm font-semibold text-fog-200">{maskEditing ? tr('Fine-tune title') : tr('Choose the title')}</h3>
            {maskEditing && job?.mask && cover.image ? <CoverTitleMaskEditor key={job.id} jobId={job.id} mask={job.mask} sourceUrl={cover.image.url}
              baselinePath={`${root}/${encodeURIComponent(job.id)}/mask/baseline`} disabled={busy || maskConflict}
              onDraft={maskDraftChanged} onReset={() => saveMask([])} onDone={() => { setMaskEditing(false); setMaskDraft(null); }} />
              : cover.image ? <CoverTitleRegions key={cover.image.url} src={cover.image.url} selection={selection} disabled={busy || active}
              maxExclusions={Math.min(8, capabilities.maxExclusions)} onChange={setSelection} />
              : <p className="text-xs text-fog-400">{cover.failed ? tr('The cover could not be loaded. Close this preview and try again.') : tr('Loading…')}</p>}
          </section>
          <section className="min-w-0" data-extract-result={job?.status ?? 'idle'} data-extract-selection-mode={job?.selectionMode}>
            <h3 className="mb-3 text-sm font-semibold text-fog-200">{tr('Preview the title')}</h3>
            {job?.status === 'ready' && !changed && !stale && capabilities.maskCorrection && !maskEditing && <div className="mb-3">
              {job.mask ? <button type="button" className="btn-key" data-extract-fine-tune disabled={busy} onClick={() => { setMaskEditing(true); setMaskProblem(null); setMaskSaved(false); }}>{tr('Fine-tune title')}</button>
                : <p className="text-xs text-fog-400">{tr('Create a new preview to fine-tune this title.')}</p>}
            </div>}
            {latest.isPending && <p className="text-xs text-fog-400">{tr('Checking for a saved preview…')}</p>}
            {latest.isError && <div className="mb-3 space-y-2"><p role="alert" className="text-xs text-amber-200">{tr('The title preview could not be loaded.')}</p>
              <button type="button" className="btn-key" onClick={() => void latest.refetch()}>{tr('Try again')}</button></div>}
            {(active || operation === 'create') && <div className="mb-4 flex items-center gap-3 text-sm text-fog-300" aria-live="polite">
              <ProgressRing progress="spin" /><span>{job?.status === 'queued' ? tr('Waiting to create your preview…') : tr('Creating your title preview…')}</span>
            </div>}
            {(progress.isError || paused) && <div className="mb-3 space-y-2">
              <p role="alert" className="text-xs text-amber-200">{tr('Progress could not be checked. Your current artwork is still kept.')}</p>
              <button type="button" className="btn-key" data-extract-check-progress onClick={() => { setPaused(false); setPollRound((n) => n + 1); void progress.refetch(); }}>{tr('Check progress again')}</button>
            </div>}
            {errorMessage && <p role="alert" className="mb-3 text-xs leading-relaxed text-amber-200" data-extract-error>{tr(errorMessage)}</p>}
            {job?.automatic && <p className="mb-3 text-xs text-fog-400">{tr('Prepared automatically for your review. Nothing has been applied.')}</p>}
            {changed && <p className="mb-3 text-xs text-amber-200" aria-live="polite" data-extract-selection-changed>{tr('The selected areas changed. Create a new preview before applying.')}</p>}
            {maskDirty && <p className="mb-3 text-xs text-amber-200" data-mask-unsaved>{tr('Save corrections before applying this title.')}</p>}
            {maskProblem && <div className="mb-3 space-y-2"><p role="alert" className="text-xs text-amber-200" data-mask-save-error>{maskProblem}</p>
              {maskConflict && <button type="button" className="btn-key" data-mask-reload onClick={() => void reloadMask()}>{tr('Reload preview')}</button>}</div>}
            {maskSaved && !maskDirty && <p className="mb-3 text-xs text-accent" data-mask-saved>{tr('Corrections saved.')}</p>}
            {displayedPreview ? <>
              <ExtractionHeroPreview series={series} url={displayedPreview} onDecoded={() => { if (!maskDirty && preview.image) setDecodedPreviewPath(preview.image.path); }} />
              <p className="mt-3 text-xs leading-relaxed text-fog-300">{tr('Check that the whole title is present, with clean edges and no author names or volume numbers. A preview can miss letters; only apply it if it looks right.')}</p>
            </> : !active && !changed && !maskEditing && <p className="text-xs leading-relaxed text-fog-400">{tr('Create a preview to see how the title looks on dark and light backgrounds.')}</p>}
            {preview.failed && !maskDirty && <div className="mt-3 space-y-2"><p role="alert" className="text-xs text-amber-200">{tr('The title preview could not be loaded.')}</p>
              <button type="button" className="btn-key" onClick={() => { void progress.refetch(); setPreviewAttempt((n) => n + 1); }}>{tr('Try again')}</button></div>}
          </section>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ink-800 bg-ink-950 p-3">
        <button type="button" className="btn-key" data-extract-discard disabled={busy} onClick={() => void discard()}>{tr('Discard')}</button>
        {active && <button type="button" className="btn-key" data-extract-cancel disabled={busy} onClick={() => void cancel()}>{tr('Cancel preview')}</button>}
        <button type="button" className="btn-key" data-extract-create disabled={!capabilities.available || busy || active || maskDirty || latest.isPending || !cover.image?.fingerprint} onClick={() => void create()}>
          {job ? tr('Create a new preview') : tr('Create preview')}</button>
        {maskDirty ? <button type="button" className="btn-accent px-4 py-2 text-sm disabled:opacity-40" data-mask-save
          disabled={busy || maskConflict || !currentMaskDraft?.valid || currentMaskDraft.drawing || currentMaskDraft.revision !== job?.mask?.revision}
          onClick={() => { if (currentMaskDraft) void saveMask(currentMaskDraft.strokes); }}>{operation === 'mask' ? tr('Saving corrections…') : tr('Save corrections')}</button>
          : <button type="button" className="btn-accent px-4 py-2 text-sm disabled:opacity-40" data-extract-apply disabled={!canApply} onClick={() => void apply()}>
            {operation === 'apply' ? tr('Applying…') : tr('Apply title artwork')}</button>}
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
