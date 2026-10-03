'use client';
// Replace a source (v0.54.0): every series whose main source it is, moved to a working source in ONE run.
//
// The owner: "i have to go one by one test and find replacement sources". aqua went offline on 23 Sep as the main
// source of 195 series, 184 of which already followed a working source -- and nothing could make that source their
// main one, so every count, filter and sweep queue kept grouping them under a dead site. Replace is one press:
// - first the dialog says what will happen, in numbers the server works out before anything moves (GET
//   …/replace-preview): the series that switch at once to a source they already follow, the ones searched for, and
//   that the source is turned off once nothing uses it;
// - Start runs it (POST /api/admin/sources/find {mode: 'replace'}), the same one-at-a-time run as Find other sources,
//   and the dialog becomes the run: how far it has got, three counts, and each series as it lands, "{from} → {to}" or
//   why not. Stop stops it; Run in background closes the dialog and the run goes on, on Server tasks and on Health.
// - "Let me review each match first" moves nothing: each series' suggested source waits in the results for Make main.
//
// Admin → Sources' Needs attention row and source sheet open it, and so do Health's source and frozen-series rows
// (HealthActions.tsx), each with the find runs it already follows (lib/useFindRun.tsx): one run at a time, server-wide.
// A Sheet, not a Modal: it comes up from the bottom on a phone, and it never opens over another sheet (the source
// sheet closes first) -- a Modal under a Sheet cannot be tapped.
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { numberText } from '@/lib/format';
import { useReduceEffects } from '@/lib/effects';
import { waitingText } from '@/lib/archive';
import {
  busyLine, findSlotState, findSummary, findWhyLine, replaceCounts, replaceRunOf, type FindResult, type FindRun,
} from '@/lib/findSources';
import type { FindRunApi } from '@/lib/useFindRun';
import { OVERVIEW_KEY, OVERVIEW_URL, replacePlanLines, replaceSubtitle, type ReplacePreview, type SourcesOverview } from '@/lib/sourcesPanel';
import { ActionStatus } from '@/components/ActionList';
import { Sheet } from '@/components/ui';

/** How many of the newest series the run view lists: the results sheet holds every one. */
const RECENT_ROWS = 40;

export function ReplaceDialog({ sourceId, name, fr, slot, onClose, onResults }: {
  sourceId: string;
  /** The source's name, when the caller has it; else it is looked up in the sources overview. */
  name?: string;
  /** The find runs this page follows: Health's provider, or Admin → Sources' own. */
  fr: FindRunApi | null;
  /** The key a run started here is followed under, so the row that opened it says what it is doing too. */
  slot: string;
  onClose: () => void;
  /** Opens the run's results in full; the dialog closes first (one sheet at a time). */
  onResults?: () => void;
}) {
  const { data: overview } = useQuery({
    queryKey: OVERVIEW_KEY, queryFn: () => api<SourcesOverview>(OVERVIEW_URL), enabled: !name, staleTime: 30_000,
  });
  const shown = name ?? overview?.sources.find((s) => s.id === sourceId)?.name ?? sourceId;
  // "Replace again" after a run has ended sets that run aside, and the dialog asks afresh.
  const [asideRun, setAsideRun] = useState<string | null>(null);
  const slotted = fr?.slots[slot];
  const pressed = slotted && (!slotted.runId || slotted.runId !== asideRun) ? slotted : undefined;
  // The run this dialog started; or, opened again while one replaces this very source, that one -- to its end
  // (lib/findSources.ts replaceRunOf).
  const mine = fr?.runOf(slot) ?? null;
  const [watched, setWatched] = useState<string | null>(null);
  const live: FindRun | null = replaceRunOf({ sourceId, status: fr?.status, mine, watched, aside: asideRun });
  // A run seen going here stays this dialog's once it ends: React's render-time update, settled before anything paints.
  if (live?.status === 'running' && live.id !== watched) setWatched(live.id);
  // A start the server refused (another run, nothing to replace) is said where Start is, which stays to try again.
  const refusal = !live && pressed && (pressed.phase === 'refused' || pressed.phase === 'failed') ? pressed.reason ?? null : null;
  const phase = live || (pressed && !refusal) ? 'run' : 'ask';
  return phase === 'ask'
    ? <AskView sourceId={sourceId} name={shown} fr={fr} slot={slot} refusal={refusal} onClose={onClose} />
    : <RunView sourceId={sourceId} name={shown} fr={fr} slot={slot} live={live} onClose={onClose} onResults={onResults}
      onAgain={live && live.status !== 'running' ? () => setAsideRun(live.id) : undefined} />;
}

/** Before Start: what will happen, in the server's numbers, and the two choices. */
function AskView({ sourceId, name, fr, slot, refusal, onClose }: {
  sourceId: string; name: string; fr: FindRunApi | null; slot: string; refusal: string | null; onClose: () => void;
}) {
  const { data: p, isError, isLoading } = useQuery({
    queryKey: ['replace-preview', sourceId],
    queryFn: () => api<ReplacePreview>(`/api/admin/sources/${encodeURIComponent(sourceId)}/replace-preview`),
    staleTime: 0,
    retry: false,
  });
  // On by default: replacing a source is retiring it. Off while reviewing -- nothing moves then, so nothing is left to
  // turn it off after, and the server refuses the two together.
  const [turnOff, setTurnOff] = useState(true);
  const [review, setReview] = useState(false);
  const ids = useId();
  // Another run of either kind holds the server: Start waits, and says why.
  const busy = !!p?.busy || !!fr?.status?.running;
  const lines = p ? replacePlanLines(p, name, turnOff && !review) : [];
  const start = () => {
    if (!fr || !p) return;
    void fr.start(slot, { sourceId, mode: 'replace', ...(review ? { review: true } : { turnOff }) });
  };
  return (
    <Sheet title={tr('Replace {name}', { name })} onClose={onClose} overBottomNav wrapTitle
      subtitle={p ? <span data-replace-main={p.main}>{replaceSubtitle(p.main)}</span> : undefined}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
          {(busy || refusal) && (
            <p role="status" className="me-auto min-w-0 flex-1 basis-48 text-[11px] leading-snug text-amber-300/90" data-replace-busy>{busy ? busyLine() : refusal}</p>
          )}
          <button type="button" onClick={onClose} className="btn-key" data-replace-cancel>{tr('Cancel')}</button>
          <button type="button" onClick={start} disabled={!p || p.main === 0 || busy || !fr} className="btn-key btn-key-primary" data-replace-start>
            {tr('Start')}
          </button>
        </div>
      }>
      <div className="pb-3" data-replace-dialog={sourceId} data-replace-phase="ask">
        {isLoading && <div className="skeleton h-24 rounded-xl" aria-busy="true" />}
        {isError && <p role="alert" className="py-2 text-sm text-amber-300">{tr('Could not work out what Replace would do. Try again in a moment.')}</p>}
        {p && p.main === 0 && <p className="py-2 text-sm text-fog-300" data-replace-nothing>{tr('No series uses it as its main source any more.')}</p>}
        {p && p.main > 0 && (
          <ol className="space-y-2.5" data-replace-plan>
            {lines.map((l, i) => (
              <li key={l.kind} data-replace-line={l.kind} data-n={l.n ?? undefined} className="flex items-start gap-3 text-[13px] leading-snug text-fog-200">
                {/* A circle, equal sides and no padding: a number, never a capsule. */}
                <span aria-hidden className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold tabular-nums text-accent">
                  {numberText(i + 1)}
                </span>
                <span className="min-w-0">{l.text}</span>
              </li>
            ))}
          </ol>
        )}
        {p && p.main > 0 && (
          <fieldset className="mt-4 space-y-2 border-t border-ink-800/70 pt-3">
            <legend className="sr-only">{tr('Replace {name}', { name })}</legend>
            <label htmlFor={`${ids}-off`} className={`flex items-start gap-2.5 text-[13px] ${review ? 'text-fog-500' : 'text-fog-200'}`}>
              <input id={`${ids}-off`} type="checkbox" checked={turnOff && !review} disabled={review} onChange={(e) => setTurnOff(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" data-replace-turnoff />
              <span>{tr('Turn it off when done')}</span>
            </label>
            <label htmlFor={`${ids}-review`} className="flex items-start gap-2.5 text-[13px] text-fog-200">
              <input id={`${ids}-review`} type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" data-replace-review />
              <span className="min-w-0">
                {tr('Let me review each match first')}
                {review && <span className="mt-0.5 block text-[11px] leading-relaxed text-fog-500">{tr('Nothing moves until you choose: each series’ match waits in the results, with Make main.')}</span>}
              </span>
            </label>
          </fieldset>
        )}
      </div>
    </Sheet>
  );
}

/** After Start: the run, live -- how far, three counts, each series as it lands -- then what it did. */
function RunView({ sourceId, name, fr, slot, live, onClose, onResults, onAgain }: {
  sourceId: string; name: string; fr: FindRunApi | null; slot: string; live: FindRun | null; onClose: () => void; onResults?: () => void;
  /** After the run has ended: ask afresh, for what is still on the source. */
  onAgain?: () => void;
}) {
  const plain = useReduceEffects();
  const pressed = fr?.slots[slot];
  const run = live;
  const runningNow = run?.status === 'running';
  const stop = () => { void fr?.stop(pressed ? slot : undefined); };
  // Starting, refused or failed before the run had an id: the slot's own state says which.
  const before = !run ? findSlotState(pressed, null) : null;
  const counts = replaceCounts(run);
  const total = run?.total ?? 0;
  const done = Math.min(run?.done ?? 0, total);
  const progress = total > 0 ? done / total : 0;
  const recent = [...(run?.results ?? [])].reverse().slice(0, RECENT_ROWS);
  const [nowBefore, nowAfter] = tr('Now: {title}').split('{title}');
  const wait = runningNow && run?.waiting ? waitingText({ why: run.waiting }, null) : '';
  const ended = !!run && !runningNow;
  const outcome = ended ? findSummary(run!) : '';
  const partial = ended && (run!.status !== 'done' || !!run!.left || counts.none > 0);
  return (
    <Sheet title={tr('Replace {name}', { name })} onClose={onClose} overBottomNav wrapTitle
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
          {runningNow ? (
            <>
              <button type="button" onClick={stop} disabled={!!pressed?.stopping} className="btn-key btn-key-danger" data-replace-stop>
                {pressed?.stopping ? tr('Stopping…') : tr('Stop')}
              </button>
              <button type="button" onClick={onClose} className="btn-key" data-replace-background>{tr('Run in background')}</button>
            </>
          ) : (
            <>
              {ended && onResults && <button type="button" onClick={onResults} className="btn-key" data-replace-results>{tr('Show results')}</button>}
              {/* Only while series are still on the source: a run that moved them all has nothing to do again. */}
              {ended && onAgain && !!run?.left && <button type="button" onClick={onAgain} className="btn-key" data-replace-again>{tr('Replace again')}</button>}
              <button type="button" onClick={onClose} className="btn-key" data-replace-close>{tr('Close')}</button>
            </>
          )}
        </div>
      }>
      <div className="pb-3" data-replace-dialog={sourceId} data-replace-phase="run" data-replace-run={run?.status ?? pressed?.phase ?? ''}>
        {before && before.kind !== 'idle' && <ActionStatus state={before} />}
        {run && (
          <>
            {/* The bar fills from the start edge, so from the right in Arabic (--start, app/globals.css). */}
            <div className="mt-1 h-1.5 overflow-hidden rounded-[3px] bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={total || 1}
              aria-valuenow={done} aria-label={tr('{done} of {total} series', { done, total })}>
              <div className={`h-full origin-[var(--start)] bg-accent ${plain ? '' : 'transition-transform duration-500 ease-out'}`}
                style={{ transform: `scaleX(${ended && run.status === 'done' ? 1 : progress})` }} />
            </div>
            <p className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] tabular-nums text-fog-400" data-replace-progress>
              <span>{tr('{done} of {total} series', { done, total })}</span>
              {wait ? <span>· {wait}</span> : runningNow && run.current?.title && (
                <span className="flex min-w-0 max-w-full">
                  <span className="shrink-0 whitespace-pre">· {nowBefore}</span>
                  <bdi dir="auto" className="block min-w-0 truncate text-fog-200">{run.current.title}</bdi>
                  {nowAfter && <span className="shrink-0 whitespace-pre">{nowAfter}</span>}
                </span>
              )}
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-3" data-replace-counts>
              <Count id="moved" n={counts.moved} label={tr('Moved')} tone="text-emerald-300" />
              <Count id="found" n={counts.found} label={tr('New source found')} tone="text-fog-50" />
              <Count id="none" n={counts.none} label={tr('No replacement')} tone={counts.none ? 'text-amber-300' : 'text-fog-50'} />
            </dl>
            {counts.review > 0 && (
              <p className="mt-2 text-[12px] text-fog-300" data-replace-review-waiting>
                {counts.review === 1 ? tr('1 series to review') : tr('{n} series to review', { n: counts.review })}
              </p>
            )}
            {ended && (
              <p className={`mt-3 text-[12px] leading-snug ${partial ? 'text-amber-300' : 'text-accent'}`} data-replace-outcome>{outcome}</p>
            )}
            {recent.length > 0 && (
              <ul className="mt-3 max-h-72 divide-y divide-ink-800/70 overflow-y-auto rounded-xl border border-ink-700/60 bg-ink-900/40" data-lenis-prevent data-replace-rows>
                {recent.map((r) => <RunRow key={r.seriesId} r={r} />)}
              </ul>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** One of the three big numbers: the term first for a screen reader, the number drawn above it. */
function Count({ id, n, label, tone }: { id: string; n: number; label: string; tone: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse" data-replace-count={id}>
      <dt className="mt-0.5 text-[11px] leading-tight text-fog-500">{label}</dt>
      <dd className={`font-display text-2xl font-semibold tabular-nums ${tone}`}>{numberText(n)}</dd>
    </div>
  );
}

/** One series as it landed: its new main source, "from → to", or why it has none. */
function RunRow({ r }: { r: FindResult }) {
  const state = r.promoted ? r.promoted.via : r.proposals?.some((p) => !p.state) ? 'review' : r.why ?? 'none';
  return (
    <li className="min-w-0 px-3 py-2" data-replace-row={r.seriesId} data-replace-row-state={state}>
      <p className="flex min-w-0 items-center gap-2">
        {r.title
          ? <bdi dir="auto" className="min-w-0 truncate text-[13px] text-fog-100">{r.title}</bdi>
          : <span className="min-w-0 truncate text-[13px] text-fog-500">{tr('Hidden by the 18+ filter')}</span>}
        {r.promoted && (
          <span className="shrink-0 rounded-[4px] bg-ink-800 px-1.5 text-[10px] font-semibold leading-4 text-fog-400">
            {r.promoted.via === 'search' ? tr('New source found') : tr('Moved')}
          </span>
        )}
      </p>
      {r.promoted ? (
        <p className="mt-0.5 text-[11px] text-fog-400">
          {/* Read out as a sentence; drawn as "from → to", the arrow pointing the reading way (the other way in Arabic). */}
          <span className="sr-only">{tr('From {from} to {to}', { from: `\u2068${r.promoted.fromName}\u2069`, to: `\u2068${r.promoted.toName}\u2069` })}</span>
          <span aria-hidden className="flex min-w-0 items-center gap-1.5">
            <bdi className="min-w-0 truncate">{r.promoted.fromName}</bdi>
            <span className="inline-block shrink-0 rtl:-scale-x-100">→</span>
            <bdi className="min-w-0 truncate text-fog-200">{r.promoted.toName}</bdi>
          </span>
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">{state === 'review' ? tr('To review') : findWhyLine(r.why)}</p>
      )}
    </li>
  );
}
