'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { Src, SrcState } from '@/lib/sourceGroups';
export { budgetFor } from '@/lib/sourceGroups';
import { noteFor, retryIn, sourceIcon, iconTint, type ListMode } from '@/lib/sourceGroups';
import { t as tr } from '@/lib/i18n';
import type { Src } from '@/lib/sourceGroups';
import type { SrcState } from '@/lib/sourceGroups';

// Keyed on what `noteFor` decided, not on the raw state, because "empty" is two different things and the
// server is the only one who knows which. `loading` and `off` used to be in here and nothing ever set them.
//
// Now a ring around the icon rather than a separate dot: the icon is the thing you look at, so the health
// belongs on it. Emerald is deliberately absent -- a working source needs no decoration, and ringing all
// twelve green would make the one amber one harder to find, not easier.
const RING = {
  ok: '',
  warn: 'ring-2 ring-amber-400/80',
  quiet: 'ring-1 ring-fog-600/60',
  idle: 'ring-1 ring-ink-600',
};

/**
 * A source's icon.
 *
 * The route always answers with an image: a source with no icon of its own gets a lettered tile rendered
 * server-side, using the same colour hash as `iconTint` below. That is deliberate -- answering 404 and
 * letting the browser fall back meant a console error per iconless source per visit, which the end-to-end
 * run caught as six of them.
 *
 * `onError` therefore only fires if the request itself fails, and is kept as a last resort.
 */
function SourceIcon({ id, name, ring }: { id: string; name: string; ring: string }) {
  const [failed, setFailed] = useState(false);
  const cls = `h-5 w-5 shrink-0 overflow-hidden rounded-[6px] ${ring}`;
  if (failed) {
    return (
      <span aria-hidden className={`${cls} grid place-items-center text-[10px] font-bold text-fog-200`}
        style={{ background: iconTint(name) }}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={sourceIcon(id)} alt="" width={20} height={20} loading="lazy" decoding="async"
    onError={() => setFailed(true)} className={`${cls} bg-ink-700 object-cover`} />;
}

/**
 * Which sources are being asked, and how each one answered.
 *
 * This is the whole filter surface. There was a language rail above it once, which is gone: it made the wall
 * restartable mid-load, and a restart was what stalled it.
 *
 * Filtering here is display-only -- `onSelect` changes which of the ALREADY-LOADED covers are shown and
 * nothing else. Every budgeted source keeps loading regardless. That is what makes tapping instant, and it
 * is also why this cannot reproduce the stall: no bookkeeping is cleared and no child is remounted.
 *
 * Changing MODE is the one thing here that needs new data, and the parent handles it by namespacing its
 * state per mode rather than clearing anything. See the warning on SourceLatest.
 */
export function SourcePicker({ sources, states, settled, total, selected, onSelect, mode, onMode }: {
  sources: Src[];
  states: Record<string, SrcState>;
  settled: number;
  total: number;
  /** The source being shown alone, or null for all of them. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  mode: ListMode;
  onMode: (m: ListMode) => void;
}) {
  const shown = sources.slice(0, 12);
  // The parent namespaces its bookkeeping by listing mode, so a bare id finds nothing here. Getting this
  // wrong is silent: every chip would simply read as "not asked yet" and sit permanently dimmed.
  const stateOf = (id: string): SrcState => states[`${mode}:${id}`] ?? 'idle';
  // Sources that are actually broken, as opposed to merely having nothing new. Two at most: this is a hint
  // under a wall of covers, not an incident report, and the full story lives in Admin.
  const troubled = shown
    .map((s) => ({ s, ...noteFor(s, stateOf(s.id)) }))
    .filter((x) => !!x.note)
    .slice(0, 2);

  return (
    <div className="mt-4 space-y-2.5">
      {/* Wrapping, never a horizontal rail. Two separate tests depend on that: the rails test bans a
          scrollbar-hiding strip here, and the browser layout check measures this page at 390px with a
          one-pixel tolerance. A rail would also be picked up as "the first scrolling element" by the
          end-to-end arrow test, which means for the trending rail below. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Which listing, before which sources -- it changes what the chips beside it can even offer. */}
        <div className="flex items-center gap-1.5 pe-1">
          {(['newest', 'popular'] as const).map((m) => (
            <button key={m} type="button" onClick={() => onMode(m)} aria-pressed={mode === m}
              className={`chip text-xs ${mode === m ? 'chip-active' : ''}`}>
              {m === 'newest' ? tr('Newest') : tr('Popular')}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-ink-700" />
        </div>

        {shown.map((s) => {
          const st = stateOf(s.id);
          const { dot, note } = noteFor(s, st);
          const on = selected === s.id;
          return (
            <button
              key={s.id}
              type="button"
              // Tapping the source already shown clears the filter, matching every other chip in the app.
              onClick={() => onSelect(on ? null : s.id)}
              aria-pressed={on}
              title={note ? `${s.name} — ${note}` : s.name}
              className={`chip max-w-[46vw] text-xs sm:max-w-none ${on ? 'chip-active' : ''} ${st === 'idle' && !on ? 'opacity-55' : ''}`}
            >
              <SourceIcon id={s.id} name={s.name} ring={RING[dot]} />
              <span className="truncate">{s.name}</span>
            </button>
          );
        })}

        {selected && (
          <button type="button" onClick={() => onSelect(null)} className="chip text-xs">
            {tr('Show all')} ×
          </button>
        )}
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
export function SourceLatest({ source, listMode, page, enabled, onSettled }: {
  source: Src;
  listMode: ListMode;
  page: number;
  enabled: boolean;
  /** The key is namespaced by listing mode; the parent stores everything under it. */
  onSettled: (key: string, items: any[], ok: boolean) => void;
}) {
  const { data, isError, isSuccess } = useQuery({
    // The mode is part of the key here for the same reason it is part of the server's cache key: without
    // it the two listings share an entry and whichever loads first answers for both.
    queryKey: ['src-list', listMode, source.id, page],
    // The signal matters more here than anywhere else in the app. Without consuming it, react-query's
    // `removeObserver` takes its non-aborting branch, so a source dropped from the wall keeps scraping:
    // the server spends its full eight-second budget on an answer nobody will read, and a timeout then
    // writes a five-to-thirty-minute cooldown against that source. Abandoning a request used to make the
    // wall worse for the next half hour.
    queryFn: ({ signal }) =>
      api<{ content: any[] }>(
        `/api/sources/${listMode === 'popular' ? 'popular' : 'latest'}?source=${encodeURIComponent(source.id)}&page=${page}`,
        { signal },
      ),
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
    const key = `${listMode}:${source.id}`;
    if (isSuccess) onSettled(key, data?.content ?? [], true);
    else if (isError) onSettled(key, [], false);
  }, [isSuccess, isError, data, source.id, listMode, onSettled]);

  return null;
}
