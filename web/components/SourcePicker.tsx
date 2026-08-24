'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ScrollRail } from '@/components/ScrollRail';
import { t as tr } from '@/lib/i18n';

export type { Src, SrcState } from '@/lib/sourceGroups';
export { inGroup, languagesOf, budgetFor } from '@/lib/sourceGroups';
import type { Src } from '@/lib/sourceGroups';
import { inGroup, languagesOf } from '@/lib/sourceGroups';
import type { SrcState } from '@/lib/sourceGroups';

const DOT: Record<SrcState, string> = {
  loading: 'bg-accent animate-pulse-soft',
  ok: 'bg-emerald-400',
  empty: 'bg-fog-600',
  idle: 'bg-ink-500',
  blocked: 'bg-amber-400',
  off: 'bg-ink-600',
};

export function SourcePicker({ sources, lang, onLang, states, settled, total }: {
  sources: Src[];
  lang: string;
  onLang: (code: string) => void;
  states: Record<string, SrcState>;
  settled: number;
  total: number;
}) {
  const langs = languagesOf(sources);
  const group = sources.filter((s) => s.latest && inGroup(s, lang)).slice(0, 12);

  return (
    <div className="mt-4 space-y-2.5">
      {langs.length > 1 && (
        <ScrollRail size="sm" label={tr('Language')}
          className="bleed flex items-center gap-2 px-4 pb-3 lg:px-8">
          <span className="shrink-0 pe-1 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Language')}</span>
          {langs.map((l) => (
            <button key={l.code} onClick={() => onLang(l.code)}
              className={`chip shrink-0 whitespace-nowrap text-xs ${l.code === lang ? 'chip-active' : ''}`}>
              {l.label}<span className="ms-1 tabular-nums text-fog-500">{l.count}</span>
            </button>
          ))}
        </ScrollRail>
      )}

      {/* The source chips ARE the loading indicator: which sources are being asked, and how each answered. */}
      <div className="flex flex-wrap items-center gap-2">
        {group.map((s) => {
          const st = states[s.id] ?? 'idle';
          return (
            <span key={s.id} title={s.name}
              className={`chip max-w-[46vw] cursor-default text-xs sm:max-w-none ${st === 'idle' || st === 'off' ? 'opacity-55' : ''}`}>
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[st]}`} />
              <span className="truncate">{s.name}</span>
            </span>
          );
        })}
      </div>

      {settled < total && (
        <div className="h-px w-full overflow-hidden bg-ink-700">
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${(settled / Math.max(1, total)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * One source's newest page. Renders nothing.
 *
 * It exists so that "one request per source" stays a legal hook: the parent renders a stable list of these
 * and each owns its own query, rather than the parent trying to call `useQuery` in a loop. `enabled` is the
 * concurrency gate; `retry: false` because a fifteen-second failure retried three times is forty-five
 * seconds of nothing.
 */
export function SourceLatest({ source, page, enabled, onSettled }: {
  source: Src;
  page: number;
  enabled: boolean;
  onSettled: (id: string, items: any[], ok: boolean) => void;
}) {
  const { data, isError, isSuccess } = useQuery({
    queryKey: ['src-latest', source.id, page],
    queryFn: () => api<{ content: any[] }>(`/api/sources/latest?source=${encodeURIComponent(source.id)}&page=${page}`),
    enabled,
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // Inherited `true` means a tab left open on Discover re-fires six live scrapes the moment you come back
    // to it, and the wall goes blank while they run. Nothing here changes in the seconds you were away.
    refetchOnWindowFocus: false,
  });

  // Reported from an effect rather than inside queryFn: a cached hit never runs queryFn, and a source that
  // answered instantly from cache must still release the concurrency gate or the wall stalls behind it.
  useEffect(() => {
    if (isSuccess) onSettled(source.id, data?.content ?? [], true);
    else if (isError) onSettled(source.id, [], false);
  }, [isSuccess, isError, data, source.id, onSettled]);

  return null;
}
