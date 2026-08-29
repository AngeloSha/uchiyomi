'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { ProgressBar } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

interface Job { folder: string; title: string; total: number; done: number; status: string; reason?: string }

/**
 * What is downloading, wherever you are.
 *
 * Adding a series used to give no sign it had worked: the request held the button for up to a minute while
 * the first chapter downloaded, and the only progress anywhere was a strip on Discover, below the hero and
 * behind the dialog's own backdrop. Navigating away lost sight of it entirely. So the question this answers
 * is the one that was actually being asked -- "did that start, or not?"
 *
 * Fixed rather than placed in either nav on purpose: the top nav is desktop-only, the bottom nav is tight
 * for width on a phone, and a fixed element adds nothing to the document's scroll width, which the layout
 * checks measure at 390px with a one-pixel tolerance.
 */
export function DownloadsIndicator() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const mayAdd = canDownload(user);

  const { data } = useQuery({
    // The same key and endpoint Discover uses. Sharing is required, not incidental: one query key must map
    // to exactly one endpoint, and this is the same data.
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: mayAdd,
    refetchInterval: (qy) => ((qy.state.data?.content ?? []).some((j) => j.status === 'downloading') ? 2500 : 30_000),
  });

  const jobs = data?.content ?? [];
  const active = jobs.filter((j) => j.status === 'downloading');
  const failed = jobs.filter((j) => j.status === 'error');
  // Nothing to say when nothing is happening. A finished download ages out on the server, so this does not
  // linger after the fact; a failed one stays until dismissed, because it is the only record of the failure.
  if (!mayAdd || (!active.length && !failed.length)) return null;

  const dismiss = async (folder: string) => {
    try { await api(`/api/sources/jobs/${encodeURIComponent(folder)}`, { method: 'DELETE' }); } catch { /* already gone */ }
    qc.invalidateQueries({ queryKey: ['source-jobs'] });
  };

  const label = active.length
    ? tr('{n} downloading', { n: active.length })
    : tr('{n} failed', { n: failed.length });

  return (
    <div className="safe-bottom fixed bottom-20 end-3 z-40 lg:bottom-5 lg:end-5">
      {open && (
        <div className="card mb-2 max-h-[50vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-3 shadow-lift">
          {[...active, ...failed].map((j) => (
            <div key={j.folder} className="border-b border-ink-700/60 py-2 last:border-0">
              <p className="truncate text-xs font-medium text-fog-100">{j.title}</p>
              {j.status === 'downloading' ? (
                <>
                  <div className="mt-1.5"><ProgressBar value={j.total ? j.done / j.total : 0.02} /></div>
                  <p className="mt-1 text-[11px] tabular-nums text-fog-500">{j.done}/{j.total}</p>
                </>
              ) : (
                <div className="mt-1 flex items-start gap-2">
                  {/* The reason has always been recorded and never shown; the strip said only "Download
                      stopped." for every cause there is. */}
                  <p className="flex-1 text-[11px] leading-relaxed text-amber-300">{j.reason || tr('Download stopped. Try another source or wait.')}</p>
                  <button onClick={() => dismiss(j.folder)} className="shrink-0 text-[11px] text-fog-500 hover:text-fog-200">
                    {tr('Dismiss')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`chip shadow-lift text-xs ${failed.length && !active.length ? 'border-amber-500/50 text-amber-300' : ''}`}
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${active.length ? 'animate-pulse-soft bg-accent' : 'bg-amber-400'}`} />
        {label}
      </button>
    </div>
  );
}
