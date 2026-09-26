'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { chapterSpan, groupRecent, originLabel, type Activity } from '@/lib/serverDownloads';

/**
 * "On the server": what is downloading now and what came in today, whatever started it (lib/serverDownloads.ts).
 *
 * On the Offline tab because its download icon is where people look for downloads, and because the pill only
 * appears while something is happening: at nine in the morning, the scheduled check's chapters from the
 * night are here and nowhere else. The rest of the page is this device's copies, and says so; this section is
 * the server's, and says that.
 */
export function ServerDownloads({ online }: { online: boolean }) {
  const { user } = useAuth();
  const mayAdd = canDownload(user);
  const { data } = useQuery({
    // The pill's query and key (components/DownloadsIndicator.tsx): one key, one endpoint, one cache.
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: unknown[]; activity?: Activity }>('/api/sources/jobs'),
    enabled: mayAdd && online,
    refetchInterval: (qy) => ((qy.state.data?.activity?.active.length ?? 0) > 0 ? 2500 : 30_000),
  });
  const active = data?.activity?.active ?? [];
  const groups = groupRecent(data?.activity?.recent ?? []);
  if (!mayAdd || !online || (!active.length && !groups.length)) return null;

  return (
    <section className="px-5 pt-4 lg:px-0">
      <h2 className="mb-2 font-display text-base font-semibold text-fog-100">{tr('On the server')}</h2>
      <div className="card divide-y divide-ink-800/70 overflow-hidden">
        {active.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-xs font-medium text-fog-200">{tr('Downloading now')}</p>
            {active.slice(0, 20).map((e) => (
              <div key={e.id} className="mt-2 flex items-baseline gap-2">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.status === 'queued' ? 'bg-ink-600' : 'animate-pulse-soft bg-accent'}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fog-100">{e.title} · {tr('Ch. {n}', { n: e.number })}</p>
                  <p className="truncate text-[11px] text-fog-500">
                    {originLabel(e.origin)} · {e.source}{e.status === 'queued' ? ` · ${tr('waiting for the source')}` : ''}
                  </p>
                </div>
              </div>
            ))}
            {active.length > 20 && <p className="mt-2 text-[11px] text-fog-500">{tr('and {n} more', { n: active.length - 20 })}</p>}
          </div>
        )}
        {groups.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-xs font-medium text-fog-200">{tr('Came in today')}</p>
            {groups.map((g) => {
              const name = <span className="truncate text-sm text-fog-100">{g.title}</span>;
              return (
                <div key={g.key} className="mt-2">
                  {g.seriesId ? <Link href={`/series/?id=${encodeURIComponent(g.seriesId)}`} className="block truncate hover:underline">{name}</Link> : name}
                  <p className="text-[11px] text-fog-400">
                    {[g.numbers.length ? chapterSpan(g.numbers) : '', g.origins.map(originLabel).join(', '), relativeTime(new Date(g.at).toISOString())]
                      .filter(Boolean).join(' · ')}
                  </p>
                  {g.partial > 0 && <p className="text-[11px] text-fog-500">{tr('{n} saved with pages missing', { n: g.partial })}</p>}
                  {g.failed.map((f) => (
                    <p key={f.id} className="text-[11px] text-amber-300">
                      {tr('Ch. {n} could not be saved', { n: f.number })}{f.reason ? `: ${f.reason}` : ''}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
