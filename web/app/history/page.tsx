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

interface HistoryRow {
  book_id: string; series_id: string; page: number; completed: boolean; created_at: string;
  book_title: string; series_title: string;
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
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
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold lg:text-3xl">Reading history</h1>
      </header>

      {isLoading ? (
        <div className="space-y-3 px-4 pt-3 lg:mx-auto lg:max-w-2xl lg:px-0">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-2xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState art={ART.emptyUpdates} title="Nothing here yet"
          sub="Chapters you read will show up here, newest first." cta={{ href: '/library', label: 'Browse library' }} />
      ) : (
        <div className="px-4 pt-2 lg:mx-auto lg:max-w-2xl lg:px-0">
          {groups.map((g) => (
            <section key={g.label} className="mb-5">
              <h2 className="sticky top-0 z-10 bg-ink-950/90 py-2 text-xs font-semibold uppercase tracking-widest text-fog-500 backdrop-blur">
                {g.label}
              </h2>
              <div className="card divide-y divide-ink-800/70 overflow-hidden">
                {g.items.map((r) => (
                  <div key={r.book_id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <Link href={`/series/?id=${r.series_id}`} className="h-14 w-10 shrink-0 overflow-hidden rounded-lg border border-ink-700">
                      <Img src={img.bookThumb(r.book_id)} alt="" className="h-full w-full" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link href={`/series/?id=${r.series_id}`} className="block truncate text-sm font-medium text-fog-100">
                        {r.series_title || 'Unknown series'}
                      </Link>
                      <p className="truncate text-[11px] text-fog-500">
                        {r.book_title}
                        <span className="text-fog-600"> · {relativeTime(r.created_at)}</span>
                        {r.completed
                          ? <span className="ml-1.5 inline-flex items-center gap-0.5 text-emerald-400"><IcCheck width={11} height={11} /> finished</span>
                          : <span className="ml-1.5 text-accent">page {r.page}</span>}
                      </p>
                    </div>
                    <Link href={`/reader/?book=${r.book_id}`} aria-label="Open in reader"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
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
