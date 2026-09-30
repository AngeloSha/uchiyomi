'use client';
// What a "Find other sources" search is doing, and where its review is.
//
// - FindRunRow: the searching run, or the newest one, as one action row: how far it has got and what it is on, with
//   its Stop; then what it found. The same row heads the review and sits on Health.
// - FindRunCard: Health's card for it, under the checks, while there is a run to show, with the way to its review.
//
// The search itself is the server's (POST /api/admin/sources/find); the review, where an admin chooses what to follow,
// is app/admin/find/page.tsx. The idea, the review and the other-names list are @TIGamingTV's (PR #119).
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { durationText, relativeTime } from '@/lib/format';
import { findRunState, reviewHref, toMs, type FindRun, type FindRunSummary } from '@/lib/findSources';
import { FIND_KEY, useFindStatus } from '@/lib/useFindRun';
import { kickDownloads } from '@/lib/useServerDownloads';
import { ActionList, type ActionSpec } from '@/components/ActionList';

/** "3h ago", or while it searches "Started 5 min ago": when, beside the run's name. */
export function whenLine(run: FindRunSummary): string {
  if (run.status === 'running') {
    const at = toMs(run.startedAt);
    return Number.isFinite(at) ? tr('Started {time} ago', { time: durationText(Date.now() - at) }) : '';
  }
  const at = toMs(run.finishedAt ?? run.startedAt);
  return Number.isFinite(at) ? relativeTime(new Date(at).toISOString()) : '';
}

/**
 * The run as one action row. While it searches the row's key is Stop (at once: the series in flight stays
 * unsearched, and what it found is kept); a finished run has no key -- its words are what it found. `label` is the
 * run's name, or -- where a heading already names it -- its status, which the line under it then does not say again.
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

/** Stop the searching run, at once. */
export async function stopFind(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  try { await api('/api/admin/sources/find/stop', { method: 'POST' }); } catch { /* the next poll says what happened */ }
  void qc.invalidateQueries({ queryKey: FIND_KEY });
  void kickDownloads(qc);
}

/** Health's card: the searching run or the newest one, with its review a press away. Nothing before the first run. */
export function FindRunCard() {
  const qc = useQueryClient();
  const { data } = useFindStatus({ poll: true });
  const [stopping, setStopping] = useState<string | null>(null);
  const run = data?.run;
  if (!run) return null;
  return (
    <section data-find-card={run.id} className="card grad-border full px-4 py-1">
      <FindRunRow run={run} stopping={stopping === run.id} onStop={() => { setStopping(run.id); void stopFind(qc); }} />
      <div className="pb-3">
        <Link href={reviewHref(run.id)} className="btn-key" data-find-review>{run.open > 0 ? tr('Review') : tr('Show results')}</Link>
      </div>
    </section>
  );
}
