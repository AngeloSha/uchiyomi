'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { Img } from '@/components/ui';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcChevronLeft, IcCheck, IcPlay } from '@/components/icons';
import { keys, t as tr } from '@/lib/i18n';

interface HistoryRow {
  book_id: string; series_id: string; page: number; completed: boolean; created_at: string;
  book_title: string; series_title: string;
}

// Two of these three are translatable strings reaching `tr()` through a variable, so they are declared;
// the third is already localised by the browser. See lib/i18n.ts.
const DAY_LABELS = keys('Today', 'Yesterday');
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return DAY_LABELS[0];
  if (same(d, yest)) return DAY_LABELS[1];
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

export default function HistoryPage() {
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ['history'], queryFn: () => api<{ content: HistoryRow[] }>('/api/history?limit=200') });
  const rows = data?.content ?? [];

  // group by calendar day (rows arrive newest-first)
  const groups: Array<{ label: string; items: HistoryRow[] }> = [];
  for (const r of rows) {
    const label = dayLabel(r.created_at);
    if (groups[groups.length - 1]?.label === label) groups[groups.length - 1].items.push(r);
    else groups.push({ label, items: [r] });
  }

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0 lg:pt-6">
        {/* A phone's way back; on a desktop History is the sidebar's (components/Sidebar.tsx). */}
        <button onClick={() => router.back()} aria-label={tr('Back')} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100 lg:hidden">
          <IcChevronLeft width={22} height={22} className="rtl:-scale-x-100" />
        </button>
        <h1 className="font-display text-2xl font-bold lg:text-3xl">{tr('Reading history')}</h1>
      </header>

      {isLoading ? (
        <div className="grid gap-2 px-4 pt-3 sm:grid-cols-2 lg:px-0 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState art={ART.emptyUpdates} title={tr('Nothing here yet')}
          sub={tr('Chapters you read will show up here, newest first.')} cta={{ href: '/library', label: tr('Browse library') }} />
      ) : (
        // The page's width, in columns (UI refresh: it was a 672 px column in the middle of a wide screen). Each day's
        // heading sticks under the top bar on a desktop, not behind it.
        <div className="px-4 pt-2 lg:px-0">
          {groups.map((g) => (
            <section key={g.label} className="mb-6">
              <h2 className="sticky top-0 z-10 bg-ink-950/90 py-2 text-xs font-semibold uppercase tracking-widest text-fog-500 backdrop-blur rtl:tracking-normal lg:top-[var(--topbar-h)]">
                {tr(g.label)}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {g.items.map((r) => (
                  <div key={r.book_id} className="card flex items-center gap-3 px-3 py-2.5 transition-colors hover:border-ink-600">
                    <Link href={`/series/?id=${r.series_id}`} className="h-16 w-11 shrink-0 overflow-hidden rounded-lg border border-ink-700">
                      <Img src={img.bookThumb(r.book_id)} alt="" className="h-full w-full" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link href={`/series/?id=${r.series_id}`} className="block truncate text-sm font-medium text-fog-100">
                        {r.series_title || tr('Unknown series')}
                      </Link>
                      <p className="truncate text-[11px] text-fog-500">
                        {r.book_title}
                        <span className="text-fog-600"> · {relativeTime(r.created_at)}</span>
                        {r.completed
                          ? <span className="ms-1.5 inline-flex items-center gap-0.5 text-emerald-400"><IcCheck width={11} height={11} /> {tr('finished')}</span>
                          : <span className="ms-1.5 text-accent">{tr('page {n}', { n: r.page })}</span>}
                      </p>
                    </div>
                    <Link href={`/reader/?book=${r.book_id}`} aria-label={tr('Open in reader')}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent transition hover:bg-accent hover:text-black">
                      <IcPlay width={15} height={15} />
                    </Link>
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
