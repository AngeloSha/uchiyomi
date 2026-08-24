'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { langName } from '@/lib/langNames';
import { t as tr, storedLocale, detectLocale } from '@/lib/i18n';

export interface Src {
  id: string;
  name: string;
  /** null means "declares no single language", not "serves none". See `inGroup`. */
  lang: string | null;
  latest?: boolean;
  status?: 'ok' | 'disabled' | 'rate_limited' | 'blocked' | 'down';
  blockedUntil?: string | null;
}

export type SrcState = 'loading' | 'ok' | 'empty' | 'idle' | 'blocked' | 'off';

const DOT: Record<SrcState, string> = {
  loading: 'bg-accent animate-pulse-soft',
  ok: 'bg-emerald-400',
  empty: 'bg-fog-600',
  idle: 'bg-ink-500',
  blocked: 'bg-amber-400',
  off: 'bg-ink-600',
};

/**
 * A source belongs to a language group when it declares that language, or declares none.
 *
 * A source with no declared language is not an orphan: MangaDex serves everything, and the pack sources are
 * code rather than an operator's choice. Bucketing those separately would put a "no language" chip on a page
 * whose entire organising idea is language.
 */
export const inGroup = (s: Src, lang: string) => !lang || s.lang === lang || s.lang === 'all' || !s.lang;

/** Languages worth a chip: those a `latest`-capable source actually declares. */
export function languagesOf(sources: Src[]): { code: string; label: string; count: number }[] {
  const locale = (typeof window === 'undefined' ? 'en' : (storedLocale() ?? detectLocale())) as string;
  const n = new Map<string, number>();
  for (const s of sources) {
    // 'all' and null would otherwise add themselves to all thirty counts and tell you nothing.
    if (!s.lang || s.lang === 'all' || !s.latest || s.status === 'disabled') continue;
    n.set(s.lang, (n.get(s.lang) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([code, count]) => ({ code, label: langName(code, locale), count }))
    .sort((a, b) => (a.code === locale ? -1 : b.code === locale ? 1 : 0) || b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Which sources to actually fetch, and in what order.
 *
 * English on this install is six declared sources plus four universals plus three packs. Fetching thirteen
 * at up to fifteen seconds each is not a plan, and the page that did fetch every one of them opened
 * forty-five concurrent scrapes. Six, best-first:
 *   1. healthy before rate-limited or blocked, because a blocked source is a guaranteed fifteen seconds for
 *      a guaranteed nothing;
 *   2. sources that actually declare the chosen language before the universals, since the chip is the point;
 *   3. registry order after that, which puts the preferred adapters first.
 */
export function budgetFor(sources: Src[], lang: string, max = 6): Src[] {
  return sources
    .filter((s) => s.latest && s.status !== 'disabled' && inGroup(s, lang))
    .sort((a, b) =>
      Number(a.status !== 'ok') - Number(b.status !== 'ok') ||
      Number(a.lang !== lang) - Number(b.lang !== lang))
    .slice(0, max);
}

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
        <div className="bleed hide-scrollbar flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:px-8">
          <span className="shrink-0 pe-1 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Language')}</span>
          {langs.map((l) => (
            <button key={l.code} onClick={() => onLang(l.code)}
              className={`chip shrink-0 whitespace-nowrap text-xs ${l.code === lang ? 'chip-active' : ''}`}>
              {l.label}<span className="ms-1 tabular-nums text-fog-500">{l.count}</span>
            </button>
          ))}
        </div>
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
  });

  // Reported from an effect rather than inside queryFn: a cached hit never runs queryFn, and a source that
  // answered instantly from cache must still release the concurrency gate or the wall stalls behind it.
  useEffect(() => {
    if (isSuccess) onSettled(source.id, data?.content ?? [], true);
    else if (isError) onSettled(source.id, [], false);
  }, [isSuccess, isError, data, source.id, onSettled]);

  return null;
}
