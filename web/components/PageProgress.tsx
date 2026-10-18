// the chapter a download is fetching now, page by page: a thin bar and "34/78 pages · about 40 s left"
// (lib/serverDownloads.ts pageLine). The Downloads view's Running tiles and the series page's download band, each of
// which already names the chapter on its own line ("Ch. 132 · MangaFire"); seen on a desktop tile, a third "Ch. 132"
// here only pushed the time left out of sight. Nothing until the server has sized the chapter (its page list is in), so
// a chapter still waiting for its source's slot shows only the ring.
import { t as tr } from '@/lib/i18n';
import { chaptersAfter, leftText, pageLine, type ActivityEntry } from '@/lib/serverDownloads';
import { useReduceEffects } from '@/lib/effects';

export function PageProgress({ entries, job, className = '' }: { entries: readonly ActivityEntry[]; job?: { done: number; total: number }; className?: string }) {
  const plain = useReduceEffects();
  // The time left is the whole download's: the chapters of the job not yet started, at this chapter's page rate.
  const line = pageLine(entries, Date.now(), { chaptersAfter: chaptersAfter(job, entries) });
  if (!line) return null;
  const words = [
    tr('{done}/{total} pages', { done: line.done, total: line.total }),
    line.secondsLeft != null ? leftText(line.secondsLeft) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div data-page-progress={`${line.done}/${line.total}`} className={`mt-1 ${className}`}>
      <div className="h-1 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuemin={0} aria-valuemax={line.total} aria-valuenow={line.done} aria-label={words}>
        <div className={`h-full rounded-full bg-accent ${plain ? '' : 'transition-[width] duration-700 ease-out'}`} style={{ width: `${Math.round(line.fraction * 100)}%` }} />
      </div>
      <p className="mt-0.5 text-[11px] leading-snug tabular-nums text-fog-400">{words}</p>
    </div>
  );
}
