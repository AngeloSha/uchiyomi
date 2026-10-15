'use client';
// Zip exports in progress, bottom corner, like a cloud drive's "preparing your download": each job shows its
// progress while the server packs it, then the browser takes the file and the row says so.
import { dismissExport, exportFileUrl, saveExport, useExports, wasSaved, type ExportJobView } from '@/lib/exports';
import { ProgressBar } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function Row({ j }: { j: ExportJobView }) {
  const busy = j.status === 'queued' || j.status === 'zipping';
  const pct = j.totalBytes ? j.doneBytes / j.totalBytes : 0;
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-fog-50" title={j.name}>{j.name}</p>
        <button type="button" onClick={() => void dismissExport(j.id)} aria-label={busy ? tr('Cancel') : tr('Dismiss')}
          className="shrink-0 rounded px-1.5 text-xs text-fog-300 hover:text-fog-50">{busy ? tr('Cancel') : tr('Dismiss')}</button>
      </div>
      {busy && (
        <>
          <p className="mb-1 mt-0.5 text-xs text-fog-300">
            {j.status === 'queued' ? tr('Waiting to start…') : tr('Zipping {done} of {total}', { done: mb(j.doneBytes), total: mb(j.totalBytes) })}
          </p>
          <ProgressBar value={j.status === 'queued' ? 0.02 : pct} />
        </>
      )}
      {j.status === 'ready' && (
        <p className="mt-0.5 text-xs text-fog-300">
          {wasSaved(j.id) ? tr('Sent to your browser ({size}).', { size: mb(j.fileBytes) }) : tr('Ready ({size}).', { size: mb(j.fileBytes) })}{' '}
          <a href={exportFileUrl(j.id) ?? undefined} download onClick={() => void saveExport(j.id)} className="text-accent underline">{tr('Download again')}</a>
        </p>
      )}
      {j.status === 'failed' && <p role="alert" className="mt-0.5 text-xs text-rose-300">{tr('Could not make the zip')}{j.error ? `: ${j.error}` : ''}</p>}
    </li>
  );
}

export function ExportTray() {
  const jobs = useExports().filter((j) => j.status !== 'cancelled');
  if (!jobs.length) return null;
  return (
    <section aria-label={tr('Downloads as zip')} data-export-tray
      className="glass fixed bottom-24 end-3 z-40 w-[min(22rem,calc(100vw-1.5rem))] divide-y divide-ink-700 overflow-hidden rounded-2xl border border-ink-700 shadow-lift lg:bottom-4">
      <ul>{jobs.map((j) => <Row key={j.id} j={j} />)}</ul>
    </section>
  );
}
