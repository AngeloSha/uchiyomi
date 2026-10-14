'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listDownloads, deleteDownload, deleteSeriesDownloads, clearAllDownloads, storageEstimate, OfflineChapter } from '@/lib/downloads';
import { OfflineCover } from '@/components/OfflineCover';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { runSmartOffline } from '@/lib/offlineSync';
import { bytes } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcTrash, IcPlay, IcWifiOff, IcRefresh } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { isDesktop, serverReachableHint } from '@/lib/desktop';
import { canDownload, useAuth } from '@/lib/auth';
import { downloadsHref } from '@/lib/libraryView';

export default function DownloadsPage() {
  const [items, setItems] = useState<OfflineChapter[]>([]);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // What a delete asks first (ConfirmDialog, UI refresh: it was window.confirm).
  const [asking, setAsking] = useState<{ kind: 'series'; seriesId: string; title: string; count: number } | { kind: 'all' } | null>(null);
  const toast = useToast();
  const router = useRouter();
  const { user, status } = useAuth();
  // Desktop hides the Offline tab and "Save offline" (the chapters are on this disk already), so this page there
  // is an empty "No downloads yet" pointing at controls the app does not show. A deep link to it -- the reader's
  // end-of-downloads button, an old bookmark -- goes to what "downloads" means on a desktop: what the app
  // fetched onto this PC, Library -> Downloads (v0.49.0; the library itself before there was such a view).
  const desktop = isDesktop();
  useEffect(() => { if (desktop) router.replace('/library/?view=downloads'); }, [desktop, router]);

  const refresh = async () => {
    setItems(await listDownloads());
    setUsage(await storageEstimate());
    setLoaded(true);
  };
  useEffect(() => {
    refresh();
    setOnline(serverReachableHint());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  if (desktop) return null;

  const remove = async (bookId: string) => {
    await deleteDownload(bookId);
    refresh();
  };

  // Every count on this page is one pair of keys, in the reader's words: they were English in every language, and
  // "Deleted 1 chapters" in English (v0.49.1).
  const deleted = (n: number) => (n === 1 ? tr('Deleted 1 chapter') : tr('Deleted {n} chapters', { n }));

  const removeSeries = async (seriesId: string) => {
    const n = await deleteSeriesDownloads(seriesId);
    toast(deleted(n), 'success');
    refresh();
  };

  const removeAll = async () => {
    const n = await clearAllDownloads();
    toast(deleted(n), 'success');
    refresh();
  };

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    // One card, in one language: the result takes the busy card's place (the same key).
    toast(tr('Syncing favorites…'), 'info', { busy: true, key: 'sync' });
    const n = await runSmartOffline(5);
    toast(!n ? tr('Already up to date') : n === 1 ? tr('Downloaded 1 chapter') : tr('Downloaded {n} chapters', { n }), 'success', { key: 'sync' });
    await refresh();
    setSyncing(false);
  };

  // By series -- its id, not its title: two series may share one.
  const groups = items.reduce<Record<string, OfflineChapter[]>>((acc, c) => {
    (acc[c.seriesId] ||= []).push(c);
    return acc;
  }, {});
  const totalBytes = items.reduce((a, c) => a + (c.totalBytes || 0), 0);

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Offline')}</h1>
          <button onClick={sync} disabled={syncing || !online} className="btn-key h-9">
            <IcRefresh width={15} height={15} className={syncing ? 'animate-spin text-accent' : ''} /> {syncing ? tr('Syncing…') : tr('Sync now')}
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-fog-500">
          <span>{items.length === 1 ? tr('1 chapter') : tr('{n} chapters', { n: items.length })} · {bytes(totalBytes)}</span>
          {!online && <span className="inline-flex items-center gap-1 text-accent"><IcWifiOff width={13} height={13} /> {tr('offline')}</span>}
          {items.length > 0 && (
            <button onClick={() => setAsking({ kind: 'all' })} className="btn-key btn-key-danger ms-auto">
              <IcTrash width={13} height={13} />{tr('Delete all')}</button>
          )}
        </div>
        {usage.quota > 0 && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-[2px] bg-ink-700">
              <div className="h-full bg-accent" style={{ width: `${Math.min(100, (usage.usage / usage.quota) * 100)}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-fog-500">{tr('{used} of {total} device storage used', { used: bytes(usage.usage), total: bytes(usage.quota) })}</p>
          </div>
        )}
      </header>

      {/* This page is this device's copies, and only them (v0.49.0). What the server fetches moved to Library ->
          Downloads; one line says so, for whoever learned to look here since v0.48.1 -- and only online and
          signed in, since offline there is no server to show, and it asks the server nothing itself. */}
      {online && status === 'authed' && canDownload(user) && (
        <p data-server-downloads-pointer className="px-5 pt-3 text-xs text-fog-500 lg:px-0">
          <Link href={downloadsHref()} className="hover:text-fog-200 hover:underline">{tr('What the server fetches is under Library → Downloads.')}</Link>
        </p>
      )}

      {loaded && items.length === 0 ? (
        <EmptyState art={ART.emptyDownloads} title={tr('No downloads yet')}
          sub={online
            ? tr('Tap the download icon on any chapter — or turn on Keep favorites offline under Profile → Settings → Downloads — to read offline. Perfect for flights and commutes.')
            : tr('Nothing is saved on this device, and there is no connection to fetch anything with. Reconnect and download a chapter to read it here.')}
          cta={/* no cta offline: it points at the library, which is built entirely from the server */
            online ? { href: '/library', label: tr('Browse library') } : undefined} />
      ) : (
        // One card per series, side by side on a wide screen (.board), each with its cover. Every chapter is ONE link to
        // the reader: the browser walk counts them and clicks one by its address offline (e2e/run.mjs).
        <div className="board px-5 pt-4 lg:px-0" data-offline-series-list>
          {Object.entries(groups).map(([seriesId, chapters]) => {
            const title = chapters[0].seriesTitle;
            return (
              <section key={seriesId} className="card overflow-hidden" data-offline-series={seriesId}>
                <div className="flex items-center gap-3 p-3">
                  <OfflineCover seriesId={seriesId} bookId={chapters[0].bookId} online={online && status === 'authed'} title={title} />
                  <div className="min-w-0 flex-1">
                    <h2 className="line-clamp-2 font-display text-base font-semibold leading-tight text-fog-100">{title}</h2>
                    <p className="mt-1 text-2xs text-fog-500">
                      {chapters.length === 1 ? tr('1 chapter') : tr('{n} chapters', { n: chapters.length })} · {bytes(chapters.reduce((a, c) => a + (c.totalBytes || 0), 0))}
                    </p>
                  </div>
                  <button onClick={() => setAsking({ kind: 'series', seriesId, title, count: chapters.length })}
                    className="btn-key btn-key-danger w-8 shrink-0 px-0" aria-label={tr('Delete all of {title}', { title })} title={tr('Delete all of {title}', { title })}>
                    <IcTrash width={14} height={14} />
                  </button>
                </div>
                <ul className="divide-y divide-ink-800/70 border-t border-ink-800/70">
                  {chapters.map((c) => (
                    <li key={c.bookId} className="flex items-center gap-2 px-2 py-1.5">
                      <Link href={`/reader/?book=${c.bookId}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-white/[0.04]">
                        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><IcPlay width={14} height={14} /></span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-fog-100">{c.title}</span>
                          <span className="block text-2xs text-fog-500">{c.pageCount === 1 ? tr('1 page') : tr('{n} pages', { n: c.pageCount })} · {bytes(c.totalBytes)}</span>
                        </span>
                      </Link>
                      <button onClick={() => remove(c.bookId)} className="btn-key w-8 shrink-0 px-0" aria-label={tr('Delete')} title={tr('Delete')}>
                        <IcTrash width={14} height={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {asking && (
        <ConfirmDialog
          title={asking.kind === 'all'
            ? (items.length === 1 ? tr('Delete the downloaded chapter on this device?') : tr('Delete all {n} downloaded chapters on this device?', { n: items.length }))
            : (asking.count === 1 ? tr('Delete the downloaded chapter of “{title}”?', { title: asking.title }) : tr('Delete all {n} downloaded chapters of “{title}”?', { n: asking.count, title: asking.title }))}
          body={tr('Only the copies on this device. The chapters stay on the server.')}
          confirmLabel={tr('Delete')}
          danger
          onConfirm={() => { const a = asking; setAsking(null); if (a.kind === 'all') void removeAll(); else void removeSeries(a.seriesId); }}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}
