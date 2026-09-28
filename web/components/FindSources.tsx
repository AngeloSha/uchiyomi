'use client';
// What a "Find other sources" run did, and where to see it (v0.49.1).
//
// - FindRunRow: the running run, or the newest finished one, as one action row: how far it has got and what it is
//   on, with its Stop; then what it did, and how long it took. The same row heads the results and sits on Health.
// - FindResultsSheet: which series got which sources, which found nothing and why, which were skipped, and which the
//   run never reached -- "not tried" is its own section, never "nothing found", with a key to search those now.
//   Opened from the run's Server tasks card (Library -> Downloads) and from Health.
// - FindRunCard: Health's card for it, under the checks, while there is a run to show.
//
// The run itself is the server's (POST /api/admin/sources/find); GET says how far the running one has got, or what the
// newest one did, and keeps the newest twenty. The idea, the other-names list and the name parsing are @TIGamingTV's
// (PR #119).
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { durationText, relativeTime } from '@/lib/format';
import { runStatusWord } from '@/lib/healthCopy';
import { seriesHref } from '@/lib/healthLinks';
import {
  findRunState, findSlotState, findSummary, findWhyLine, groupResults, notTriedIds, toMs, type FindResult, type FindRun,
  type FindRunSummary, type FindStatus,
} from '@/lib/findSources';
import { FIND_KEY, fetchFind, useFindRun, useFindRuns } from '@/lib/useFindRun';
import { kickDownloads } from '@/lib/useServerDownloads';
import { ActionList, ActionStatus, type ActionSpec } from '@/components/ActionList';
import { OnBody, Sheet } from '@/components/ui';

/** "3h ago", or while it runs "Started 5 min ago": when, beside the run's name. */
function whenLine(run: FindRunSummary): string {
  if (run.status === 'running') {
    const at = toMs(run.startedAt);
    return Number.isFinite(at) ? tr('Started {time} ago', { time: durationText(Date.now() - at) }) : '';
  }
  const at = toMs(run.finishedAt ?? run.startedAt);
  return Number.isFinite(at) ? relativeTime(new Date(at).toISOString()) : '';
}

/**
 * The run as one action row. While it runs the row's key is Stop (at once: the series in flight is not tried unless
 * it already followed a source); a finished run has no key -- its words are what it did. `label` is the run's name,
 * or -- where the sheet's title already is the name -- its status, which the line under it then does not say again.
 */
export function FindRunRow({ run, onStop, stopping, label }: { run: FindRun; onStop?: () => void; stopping?: boolean; label?: string }) {
  const running = run.status === 'running';
  const spec: ActionSpec = {
    id: 'find-run',
    label: label ?? tr('Other-source search'),
    what: whenLine(run),
    state: findRunState(run, { onStop, stopping, status: label === undefined }),
    ...(running && onStop ? { onRun: onStop, buttonProps: { 'data-find-stop': '' } as ActionSpec['buttonProps'] } : {}),
  };
  return <ActionList actions={[spec]} />;
}

/**
 * One series and what became of it. The server leaves the title out for a series this admin may not list -- the 18+
 * hide, a tidy screen they chose -- and the row says so instead: an empty link read as a blank line between two
 * series (the review's s5-01), and a name of the page's own making would be one the series does not have. Not a link
 * either: its only words would be the placeholder.
 */
export function FindResultRow({ r, onOpen }: { r: FindResult; onOpen: () => void }) {
  return (
    <li data-find-result={r.seriesId} className="min-w-0 py-2">
      {r.title
        ? <Link href={seriesHref(r.seriesId)} onClick={onOpen} className="block truncate text-sm text-fog-100 hover:text-accent" dir="auto">{r.title}</Link>
        : <p data-find-hidden className="truncate text-sm text-fog-500">{tr('Hidden by the 18+ filter')}</p>}
      {r.followed.length > 0
        ? r.followed.map((f) => (
          <p key={f.sourceId} className="mt-0.5 flex min-w-0 gap-1.5 text-[11px] text-fog-400">
            <bdi className="truncate text-fog-200">{f.name}</bdi>
            {f.chapters != null && <span className="shrink-0 tabular-nums text-fog-500">{f.chapters === 1 ? tr('1 chapter') : tr('{n} chapters', { n: f.chapters })}</span>}
          </p>
        ))
        : r.why !== 'not_tried' && <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">{findWhyLine(r.why)}</p>}
    </li>
  );
}

function Group({ id, title, rows, note, onOpen }: { id: string; title: string; rows: FindResult[]; note?: string; onOpen: () => void }) {
  if (!rows.length) return null;
  return (
    <section data-find-group={id} aria-labelledby={`find-${id}`} className="mt-4">
      <h3 id={`find-${id}`} className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-fog-500">
        {title}<span className="tabular-nums text-fog-600">{rows.length}</span>
      </h3>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-fog-500">{note}</p>}
      <ul role="list" className="divide-y divide-ink-800/70">
        {rows.map((r) => <FindResultRow key={r.seriesId} r={r} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

/**
 * The newest run's results, in four groups. `poll`: ask again every 2 s while it runs -- off where a follower on the
 * page already does (Health's FindRunProvider), since every observer with an interval polls on its own timer.
 */
export function FindResultsSheet({ onClose, poll = true }: { onClose: () => void; poll?: boolean }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: FIND_KEY,
    queryFn: fetchFind,
    enabled: isAdmin,
    retry: false,
    refetchInterval: poll ? (qq) => (qq.state.data?.running ? 2000 : false) : undefined,
  });
  // A search of what the run never reached, from here: the same route, the same one-run rule.
  const again = useFindRuns({ enabled: false });
  const [stopping, setStopping] = useState<string | null>(null);
  const data: FindStatus | undefined = q.data;
  const run = data?.run ?? null;
  const g = groupResults(run?.results);
  // What the run never reached, once it is over -- stopped, out of time, or cut short by a restart, whose unreached
  // series the server lists as not tried exactly as a stop's.
  const untried = run && run.status !== 'running' ? notTriedIds(run) : [];
  const retry = again.slots.retry;
  const stop = async () => {
    if (!run) return;
    setStopping(run.id);
    try { await api('/api/admin/sources/find/stop', { method: 'POST' }); } catch { setStopping(null); }
    void qc.invalidateQueries({ queryKey: FIND_KEY });
    void kickDownloads(qc);
  };
  const earlier = (data?.recent ?? []).filter((r) => r.id !== run?.id).slice(0, 5);
  return (
    <OnBody>
      <Sheet title={tr('Other-source search')} onClose={onClose} overBottomNav>
        <div data-find-results className="pb-2">
          {q.isLoading && <div className="skeleton h-16 rounded-xl" />}
          {!q.isLoading && q.isError && !data && <p className="text-xs text-rose-300">{tr('Could not load the results')}</p>}
          {!q.isLoading && data && !run && <p className="text-xs text-fog-500">{tr('No search for other sources has run yet.')}</p>}
          {run && (
            <>
              <FindRunRow run={run} label={runStatusWord(run.status)} onStop={isAdmin ? () => { void stop(); } : undefined} stopping={stopping === run.id} />
              {untried.length > 0 && (
                <div className="mt-2">
                  <button type="button" className="btn-key" disabled={retry?.phase === 'starting' || !!data?.running}
                    onClick={() => { void again.start('retry', { seriesIds: untried }).then(() => { void q.refetch(); void kickDownloads(qc); }); }}>
                    {untried.length === 1 ? tr('Search the 1 series not tried') : tr('Search the {n} series not tried', { n: untried.length })}
                  </button>
                  {(retry?.phase === 'refused' || retry?.phase === 'failed') && <ActionStatus state={findSlotState(retry, null)} />}
                </div>
              )}
              <Group id="found" title={tr('New sources')} rows={g.found} onOpen={onClose} />
              <Group id="nothing" title={tr('Nothing found')} rows={g.nothing} onOpen={onClose} />
              <Group id="skipped" title={tr('Skipped')} rows={g.skipped} onOpen={onClose} />
              <Group id="not-tried" title={tr('Not tried')} rows={g.notTried} onOpen={onClose}
                note={tr('The search was stopped, ran out of time or was interrupted by a restart before it got to these.')} />
            </>
          )}
          {earlier.length > 0 && (
            <section data-find-group="earlier" className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Earlier searches')}</h3>
              <ul role="list" className="mt-1 space-y-1.5">
                {/* The status word leads each line, so the summary after it leaves its own out: "Stopped before it
                    finished · 6m ago · Stopped before it finished · 3 of 7 series" said it twice. */}
                {earlier.map((r) => (
                  <li key={r.id} className="text-[11px] leading-relaxed text-fog-400">
                    <span className="text-fog-300">{runStatusWord(r.status)}</span>
                    {whenLine(r) && <span className="text-fog-500"> · {whenLine(r)}</span>}
                    <span className="text-fog-500"> · {findSummary(r, { status: false })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Sheet>
    </OnBody>
  );
}

/** Health's card: the running run or the newest one, with its results a press away. Nothing before the first run. */
export function FindRunCard() {
  const fr = useFindRun();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const run = fr?.status?.run;
  if (!fr || !run) return null;
  return (
    <section data-find-card={run.id} className="card grad-border full px-4 py-1">
      <FindRunRow run={run} stopping={stopping === run.id} onStop={() => { setStopping(run.id); void fr.stop(); }} />
      <div className="pb-3">
        <button type="button" onClick={() => setOpen(true)} className="btn-key" data-find-results-open>{tr('Show results')}</button>
      </div>
      {open && <FindResultsSheet poll={false} onClose={() => setOpen(false)} />}
    </section>
  );
}
