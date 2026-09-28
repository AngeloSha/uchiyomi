'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { IcHourglass } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { reasonText } from '@/lib/said';
import { chaptersLeft } from '@/lib/chapterRows';
import { fetchingLabel, fetchingToast, mayCancel } from '@/lib/jobs';
import { downloadsHref } from '@/lib/libraryView';
import { bandFor, bandReload, downloadSections, landedFor, originLabel, tileStatus, type BandSeen } from '@/lib/serverDownloads';
import { kickDownloads, useServerDownloads } from '@/lib/useServerDownloads';
import { ArchiveBand } from '@/components/ArchiveQueue';

/** How often at most the band re-reads the chapter list while chapters land: a sweep can land one a second. */
const RELOAD_EVERY_MS = 4000;

/**
 * This series' server downloads, whoever started them (v0.49.0), in one slim band above its chapter list: the
 * add or Fetch in flight, the scheduled check's chapters, the slow archive -- with a ring, one sentence, Cancel
 * when it is yours to stop, and "See all" into Library -> Downloads. A failed download of yours says why, with
 * Try again and Dismiss.
 *
 * The slow archive (#117) has a line of its own: its progress, what it waits for, and Pause, Resume and Stop for
 * whoever may. This band is the one place on the series page to watch it; the page itself only starts one.
 *
 * It also turns grey rows into chapters as they land. The page used to refresh its chapter list only when a
 * job IT started ended, so a chapter the scheduled check or someone else's Fetch brought in stayed grey until a
 * reload; now any landing for this series re-reads the list, at most every four seconds.
 *
 * The one ['source-jobs'] query AppShell polls; this adds no poll of its own. Renders nothing for a viewer who
 * may not download (the query is off for them) and nothing while the series has nothing going on.
 */
export function SeriesServerDownloads({ seriesId, folder }: { seriesId: string; folder?: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useServerDownloads();
  const { tile, failed, archive } = bandFor(downloadSections(data, { admin: isAdmin }), seriesId, folder);

  // Reintroduce by dropping this effect: a chapter someone else's download lands stays grey until a reload.
  // Null until the poll first answers: what decides is `bandReload` (shouldReload, per series), where a test can
  // reach it. What was seen is kept WITH its series id: moving to another series in the app keeps this mounted.
  const landed = data ? landedFor(data, seriesId, folder) : null;
  const seen = useRef<BandSeen | null>(null);
  const last = useRef(0);
  useEffect(() => {
    const step = bandReload(seen.current, seriesId, landed);
    seen.current = step.seen;
    if (!step.reload) return;
    const reload = () => {
      last.current = Date.now();
      for (const k of [['series-books', seriesId], ['series-listing', seriesId], ['series', seriesId]]) qc.invalidateQueries({ queryKey: k });
    };
    const wait = RELOAD_EVERY_MS - (Date.now() - last.current);
    if (wait <= 0) { reload(); return; }
    const t = setTimeout(reload, wait);
    return () => clearTimeout(t);
  }, [landed, seriesId, qc]);

  if (!tile && !failed && !archive) return null;
  const call = async (path: string, method: 'POST' | 'DELETE') => {
    try { await api(path, { method }); } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    void kickDownloads(qc);
  };
  const retry = async (numbers: number[]) => {
    try {
      const res = await api<{ folder: string; total: number }>('/api/sources/fetch', { method: 'POST', json: { seriesId, numbers } });
      toast(fetchingToast(res.total), 'info', { busy: true });
    } catch (e) { toast(msgOf(e, tr('Could not start.')), 'error'); }
    void kickDownloads(qc);
  };

  const job = tile?.job;
  // One sentence: how much of a person's download is left and where it is, or what the server is doing here.
  const status = tile ? tileStatus(tile) : '';
  const lead = !tile ? ''
    : job ? fetchingLabel(chaptersLeft([job]))
    : tile.archive ? tr('Archiving slowly')
    : tile.entries[0] ? originLabel(tile.entries[0].origin) : '';
  const sentence = [lead, status].filter(Boolean).join(' · ');
  // The archive's own row draws its line below; its chapter in flight is not a second one.
  const tileLine = !!tile && !(tile.archive && archive);
  // `||`, not `??`: an archive row's tile with nothing in flight has the folder '' -- a string -- and `??` kept it,
  // losing the failed download's folder to focus on.
  const href = downloadsHref(tile?.folder || failed?.job.folder || folder);
  return (
    <div data-series-downloads className="mb-3 space-y-2">
      {tile && tileLine && (
        <div data-band-state={tile.archive ? 'archive' : 'active'} className="card flex items-center gap-3 px-3 py-2.5">
          <span className="relative grid shrink-0 place-items-center">
            <ProgressRing progress={tile.progress} size={28} tone={tile.archive ? 'amber' : 'accent'} static={tile.archive}
              label={sentence || tile.title} valueText={job && job.total > 0 ? `${job.done}/${job.total}` : undefined} />
            {tile.archive && <IcHourglass width={12} height={12} className="absolute text-amber-400" aria-hidden />}
          </span>
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-fog-200">
            {sentence}
            {/* The count is its own bidi run, in the line's direction. Not isolated, a sentence ending in a source's
                Latin name ("… · fake-a") took "1/3" into that name's run: in Arabic it printed "fake-a1/3", its gap
                on the far side. Isolated, it follows the name in either direction, the gap between them. */}
            {job && job.total > 0 && <span className="ms-1.5 tabular-nums text-fog-500 [unicode-bidi:isolate]">{Math.min(job.done, job.total)}/{job.total}</span>}
          </p>
          {job && mayCancel(job, isAdmin) && (
            <button type="button" onClick={() => call(`/api/sources/jobs/${encodeURIComponent(job.folder)}/cancel`, 'POST')} className="btn-key">
              {tr('Cancel')}
            </button>
          )}
          <Link href={href} className="shrink-0 text-[12px] font-medium text-accent hover:underline">{tr('See all')}</Link>
        </div>
      )}
      {archive && <ArchiveBand item={archive} view={data?.archive} />}
      {failed && (
        <div data-band-state="failed" className="card flex flex-wrap items-center gap-x-3 gap-y-2 border-amber-500/40 px-3 py-2.5">
          <p dir="auto" className="min-w-0 flex-1 basis-48 text-[13px] leading-snug text-amber-300">
            {reasonText(failed.job) || tr('Fetch stopped. Try another source or wait.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {failed.retry.length > 0 && <button type="button" onClick={() => retry(failed.retry)} className="btn-key">{tr('Try again')}</button>}
            {failed.dismiss && (
              <button type="button" onClick={() => call(`/api/sources/jobs/${encodeURIComponent(failed.job.folder)}`, 'DELETE')} className="btn-key">
                {tr('Dismiss')}
              </button>
            )}
            {/* Its "See all" whenever the tile's line (which has its own) is not shown -- an archive's included. */}
            {!tileLine && <Link href={href} className="text-[12px] font-medium text-accent hover:underline">{tr('See all')}</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
