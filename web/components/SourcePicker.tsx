'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { Src, SrcState } from '@/lib/sourceGroups';
export { budgetFor } from '@/lib/sourceGroups';
import { noteFor, retryIn } from '@/lib/sourceGroups';
import type { Src } from '@/lib/sourceGroups';
import type { SrcState } from '@/lib/sourceGroups';

// Keyed on what `noteFor` decided, not on the raw state, because "empty" is two different things and the
// server is the only one who knows which. `loading` and `off` used to be in here and nothing ever set them.
const DOT = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  quiet: 'bg-fog-600',
  idle: 'bg-ink-500',
};

/**
 * Which sources are being asked, and how each one answered.
 *
 * This is the whole filter surface now. There was a language rail above it, which is gone: it made the wall
 * restartable mid-load, and a restart was what stalled it.
 */
export function SourcePicker({ sources, states, settled, total }: {
  sources: Src[];
  states: Record<string, SrcState>;
  settled: number;
  total: number;
}) {
  const shown = sources.filter((s) => s.latest).slice(0, 12);
  // Sources that are actually broken, as opposed to merely having nothing new. Two at most: this is a hint
  // under a wall of covers, not an incident report, and the full story lives in Admin.
  const troubled = shown
    .map((s) => ({ s, ...noteFor(s, states[s.id] ?? 'idle') }))
    .filter((x) => !!x.note)
    .slice(0, 2);

  return (
    <div className="mt-4 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((s) => {
          const st = states[s.id] ?? 'idle';
          const { dot, note } = noteFor(s, st);
          return (
            <span key={s.id} title={note ? `${s.name} — ${note}` : s.name}
              className={`chip max-w-[46vw] cursor-default text-xs sm:max-w-none ${st === 'idle' ? 'opacity-55' : ''}`}>
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[dot]}`} />
              <span className="truncate">{s.name}</span>
            </span>
          );
        })}
      </div>

      {/* `title` is invisible on a touchscreen, which is most of this app's use, so the reason also has to
          exist as text. Without this the amber dot would be one more colour nobody can interpret. */}
      {troubled.map(({ s, note }) => {
        const when = retryIn(s);
        return (
          <p key={s.id} className="text-[11px] leading-relaxed text-fog-500">
            <span className="text-fog-400">{s.name}</span>: {note}{when ? ` (${when})` : ''}
          </p>
        );
      })}

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
 *
 * ⚠ If the parent ever clears its settle bookkeeping again, it MUST also change these children's React key
 * so they remount. That combination is what caused the stall this component was rewritten to fix: a source
 * present both before and after a reset kept its key, so it never unmounted; its query still held cached
 * data, so `isSuccess` and `data` never changed identity, so the effect below never re-ran; and the parent
 * had just forgotten it. `settled` could then never reach `budget.length`, leaving skeleton tiles on screen
 * forever and killing infinite scroll for the rest of the session.
 */
export function SourceLatest({ source, page, enabled, onSettled }: {
  source: Src;
  page: number;
  enabled: boolean;
  onSettled: (id: string, items: any[], ok: boolean) => void;
}) {
  const { data, isError, isSuccess } = useQuery({
    queryKey: ['src-latest', source.id, page],
    // The signal matters more here than anywhere else in the app. Without consuming it, react-query's
    // `removeObserver` takes its non-aborting branch, so a source dropped from the wall keeps scraping:
    // the server spends its full eight-second budget on an answer nobody will read, and a timeout then
    // writes a five-to-thirty-minute cooldown against that source. Abandoning a request used to make the
    // wall worse for the next half hour.
    queryFn: ({ signal }) =>
      api<{ content: any[] }>(`/api/sources/latest?source=${encodeURIComponent(source.id)}&page=${page}`, { signal }),
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
