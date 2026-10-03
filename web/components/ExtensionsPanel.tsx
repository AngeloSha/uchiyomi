'use client';
// Extensions in Admin → Sources (v0.54.0; Admin → Extensions' own tab in v0.53.0): the catalogue an admin adds
// extensions from (Add sources), the actions every extension key runs, and the tools of the list.
//
// Built around discussion #121, a real user lost in a 1,300-extension repository: Browse is its search and language,
// one quiet line (how many match, the repositories as a link, Show 18+ extensions), and the catalogue a page at a time.
// A row says at most one state word and offers at most one key; amber is for a real problem only.
//
// The Installed list that was this tab's other half is Admin → Sources' Your sources since v0.54.0: one list of every
// source of every kind, an extension's among them, each opening its sheet (components/SourceSheet.tsx), whose extension
// part -- its languages, settings, Update and Remove extension -- is components/ExtensionSheet.tsx.
//
// Every sheet is portalled to <body> (components/ui.tsx OnBody): inside a `.card`, whose backdrop blur makes it the
// containing block of anything `fixed`, a sheet covered the card instead of the screen.
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { numberText } from '@/lib/format';
import {
  BROWSE_PAGE, NO_FILTERS, catalogQuery, extLanguageName, languageOptions, narrowed, nextOffset, reasonLine,
  type BrowseFilters, type CatalogExt, type CatalogPage,
} from '@/lib/extensions';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Switch } from '@/components/Switch';
import { ProgressRing } from '@/components/ProgressRing';
import { StatusMark } from '@/components/StatusMark';
import { IcChevronRight, IcGlobe, IcRefresh, IcSearch } from '@/components/icons';
import { Busy, ExtIcon, ExtTags, Facts, busyKey } from '@/components/ExtensionBits';
import { RepoForm } from '@/components/ExtensionRepos';

/** Every query this tab reads, asked again after anything it changes: what is installed and on moves several at once. */
const EXT_KEYS = [['ext-status'], ['ext-installed'], ['ext-catalog'], ['ext-sources'], ['ext-pkg-sources'], ['sources']] as const;

export type ExtAction = 'install' | 'update' | 'uninstall' | 'enable';

/**
 * Install, update, remove and "Turn on its sources", with what each is doing while it runs (by package), "Update
 * all" and "Check for updates". One owner for the toasts, so the rows, the sheet and Browse say the same words.
 */
export function useExtensionActions() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<Record<string, ExtAction | 'all'>>({});
  // Why the last "Check for extension updates" could not read the repositories, until one does: a toast lasts
  // seconds, and an unreachable repository is still unreachable after it.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const mark = (key: string, v: ExtAction | 'all' | null) => setBusy((b) => {
    const n = { ...b };
    if (v) n[key] = v; else delete n[key];
    return n;
  });
  /** Asks every list again; resolves once the ones on screen have answered (a failed refetch resolves too). */
  const refreshAll = () => Promise.all(EXT_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] })));

  /**
   * One extension. Resolves to the server's answer (how many sources it provides), or null when it failed -- and only
   * once the lists on screen have it, so the key stays busy until its row has changed, and a sheet opened next (an
   * install with several languages) opens on them, never on "This extension provides no source." (walk49 at 390
   * caught that: the installed list came back before its sources did).
   */
  const act = async (e: Pick<CatalogExt, 'pkgName' | 'name'>, action: ExtAction): Promise<{ sources: number } | null> => {
    mark(e.pkgName, action);
    // The name is isolated (FSI … PDI): a toast is a plain string, and an extension's own name keeps its own direction
    // inside an Arabic sentence.
    const name = `⁨${e.name}⁩`;
    try {
      const r = await api<{ sources: number; on?: number; hidden?: number }>(`/api/admin/extensions/catalog/${encodeURIComponent(e.pkgName)}`, { json: { action } });
      const leftOff = !r.hidden ? ''
        : r.hidden === 1 ? tr('1 source left off (hidden languages)') : tr('{n} sources left off (hidden languages)', { n: r.hidden });
      const said = action === 'uninstall' ? tr('Removed {name}', { name })
        : action === 'update' ? tr('Updated {name}', { name })
        : action === 'enable'
          ? (r.on === 1 ? tr('Turned on {name} — 1 source ready to search', { name }) : tr('Turned on {name} — {n} sources ready to search', { name, n: r.on ?? 0 }))
          : r.sources === 1 ? tr('Added {name} — 1 source ready to search', { name })
          : r.sources ? tr('Added {name} — {n} sources ready to search', { name, n: r.sources })
          : tr('Added {name}', { name });
      toast(leftOff ? `${said} · ${leftOff}` : said, 'success');
      await refreshAll();
      return r;
    } catch (err) {
      toast(msgOf(err, action === 'uninstall' ? tr('Could not remove {name}', { name })
        : action === 'update' ? tr('Could not update {name}', { name })
        : action === 'enable' ? tr('Could not turn on {name}', { name })
        : tr('Could not add {name}', { name })), 'error');
      return null;
    } finally {
      mark(e.pkgName, null);
    }
  };

  /**
   * Update everything at once: the scheduled check's own run, which re-reads the repositories first (a stale
   * catalogue answered "Everything is already up to date"). The first failure is named with its reason: the reason
   * is usually the repository's, not ours.
   */
  const updateAll = async () => {
    mark('__updateall', 'all');
    try {
      const r = await api<{ updated: string[]; failed: { name: string; reason: string }[] }>('/api/admin/extensions/update-all', { json: {} });
      void refreshAll();
      const n = r.updated.length;
      const updated = n === 1 ? tr('Updated 1 extension') : tr('Updated {n} extensions', { n });
      if (r.failed.length) {
        const why = tr('Could not update {name}: {reason}', { name: `⁨${r.failed[0].name}⁩`, reason: `⁨${r.failed[0].reason}⁩` });
        toast(n ? `${updated} · ${why}` : why, 'error');
      } else {
        toast(n ? updated : tr('Everything is already up to date'), 'success');
      }
    } catch (err) { toast(msgOf(err, tr('Could not update extensions')), 'error'); }
    mark('__updateall', null);
  };

  /** Re-read the repositories: new extensions, and what has an update. The scheduled check does it every few hours too. */
  const refresh = async () => {
    mark('__refresh', 'all');
    try {
      const r = await api<{ count: number }>('/api/admin/extensions/refresh', { json: {} });
      setRefreshError(null);
      void refreshAll();
      void qc.invalidateQueries({ queryKey: ['ext-repos'] });
      toast(r.count === 1 ? tr('Refreshed — 1 extension available') : tr('Refreshed — {n} extensions available', { n: r.count }), 'success');
    } catch (err) {
      setRefreshError(reasonLine(msgOf(err, '')));
      toast(tr('Could not refresh the list'), 'error');
    }
    mark('__refresh', null);
  };

  return { busy, act, updateAll, refresh, refreshAll, refreshError };
}
export type ExtActions = ReturnType<typeof useExtensionActions>;

/**
 * The extension tools of Your sources, at the end of its row of views (v0.53.0's Installed tools): the languages hidden
 * in every extension, and the check for updates. Their words from `sm`; on a phone the icon alone, named for a screen
 * reader and in a tooltip.
 */
export function ExtensionTools({ actions, onLanguages }: { actions: ExtActions; onLanguages: () => void }) {
  const checking = !!actions.busy.__refresh;
  const check = checking ? tr('Checking for updates…') : tr('Check for extension updates');
  return (
    <>
      <button type="button" onClick={onLanguages} aria-label={tr('Languages')} title={tr('Languages')}
        className="btn-key w-8 px-0 sm:w-auto sm:px-3" data-ext-languages>
        <IcGlobe aria-hidden width={15} height={15} />
        <span className="hidden sm:inline">{tr('Languages')}</span>
      </button>
      <button type="button" onClick={actions.refresh} disabled={checking} aria-label={check} title={check}
        className={`btn-key w-8 px-0 sm:w-auto sm:px-3 ${busyKey(checking)}`} data-ext-refresh>
        {checking ? <Busy><span className="hidden sm:inline">{check}</span></Busy>
          : <><IcRefresh aria-hidden width={14} height={14} /><span className="hidden sm:inline">{check}</span></>}
      </button>
    </>
  );
}

/** The amber key, for an update waiting: the one amber action on a row. */
const AMBER_KEY = 'border-amber-500/35 bg-amber-500/10 text-amber-300 hover:border-amber-400/70 hover:text-amber-200';

/**
 * A row's opener. The whole row is its hit area -- the ::after covers the <li> -- and its focus ring is drawn there
 * too. A key in the row is the opener's sibling, raised over that area: pressing it never opens the sheet, and there
 * is no button inside a button.
 */
export const OPENER = 'flex min-w-0 flex-1 items-center gap-3 text-start after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent/60';
/** A row, about 64 px. One that opens a sheet is tinted under the pointer, with no transition. Your sources' rows too. */
export const ROW = 'relative flex min-h-16 min-w-0 items-center gap-3 px-4 py-3';

// ---- Browse ----------------------------------------------------------------------------------------------------

export function BrowseView({ actions, repos, adult, onAdult, onOpen, onRepos }: {
  actions: ExtActions; repos?: string[]; adult: boolean; onAdult: (on: boolean) => void; onOpen: (pkg: string) => void; onRepos: () => void;
}) {
  const [narrow, setF] = useState<BrowseFilters>(NO_FILTERS);
  const f = useMemo<BrowseFilters>(() => ({ ...narrow, adult }), [narrow, adult]);
  const [typed, setTyped] = useState('');
  // The search waits for a pause in the typing: every keystroke was a request for the whole catalogue.
  useEffect(() => {
    const h = setTimeout(() => setF((x) => (x.q === typed ? x : { ...x, q: typed })), 250);
    return () => clearTimeout(h);
  }, [typed]);
  const set = (patch: Partial<BrowseFilters>) => setF((x) => ({ ...x, ...patch }));
  const { data, isError, error, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, refetch, isPlaceholderData } = useInfiniteQuery({
    queryKey: ['ext-catalog', f],
    queryFn: ({ pageParam }) => api<CatalogPage>(`/api/admin/extensions/catalog?${catalogQuery(f, pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last) => nextOffset(last),
    // A new filter keeps the list it replaces on screen until its first page lands, rather than flashing empty.
    placeholderData: keepPreviousData,
  });
  const first = data?.pages[0];
  const rows = data?.pages.flatMap((p) => p.content) ?? [];
  const options = useMemo(() => languageOptions(first?.langs ?? []), [first?.langs]);

  // The next page loads as the end of the list comes near, with "Show more" under it for anyone who gets there first
  // (and for a screen reader, which has no scroll to watch).
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((seen) => {
      if (seen[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const install = async (e: CatalogExt) => {
    const r = await actions.act(e, 'install');
    // An extension with a source per language opens on its languages at once: installing switched on every one that
    // is not hidden, and choosing the ones you read is the next step (and the one that keeps under the source limit).
    if (r && r.sources > 1) onOpen(e.pkgName);
  };

  const noRepos = !!repos && repos.length === 0;
  const firstRun = noRepos && !!first && first.total === 0;
  const counted = !!first && first.matched > 0;
  return (
    <div className="space-y-3" data-ext-browse>
      {firstRun ? (
        <div className="card grad-border p-4 lg:p-5" data-ext-first-run>
          <p className="font-display text-lg font-semibold text-fog-50">{tr('Add an extension repository')}</p>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-fog-400">
            {tr('An extension repository is a list of extensions that someone publishes. Uchiyomi doesn’t host any, so you add one you trust.')}
          </p>
          <div className="mt-3 max-w-2xl"><RepoForm /></div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">{tr('Search extensions…')}</span>
              <IcSearch aria-hidden width={16} height={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-fog-500" />
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={tr('Search extensions…')} enterKeyHint="search"
                autoCapitalize="none" autoCorrect="off" spellCheck={false} data-ext-search
                className="field max-w-none ps-9" />
            </label>
            <select value={f.lang} onChange={(e) => set({ lang: e.target.value })} aria-label={tr('Language')} className="field sm:w-56" data-ext-lang>
              {options.map((o) => <option key={o.value || 'any'} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* One quiet line under them: how many match, the repositories they come from -- a link to their sheet, in
              place of a Repositories key -- and the 18+ switch. No filter chips: Installed and Has an update were the
              Installed tab again. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-fog-500" data-ext-count-line>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
              {counted && (
                <span className="tabular-nums" data-ext-count>
                  {first.matched === 1 ? tr('1 extension matches') : tr('{n} extensions match', { n: numberText(first.matched) })}
                </span>
              )}
              {isFetching && !isFetchingNextPage && <ProgressRing progress="spin" size={12} tone="muted" />}
              {counted && <span aria-hidden>·</span>}
              {/* Counted once the list has answered; reachable before that, and if it never does. */}
              <button type="button" onClick={onRepos} className="text-accent hover:underline" data-ext-repos>
                {!repos ? tr('Repositories') : repos.length === 1 ? tr('1 repository') : tr('{n} repositories', { n: numberText(repos.length) })}
              </button>
            </p>
            {/* A switch with its words, not a chip reading "18+": that read as "only 18+" (#121), and off it hides them. */}
            <label className="ms-auto flex items-center gap-2 text-fog-300" data-ext-adult>
              <Switch on={f.adult} onChange={onAdult} label={tr('Show 18+ extensions')} />
              <span>{tr('Show 18+ extensions')}</span>
            </label>
          </div>

          {noRepos && (
            <p className="text-[12px] text-amber-300/90">{tr('No extension repository yet — add one to see extensions')} ·{' '}
              <button type="button" onClick={onRepos} className="text-accent hover:underline">{tr('Repositories')}</button>
            </p>
          )}

          {isError ? (
            <div className="card px-4 py-6 text-center" data-ext-browse-error>
              <p className="text-sm font-medium text-fog-100">{tr('Could not read the extension list')}</p>
              <p dir="auto" className="mx-auto mt-1 line-clamp-3 max-w-md break-words text-[12px] text-fog-500">{reasonLine(msgOf(error, '')) || tr('The extension engine did not answer. Try again in a moment.')}</p>
              <button type="button" onClick={() => void refetch()} className="btn-key btn-key-primary mt-3">{tr('Try again')}</button>
            </div>
          ) : !first ? (
            <div className="card divide-y divide-ink-800/70 overflow-hidden rounded-2xl" aria-busy="true">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex h-16 items-center gap-3 px-4"><div className="skeleton h-10 w-10 rounded-xl" /><div className="skeleton h-3 w-40 rounded" /></div>)}
            </div>
          ) : rows.length === 0 ? (
            <NothingFound f={f} hiddenAdult={first.hiddenAdult} total={first.total} onClear={() => { setTyped(''); setF(NO_FILTERS); }}
              onAdult={() => onAdult(true)} />
          ) : (
            <>
              <ul className={`card grad-border divide-y divide-ink-800/70 overflow-hidden rounded-2xl transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`} data-ext-list>
                {rows.map((e) => (
                  <BrowseRow key={e.pkgName} e={e} busy={actions.busy[e.pkgName]} onInstall={() => void install(e)}
                    onUpdate={() => void actions.act(e, 'update')} onOpen={() => onOpen(e.pkgName)} />
                ))}
              </ul>
              <div ref={sentinel} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <p className="text-[12px] tabular-nums text-fog-500" data-ext-showing>
                  {tr('Showing {shown} of {matched}', { shown: numberText(rows.length), matched: numberText(first.matched) })}
                </p>
                {hasNextPage && (
                  <button type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="btn-key" data-ext-more>
                    {isFetchingNextPage ? <Busy tone="muted">{tr('Loading…')}</Busy> : tr('Show {n} more', { n: numberText(Math.min(BROWSE_PAGE, first.matched - rows.length)) })}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Nothing matches: what was asked, the way back, and the 18+ extensions it would have found, if any. */
function NothingFound({ f, hiddenAdult, total, onClear, onAdult }: {
  f: BrowseFilters; hiddenAdult: number; total: number; onClear: () => void; onAdult: () => void;
}) {
  const q = f.q.trim();
  return (
    <div className="card px-4 py-8 text-center" data-ext-nothing>
      <p className="text-sm font-medium text-fog-100">
        {total === 0 ? tr('No extensions yet — add a repository above to see what’s available.')
          : q ? <>{tr('No extension matches “{q}”', { q: '⁨' + q + '⁩' })}</>
          : tr('No extension matches these filters')}
      </p>
      {hiddenAdult > 0 && (
        <p className="mx-auto mt-1.5 max-w-sm text-[12px] text-fog-400" data-ext-hidden-adult>
          {hiddenAdult === 1 ? tr('An 18+ extension matches. It is hidden while Show 18+ extensions is off.')
            : tr('{n} 18+ extensions match. They are hidden while Show 18+ extensions is off.', { n: hiddenAdult })}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {hiddenAdult > 0 && <button type="button" onClick={onAdult} className="btn-key btn-key-primary">{tr('Show 18+ extensions')}</button>}
        {narrowed(f) && <button type="button" onClick={onClear} className="btn-key">{tr('Clear filters')}</button>}
      </div>
    </div>
  );
}

/**
 * One extension of the catalogue: icon, name and its marks, language and version, and at the end what it is to you.
 * Not installed: Install, one press, the key turning into a small ring and its words while the engine downloads and
 * converts it. Installed: "Already installed" and a chevron, and the row opens its sheet -- or, with an update
 * waiting, the amber Update.
 */
function BrowseRow({ e, busy, onInstall, onUpdate, onOpen }: {
  e: CatalogExt; busy?: ExtAction | 'all'; onInstall: () => void; onUpdate: () => void; onOpen: () => void;
}) {
  const head = (
    <>
      <ExtIcon url={e.iconUrl} name={e.name} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <bdi dir="auto" className="truncate text-sm font-medium text-fog-100">{e.name}</bdi>
          <ExtTags e={e} />
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-fog-500"><Facts items={[extLanguageName(e.lang), e.versionName ? `v${e.versionName}` : null]} /></span>
      </span>
    </>
  );
  return (
    <li data-ext-item={e.pkgName} className={`${ROW} ${e.installed ? 'hover:bg-ink-800/40' : ''}`}>
      {e.installed ? (
        <button type="button" onClick={onOpen} className={OPENER} data-ext-open>
          {head}
          {!e.hasUpdate && (
            <>
              {/* Words where there is room; the check alone on a phone, named for a screen reader. */}
              <span className="hidden shrink-0 sm:inline-flex"><StatusMark tone="ok" label={tr('Already installed')} size="md" /></span>
              <span className="inline-flex shrink-0 sm:hidden"><StatusMark tone="ok" title={tr('Already installed')} size="md" /></span>
              <IcChevronRight aria-hidden width={16} height={16} className="shrink-0 text-fog-600 rtl:-scale-x-100" />
            </>
          )}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{head}</span>
      )}
      {!e.installed ? (
        // The accent without its fill: a page of sixty would be a column of sixty bright buttons.
        <button type="button" onClick={onInstall} disabled={!!busy} className={`btn-key btn-key-accent min-w-[5.5rem] ${busyKey(busy === 'install')}`} data-ext-install>
          {busy === 'install' ? <Busy>{tr('Installing…')}</Busy> : tr('Install')}
        </button>
      ) : e.hasUpdate ? (
        <button type="button" onClick={onUpdate} disabled={!!busy} className={`btn-key relative ${AMBER_KEY} ${busyKey(busy === 'update')}`} data-ext-update>
          {busy === 'update' ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update')}
        </button>
      ) : null}
    </li>
  );
}
