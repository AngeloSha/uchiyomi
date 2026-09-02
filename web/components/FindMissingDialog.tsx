'use client';
/**
 * Finding, and confirming, the chapters a series is missing.
 *
 * The button is the entry point; this dialog is the feature. A chapter fetched from the wrong series lands as
 * `Chapter 47.cbz` exactly where the right one belongs, looks identical in every listing, and is only found
 * by opening it. Nothing here downloads anything until a person has been shown which source, which title on
 * that source, and how many chapters, and has pressed a button that repeats all three back to them.
 *
 * Sources that were checked and rejected are shown too, with the reason and the measured overlap, because
 * "MangaDex has this but numbers it differently" is worth knowing and a silently shortened list is not.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { t as tr } from '@/lib/i18n';

interface Candidate {
  source: string; name: string; sourceSeriesId: string; title: string; coverUrl?: string;
  count: number; first: number | null; last: number | null;
  coverage: number; matched: number;
  fillable: number[]; newer: number[];
  why: string; pinned: boolean;
}
interface Scan {
  seriesId: string; title: string; folder: string;
  have: { count: number; first?: number; last?: number };
  gaps: { lo: number; hi: number; count: number }[];
  candidates: Candidate[];
  planId: string;
  refusal: { code: string; message: string } | null;
}
interface Job { folder: string; title: string; total: number; done: number; status: string; reason?: string }

/** Why a source was not offered, in words rather than a code. */
function whyText(c: Candidate): string {
  switch (c.why) {
    case 'numbering_mismatch':
      return tr('Numbers its chapters differently') +
        ` (${Math.round(c.coverage * 100)}%` + tr(' of yours match') + ')';
    case 'nothing_to_fill': return tr('Has nothing you are missing');
    case 'no_chapters': return tr('Listed no chapters');
    case 'blocked': return tr('Temporarily unavailable');
    case 'disabled': return tr('Switched off');
    default: return tr('Not usable');
  }
}

export function FindMissingDialog({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [altTitle, setAltTitle] = useState('');
  const [term, setTerm] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = useQuery({
    queryKey: ['fill-scan', seriesId, term],
    queryFn: () => api<Scan>('/api/sources/fill/scan', { method: 'POST', json: { seriesId, altTitle: term || undefined } }),
    staleTime: 60_000,
    retry: false,
  });

  // The same key the downloads pill uses, so both surfaces agree and neither polls on its own schedule.
  const jobs = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!started,
    refetchInterval: 2000,
  });
  const job = jobs.data?.content?.find((j) => j.folder === started);

  const run = async (c: Candidate) => {
    if (!scan.data) return;
    setBusy(true);
    try {
      const numbers = c.fillable;
      const res = await api<{ folder: string }>('/api/sources/fill', {
        method: 'POST',
        json: { planId: scan.data.planId, source: c.source, sourceSeriesId: c.sourceSeriesId, numbers },
      });
      setStarted(res.folder);
      qc.invalidateQueries({ queryKey: ['source-jobs'] });
      toast(tr('Fetching {n} chapters…').replace('{n}', String(numbers.length)), 'info');
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (started) {
    return (
      <Modal title={tr('Filling in the gaps')} onClose={onClose}>
        <p className="text-sm text-fog-400">
          {job?.reason
            ? job.reason
            : tr('This runs in the background. You can close this and it will keep going.')}
        </p>
        <div className="mt-4">
          <ProgressBar value={job && job.total ? job.done / job.total : 0.02} />
          <p className="mt-2 text-xs text-fog-500">
            {job ? `${job.done} / ${job.total}` : tr('Starting…')}
          </p>
        </div>
        <button onClick={onClose} className="btn-ghost mt-5 w-full text-sm">{tr('Close')}</button>
      </Modal>
    );
  }

  const d = scan.data;
  const usable = (d?.candidates || []).filter((c) => c.why === 'ok');
  const rejected = (d?.candidates || []).filter((c) => c.why !== 'ok');

  return (
    <Modal title={tr('Find missing chapters')} onClose={onClose}>
      {scan.isLoading && <p className="text-sm text-fog-400">{tr('Asking your sources…')}</p>}
      {scan.error && <p className="text-sm text-rose-300">{msgOf(scan.error, tr('The scan failed.'))}</p>}

      {d && (
        <>
          <p className="text-sm text-fog-300">
            {tr('You have {n} chapters').replace('{n}', String(d.have.count))}
            {d.have.first != null && `, ${d.have.first}–${d.have.last}`}
            {d.gaps.length
              ? `. ${tr('Missing')}: ${d.gaps.map((g) => (g.lo === g.hi ? g.lo : `${g.lo}–${g.hi}`)).join(', ')}`
              : `. ${tr('No gaps between them.')}`}
          </p>

          {d.refusal && <p className="mt-3 text-sm text-amber-300">{d.refusal.message}</p>}

          {usable.map((c) => (
            <div key={`${c.source}:${c.sourceSeriesId}`} className="mt-4 rounded-2xl border border-ink-700 p-3">
              <div className="flex gap-3">
                <Img src={sourceCover(c.source, c.coverUrl)} alt="" className="h-16 w-12 shrink-0 rounded-lg object-cover" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{c.name}</p>
                  {/* Their title, verbatim. If it is not this series, this line is where a person notices. */}
                  <p className="truncate text-xs text-fog-400">{tr('Listed there as')} “{c.title}”</p>
                  <p className="mt-1 text-xs text-fog-500">
                    {c.count} {tr('chapters')} ({c.first}–{c.last}) · {tr('matches {m} of your {n}')
                      .replace('{m}', String(c.matched)).replace('{n}', String(d.have.count))}
                    {c.pinned && ` · ${tr('this series’ own source')}`}
                  </p>
                </div>
              </div>
              <button
                disabled={busy}
                onClick={() => run(c)}
                className="btn-accent mt-3 w-full text-sm disabled:opacity-50"
              >
                {tr('Fetch {n} chapters from {s}')
                  .replace('{n}', String(c.fillable.length))
                  .replace('{s}', c.name)}
              </button>
            </div>
          ))}

          {!usable.length && !scan.isLoading && !d.refusal && (
            <p className="mt-3 text-sm text-fog-400">{tr('No source could supply what is missing.')}</p>
          )}

          {/* The series that prompted this is listed elsewhere under a completely different English name. */}
          <div className="mt-5">
            <label className="text-xs text-fog-500">{tr('Known under another name?')}</label>
            <div className="mt-1 flex gap-2">
              <input
                value={altTitle}
                onChange={(e) => setAltTitle(e.target.value)}
                placeholder={tr('Search under a different title')}
                className="min-w-0 flex-1 rounded-full border border-ink-700 bg-transparent px-3 py-2 text-sm"
              />
              <button onClick={() => setTerm(altTitle.trim())} className="btn-ghost shrink-0 text-sm">
                {tr('Search')}
              </button>
            </div>
          </div>

          {rejected.length > 0 && (
            <div className="mt-5">
              <p className="text-xs uppercase tracking-wide text-fog-600">{tr('Checked, not usable')}</p>
              <ul className="mt-2 space-y-1">
                {rejected.map((c) => (
                  <li key={`${c.source}:${c.sourceSeriesId}`} className="text-xs text-fog-500">
                    <span className="text-fog-400">{c.name}</span> · {whyText(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
