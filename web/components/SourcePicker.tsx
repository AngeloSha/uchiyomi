'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type { Src, SrcState } from '@/lib/sourceGroups';
export { budgetFor } from '@/lib/sourceGroups';
import { noteFor, sourceIcon, iconTint, type ListMode } from '@/lib/sourceGroups';
import { t as tr } from '@/lib/i18n';
import type { Src } from '@/lib/sourceGroups';
import type { SrcState } from '@/lib/sourceGroups';
import { SourceListSheet } from '@/components/SourceListSheet';
import { SourcesExplainer } from '@/components/SourcesExplainer';

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
export function SourceIcon({ id, name, ring = '', size = 20, registered = true }: {
  id: string;
  name: string;
  ring?: string;
  /** 16 for a caption or a chip, 20 for a row in the add dialog, 24 for a sheet row. */
  size?: 16 | 20 | 24;
  /**
   * `false` for a source the server no longer loads (an extension removed since the series was added):
   * the image route answers 404 for it, so the lettered tile is drawn straight away rather than after a
   * failed request per visit.
   */
  registered?: boolean;
}) {
  const [failed, setFailed] = useState(!registered);
  const box = size === 16 ? 'h-4 w-4 rounded-[4px]' : size === 24 ? 'h-6 w-6 rounded-[7px]' : 'h-5 w-5 rounded-[6px]';
  const cls = `${box} shrink-0 overflow-hidden ${ring}`;
  if (failed) {
    return (
      <span aria-hidden className={`${cls} grid place-items-center text-[10px] font-bold text-fog-200`}
        style={{ background: iconTint(name) }}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={sourceIcon(id)} alt="" width={size} height={size} loading="lazy" decoding="async"
    onError={() => setFailed(true)} className={`${cls} bg-ink-700 object-cover`} />;
}

/**
 * Which sources are being asked, and how each one answered -- as one chip, with the list behind it.
 *
 * This is the whole filter surface. There was a language rail above it once, which is gone: it made the wall
 * restartable mid-load, and a restart was what stalled it. Then there was a wall of up to twelve chips with
 * two note lines under it, which is gone too: on a phone it was more text than the covers it introduced,
 * and the owner's complaint was exactly that -- "all this sources business is ruining the UX". One chip
 * says "All sources · 8 sources · 1 with issues"; tapping it opens `SourceListSheet`, where each source has
 * its health and the server's reason, and a tap there browses that source alone. With one selected the chip
 * becomes its name (tap: the sheet again) beside a × that clears.
 *
 * Filtering here is display-only -- `onSelect` changes which of the ALREADY-LOADED covers are shown and
 * nothing else. Every budgeted source keeps loading regardless. That is what makes tapping instant, and it
 * is also why this cannot reproduce the stall: no bookkeeping is cleared and no child is remounted.
 *
 * Changing MODE is the one thing here that needs new data, and the parent handles it by namespacing its
 * state per mode rather than clearing anything. See the warning on SourceLatest.
 */
export function SourcePicker({ sources, states, settled, total, count, selected, onSelect, mode, onMode }: {
  sources: Src[];
  states: Record<string, SrcState>;
  settled: number;
  total: number;
  /**
   * The number the chip says: every source that can answer this listing, not `sources.length`. The budget
   * the parent passes as `sources` starts at six and widens by one for every source that answers with
   * nothing, so a count taken from it would tick upward while the wall loads -- a number that changes by
   * itself reads as a bug. Nor the parent's ranked list, which is capped at twelve: "12 sources" over a
   * 14-source install was the first thing a reviewer read off the chip. The sheet still lists only the
   * sources actually being asked, and its footer says "Asking {n} of {m}" so the two surfaces agree.
   */
  count: number;
  /** The source being shown alone, or null for all of them. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  mode: ListMode;
  onMode: (m: ListMode) => void;
}) {
  const shown = sources.slice(0, 12);
  // The parent namespaces its bookkeeping by listing mode, so a bare id finds nothing here. Getting this
  // wrong is silent: every row would simply read as "not asked yet" and sit permanently dimmed.
  const stateOf = (id: string): SrcState => states[`${mode}:${id}`] ?? 'idle';
  // Sources that are actually broken, as opposed to merely having nothing new. A count on the chip, in
  // amber; the sentences themselves live in the sheet, and the full story in Admin. Counted by the DOT the
  // sheet lights, not by whether a sentence exists: the two used to differ (a failure without a server note
  // had the dot and no sentence), so the chip said "2 with issues" over three amber rows.
  const troubled = shown.filter((s) => noteFor(s, stateOf(s.id)).dot === 'warn').length;
  // `selected` always names a budgeted source (the parent clears it on a mode change and the budget only
  // grows), but the × must stay reachable even if it ever did not, or the wall could not be un-filtered.
  const current = selected ? sources.find((s) => s.id === selected) ?? { id: selected, name: selected } : null;
  // Which sheet is up. The explainer REPLACES the list rather than stacking on it: both are `Sheet`s at the
  // same z-index, each with its own Escape listener, so stacked they would close together on one key and
  // their two backdrops would sit near-black. Closing the explainer brings the list back.
  const [sheet, setSheet] = useState<'list' | 'explainer' | null>(null);

  return (
    <div className="mt-4 space-y-2.5">
      {/* Wrapping, never a horizontal rail. Two separate tests depend on that: the rails test bans a
          scrollbar-hiding strip here, and the browser layout check measures this page at 390px with a
          one-pixel tolerance. A rail would also be picked up as "the first scrolling element" by the
          end-to-end arrow test, which means for the trending rail below. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Which listing, before which sources -- it changes what the chip beside it can even offer. */}
        <div className="flex items-center gap-1.5 pe-1">
          {(['newest', 'popular'] as const).map((m) => (
            <button key={m} type="button" onClick={() => onMode(m)} aria-pressed={mode === m}
              className={`chip text-xs ${mode === m ? 'chip-active' : ''}`}>
              {m === 'newest' ? tr('Newest') : tr('Popular')}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-ink-700" />
        </div>

        {current ? (
          // Two SIBLING buttons, never a × inside the chip: a button inside a button is invalid DOM, and on
          // a touchscreen the inner one is unreachable half the time.
          <span className="inline-flex items-center gap-1">
            <button type="button" onClick={() => setSheet('list')} aria-haspopup="dialog" aria-pressed
              className="chip chip-active max-w-[46vw] text-xs sm:max-w-none">
              <SourceIcon id={current.id} name={current.name} size={16} />
              <span className="truncate">{current.name}</span>
            </button>
            <button type="button" onClick={() => onSelect(null)} aria-label={tr('Show all')}
              className="chip chip-active px-2.5 text-xs">
              ×
            </button>
          </span>
        ) : shown.length > 0 && (
          <button type="button" onClick={() => setSheet('list')} aria-haspopup="dialog" className="chip text-xs">
            {/* Three favicons stacked, the way the group avatars stack on a series page: recognisable as
                "several", without naming any. The ring is the chip's own ground so the overlap reads. */}
            <span className="inline-flex items-center">
              {shown.slice(0, 3).map((s, i) => (
                <span key={s.id} className={`inline-flex ${i > 0 ? '-ms-1.5' : ''}`}>
                  <SourceIcon id={s.id} name={s.name} size={16} ring="ring-1 ring-ink-900" />
                </span>
              ))}
            </span>
            <span>{tr('All sources')}</span>
            <span className="text-fog-500">· {tr('{n} sources', { n: count })}</span>
            {troubled > 0 && <span className="text-amber-300">· {tr('{n} with issues', { n: troubled })}</span>}
          </button>
        )}
      </div>

      {settled < total && (
        <div className="h-px w-full overflow-hidden bg-ink-700">
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${(settled / Math.max(1, total)) * 100}%` }} />
        </div>
      )}

      {sheet === 'list' && (
        <SourceListSheet sources={shown} total={count} stateOf={stateOf} selected={selected} onSelect={onSelect}
          onExplain={() => setSheet('explainer')} onClose={() => setSheet(null)} />
      )}
      {sheet === 'explainer' && <SourcesExplainer onClose={() => setSheet('list')} />}
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
