'use client';
// Admin → Sources (v0.54.0): ONE tab for every source, where Providers and Extensions were two.
//
// The owner: "why do we have 2 when they are basically the same … the providers tab is super clutters and non user
// friendly … i have to go one by one test and find replacement sources". The two tabs were one source list cut three
// ways -- Providers (built-ins, MangaDex, sites, and only the extension sources registered), Extensions (packages and
// their languages), Health's Source health -- with five off-switches over three stores, 120 words of fixed text before
// the first source, two to five keys on every card, and no way at all to move a series off a dead source. Now, top to
// bottom:
// 1. the extension engine's strip (components/EngineSetup.tsx EngineReady), or its setup card while it is not running
//    -- which no longer hides the rest: built-ins, MangaDex and sites work without it;
// 2. Needs attention, only while something needs someone: a source to replace (offline, failing or switched off, and
//    still some series' main source) with Replace, the one filled key; the failing sources nothing uses, with Turn off
//    all; an extension update, with Update;
// 3. Your sources | Add sources. Your sources is one list of every source of every kind (GET
//    /api/admin/sources/overview), one line and at most one key a row, the switched-off ones folded away, with Test all
//    and the extension tools at the end of the row of views. Add sources holds the ways in: a site by address, MangaDex's
//    languages, the language of sites that do not say, Import a list, source packs, and the extension catalogue.
// A row opens the source's sheet (components/SourceSheet.tsx); Replace opens components/ReplaceDialog.tsx.
//
// Every sheet is portalled to <body> (components/ui.tsx OnBody): inside a `.card`, whose backdrop blur makes it the
// containing block of anything `fixed`, a sheet covered the card instead of the screen.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { numberText } from '@/lib/format';
import { useReduceEffects } from '@/lib/effects';
import { isDesktop } from '@/lib/desktop';
import { IDLE, isBusy, type ActionState } from '@/lib/actionState';
import { checkAllSession, type CheckAllSession, type SourceCheckProgress } from '@/lib/sourceCheckRun';
import { checkAllLabel, sweepToast } from '@/lib/sourceEvidence';
import { turnOffAllLabel, turnOffEach, turnOffOutcome, turnOffQuestion } from '@/lib/sourceHealth';
import { TONE_TEXT } from '@/lib/status';
import { installedList, type CatalogPage, type ExtSourcesAnswer, type ExtStatus } from '@/lib/extensions';
import { useFindRuns } from '@/lib/useFindRun';
import {
  OVERVIEW_KEY, OVERVIEW_URL, attentionRows, failingSince, failingUnusedTitle, initialView, kindLabel, namesSep, needsAttention, replaceLine, rowAction,
  rowFacts, settingsTarget, sourceSays, sourceTarget, splitSources, turnOnRequest, updatesTitle,
  type OverviewSource, type SourceEvidenceRow, type SourcesOverview, type SourcesView,
} from '@/lib/sourcesPanel';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { OnBody } from '@/components/ui';
import { ActionStatus } from '@/components/ActionList';
import { LinkRow, Row } from '@/components/settings';
import { EngineInstall } from '@/components/EngineInstall';
import { EngineReady, EngineSetup } from '@/components/EngineSetup';
import { ExtensionSettings } from '@/components/ExtensionSettings';
import { LanguagesSheet } from '@/components/ExtensionLanguages';
import { ReposSheet } from '@/components/ExtensionRepos';
import { BrowseView, ExtensionTools, OPENER, ROW, useExtensionActions } from '@/components/ExtensionsPanel';
import { Busy, busyKey } from '@/components/ExtensionBits';
import { MangadexLanguages, UnstatedLanguageRow } from '@/components/MangadexCard';
import { SourceSheet, type SheetTarget } from '@/components/SourceSheet';
import { SourceTile } from '@/components/SourceTile';
import { ReplaceDialog } from '@/components/ReplaceDialog';
import { FindResultsSheet } from '@/components/FindSources';
import { IcChevronRight, IcInfo, IcRefresh } from '@/components/icons';

/** The view, from `?view=` (or `card=mangadex`) once on arrival, and written back on a switch (lib/useTabParam.ts's rule). */
function useViewParam(): [SourcesView, (v: SourcesView) => void] {
  const params = useSearchParams();
  const [view, setView] = useState<SourcesView>(() => initialView(params));
  const set = (v: SourcesView) => {
    setView(v);
    const u = new URL(window.location.href);
    u.searchParams.set('view', v);
    window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
  };
  return [view, set];
}

/** Takes `settings=` (and v0.55.0's `source=`) off the address once its sheet is closed, so a reload does not open it again. */
function dropSettingsParam() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has('settings') && !u.searchParams.has('source')) return;
  u.searchParams.delete('settings');
  u.searchParams.delete('source');
  window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
}

export function SourcesPanel() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const [view, setView] = useViewParam();
  // The deep link to an extension source's settings (`?settings=<id>`, v0.53.0's Extensions link): its sheet, on its
  // settings. v0.55.0: `?source=<id>`, Health's Free a slot, is any source's sheet. Read once, in the initialiser, as
  // every address the console reads is.
  const [arrived] = useState(() => (settingsTarget(params) ? null : sourceTarget(params)));
  const [sheet, setSheet] = useState<SheetTarget | null>(() => {
    const id = settingsTarget(params);
    if (id) return { id, settings: true };
    return arrived ? { id: arrived } : null;
  });
  const [replacing, setReplacing] = useState<{ id: string; name: string } | null>(null);
  const [aside, setAside] = useState<'langs' | 'repos' | 'results' | null>(null);

  const { data: status } = useQuery({ queryKey: ['ext-status'], queryFn: () => api<ExtStatus>('/api/admin/extensions/status') });
  const ready = !!status?.configured && !!status?.reachable;
  const { data: overview, isError: overviewFailed, refetch: refetchOverview } = useQuery({
    queryKey: OVERVIEW_KEY, queryFn: () => api<SourcesOverview>(OVERVIEW_URL), refetchInterval: 15_000,
  });
  // The stored evidence behind a sheet's Details, and since when a source has failed.
  const { data: adminRows } = useQuery({
    queryKey: ['admin-sources'], queryFn: () => api<{ content: SourceEvidenceRow[]; testMs?: number }>('/api/admin/sources'),
  });
  const evidence = useMemo(() => new Map((adminRows?.content ?? []).map((r) => [r.source_id, r])), [adminRows]);
  const actions = useExtensionActions();
  // The installed extensions and their sources: an extension's part of a sheet, and the update row's names. 18+ ones
  // included -- an installed extension is always listed.
  const { data: inst } = useQuery({
    queryKey: ['ext-installed'], enabled: ready,
    queryFn: () => api<CatalogPage>('/api/admin/extensions/catalog?installed=true&nsfw=true&limit=400'),
  });
  const { data: srcs } = useQuery({ queryKey: ['ext-sources'], enabled: ready, queryFn: () => api<ExtSourcesAnswer>('/api/admin/extensions/sources') });
  const { data: repos } = useQuery({ queryKey: ['ext-repos'], enabled: ready, queryFn: () => api<{ content: string[] }>('/api/admin/extensions/repos') });
  const installed = useMemo(() => installedList(inst?.content ?? [], srcs?.content ?? []), [inst, srcs]);

  /** After anything here changes a source: the lists, the evidence, and Health with the header's mark. */
  const changed = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['sources'] }),
    qc.invalidateQueries({ queryKey: ['admin-sources'] }),
    qc.invalidateQueries({ queryKey: ['admin-health'] }),
    qc.invalidateQueries({ queryKey: ['health-summary'] }),
  ]);
  // Replace runs started here are followed here (one at a time, server-wide); when one ends, everything is asked again.
  const fr = useFindRuns({ onEnded: changed });
  const check = useTestAll(changed);

  const closeSheet = () => { setSheet(null); dropSettingsParam(); };
  const openReplace = (s: OverviewSource) => { setSheet(null); setReplacing({ id: s.id, name: s.name }); };
  // A settings link to a source the overview does not hold (an extension's source the engine lists but Uchiyomi does
  // not know yet): its settings alone, as before. A `source=` link to one (v0.55.0): no sheet -- the list is the place.
  const unknown = !!sheet && 'id' in sheet && !!overview && !overview.sources.some((s) => s.id === sheet.id);
  const lostSettings = unknown && !!sheet && 'id' in sheet && !!sheet.settings;
  const lostSource = unknown && !!sheet && 'id' in sheet && !sheet.settings && sheet.id === arrived;

  return (
    <div className="space-y-6" data-sources-panel>
      {/* The extension engine: its strip when it runs, its setup card when it does not -- above the rest, never instead of it. */}
      {!status ? <div className="skeleton h-16 rounded-2xl" aria-busy="true" />
        : isDesktop() && !ready ? <EngineInstall />
        : !ready ? <EngineSetup status={status} />
        : <EngineReady status={status} desktop={isDesktop()} />}

      {overview && needsAttention(overview.attention) && (
        <Attention overview={overview} evidence={evidence} installed={installed} actions={actions}
          onOpen={(id) => setSheet({ id })} onReplace={openReplace} onChanged={changed} />
      )}

      <section aria-label={tr('Sources')} className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-3 border-b border-ink-800/80">
          <ViewTabs view={view} onView={setView} count={overview ? splitSources(overview.sources).on.length : undefined} />
          {view === 'yours' && (
            <div className="ms-auto flex shrink-0 gap-1.5 pb-2 sm:gap-2">
              <TestAllKey checking={check.checking} onPress={check.press} />
              {ready && <ExtensionTools actions={actions} onLanguages={() => setAside('langs')} />}
            </div>
          )}
        </div>
        {view === 'yours' && <TestAllLine progress={check.progress} result={check.result} />}
        {view === 'yours' && actions.refreshError !== null && (
          <p role="alert" className="text-[12px] leading-relaxed text-amber-300" data-ext-refresh-error>
            {tr('Could not reach the repositories to check for updates.')}
            {actions.refreshError && <span dir="auto" className="ms-1 line-clamp-2 break-words text-amber-200/70">{actions.refreshError}</span>}
          </p>
        )}
        {view === 'yours' ? (
          <YourSources overview={overview} failed={overviewFailed} evidence={evidence} onRetry={() => void refetchOverview()}
            onOpen={(id) => setSheet({ id })} onChanged={changed} onAdd={() => setView('add')} />
        ) : (
          <AddSources ready={ready} overview={overview} actions={actions} repos={repos?.content} onChanged={changed}
            onOpen={(pkg) => setSheet({ pkg })} onRepos={() => setAside('repos')} />
        )}
      </section>

      {sheet && !lostSettings && !lostSource && (
        <OnBody>
          <SourceSheet target={sheet} overview={overview} evidence={evidence} testMs={adminRows?.testMs} status={status} actions={actions}
            installed={installed} hiddenLangs={srcs?.hiddenLangs ?? []} onClose={closeSheet} onReplace={openReplace}
            onLanguages={() => { closeSheet(); setAside('langs'); }} onChanged={changed} />
        </OnBody>
      )}
      {sheet && lostSettings && 'id' in sheet && (
        <ExtensionSettings target={{ sourceId: sheet.id.replace(/^sw:/, '') }} onClose={closeSheet} />
      )}
      {replacing && (
        <OnBody>
          <ReplaceDialog sourceId={replacing.id} name={replacing.name} fr={fr} slot={`replace:${replacing.id}`}
            onClose={() => setReplacing(null)} onResults={() => { setReplacing(null); setAside('results'); }} />
        </OnBody>
      )}
      {aside === 'results' && <FindResultsSheet onClose={() => setAside(null)} poll={false} />}
      {aside === 'langs' && <OnBody><LanguagesSheet onClose={() => setAside(null)} /></OnBody>}
      {aside === 'repos' && <OnBody><ReposSheet repos={repos?.content ?? []} onClose={() => setAside(null)} /></OnBody>}
    </div>
  );
}

// ---- Needs attention -----------------------------------------------------------------------------------------------

/**
 * A row of Needs attention: a face, what it is about in one line, and its one key. A source's row opens its sheet too
 * (`onOpen`): the whole row is the target, and the key its sibling, never a button inside a button.
 */
function AttentionRow({ lead, title, tag, line, hook, onOpen, children }: {
  lead: ReactNode; title: ReactNode; tag?: string; line: ReactNode; hook: Record<`data-${string}`, string>; onOpen?: () => void; children?: ReactNode;
}) {
  const words = (
    <>
      {lead}
      <span className="min-w-0 flex-1">
        {/* A sentence wraps on a phone, where "1 extension has an update" was cut to "1 extension has …". */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 break-words text-sm font-medium text-fog-100">{title}</span>
          {tag && <span className="shrink-0 rounded-[4px] bg-ink-800 px-1.5 text-[10px] font-semibold leading-4 text-fog-400">{tag}</span>}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fog-500">{line}</span>
      </span>
    </>
  );
  return (
    <li {...hook} className={`${ROW} ${onOpen ? 'hover:bg-ink-800/30' : ''}`}>
      {onOpen
        ? <button type="button" onClick={onOpen} className={OPENER} data-sources-open>{words}</button>
        : <span className="flex min-w-0 flex-1 items-center gap-3">{words}</span>}
      {children && <div className="relative flex shrink-0 items-center gap-2">{children}</div>}
    </li>
  );
}

/** A count on a tile, for a row about several sources. */
function CountTile({ n, tone }: { n: number; tone: 'warn' | 'info' }) {
  return (
    <span aria-hidden className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border text-[13px] font-semibold tabular-nums ${
      tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-ink-600 bg-ink-800/60 text-fog-300'}`}>
      {numberText(n)}
    </span>
  );
}

/** Names on one line, each in its own direction (an Arabic page, an English name), with the reader's separator. */
function Names({ names }: { names: string[] }) {
  const sep = namesSep();
  return <>{names.map((n, i) => <span key={`${n}-${i}`}>{i > 0 && sep}<bdi>{n}</bdi></span>)}</>;
}

export function Attention({ overview, evidence, installed, actions, onOpen, onReplace, onChanged }: {
  overview: SourcesOverview;
  evidence: ReadonlyMap<string, SourceEvidenceRow>;
  installed: ReturnType<typeof installedList>;
  actions: ReturnType<typeof useExtensionActions>;
  onOpen: (id: string) => void;
  onReplace: (s: OverviewSource) => void;
  onChanged: () => Promise<unknown>;
}) {
  const a = overview.attention;
  const byId = new Map(overview.sources.map((s) => [s.id, s]));
  const replace = a.replace.map((id) => byId.get(id)).filter((s): s is OverviewSource => !!s);
  const unused = a.failingUnused;
  const updating = installed.filter((e) => e.hasUpdate);
  const n = attentionRows(a);
  return (
    <section aria-label={tr('Needs attention')} data-sources-attention
      className="card relative overflow-hidden rounded-2xl border-amber-500/30 bg-linear-to-b from-amber-500/[0.06] to-ink-850/70">
      <h3 className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-300 rtl:tracking-normal">
        {tr('Needs attention')}<span className="ms-2 tabular-nums">{numberText(n)}</span>
      </h3>
      <ul className="divide-y divide-ink-800/70">
        {replace.map((s) => {
          const [why, ...rest] = replaceLine(s, failingSince(evidence.get(s.id)));
          return (
            <AttentionRow key={s.id} hook={{ 'data-sources-attention-row': 'replace', 'data-source-id': s.id, 'data-main': String(s.main), 'data-with-backup': String(s.withBackup) }}
              onOpen={() => onOpen(s.id)}
              lead={<SourceTile id={s.id} name={s.name} icon={s.icon} tone="warn" size={40} />}
              title={<bdi dir="auto">{s.name}</bdi>} tag={kindLabel(s.kind)}
              line={<><span className="font-medium text-amber-300">{why}</span>{rest.map((r) => <span key={r}> · {r}</span>)}</>}>
              <button type="button" onClick={() => onReplace(s)} className="btn-key btn-key-primary" data-sources-replace={s.id}>{tr('Replace')}</button>
            </AttentionRow>
          );
        })}
        {unused.length > 0 && (
          <TurnOffAll ids={unused} names={unused.map((id) => byId.get(id)?.name ?? id)} onChanged={onChanged} />
        )}
        {a.updates > 0 && (
          <AttentionRow hook={{ 'data-sources-attention-row': 'updates' }} lead={<CountTile n={a.updates} tone="info" />}
            title={updatesTitle(a.updates)}
            line={updating.length ? <Names names={updating.map((e) => e.name)} /> : null}>
            {a.updates === 1 && updating.length === 1 ? (
              <button type="button" onClick={() => void actions.act(updating[0], 'update')} disabled={!!actions.busy[updating[0].pkgName]} data-ext-update
                className={`btn-key border-amber-500/35 bg-amber-500/10 text-amber-300 hover:border-amber-400/70 hover:text-amber-200 ${busyKey(actions.busy[updating[0].pkgName] === 'update')}`}>
                {actions.busy[updating[0].pkgName] === 'update' ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update')}
              </button>
            ) : (
              <button type="button" onClick={() => void actions.updateAll()} disabled={!!actions.busy.__updateall} data-ext-update-all
                className={`btn-key border-amber-500/35 bg-amber-500/10 text-amber-300 hover:border-amber-400/70 hover:text-amber-200 ${busyKey(!!actions.busy.__updateall)}`}>
                {actions.busy.__updateall ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update all')}
              </button>
            )}
          </AttentionRow>
        )}
      </ul>
    </section>
  );
}

/**
 * The failing sources nothing uses, with Turn off all: it asks first, inline, and then switches each off in turn --
 * one request and one audit line per source, as v0.53.0's Health does (lib/sourceHealth.ts turnOffEach) -- through
 * the retire route, which refuses a source that became some series' main source meanwhile.
 */
function TurnOffAll({ ids, names, onChanged }: { ids: string[]; names: string[]; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<ActionState>(IDLE);
  const n = ids.length;
  const busy = isBusy(state);
  const run = async () => {
    setAsking(false);
    const at = Date.now();
    setState({ kind: 'starting' });
    const { off, failed } = await turnOffEach(ids,
      (id) => api(`/api/admin/sources/${encodeURIComponent(id)}/retire`, { json: { how: 'off' } }),
      (done, total) => setState(done < total
        ? { kind: 'working', startedAt: at, step: tr('Turning off {done} of {total}…', { done: done + 1, total }), progress: done / total }
        : { kind: 'working', startedAt: at, step: tr('Checking the result…'), progress: 1 }));
    const line = turnOffOutcome(off.length, failed.length);
    toast(line, failed.length ? (off.length ? 'info' : 'error') : 'success');
    await onChanged().catch(() => {});
    setState(!off.length && failed.length
      ? { kind: 'failed', finishedAt: Date.now(), reason: line }
      : { kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: line, ...(failed.length ? { partial: true } : {}) });
  };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(false); } };
  return (
    <li data-sources-attention-row="failing-unused" className="px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <CountTile n={n} tone="warn" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium text-fog-100">{failingUnusedTitle(n)}</p>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fog-500"><Names names={names} /></p>
        </div>
        <button type="button" onClick={() => setAsking(!asking)} aria-expanded={asking} disabled={busy} className="ms-auto btn-key" data-source-bulk-off>
          {turnOffAllLabel(n)}
        </button>
      </div>
      {asking && (
        <div role="group" aria-label={turnOffAllLabel(n)} onKeyDown={escape} data-source-bulk-confirm
          className="mt-2.5 rounded-xl border border-ink-700 bg-ink-900/70 px-3 py-2.5">
          <p className="text-xs leading-relaxed text-fog-200">{turnOffQuestion(n)}</p>
          <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
            {/* Cancel takes the focus: Enter pressed twice on the row's key must not switch anything off. */}
            <button type="button" autoFocus onClick={() => setAsking(false)} className="btn-key" data-source-bulk-cancel>{tr('Cancel')}</button>
            <button type="button" onClick={() => { void run(); }} className="btn-key btn-key-danger" data-source-bulk-go>{turnOffAllLabel(n)}</button>
          </div>
        </div>
      )}
      <div data-source-bulk-status><ActionStatus state={state} /></div>
    </li>
  );
}

// ---- Your sources | Add sources -------------------------------------------------------------------------------------

/**
 * Your sources | Add sources: two text tabs with an accent underline sliding between them, as Library → Series |
 * Downloads has it -- no capsule. The underline slides only when motion is welcome.
 */
function ViewTabs({ view, onView, count }: { view: SourcesView; onView: (v: SourcesView) => void; count?: number }) {
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const tabs: Array<[SourcesView, string, number | undefined]> = [['yours', tr('Your sources'), count], ['add', tr('Add sources'), undefined]];
  return (
    <div role="tablist" aria-label={tr('Sources')} className="flex items-end gap-5 sm:gap-6">
      {tabs.map(([v, label, n]) => {
        const on = v === view;
        return (
          <button key={v} type="button" role="tab" aria-selected={on} data-sources-view={v} onClick={() => { if (!on) onView(v); }}
            className={`relative -mb-px flex items-center gap-1.5 whitespace-nowrap pb-2 pt-1 font-display text-[15px] font-semibold transition-colors sm:text-base ${on ? 'text-fog-50' : 'text-fog-500 hover:text-fog-200'}`}>
            {label}
            {typeof n === 'number' && <span className="text-[13px] font-medium tabular-nums text-fog-500 sm:text-sm">{numberText(n)}</span>}
            {on && (
              <motion.span layoutId="sourcesview" aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-sm bg-accent"
                transition={plain || still ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

type CheckResult = { sources?: unknown[]; needsAttention?: unknown[]; inconclusive?: unknown[] };

/**
 * Test all: the daily check of every source, on demand (POST/GET /api/admin/sources/check, lib/sourceCheckRun.ts). A
 * check already running when the tab opens -- the daily one, or one another tab started -- is followed too, and ONE
 * owner per visit says how it ended: the visit's follower, or a press, never both, and neither once the tab is left.
 */
function useTestAll(onDone: () => Promise<unknown>) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<SourceCheckProgress | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const session = useRef<CheckAllSession | null>(null);
  useEffect(() => {
    const run = checkAllSession(api, {
      progress: (p) => { setChecking(true); setProgress(p); },
      done: (r) => {
        setResult(r);
        const t = sweepToast(r);
        toast(t.text, t.type);
        void onDone();
      },
      failed: (e) => toast(msgOf(e, tr('Could not run the check')), 'error'),
      idle: () => { setChecking(false); setProgress(null); },
    });
    session.current = run;
    void run.follow();
    return () => run.leave();
    // Once per visit to the tab: the session owns the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const press = () => {
    setChecking(true);
    setResult(null);
    void session.current?.press();
  };
  return { checking, progress, result, press };
}

/** Test all's key: words from `sm`, the icon alone on a phone, named for a screen reader and in a tooltip. */
function TestAllKey({ checking, onPress }: { checking: boolean; onPress: () => void }) {
  const label = checking ? tr('Testing…') : tr('Test all');
  return (
    <button type="button" onClick={onPress} disabled={checking} aria-label={label} title={label} data-source-check-all
      className={`btn-key w-8 px-0 sm:w-auto sm:px-3 ${busyKey(checking)}`}>
      {checking ? <Busy><span className="hidden sm:inline">{label}</span></Busy>
        : <><IcRefresh aria-hidden width={14} height={14} /><span className="hidden sm:inline">{label}</span></>}
    </button>
  );
}

/** Test all's line under the row: how far it has got -- "Testing 7 of 40 · Manga Ball (EN)" -- then what it found. */
function TestAllLine({ progress, result }: { progress: SourceCheckProgress | null; result: CheckResult | null }) {
  if (progress?.running) {
    return <p role="status" className="text-[12px] tabular-nums text-accent" data-source-check-progress>{checkAllLabel(progress)}</p>;
  }
  if (!result) return null;
  const n = result.sources?.length ?? 0;
  const t = sweepToast(result);
  return (
    <p role="status" className={`text-[12px] ${t.type === 'success' ? 'text-fog-400' : 'text-amber-300'}`} data-source-check-result>
      {n === 1 ? tr('Checked 1 source.') : tr('Checked {n} sources.', { n })} {t.text}
    </p>
  );
}

/** The word's colour by tone: green for a healthy source, amber for a real problem, quiet for the rest. */
const WORD: Record<string, string> = { ok: 'text-emerald-300', warn: 'text-amber-300', problem: 'text-amber-300', info: 'text-fog-300', off: 'text-fog-400', accent: 'text-accent' };

export function YourSources({ overview, failed, evidence, onRetry, onOpen, onChanged, onAdd }: {
  overview: SourcesOverview | undefined;
  failed: boolean;
  evidence: ReadonlyMap<string, SourceEvidenceRow>;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<unknown>;
  onAdd: () => void;
}) {
  if (!overview) {
    return failed ? (
      <div className="card px-4 py-6 text-center" data-sources-error>
        <p className="text-sm font-medium text-fog-100">{tr('Could not read your sources')}</p>
        <button type="button" onClick={onRetry} className="btn-key mt-3">{tr('Try again')}</button>
      </div>
    ) : (
      <div className="card divide-y divide-ink-800/70 overflow-hidden rounded-2xl" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex h-16 items-center gap-3 px-4"><div className="skeleton h-10 w-10 rounded-xl" /><div className="skeleton h-3 w-40 rounded" /></div>
        ))}
      </div>
    );
  }
  const { on, off } = splitSources(overview.sources);
  const row = (s: OverviewSource) => (
    <SourceRow key={s.id} s={s} since={failingSince(evidence.get(s.id))} action={rowAction(s, overview.attention)} onOpen={() => onOpen(s.id)} onChanged={onChanged} />
  );
  if (!overview.sources.length) {
    return (
      <div className="card px-4 py-8 text-center" data-sources-empty>
        <p className="text-sm font-semibold text-fog-100">{tr('No sources installed')}</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-fog-500">
          {isDesktop()
            ? tr('Add a site, or download the extension engine and add an extension, under Add sources. With none, Uchiyomi reads only the library you already own.')
            : tr('Add a site or an extension under Add sources, or mount a source pack at the server’s {dir}. With none, Uchiyomi reads only the library you already own.', { dir: 'SOURCES_DIR' })}
        </p>
        <button type="button" onClick={onAdd} className="btn-key mt-3">{tr('Add sources')}</button>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-sources-yours>
      {on.length > 0 && <ul className="card grad-border divide-y divide-ink-800/70 overflow-hidden rounded-2xl" data-sources-list>{on.map(row)}</ul>}
      {off.length > 0 && <OffFold n={off.length}>{off.map(row)}</OffFold>}
    </div>
  );
}

/** Switched off, folded: closed until opened, its count beside its name. */
function OffFold({ n, children }: { n: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const plain = useReduceEffects();
  return (
    <section data-sources-fold="off" className="card overflow-hidden rounded-2xl">
      <button type="button" aria-expanded={open} aria-controls="sources-off" onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-start text-sm text-fog-300 hover:text-fog-100">
        <span className="min-w-0 flex-1">{tr('Switched off')}<span className="ms-2 tabular-nums text-fog-500">{numberText(n)}</span></span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-fog-500">
          {open ? tr('Hide') : tr('Show')}
          {/* Mirrored on the outer span and turned on the inner one (ActionList.tsx): both on one pointed it up in Arabic. */}
          <span aria-hidden className="inline-grid rtl:-scale-x-100">
            <IcChevronRight width={14} height={14} className={`${plain ? '' : 'transition'} ${open ? 'rotate-90' : ''}`} />
          </span>
        </span>
      </button>
      {open && <ul id="sources-off" className="divide-y divide-ink-800/70 border-t border-ink-800/60">{children}</ul>}
    </section>
  );
}

/**
 * One source: its face, its name and kind, and one line -- its state, how many series use it, its language -- then one
 * key when there is one thing to do (Turn on, for a source switched off that series use), else a chevron. The row
 * opens the source's sheet; the key is the opener's sibling, never a button inside a button.
 */
function SourceRow({ s, since, action, onOpen, onChanged }: {
  s: OverviewSource; since: string | null; action: 'turn-on' | null; onOpen: () => void; onChanged: () => Promise<unknown>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const says = sourceSays(s, since);
  const facts = rowFacts(s);
  const turnOn = async () => {
    setBusy(true);
    try {
      const r = turnOnRequest(s);
      await api(r.path, r.json ? { json: r.json } : { method: 'POST' });
      toast(tr('Enabled'), 'success');
      await onChanged();
    } catch (e) { toast(msgOf(e, tr('Could not save that')), 'error'); }
    setBusy(false);
  };
  return (
    <li data-sources-row={s.id} data-source-state={s.state} data-standing={s.standing} className={`${ROW} hover:bg-ink-800/40`}>
      <button type="button" onClick={onOpen} className={OPENER} data-sources-open>
        <SourceTile id={s.id} name={s.name} icon={s.icon} tone={says.tone === 'ok' ? 'info' : says.tone} dim={says.tone === 'off'} size={40} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <bdi dir="auto" className="truncate text-sm font-medium text-fog-100">{s.name}</bdi>
            <span className="shrink-0 rounded-[4px] bg-ink-800 px-1.5 text-[10px] font-semibold leading-4 text-fog-400" data-source-kind={s.kind}>{kindLabel(s.kind)}</span>
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-fog-500" data-source-line>
            <span className={WORD[says.tone] ?? TONE_TEXT.info}>{says.word}</span>
            {says.reason && <> — {says.reason}</>}
            {facts.map((f) => <span key={f}> · <bdi>{f}</bdi></span>)}
          </span>
        </span>
        {!action && <IcChevronRight aria-hidden width={16} height={16} className="shrink-0 text-fog-600 rtl:-scale-x-100" />}
      </button>
      {action === 'turn-on' && (
        <button type="button" onClick={() => void turnOn()} disabled={busy} className={`btn-key btn-key-accent relative ${busyKey(busy)}`} data-sources-turn-on={s.id}>
          {busy ? <Busy>{tr('Turning on…')}</Busy> : tr('Turn on')}
        </button>
      )}
    </li>
  );
}

function AddSources({ ready, overview, actions, repos, onChanged, onOpen, onRepos }: {
  ready: boolean;
  overview: SourcesOverview | undefined;
  actions: ReturnType<typeof useExtensionActions>;
  repos?: string[];
  onChanged: () => Promise<unknown>;
  onOpen: (pkg: string) => void;
  onRepos: () => void;
}) {
  // Show 18+ extensions, for the catalogue: off, its 18+ extensions are left out (never "only 18+").
  const [adult, setAdult] = useState(false);
  return (
    <div className="space-y-6" data-sources-add>
      {/* The quick ways first, each a line until opened: the catalogue under them loads its next page as it scrolls, and
          anything after it could never be reached. */}
      <div className="card grad-border divide-y divide-ink-800/70 rounded-2xl px-4">
        <AddSite onAdded={onChanged} />
        <MangadexLanguages sources={(overview?.sources ?? []).filter((s) => s.kind === 'mangadex')} onSaved={() => void onChanged()} />
        <div className="py-1"><UnstatedLanguageRow /></div>
        <div className="py-1">
          <LinkRow href="/admin/import/" label={tr('Import a list')}
            help={tr('A Mihon or Tachiyomi backup, a public MangaDex list, or pasted titles: you review every match before anything is added.')} />
        </div>
        <div className="py-1"><SourcePacksRow onDone={onChanged} /></div>
      </div>
      <section aria-label={tr('Extensions')} className="space-y-3">
        <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-fog-500 rtl:tracking-normal">{tr('Extensions')}</h3>
        {ready
          ? <BrowseView actions={actions} repos={repos} adult={adult} onAdult={setAdult} onOpen={onOpen} onRepos={onRepos} />
          : <p className="text-[12px] text-fog-500" data-sources-no-engine>{tr('Extensions appear here once the extension engine is running.')}</p>}
      </section>
    </div>
  );
}

/**
 * Source packs: compiled plugins mounted at the server's SOURCES_DIR, picked up by Reload with no restart (POST
 * /api/admin/sources/reload, which reads the built-ins, the added sites and the extension sources again too).
 * Providers' toolbar key until v0.54.0; a way in, so a row of Add sources, where the docs point.
 */
function SourcePacksRow({ onDone }: { onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const r = await api<{ available: number }>('/api/admin/sources/reload', { method: 'POST' });
      toast(r.available === 1 ? tr('Reloaded — 1 source available') : tr('Reloaded — {n} sources available', { n: r.available }), 'success');
      await onDone();
    } catch { toast(tr('Reload failed'), 'error'); }
    setReloading(false);
  };
  return (
    <Row label={tr('Source packs')}
      help={tr('Mount a compiled source pack at the server’s {dir}, then reload: it is picked up with no restart.', { dir: 'SOURCES_DIR' })}>
      <button type="button" onClick={() => void reload()} disabled={reloading} className={`btn-key ${busyKey(reloading)}`} data-sources-reload>
        {reloading ? <Busy tone="muted">{tr('Reloading…')}</Busy> : tr('Reload sources')}
      </button>
    </Row>
  );
}

type Smoke = { ok: boolean; timedOut?: boolean; checks: { name: string; ok: boolean; detail: string }[] };

/**
 * A site by its address: pick the engine (or let Uchiyomi tell), name it, paste its homepage. Picked up at once, and
 * tested on the spot -- the checks it passed and failed are listed under the form. Its 28-word explanation is behind
 * the (i), where Providers printed it under the form on every visit.
 */
function AddSite({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const toast = useToast();
  const [eng, setEng] = useState<'auto' | 'madara' | 'manganato' | 'mangathemesia'>('auto');
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [adding, setAdding] = useState(false);
  const [help, setHelp] = useState(false);
  const [smoke, setSmoke] = useState<{ name: string; res: Smoke } | null>(null);
  const add = async () => {
    if (!name.trim() || !base.trim()) return;
    setAdding(true);
    setSmoke(null);
    const nm = name.trim();
    const shown = `⁨${nm}⁩`;
    try {
      const r = await api<{ engine?: string; smoke?: Smoke }>('/api/admin/sources/custom', { json: { engine: eng, name: nm, base: base.trim() } });
      if (r.smoke) setSmoke({ name: nm, res: r.smoke });
      if (r.smoke?.ok) toast(tr('Added {name}, and it works', { name: shown }), 'success');
      else if (r.smoke) toast(tr('Added {name}, but some checks failed: see below', { name: shown }), 'error');
      // Its own words: "Added {name}" is an extension's, and several languages say so in it.
      else toast(tr('Added the site {name}', { name: shown }), 'success');
      setName('');
      setBase('');
      await onAdded();
    } catch (e) {
      toast(msgOf(e, tr('Could not add that site. Check the address, or pick its engine.')), 'error');
    }
    setAdding(false);
  };
  return (
    <section aria-labelledby="sources-add-site" className="py-3" data-sources-add-site>
      <div className="flex items-center gap-1.5">
        <h3 id="sources-add-site" className="text-sm text-fog-100">{tr('Add a site by address')}</h3>
        {/* 32 px to tap; the negative margins keep the heading's line as tall as its words. */}
        <button type="button" onClick={() => setHelp(!help)} aria-expanded={help} aria-controls="sources-add-site-help" aria-label={tr('About adding a site')}
          className="-my-1.5 grid h-8 w-8 place-items-center rounded-full text-fog-500 transition hover:text-fog-200" data-sources-add-site-help>
          <IcInfo width={14} height={14} />
        </button>
      </div>
      {help && (
        <p id="sources-add-site-help" className="mt-1 max-w-prose text-[11px] leading-relaxed text-fog-500">
          {tr('Paste a site’s homepage address: its engine is found by itself, or pick it. Works for sites on the Madara, MangaThemesia or Manganato engines, at once and with no restart.')}
        </p>
      )}
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <select value={eng} onChange={(e) => setEng(e.target.value as typeof eng)} aria-label={tr('Engine')} className="field w-auto">
          <option value="auto">{tr('Auto-detect')}</option>
          <option value="madara">{tr('Madara (WordPress)')}</option>
          <option value="mangathemesia">{tr('MangaThemesia')}</option>
          <option value="manganato">{tr('Manganato')}</option>
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Name')} aria-label={tr('Name')} className="field min-w-[110px] flex-1" />
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://site.com" aria-label={tr('Address')} dir="ltr"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} className="field min-w-[170px] flex-[2]" />
        <button type="submit" disabled={adding || !name.trim() || !base.trim()} className={`btn-key ${busyKey(adding)}`} data-sources-add-site-go>
          {adding ? <Busy tone="muted">{tr('Adding…')}</Busy> : tr('Add')}
        </button>
      </form>
      {smoke && (
        <div className={`mt-2.5 rounded-xl border p-2.5 ${smoke.res.ok ? 'border-emerald-600/30 bg-emerald-600/10' : 'border-amber-600/30 bg-amber-600/10'}`} data-sources-add-site-smoke>
          <p className="mb-1.5 text-[11px] font-semibold text-fog-300">
            {smoke.res.ok ? tr('{name} works: search, chapters and pages all answered', { name: `⁨${smoke.name}⁩` })
              : smoke.res.timedOut ? tr('{name}: the check ran out of time, so the site may be slow or protected. It was added anyway.', { name: `⁨${smoke.name}⁩` })
              : tr('{name}: some checks failed, so this site may only partly work', { name: `⁨${smoke.name}⁩` })}
          </p>
          <ul className="space-y-1">
            {smoke.res.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span aria-hidden className={c.ok ? 'text-emerald-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span>
                <span className="sr-only">{c.ok ? tr('passed') : tr('failed')}</span>
                {/* The smoke test's own words, as the server sends them. */}
                <bdi className="text-fog-200">{c.name}</bdi>
                <bdi dir="auto" className="min-w-0 break-words text-fog-500">{c.detail}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
