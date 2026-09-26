'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { ProgressBar } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { t as tr } from '@/lib/i18n';
import { chaptersLeft } from '@/lib/chapterRows';
import { jobNoteLines, type JobCardNotes } from '@/lib/jobNotes';
import { finished, mayCancel, pillLabel, runProgress, runTitle, type RunCard } from '@/lib/jobs';
import { beyondJobs, chapterSpan, groupRecent, originLabel, type Activity } from '@/lib/serverDownloads';
import Link from 'next/link';

// lib/jobs.ts JobCard's fields, spelled out beside the notes so this stays the one Job type the notes pin reads.
interface Job extends JobCardNotes {
  folder: string; title: string; total: number; done: number; status: string; reason?: string;
  startedAt?: number; finishedAt?: number; mine?: boolean; cancelRequested?: boolean; cancelled?: boolean;
}

/**
 * What is downloading, wherever you are.
 *
 * Adding a series used to give no sign it had worked: the request held the button for up to a minute while
 * the first chapter downloaded, and the only progress anywhere was a strip on Discover, below the hero and
 * behind the dialog's own backdrop. Navigating away lost sight of it entirely. So the question this answers
 * is the one that was actually being asked -- "did that start, or not?"
 *
 * Since #82 (v0.47.0) it also shows what the server downloads by itself -- the chapter sweep, the library
 * repair, a bulk "Fetch newest" -- as one card per run, to an admin (and a bulk run to whoever started it);
 * every running download has a Cancel, which stops it after the chapter in flight; and what finished in the
 * last day is listed under the rest, so "what did it fetch this morning" has an answer.
 *
 * Fixed rather than placed in either nav on purpose: the top nav is desktop-only, the bottom nav is tight
 * for width on a phone, and a fixed element adds nothing to the document's scroll width, which the layout
 * checks measure at 390px with a one-pixel tolerance.
 */
export function DownloadsIndicator() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const mayAdd = canDownload(user);
  const admin = user?.role === 'admin';

  const { data } = useQuery({
    // The same key and endpoint Discover uses. Sharing is required, not incidental: one query key must map
    // to exactly one endpoint, and this is the same data.
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[]; runs?: RunCard[]; activity?: Activity }>('/api/sources/jobs'),
    enabled: mayAdd,
    // Hard while a download of a person's is moving; gentler while only the server's own run is, which can go
    // on for an hour a series and a half apart.
    refetchInterval: (qy) => {
      const d = qy.state.data;
      if ((d?.content ?? []).some((j) => j.status === 'downloading') || (d?.activity?.active.length ?? 0) > 0) return 2500;
      if ((d?.runs ?? []).some((r) => r.status === 'running')) return 5000;
      return 30_000;
    },
  });

  const jobs = data?.content ?? [];
  const runs = data?.runs ?? [];
  const active = jobs.filter((j) => j.status === 'downloading');
  const failed = jobs.filter((j) => j.status === 'error');
  const done = finished(jobs);
  const running = runs.filter((r) => r.status === 'running');
  // Every chapter the server is fetching that no job card above already shows: a followed source's check, the
  // scheduled check, Check now, the repair (lib/serverDownloads.ts). Before this the pill knew only the jobs a
  // button started, so all of that came in unseen.
  const serverActive = beyondJobs(data?.activity?.active ?? [], new Set(active.map((j) => j.folder)));
  const cameIn = groupRecent(data?.activity?.recent ?? []);
  // Names for the "took chapter 12 from …" lines. Asked for only once a card has a switch to name, and the
  // pill already exists only for a viewer who may download, which is who the route answers.
  const { data: sources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: mayAdd && jobs.some((j) => !!j.switched?.length),
  });
  const nameOf = (id: string) => sources?.content.find((x) => x.id === id)?.name ?? id;
  // "Fetching", not "downloading": these are server jobs (☁), and "download" is the word the Offline tab
  // uses for copies on this device. Counted in chapters STILL TO COME across the running jobs (`chaptersLeft`,
  // where a test can reach it), falling back to the job count while a job has not sized itself yet. ⚠️ It
  // used to sum each job's `total`: a 300-chapter job at 290/300 read "Fetching 300 chapters" over its own
  // `290/300` line. Nothing to say when nothing is happening: a finished download is listed under the rest
  // while the pill is up for something else, and does not raise the pill by itself.
  const label = pillLabel(active.length, chaptersLeft(active), runs, failed.length, serverActive.length);
  if (!mayAdd || !label) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['source-jobs'] });
  const call = async (path: string, method: 'POST' | 'DELETE') => {
    try { await api(path, { method }); } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    void refresh();
  };
  const dismiss = (folder: string) => call(`/api/sources/jobs/${encodeURIComponent(folder)}`, 'DELETE');
  const cancelJob = (folder: string) => call(`/api/sources/jobs/${encodeURIComponent(folder)}/cancel`, 'POST');
  const cancelRun = (kind: string) => call(`/api/sources/runs/${kind}/cancel`, 'POST');
  const dismissRun = (kind: string) => call(`/api/sources/runs/${kind}`, 'DELETE');
  // "After this chapter": a Cancel never cuts a file in half, and a button that says only "Cancelling…"
  // for the minute a chapter can take reads as a button that did nothing.
  const stopping = <p className="mt-1 text-[11px] text-fog-400">{tr('Stopping after this chapter…')}</p>;

  return (
    <div className="safe-bottom fixed bottom-20 end-3 z-40 lg:bottom-5 lg:end-5">
      {open && (
        <div data-lenis-prevent className="card mb-2 max-h-[50vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-3 shadow-lift">
          {runs.map((r) => (
            <div key={r.kind} className="border-b border-ink-700/60 py-2 last:border-0">
              <div className="flex items-start gap-2">
                <p className="flex-1 truncate text-xs font-medium text-fog-100">{runTitle(r.kind)}</p>
                {r.status === 'running' && !r.cancelRequested && (admin || r.mine) && (
                  <button onClick={() => cancelRun(r.kind)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">{tr('Cancel')}</button>
                )}
                {r.status !== 'running' && (
                  <button onClick={() => dismissRun(r.kind)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">{tr('Dismiss')}</button>
                )}
              </div>
              {r.status === 'running' && r.total > 0 && (
                <div className="mt-1.5"><ProgressBar value={Math.max(0.02, r.done / r.total)} /></div>
              )}
              {runProgress(r) && <p className="mt-1 text-[11px] tabular-nums text-fog-500">{runProgress(r)}</p>}
              {r.status === 'running' && r.current?.title && (
                <p className="mt-1 truncate text-[11px] text-fog-400">{tr('Now: {title}', { title: r.current.title })}</p>
              )}
              {r.status === 'running' && r.cancelRequested && stopping}
              {r.status === 'cancelled' && <p className="mt-1 text-[11px] text-fog-400">{tr('Cancelled; what landed is kept.')}</p>}
              {r.status === 'error' && <p className="mt-1 text-[11px] text-amber-300">{r.reason || tr('Stopped.')}</p>}
              {r.status === 'done' && r.reason && <p className="mt-1 text-[11px] text-fog-400">{r.reason}</p>}
            </div>
          ))}
          {[...active, ...failed].map((j) => (
            <div key={j.folder} className="border-b border-ink-700/60 py-2 last:border-0">
              <div className="flex items-start gap-2">
                <p className="flex-1 truncate text-xs font-medium text-fog-100">{j.title}</p>
                {mayCancel(j, admin) && (
                  <button onClick={() => cancelJob(j.folder)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">{tr('Cancel')}</button>
                )}
              </div>
              {j.status === 'downloading' ? (
                <>
                  <div className="mt-1.5"><ProgressBar value={j.total ? j.done / j.total : 0.02} /></div>
                  <p className="mt-1 text-[11px] tabular-nums text-fog-500">{j.done}/{j.total}</p>
                  {j.cancelRequested && stopping}
                </>
              ) : (
                <div className="mt-1 flex items-start gap-2">
                  {/* The reason has always been recorded and never shown; the strip said only "Download
                      stopped." for every cause there is. */}
                  <p className="flex-1 text-[11px] leading-relaxed text-amber-300">{j.reason || tr('Fetch stopped. Try another source or wait.')}</p>
                  <button onClick={() => dismiss(j.folder)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">
                    {tr('Dismiss')}
                  </button>
                </div>
              )}
              {/* What the job did that the counter cannot show: a chapter taken from another source, a
                  chapter saved short. Under a running job as it happens, under a failed one as its record. */}
              {jobNoteLines(j, nameOf).map((line, i) => (
                <p key={i} className="mt-1 text-[11px] leading-relaxed text-fog-400">{line}</p>
              ))}
            </div>
          ))}
          {serverActive.length > 0 && (
            <div className="border-b border-ink-700/60 py-2 last:border-0">
              <p className="text-xs font-medium text-fog-100">{tr('Downloading now')}</p>
              {serverActive.slice(0, 8).map((e) => (
                <div key={e.id} className="mt-1.5">
                  <p className="truncate text-[11px] text-fog-300">{e.title} · {tr('Ch. {n}', { n: e.number })}</p>
                  <p className="truncate text-[11px] text-fog-500">
                    {originLabel(e.origin)} · {e.source}{e.status === 'queued' ? ` · ${tr('waiting for the source')}` : ''}
                  </p>
                </div>
              ))}
              {serverActive.length > 8 && <p className="mt-1.5 text-[11px] text-fog-500">{tr('and {n} more', { n: serverActive.length - 8 })}</p>}
            </div>
          )}
          {/* What came in today, whatever started it: the scheduled check's overnight chapters included. The
              jobs' own Finished list is kept for a cancelled job's reason and its Dismiss. */}
          {(cameIn.length > 0 || done.length > 0) && (
            <div className="pt-2">
              <button type="button" onClick={() => setShowFinished((v) => !v)} aria-expanded={showFinished}
                className="text-[11px] text-fog-500 hover:text-fog-200">
                {tr('Came in today ({n})', { n: cameIn.reduce((a, g) => a + g.numbers.length, 0) })}
              </button>
              {showFinished && cameIn.slice(0, 12).map((g) => (
                <div key={g.key} className="mt-1.5">
                  <p className="truncate text-[11px] text-fog-300">{g.title}{g.numbers.length ? ` · ${chapterSpan(g.numbers)}` : ''}</p>
                  <p className="truncate text-[11px] text-fog-500">{g.origins.map(originLabel).join(', ')}</p>
                  {g.failed.length > 0 && <p className="text-[11px] text-amber-300">{tr('{n} could not be saved', { n: g.failed.length })}</p>}
                </div>
              ))}
              {showFinished && done.filter((j) => j.cancelled).map((j) => (
                <div key={j.folder} className="mt-1.5 flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-fog-300">{j.title}</p>
                    <p className="text-[11px] text-fog-500">{j.reason}</p>
                  </div>
                  <button onClick={() => dismiss(j.folder)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">{tr('Dismiss')}</button>
                </div>
              ))}
            </div>
          )}
          {/* The whole list, with what failed and why, on the Offline tab (its download icon is where people look). */}
          <Link href="/downloads/" onClick={() => setOpen(false)} className="mt-2 block text-[11px] font-medium text-accent hover:underline">
            {tr('All downloads')}
          </Link>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`chip shadow-lift text-xs ${failed.length && !active.length && !running.length && !serverActive.length ? 'border-amber-500/50 text-amber-300' : ''}`}
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${active.length || running.length || serverActive.length ? 'animate-pulse-soft bg-accent' : 'bg-amber-400'}`} />
        {label}
      </button>
    </div>
  );
}
