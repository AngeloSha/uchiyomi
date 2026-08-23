'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listDownloads, deleteDownload, deleteSeriesDownloads, clearAllDownloads, storageEstimate, OfflineChapter } from '@/lib/downloads';
import { runSmartOffline } from '@/lib/offlineSync';
import { bytes } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcTrash, IcPlay, IcDownload, IcWifiOff, IcRefresh } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

export default function DownloadsPage() {
  const [items, setItems] = useState<OfflineChapter[]>([]);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

  const refresh = async () => {
    setItems(await listDownloads());
    setUsage(await storageEstimate());
    setLoaded(true);
  };
  useEffect(() => {
    refresh();
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const remove = async (bookId: string) => {
    await deleteDownload(bookId);
    refresh();
  };

  const removeSeries = async (seriesId: string, title: string, count: number) => {
    if (!window.confirm(`Delete all ${count} downloaded chapters of “${title}”?`)) return;
    const n = await deleteSeriesDownloads(seriesId);
    toast(`Deleted ${n} chapters`, 'success');
    refresh();
  };

  const removeAll = async () => {
    if (!window.confirm(`Delete all ${items.length} downloaded chapters on this device?`)) return;
    const n = await clearAllDownloads();
    toast(`Deleted ${n} chapters`, 'success');
    refresh();
  };

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    toast('Syncing favorites…');
    const n = await runSmartOffline(5);
    toast(n ? `Downloaded ${n} chapter${n > 1 ? 's' : ''}` : 'Already up to date', 'success');
    await refresh();
    setSyncing(false);
  };

  // group by series
  const groups = items.reduce<Record<string, OfflineChapter[]>>((acc, c) => {
    (acc[c.seriesTitle] ||= []).push(c);
    return acc;
  }, {});
  const totalBytes = items.reduce((a, c) => a + (c.totalBytes || 0), 0);

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Offline')}</h1>
          <button onClick={sync} disabled={syncing || !online}
            className="flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850/70 px-3.5 py-2 text-xs text-fog-200 disabled:opacity-50">
            <IcRefresh width={15} height={15} className={syncing ? 'animate-spin text-accent' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-fog-500">
          <span>{items.length} chapters · {bytes(totalBytes)}</span>
          {!online && <span className="inline-flex items-center gap-1 text-accent"><IcWifiOff width={13} height={13} /> offline</span>}
          {items.length > 0 && (
            <button onClick={removeAll} className="ms-auto inline-flex items-center gap-1 text-fog-500 transition hover:text-red-400">
              <IcTrash width={13} height={13} />{tr('Delete all')}</button>
          )}
        </div>
        {usage.quota > 0 && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (usage.usage / usage.quota) * 100)}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-fog-500">{bytes(usage.usage)} of {bytes(usage.quota)} device storage used</p>
          </div>
        )}
      </header>

      {loaded && items.length === 0 ? (
        <EmptyState art={ART.emptyDownloads} title={tr('No downloads yet')}
          sub="Tap the download icon on any chapter — or turn on Smart downloads — to read offline. Perfect for flights and commutes."
          cta={{ href: '/library', label: 'Browse library' }} />
      ) : (
        <div className="px-5 pt-4">
          {Object.entries(groups).map(([series, chapters]) => (
            <section key={series} className="mb-6">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="min-w-0 truncate font-display text-base font-semibold text-fog-100">{series}</h2>
                <div className="flex shrink-0 items-center gap-2 text-[11px] text-fog-500">
                  <span>{chapters.length} ch · {bytes(chapters.reduce((a, c) => a + (c.totalBytes || 0), 0))}</span>
                  <button onClick={() => removeSeries(chapters[0].seriesId, series, chapters.length)}
                    className="inline-flex items-center gap-1 transition hover:text-red-400" aria-label={`Delete all of ${series}`}>
                    <IcTrash width={13} height={13} />
                  </button>
                </div>
              </div>
              <div className="card divide-y divide-ink-800/70 overflow-hidden">
                {chapters.map((c) => (
                  <div key={c.bookId} className="flex items-center gap-3 px-4 py-3">
                    <Link href={`/reader/?book=${c.bookId}`} className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft text-accent">
                      <IcPlay width={16} height={16} />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fog-100">{c.title}</p>
                      <p className="text-[11px] text-fog-500">{c.pageCount} pages · {bytes(c.totalBytes)}</p>
                    </div>
                    <button onClick={() => remove(c.bookId)} className="grid h-9 w-9 place-items-center rounded-full border border-ink-700 text-fog-500">
                      <IcTrash width={16} height={16} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
