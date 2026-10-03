'use client';
// Admin → Extensions (v0.53.0): the engine's state on top, then Installed | Browse.
//
// Built around what people come here to do, in that order: see that the engine and its Cloudflare helper work (and
// fix them in one press when they do not); find an extension and install it; choose which of its languages are on;
// keep extensions updated; switch a source on or off; change an extension's settings; and, rarely, manage the
// repositories. The old tab was one card that did all of it in one column -- repositories, a languages panel, a cap
// line, an update line and a 400-row list capped with "narrow the search" -- and discussion #121 is a real user
// getting lost in it (lib/extensions.ts lists what went wrong).
//
// Round 2 is the same tab decluttered, after the owner found round 1 "still too cluttered": it said one thing three
// times (an amber bar, amber words on each row it meant, a filled key on each), warned in amber everywhere, and put
// a hint line, two keys and two bars before the first extension. Now:
// - on top, a slim strip (components/EngineSetup.tsx EngineReady), and Installed's two tools sit at the end of the
//   views' row;
// - Installed is one list -- grouped into "Needs attention" and "Ready" only while something needs someone, with
//   Update all and Turn on all in that group's header -- and a row says at most one state word and offers at most
//   one key (lib/extensions.ts rowKey / rowWord), the rest of it opening the extension's sheet;
// - Browse is its search and language, one quiet line (how many match, the repositories as a link, Show 18+
//   extensions), and the catalogue a page at a time: its Installed and Has an update chips were the Installed tab.
// Amber is for a real problem only, and the one filled accent key on the screen is Connect.
//
// Every sheet is portalled to <body> (components/ui.tsx OnBody): inside a `.card`, whose backdrop blur makes it the
// containing block of anything `fixed`, a sheet covered the card instead of the screen.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useReduceEffects } from '@/lib/effects';
import { isDesktop } from '@/lib/desktop';
import { numberText } from '@/lib/format';
import {
  BROWSE_PAGE, NO_FILTERS, browseCount, catalogQuery, extLanguageName, extLanguagesText, initialView, installedGroups, installedList, langTag,
  languageOptions, languagesOnText, narrowed, needsTurningOn, nextOffset, reasonLine, rowKey, rowWord,
  type BrowseFilters, type CatalogExt, type CatalogPage, type ExtSourcesAnswer, type ExtStatus, type ExtView, type InstalledExt,
} from '@/lib/extensions';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { OnBody } from '@/components/ui';
import { Switch } from '@/components/Switch';
import { ProgressRing } from '@/components/ProgressRing';
import { StatusGlyph, StatusMark } from '@/components/StatusMark';
import { IcChevronRight, IcGlobe, IcRefresh, IcSearch } from '@/components/icons';
import { EngineInstall } from '@/components/EngineInstall';
import { EngineReady, EngineSetup } from '@/components/EngineSetup';
import { ExtensionSettings, useExtensionSettingsParam } from '@/components/ExtensionSettings';
import { ExtensionSheet } from '@/components/ExtensionSheet';
import { Busy, ExtIcon, ExtTags, Facts, busyKey } from '@/components/ExtensionBits';
import { LanguagesSheet } from '@/components/ExtensionLanguages';
import { RepoForm, ReposSheet } from '@/components/ExtensionRepos';

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

export function ExtensionsPanel({ onProviders }: { onProviders?: () => void }) {
  // The deep link to an extension's settings (`?settings=<source id>`) is read before anything returns: a hook after
  // an early return is a hook that is sometimes not called.
  const [settingsFor, setSettingsFor] = useExtensionSettingsParam();
  const { data: status } = useQuery({ queryKey: ['ext-status'], queryFn: () => api<ExtStatus>('/api/admin/extensions/status') });
  const ready = !!status?.configured && !!status?.reachable;

  if (!status) return <div className="skeleton h-32 rounded-3xl" aria-busy="true" />;
  // Uchiyomi Desktop: the engine is a download on first use, not a container -- until the server can reach it, the
  // card is the download (components/EngineInstall.tsx). The server build never takes this branch.
  if (isDesktop() && !ready) return <EngineInstall />;
  // Off (EXTENSION_ENGINE=0), not set up, or not answering: the state and the steps for this platform (#72).
  if (!ready) return <EngineSetup status={status} />;
  return (
    <div className="space-y-6" data-extensions>
      <ExtensionLists status={status} onProviders={onProviders} />
      {settingsFor && <ExtensionSettings target={settingsFor} onClose={() => setSettingsFor(null)} />}
    </div>
  );
}

/** Which of the two views, from `?view=` once on arrival and written back on a switch (lib/useTabParam.ts's rule). */
function useViewParam(installedCount: number | undefined): [ExtView, (v: ExtView) => void] {
  const params = useSearchParams();
  const [picked, setPicked] = useState<ExtView | null>(() => initialView(params.get('view'), undefined));
  // Decided once, from the first count: a first repository's install must not move someone from Browse to Installed.
  useEffect(() => {
    if (picked === null && installedCount !== undefined) setPicked(initialView(null, installedCount));
  }, [picked, installedCount]);
  const view = picked ?? initialView(null, installedCount) ?? 'installed';
  const set = (v: ExtView) => {
    setPicked(v);
    const u = new URL(window.location.href);
    u.searchParams.set('view', v);
    window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
  };
  return [view, set];
}

function ExtensionLists({ status, onProviders }: { status: ExtStatus; onProviders?: () => void }) {
  const actions = useExtensionActions();
  // Installed extensions, 18+ ones included (an installed extension is always listed), and every source they provide.
  const { data: inst, isError: instFailed } = useQuery({
    queryKey: ['ext-installed'],
    queryFn: () => api<CatalogPage>('/api/admin/extensions/catalog?installed=true&nsfw=true&limit=400'),
  });
  const { data: srcs } = useQuery({ queryKey: ['ext-sources'], queryFn: () => api<ExtSourcesAnswer>('/api/admin/extensions/sources') });
  const { data: repos } = useQuery({ queryKey: ['ext-repos'], queryFn: () => api<{ content: string[] }>('/api/admin/extensions/repos') });
  const installed = useMemo(() => installedList(inst?.content ?? [], srcs?.content ?? []), [inst, srcs]);
  const [view, setView] = useViewParam(inst ? inst.installed : undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'repos' | 'langs' | null>(null);
  // Show 18+ extensions lives here, not in Browse: the Browse tab counts what the list holds, so it follows the switch.
  const [adult, setAdult] = useState(false);
  const opened = open ? installed.find((e) => e.pkgName === open) ?? null : null;

  return (
    <>
      <EngineReady status={status} desktop={isDesktop()} />
      <section aria-label={tr('Extensions')} className="space-y-4">
        {/* One row: the two views, and at its end Installed's two tools -- in place of a hint line and two keys over the
            list. The rule under the row is the row's, so the tools sit on it too. Russian's "Установленные" at 390 pushed
            the tools 7 px into the gutter: the tabs are a size smaller on a phone, and the tools wrap rather than
            overflow when the words and counts are longer still. */}
        <div className="flex flex-wrap items-end justify-between gap-x-3 border-b border-ink-800/80">
          <ViewTabs view={view} onView={setView} installed={inst?.installed} total={inst ? browseCount(inst, adult) : undefined} updates={inst?.updatable ?? 0} />
          {view === 'installed' && <InstalledTools actions={actions} onLanguages={() => setSheet('langs')} />}
        </div>
        {view === 'installed' ? (
          <InstalledView list={installed} loading={!inst || !srcs} failed={instFailed} actions={actions}
            onOpen={setOpen} onBrowse={() => setView('browse')} />
        ) : (
          <BrowseView actions={actions} repos={repos?.content} adult={adult} onAdult={setAdult} onOpen={setOpen} onRepos={() => setSheet('repos')} />
        )}
      </section>
      {opened && (
        <OnBody>
          <ExtensionSheet ext={opened} status={status} hiddenLangs={srcs?.hiddenLangs ?? []} actions={actions}
            onClose={() => setOpen(null)} onLanguages={() => { setOpen(null); setSheet('langs'); }} onProviders={onProviders} />
        </OnBody>
      )}
      {sheet === 'repos' && <OnBody><ReposSheet repos={repos?.content ?? []} onClose={() => setSheet(null)} /></OnBody>}
      {sheet === 'langs' && <OnBody><LanguagesSheet onClose={() => setSheet(null)} /></OnBody>}
    </>
  );
}

/**
 * Installed | Browse: two text tabs with an accent underline sliding between them, as Library → Series | Downloads
 * has it -- no capsule. Each says how many: the extensions installed (never their sources: #121's "I added only 12"),
 * and the whole catalogue. The underline slides only when motion is welcome.
 */
function ViewTabs({ view, onView, installed, total, updates }: {
  view: ExtView; onView: (v: ExtView) => void; installed?: number; total?: number; updates: number;
}) {
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const tabs: Array<[ExtView, string, number | undefined]> = [['installed', tr('Installed'), installed], ['browse', tr('Browse'), total]];
  return (
    <div role="tablist" aria-label={tr('Extensions')} className="flex items-end gap-5 sm:gap-6">
      {tabs.map(([v, label, n]) => {
        const on = v === view;
        return (
          <button key={v} type="button" role="tab" aria-selected={on} data-ext-view={v} onClick={() => { if (!on) onView(v); }}
            className={`relative -mb-px flex items-center gap-1.5 whitespace-nowrap pb-2 pt-1 font-display text-[15px] font-semibold transition-colors sm:text-base ${on ? 'text-fog-50' : 'text-fog-500 hover:text-fog-200'}`}>
            {label}
            {typeof n === 'number' && <span className="text-[13px] font-medium tabular-nums text-fog-500 sm:text-sm">{numberText(n)}</span>}
            {/* An update waiting, told from Browse with a small amber mark on Installed. On Installed itself its group
                header says so already, and a third mark for one fact was round 1's clutter. */}
            {v === 'installed' && !on && updates > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
            {on && (
              <motion.span layoutId="extview" aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-sm bg-accent"
                transition={plain || still ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Installed's two tools, at the end of the views' row: the languages hidden in every extension, and the check for
 * updates. Their words from `sm`; on a phone the icon alone, named for a screen reader and in a tooltip.
 */
function InstalledTools({ actions, onLanguages }: { actions: ExtActions; onLanguages: () => void }) {
  const checking = !!actions.busy.__refresh;
  const check = checking ? tr('Checking for updates…') : tr('Check for extension updates');
  return (
    <div className="ms-auto flex shrink-0 gap-1.5 pb-2 sm:gap-2">
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
    </div>
  );
}

// ---- Installed -------------------------------------------------------------------------------------------------

/** The amber key, for an update waiting: the one amber action on the screen. */
const AMBER_KEY = 'border-amber-500/35 bg-amber-500/10 text-amber-300 hover:border-amber-400/70 hover:text-amber-200';

function InstalledView({ list, loading, failed, actions, onOpen, onBrowse }: {
  list: InstalledExt[]; loading: boolean; failed: boolean; actions: ExtActions;
  onOpen: (pkg: string) => void; onBrowse: () => void;
}) {
  const { busy, act, updateAll } = actions;
  const off = list.filter(needsTurningOn);
  const updates = list.filter((e) => e.hasUpdate).length;
  // Every one of them in turn: one route call each, as its own row's key would make.
  const [allOn, setAllOn] = useState(false);
  const turnAllOn = async () => {
    setAllOn(true);
    for (const e of off) await act(e, 'enable');
    setAllOn(false);
  };
  return (
    <div className="space-y-5" data-ext-installed>
      {/* A repository that did not answer: said under the row whose key asked, with the engine's own words. */}
      {actions.refreshError !== null && (
        <p role="alert" className="text-[12px] leading-relaxed text-amber-300" data-ext-refresh-error>
          {tr('Could not reach the repositories to check for updates.')}
          {actions.refreshError && <span dir="auto" className="ms-1 line-clamp-2 break-words text-amber-200/70">{actions.refreshError}</span>}
        </p>
      )}

      {failed ? (
        <div className="card px-4 py-6 text-center" data-ext-installed-error>
          <p className="text-sm font-medium text-fog-100">{tr('Could not read the extension list')}</p>
          <p className="mx-auto mt-1 max-w-sm text-[12px] text-fog-500">{tr('The extension engine did not answer. Try again in a moment.')}</p>
        </div>
      ) : loading ? (
        <div className="card divide-y divide-ink-800/70 overflow-hidden rounded-2xl" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex h-16 items-center gap-3 px-4"><div className="skeleton h-10 w-10 rounded-xl" /><div className="skeleton h-3 w-40 rounded" /></div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-10 text-center" data-ext-installed-empty>
          <p className="font-display text-lg font-semibold text-fog-50">{tr('No extensions installed yet')}</p>
          <p className="mt-1 max-w-sm text-sm text-fog-400">{tr('Find one in Browse and install it with one press. Its sources are on at once, ready to search from Discover.')}</p>
          <button type="button" onClick={onBrowse} className="btn-key btn-key-accent mt-4">{tr('Browse extensions')}</button>
        </div>
      ) : (
        // One column at every width, one card: a two-column grid of cards made rows of uneven height.
        installedGroups(list).map((g) => (
          <section key={g.key} data-ext-group={g.key} className="space-y-2">
            {g.key !== 'all' && (
              <GroupHead title={g.key === 'attention'
                ? (g.list.length === 1 ? tr('Needs attention · 1') : tr('Needs attention · {n}', { n: g.list.length }))
                : (g.list.length === 1 ? tr('Ready · 1') : tr('Ready · {n}', { n: g.list.length }))}>
                {/* What used to be the update bar and the no-source bar: their keys, where the rows they act on start. */}
                {g.key === 'attention' && updates > 0 && (
                  <button type="button" onClick={updateAll} disabled={!!busy.__updateall} data-ext-update-all
                    className={`btn-key ${AMBER_KEY} ${busyKey(!!busy.__updateall)}`}>
                    {busy.__updateall ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update all')}
                  </button>
                )}
                {g.key === 'attention' && off.length > 1 && (
                  <button type="button" onClick={turnAllOn} disabled={allOn} className={`btn-key btn-key-accent ${busyKey(allOn)}`} data-ext-turn-on-all>
                    {allOn ? <Busy>{tr('Turning on…')}</Busy> : tr('Turn on all')}
                  </button>
                )}
              </GroupHead>
            )}
            <ul className="card grad-border divide-y divide-ink-800/70 overflow-hidden rounded-2xl" data-ext-list-installed>
              {g.list.map((e) => <InstalledRow key={e.pkgName} e={e} busy={busy[e.pkgName]} onOpen={() => onOpen(e.pkgName)} act={act} />)}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** A group's header: its name and count, and the keys for all of it. */
function GroupHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-0.5" data-ext-group-head>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fog-500 rtl:tracking-normal">{title}</h3>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/**
 * A row's opener. The whole row is its hit area -- the ::after covers the <li> -- and its focus ring is drawn there
 * too. A key in the row is the opener's sibling, raised over that area: pressing it never opens the sheet, and there
 * is no button inside a button.
 */
const OPENER = 'flex min-w-0 flex-1 items-center gap-3 text-start after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent/60';
/** A row, about 64 px. One that opens a sheet is tinted under the pointer, with no transition: round 2 adds no motion. */
const ROW = 'relative flex min-h-16 min-w-0 items-center gap-3 px-4 py-3';

/**
 * One installed extension: its icon, name and marks, "{language} · v{version}" and at most one state word, and at
 * most one key -- Turn on when none of its sources is on, else Update when one waits (lib/extensions.ts rowKey).
 * With nothing waiting, its languages (from `sm`), how many are on and a chevron instead. The row opens its sheet.
 */
function InstalledRow({ e, busy, onOpen, act }: {
  e: InstalledExt; busy?: ExtAction | 'all'; onOpen: () => void; act: ExtActions['act'];
}) {
  const key = rowKey(e);
  const word = rowWord(e);
  return (
    <li data-ext-row={e.pkgName} data-ext-off={needsTurningOn(e) || undefined} className={`${ROW} hover:bg-ink-800/40`}>
      <button type="button" onClick={onOpen} className={OPENER} data-ext-open>
        <ExtIcon url={e.iconUrl} name={e.name} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <bdi dir="auto" className="truncate text-sm font-medium text-fog-100">{e.name}</bdi>
            <ExtTags e={e} />
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-fog-500">
            <span className="truncate"><Facts items={[extLanguagesText(e), e.versionName ? `v${e.versionName}` : null]} /></span>
            {word && <RowWord word={word} />}
          </span>
        </span>
        {!key && e.sources.length > 0 && <LanguagesOn e={e} />}
        {!key && <IcChevronRight aria-hidden width={16} height={16} className="shrink-0 text-fog-600 rtl:-scale-x-100" />}
      </button>
      {key === 'turn-on' ? (
        <button type="button" onClick={() => void act(e, 'enable')} disabled={!!busy} className={`btn-key btn-key-accent relative ${busyKey(busy === 'enable')}`} data-ext-turn-on>
          {busy === 'enable' ? <Busy>{tr('Turning on…')}</Busy> : tr('Turn on')}
        </button>
      ) : key === 'update' ? (
        <button type="button" onClick={() => void act(e, 'update')} disabled={!!busy} className={`btn-key relative ${AMBER_KEY} ${busyKey(busy === 'update')}`} data-ext-update>
          {busy === 'update' ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update')}
        </button>
      ) : null}
    </li>
  );
}

/**
 * A row's one state word, with its glyph: an update waiting (an amber diamond), or no source on (a hollow ring, grey).
 * From `sm` it ends the meta line after a dot; on a phone it is a line of its own, every such row alike -- it wrapped
 * by the width of a version number, and the line it left ended in a dangling dot.
 */
function RowWord({ word }: { word: 'update' | 'off' }) {
  const line = 'inline-flex basis-full items-center gap-1 sm:basis-auto';
  return (
    <>
      <span aria-hidden className="hidden sm:inline">·</span>
      {word === 'update' ? (
        <span className={`${line} text-amber-300`} data-ext-word="update"><StatusGlyph tone="warn" size={9} />{tr('Update available')}</span>
      ) : (
        <span className={`${line} text-fog-400`} data-ext-word="off"><StatusGlyph tone="info" size={9} />{tr('No source on')}</span>
      )}
    </>
  );
}

/** A quiet row's languages: up to four tags from `sm`, the ones on first and lit, then +n; and how many are on. */
function LanguagesOn({ e }: { e: InstalledExt }) {
  const MAX_TAGS = 4;
  const tags = [...e.sources].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  return (
    <span className="flex shrink-0 items-center gap-2.5">
      <span className="hidden items-center gap-1 sm:flex">
        {tags.slice(0, MAX_TAGS).map((s) => (
          <span key={s.id} title={extLanguageName(s.lang)} data-ext-tag={s.enabled ? 'on' : 'off'}
            className={`whitespace-nowrap rounded-[4px] px-1.5 text-[10px] font-semibold leading-[17px] tracking-wide ${s.enabled ? 'bg-accent-soft text-accent' : 'bg-ink-800 text-fog-500'}`}>
            {langTag(s.lang)}
          </span>
        ))}
        {tags.length > MAX_TAGS && <span className="rounded-[4px] bg-ink-800 px-1.5 text-[10px] font-semibold leading-[17px] tabular-nums text-fog-500">+{tags.length - MAX_TAGS}</span>}
      </span>
      <span className="whitespace-nowrap text-[12px] tabular-nums text-fog-500">{languagesOnText(e.on, e.sources.length)}</span>
    </span>
  );
}

// ---- Browse ----------------------------------------------------------------------------------------------------

function BrowseView({ actions, repos, adult, onAdult, onOpen, onRepos }: {
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
