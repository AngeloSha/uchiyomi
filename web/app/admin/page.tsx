'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useAdminSettingsViews } from '@/components/AdminSettings';
import { ConsoleLayout, type PageView } from '@/components/ConsoleLayout';
import { seenText, useNetwork } from '@/components/NetworkSettings';
import { ADMIN_SETTINGS } from '@/lib/settingsIndex.admin';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { scheduleText, taskResult } from '@/lib/tasks';
import { bytes, numberText, relativeTime } from '@/lib/format';
import { shownDeviceName } from '@/lib/device';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { Avatar } from '@/components/Avatar';
import { IcChevronLeft, IcChevronRight, IcTrash, IcPlus, IcRefresh, IcX, IcGrid, IcShield, IcRows, IcGlobe, IcSparkle, IcUsers, IcUser, IcClock } from '@/components/icons';
import { LibraryFolders } from '@/components/LibraryFolders';
import { addFolder, foldersOf, heldByOthers, heldByText, previewQuery, previewText, sameFolders, toggleFolder, typedFolder } from '@/lib/libraryFolders';
import { CardProgress, HealthCardActions, HealthRow, hasCardActions, scanState, scanWorking } from '@/components/HealthActions';
import { FixEverythingDialog, FixEverythingKey, LastFixLine, SafeRepairLine } from '@/components/FixEverythingDialog';
import { AutofixRunProvider } from '@/lib/useAutofixRun';
import { RepairHistory, RepairLiveStrip, RepairTaskLines } from '@/components/RepairLive';
import { RESCAN_KEY, RescanPanel } from '@/components/RescanTask';
import { ActionStatus } from '@/components/ActionList';
import { RepairRunProvider } from '@/lib/useRepairRun';
import { FindRunProvider, codeOf } from '@/lib/useFindRun';
import { FindRunCard } from '@/components/FindSources';
import { checkTitle } from '@/lib/healthCopy';
import { checkNote, checkSummary, itemDetail, itemTitle } from '@/lib/said';
import { keysFor } from '@/lib/healthKeys';
import type { ActionState } from '@/lib/actionState';
import { Backdrop, Img, OnBody } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { motion, useReducedMotion } from 'framer-motion';
import { t as tr } from '@/lib/i18n';
import { bustCover } from '@/lib/coverBust';
import type { HealthCheck, Series } from '@/lib/types';
import { bridge, isDesktop, type UpdateStatus } from '@/lib/desktop';
import { SourcesPanel } from '@/components/SourcesPanel';
import { StatusEdge, StatusMark } from '@/components/StatusMark';
import { TONE_SURFACE, healthMark } from '@/lib/status';
import Link from 'next/link';
import { healthLinks } from '@/lib/healthLinks';
import { useLayer } from '@/lib/layers';
import { SourceHealthBody } from '@/components/SourceHealthBody';
import { HealthBySeries } from '@/components/HealthBySeries';
import { Segmented } from '@/components/settings';
import { healthQuery, healthView, setHealthView, type HealthView } from '@/lib/healthBySeries';
import { releaseHref, shownVersion, updateState, type UpdateState } from '@/lib/versionLine';
import { useSectionArrival } from '@/lib/useSectionArrival';
import { useReduceEffects } from '@/lib/effects';
import { joinsOnTheirOwn, memberDefaultsOf, type MemberDefaults } from '@/lib/memberDefaults';
import { deleteFilesNotice, notOnDiskTitle, type DeleteFilesResult } from '@/lib/deleteFiles';

/** A name or a title inside a sentence, isolated: in Arabic a Latin one otherwise takes the sentence's order. */
const iso = (s: string): string => `\u2068${s}\u2069`;

/**
 * The admin console (v0.88.0): ONE grouped list -- Overview and Health; Library (Libraries, Sources, Art); People
 * (Members, Sessions, Activity); Settings (Server, Series & chapters, Downloads, Maintenance, Notifications) -- beside
 * the page on screen, or before it on a phone (components/ConsoleLayout.tsx), under the server's cinematic hero: its
 * verdict, its counts and the scan.
 *
 * Before it, ten tabs in four groups under a hero that took the top of every tab, and Settings five more pages inside
 * one of them: on a phone a group menu, a row of tabs and a list of categories before the first switch -- "a tab under a
 * tab" (the owner, 2026-10-19). The Tasks tab is Maintenance's Run now: the nightly backup and repair are set and run in
 * one place.
 *
 * The page lives in the URL (`?tab=`), read through `useSearchParams`, which a statically exported page may only call
 * under a Suspense boundary -- the build fails without one. The fallback keeps the page's height so the shell does not
 * jump when the boundary resolves.
 */
export default function AdminPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <AdminInner />
    </Suspense>
  );
}

function AdminInner() {
  const { isAdmin } = useAuth();
  // v0.55.4: `?section=` -- a card found by the search palette lands, once it has loaded. A row of the console's own is
  // the console's to land on (components/ConsoleLayout.tsx); this answers the rest.
  useSectionArrival();
  const desktop = isDesktop();
  // Maintenance's Run now, after its settings: what was the Tasks tab (v0.88.0).
  const settings = useAdminSettingsViews({
    maintenance: (
      <section id="tasks" className="col-span-full min-w-0 scroll-mt-4 lg:scroll-mt-20" aria-labelledby="tasks-title">
        <h3 id="tasks-title" className="mb-1.5 px-1 text-[13px] font-semibold text-fog-300">{tr('Tasks')}</h3>
        <Tasks />
      </section>
    ),
  });
  const router = useRouter();
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats'), enabled: isAdmin });
  const { data: health } = useQuery({ ...healthQuery, enabled: isAdmin });
  const { data: art } = useQuery({ ...HERO_ART, enabled: isAdmin });

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const bad = health ? health.checks.filter((c) => c.status !== 'ok').length : null;
  // Each row's line says what is in it, or -- where one number decides whether to open it -- that number.
  const views: Record<string, PageView> = {
    // The hero above Overview says what it is on a computer, as it did before v0.88.0: no second title under it.
    overview: { icon: <IcGrid width={18} height={18} />, tint: 'bg-violet-500/15 text-violet-300',
      summary: tr('What needs a look, and who is reading'), ownHeader: true, pane: <Overview /> },
    health: { icon: <IcShield width={18} height={18} />, tint: bad ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300',
      summary: verdictOf(health, bad), pane: <Health /> },
    library: { icon: <IcRows width={18} height={18} />, tint: 'bg-indigo-500/15 text-indigo-300',
      summary: tr('Folders, age ratings and who can open them'), pane: <LibraryPanel /> },
    sources: { icon: <IcGlobe width={18} height={18} />, tint: 'bg-cyan-500/15 text-cyan-300',
      summary: tr('Sites and extensions'), pane: <SourcesPanel /> },
    art: { icon: <IcSparkle width={18} height={18} />, tint: 'bg-pink-500/15 text-pink-300',
      summary: tr('Covers and banners'), pane: <ArtReview /> },
    members: { icon: <IcUsers width={18} height={18} />, tint: 'bg-teal-500/15 text-teal-300',
      summary: stats ? (stats.members === 1 ? tr('1 member') : tr('{n} members', { n: stats.members })) : undefined, pane: <Members /> },
    sessions: { icon: <IcUser width={18} height={18} />, tint: 'bg-blue-500/15 text-blue-300',
      summary: tr('Who is signed in, on which device'), pane: <Sessions /> },
    activity: { icon: <IcClock width={18} height={18} />, tint: 'bg-orange-500/15 text-orange-300',
      summary: tr('Sign-ins and changes'), pane: <Activity /> },
    ...settings.views,
  };

  return (
    <div className="min-h-screen-d px-4 lg:px-0" data-admin-console>
      {/* The foot of the list says which Uchiyomi this is (v0.55.4, #150): the place people looked for it. */}
      <ConsoleLayout index={ADMIN_SETTINGS} label={tr('Admin')} views={views} home="overview"
        conds={{ web: !desktop, 'local-accounts': !settings.sso, extensions: settings.extensions, pointer: true, talk: false }}
        hero={(mode) => <AdminHero mode={mode} onBack={() => (window.history.length > 1 ? router.back() : router.push('/profile/'))} />}
        art={art?.seriesId ? <Backdrop seriesId={art.seriesId} className="absolute inset-0" /> : null}
        footer={<VersionLine />} />
    </div>
  );
}

/** The verdict on the server: Health's row says it, and so does the console's card. */
const verdictOf = (health: { checks: HealthCheck[] } | undefined, bad: number | null): string =>
  !health ? tr('Checking your library…')
    : bad === 1 ? tr('1 check found something')
    : bad ? tr('{n} checks found something', { n: bad })
    : tr('Everything looks healthy');

/**
 * The header.
 *
 * Two things it is trying to fix. The panel had no visual identity at all -- flat cards on flat black, in an
 * app whose every other surface is composed over ambient art -- and the health of the server, which is the
 * question an admin arrives with, was reachable only by opening a tab and waiting for it to load.
 *
 * So the backdrop is real art from THIS library (a random series, the same `Backdrop` the series page uses,
 * blurred and drowned under a gradient), and the headline is the verdict rather than a row of numbers. The
 * counts are still there, just demoted to the line that supports it.
 *
 * `band` (the UI refresh's `compact`): above every page but Overview on a computer. The verdict and its facts stay -- an
 * admin opening Settings still sees at a glance that a check failed -- but in a band, not the ~480 px that pushed
 * Settings and Members below the fold. v0.88.0 put it in a card in the list for a day; the owner: "it was cinematic and
 * nicer before with a hero section". Which version runs is the list's foot, on a phone too, where the list is the
 * first screen (components/ConsoleLayout.tsx).
 */
function AdminHero({ mode, onBack }: { mode: 'full' | 'band'; onBack: () => void }) {
  const compact = mode === 'band';
  // Both settings, both hooks on every render (components/Toast.tsx says why): the verdict rises in, unless either says not.
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const rise = (delay = 0) => ({
    initial: reduced ? false as const : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.5, delay, ease: [0.22, 0.61, 0.36, 1] as const },
  });
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const { data: health } = useQuery(healthQuery);
  // One random series for the wash. `keepPreviousData` is deliberately off: a different backdrop on each
  // visit is the point, and it is the cheapest way to make the panel feel like part of the library.
  const { data: rnd } = useQuery(HERO_ART);

  const bad = health ? health.checks.filter((c) => c.status !== 'ok').length : null;
  const verdict = verdictOf(health, bad);

  // The scan's answer, under the button (v0.49.0): it used to be dropped, so a scan refused because one ran a
  // minute ago looked exactly like one that found nothing. Then Health is checked again, and its header mark.
  const [scanned, setScanned] = useState<ActionState | null>(null);
  const scan = async () => {
    const at = Date.now();
    setScanned({ kind: 'working', startedAt: at, step: tr('Scanning library…') });
    const r = await triggerRefresh((p) => setScanned(scanWorking(p, at)));
    setScanned(scanState(r, at));
    await Promise.all([qc.invalidateQueries({ queryKey: ['admin-stats'] }), qc.invalidateQueries({ queryKey: ['admin-health'] })]);
    await qc.invalidateQueries({ queryKey: ['health-summary'] });
  };

  // Separate singular keys rather than a plural library. Nine languages with one count each does not justify
  // Intl.PluralRules and a rules table; "1 members" does need fixing, and every language here can express
  // both forms as two strings.
  const facts = [
    stats ? (stats.seriesTotal === 1 ? tr('1 series') : tr('{n} series', { n: numberText(stats.seriesTotal) })) : null,
    // v0.61.2 (#204): every chapter across them, as the series list counts them; grouped, because it runs to tens of
    // thousands. A server older than the field sends none, and the fact is simply left out.
    typeof stats?.booksTotal === 'number'
      ? (stats.booksTotal === 1 ? tr('1 chapter') : tr('{n} chapters', { n: numberText(stats.booksTotal) })) : null,
    // Desktop is one person: "1 member" there would describe a household that does not exist.
    stats && !isDesktop() ? (stats.members === 1 ? tr('1 member') : tr('{n} members', { n: stats.members })) : null,
    stats ? tr('{size} cached', { size: bytes(stats.cacheBytes) }) : null,
    // Which layout this is, in one word: the answer to "where is my database" without reading a compose file.
    stats?.database ? (stats.database === 'embedded' ? tr('embedded database') : tr('external database')) : null,
    stats?.lastScan ? tr('scanned {when}', { when: relativeTime(new Date(stats.lastScan).toISOString()) }) : null,
    // From what the sources said the last time the updater asked. Absent until a sweep has stamped it.
    stats?.backlog?.chapters
      ? stats.backlog.chapters === 1 ? tr('1 chapter behind')
        : stats.backlog.series === 1 ? tr('{n} chapters behind in 1 series', { n: stats.backlog.chapters })
        : tr('{n} chapters behind across {m} series', { n: stats.backlog.chapters, m: stats.backlog.series })
      : null,
  ].filter(Boolean) as string[];

  return (
    <div data-admin-hero={compact ? 'compact' : 'full'} className={`bleed relative isolate overflow-hidden lg:mt-2 lg:rounded-b-3xl ${compact ? 'mb-4' : 'mb-6'}`}>
      {rnd?.seriesId && <Backdrop seriesId={rnd.seriesId} className="absolute inset-0" />}
      {/* Drowned deliberately: this is a wash to sit text on, not a picture to look at. */}
      <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/90 to-ink-950/70" />
      {/* The bloom takes the verdict's colour, so the whole top of the page goes amber the moment a check
          fails. One ternary, no assets, and every pixel of it is data. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(75% 120% at var(--start) 0%, ${bad ? 'rgba(245,158,11,0.20)' : 'rgb(var(--accent) / 0.22)'}, transparent 60%)` }} />

      <div className={`bleed-pad relative pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.5rem))] ${compact ? 'pb-4 lg:pb-5 lg:pt-5' : 'pb-6 lg:pb-8 lg:pt-8'}`}>
        <div className={`flex items-center gap-2 ${compact ? 'mb-3' : 'mb-5'}`}>
          <button onClick={onBack} aria-label={tr('Back')}
            className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-fog-100 backdrop-blur">
            <IcChevronLeft width={22} height={22} className="rtl:-scale-x-100" />
          </button>
          <span className="text-xs font-semibold uppercase tracking-wider text-fog-500 rtl:tracking-normal">{tr('Admin')}</span>
        </div>

        <motion.div {...rise()}>
          <div className="flex items-center gap-2.5">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${
              !health ? 'bg-fog-600' : bad ? 'bg-amber-400' : 'bg-emerald-400'
            } ${!health ? 'animate-pulse' : ''}`} />
            <h1 className={`font-display font-bold leading-tight text-fog-50 ${compact ? 'text-xl lg:text-2xl' : 'text-2xl lg:text-4xl'}`}>{verdict}</h1>
          </div>
          {facts.length > 0 && <p className="mt-2 text-sm text-fog-400">{facts.join(' · ')}</p>}
        </motion.div>

        <motion.div {...rise(0.08)} className={compact ? 'mt-3' : 'mt-5'}>
          <button onClick={scan} disabled={scanned?.kind === 'working'} data-hero-scan className={`btn-accent disabled:opacity-60 ${compact ? 'px-4 py-2 text-xs' : 'px-5 py-2.5 text-sm'}`}>
            <IcRefresh width={16} height={16} />{scanned?.kind === 'working' ? tr('Scanning library…') : tr('Scan library now')}
          </button>
          {scanned && scanned.kind !== 'working' && <div data-hero-scan-result className="max-w-xl"><ActionStatus state={scanned} /></div>}
        </motion.div>
      </div>
    </div>
  );
}

/** The hero's art, one random series of this library: a phone's pages open under the same wash. */
const HERO_ART = {
  queryKey: ['admin-hero-art'],
  queryFn: () => api<{ seriesId: string | null }>('/api/random'),
  staleTime: 5 * 60_000,
};

/**
 * Which Uchiyomi this is, at the foot of the admin menu (v0.55.4, #150).
 *
 * Kedryn: "I can't find anymore what version I'm running. I'm pretty sure it was in a menu on the left somewhere." It
 * was only Health's Version card. The number is the server's (`/api/admin/stats`), or Uchiyomi Desktop's own
 * (`bridge().version`, the app the person installed); whether a newer one is out is Health's `update` check, read from
 * the answer the header has already asked for -- the same query key, so no request of its own and nothing asked of
 * GitHub, and with update checks off it says nothing either way (lib/versionLine.ts). Short: run.mjs reads the
 * Settings tab's first 4000 characters of text, and on a desktop the rail comes before the panel.
 */
function VersionLine() {
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const { data: health } = useQuery(healthQuery);
  const running: string | null = bridge()?.version || stats?.version || null;
  if (!running) return null;
  return (
    <p data-admin-version className="px-1 text-[11px] leading-relaxed text-fog-500">
      <VersionFacts running={running} update={updateState(health?.checks)} />
    </p>
  );
}

/**
 * "Uchiyomi v0.55.4 · up to date", or "· update available (v0.55.5)" linking to that release. Each part in its own
 * <bdi>, and the tag isolated inside its sentence: a Latin version beside Arabic words otherwise takes their order. The
 * second part is one block on a line: the rail is too narrow for both, and broke "update available" from its tag.
 */
function VersionFacts({ running, update }: { running: string; update: UpdateState }) {
  return (
    <>
      <bdi>Uchiyomi {shownVersion(running)}</bdi>
      {update?.kind === 'behind' && (
        <>{' · '}<a data-version-update href={releaseHref(update.latest)} target="_blank" rel="noopener noreferrer"
          className="inline-block text-accent hover:underline"><bdi>{tr('update available ({version})', { version: `\u2068${update.latest}\u2069` })}</bdi></a></>
      )}
      {update?.kind === 'current' && <>{' · '}<bdi className="inline-block">{tr('up to date')}</bdi></>}
    </>
  );
}

/**
 * The overview.
 *
 * Three bands, in the order an admin wants the answers: what is wrong, who is reading, and what they are reading.
 * Where to go next is the console's own list, beside this page or one Back away (v0.88.0): the four tiles that led
 * to Tasks, Sessions, Sources and Activity were a second menu inside the first.
 *
 * The counts and the scan live in the server's hero above it, where they are read before anything is clicked.
 * Repeating them here would be the same numbers twice on one screen.
 */
function Overview() {
  const still = useReducedMotion();
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const { data: health } = useQuery(healthQuery);
  // What the household is actually reading, cross-user and last-14-days. The endpoint has existed since the
  // home screen shipped and admin has never called it; it is the best available answer to "is anyone
  // reading any of this", for one query and no new component.
  const { data: trending } = useQuery({
    queryKey: ['trending'],
    queryFn: () => api<{ content: Series[] }>('/api/trending'),
    staleTime: 5 * 60_000,
  });

  const activity: any[] = stats?.activity ?? [];
  const rail = trending?.content ?? [];

  return (
    <div className="board">
      {/* The whole width either way: nothing sits beside it now, and a healthy server's card is one line high. */}
      <NeedsAttention health={health} className="full" />

      {/* Band A -- the house: one card per member, washed in the cover of what they last read. */}
      {activity.length > 0 && (
        <div className="full">
          <h2 className="mb-2 font-display text-base font-semibold">{tr('Member activity')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((m: any, i: number) => (
              <motion.div key={m.id} className="card grad-border relative min-h-28 overflow-hidden p-4"
                initial={still ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.04, ease: [0.22, 0.61, 0.36, 1] }}>
                {/* The cover re-checks visibility for THIS admin on the way out, so a restricted admin gets
                    the broken-image glyph rather than art from a library they cannot open. */}
                {m.last_series_id && (
                  <Img src={img.seriesThumb(m.last_series_id)} alt=""
                    className="pointer-events-none absolute inset-0 h-full w-full scale-110 opacity-25 blur-[2px]" />
                )}
                <div aria-hidden className="absolute inset-0 bg-linear-to-r from-ink-950 via-ink-950/80 to-ink-950/35 rtl:bg-linear-to-l" />
                <div className="relative flex items-center gap-3">
                  <Avatar avatar={m.avatar} size={48} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fog-50">{m.display_name}</p>
                    <p className="truncate text-[11px] text-fog-500">
                      {m.last_active ? tr('active {when}', { when: relativeTime(m.last_active) }) : tr('No activity yet.')}
                    </p>
                    {m.last_series_title && <p className="truncate text-[11px] text-fog-400">{m.last_series_title}</p>}
                  </div>
                  <span className="ms-auto shrink-0 text-end">
                    <span className="font-display text-xl font-bold tabular-nums text-accent">{m.week}</span>
                    <span className="block text-[10px] tabular-nums text-fog-500">{m.total}</span>
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Band B -- what the household is reading. Unmounts entirely when empty: never a heading over nothing. */}
      {rail.length > 0 && (
        <div className="full">
          <h2 className="mb-2 font-display text-base font-semibold">{tr('Top 10 in your library')}</h2>
          <div className="hide-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scroll-snap-type:x_mandatory] lg:mx-0 lg:px-0"
            data-lenis-prevent-horizontal>
            {/* The heading says ten. */}
            {rail.slice(0, 10).map((sx) => <SeriesCard key={sx.id} series={sx} />)}
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * Whether anything is wrong, and what.
 *
 * The whole width of the overview, and its height says the rest: one line on a healthy server, a tile for every check
 * that found something on a broken one.
 */
function NeedsAttention({ health, className = '' }: {
  health?: { generatedAt: string; checks: HealthCheck[] };
  className?: string;
}) {
  const failing = (health?.checks ?? []).filter((c) => c.status !== 'ok');
  return (
    <div className={`card grad-border p-4 ${className}`}>
      <h2 className="mb-2 font-display text-base font-semibold">{tr('Needs attention')}</h2>
      {!health ? (
        <p className="text-sm text-fog-500">{tr('Checking your library…')}</p>
      ) : !failing.length ? (
        <>
          <p className="text-sm text-fog-200">{tr('Everything looks healthy')}</p>
          <p className="mt-1 text-[11px] text-fog-500">{tr('checked {when}', { when: relativeTime(health.generatedAt) })}</p>
        </>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {failing.map((c) => {
            // The tint alone told a problem from a warning only to someone who can tell red from amber:
            // the glyph's shape says it too, and names it to a screen reader. The edge is StatusEdge's bar,
            // the one every card that needs a second look wears from v0.49.0. Inset 12 px rather than the
            // default 16: the tile is short, and 12 still clears its 16 px corners (checked at 390 and 1280).
            const m = healthMark(c.status);
            return (
              <div key={c.id} className={`relative rounded-2xl border px-3 py-2.5 ${TONE_SURFACE[m.tone]}`}>
                <StatusEdge tone={m.tone} inset="inset-y-3" />
                {/* In the reader's language: the title by the check's id, the summary by its codes (lib/said.ts). */}
                <p className="flex items-center gap-1.5 text-sm font-medium text-fog-100"><StatusMark tone={m.tone} title={m.label} />{checkTitle(c)}</p>
                <p dir="auto" className="mt-0.5 text-[11px] text-fog-400">{checkSummary(c)}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** An account's role, in the reader's words. "Admin" is the console's own name (the rail's head), so the role is its own key. */
const roleText = (role: string): string => (role === 'admin' ? tr('Administrator') : tr('Member'));

/**
 * The household.
 *
 * One card per member rather than one divided list. The list was correct at 864px and wrong at 1592, where
 * every row left a lake of nothing between a name and the chips that act on it; a card puts the actions
 * under the face they belong to at every width, and twenty members become a wall you can scan.
 */
function Members() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ content: any[]; auth?: { mode: 'local' | 'oidc-only'; sso: string | null; signup: boolean } }>('/api/admin/users'),
  });
  // SSO-only mode (v0.63.0, #208): accounts come from the provider. No New account, no password to reset -- the server
  // refuses both -- and a card that says where accounts come from instead. Reintroduce the form and "Members offers no
  // New account and no password in SSO-only mode" in web/test/ssoOnly.test.ts fails. The one account Members still
  // makes there is a profile with no password, which opens at home (New profile, below).
  const ssoOnly = data?.auth?.mode === 'oidc-only';
  const provider = data?.auth?.sso ?? '';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  // A profile that opens at home without a password, and the account that manages it.
  const [localOpen, setLocalOpen] = useState(false);
  const [managedBy, setManagedBy] = useState('');
  const [busy, setBusy] = useState(false);
  // A password reset and a deletion are the two things here that cannot be undone by clicking again, so
  // both go through the app's own dialogs. prompt()/confirm() were untranslatable, unstyled, and in a
  // standalone PWA are rendered badly or suppressed outright.
  const [resetting, setResetting] = useState<any | null>(null);
  const [pw, setPw] = useState('');
  const [deleting, setDeleting] = useState<any | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const inval = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    // In SSO-only mode the server makes a profile with no password and nothing else (403 sso_only): New profile sends that.
    const open = localOpen || ssoOnly;
    if (!username.trim() || (!password && !open) || busy) return;
    setBusy(true);
    try {
      await api('/api/admin/users', { json: {
        username: username.trim(), password: ssoOnly ? undefined : password || undefined, displayName: displayName.trim() || undefined,
        role: open ? 'user' : role, ...(open ? { localOpen: true, managedBy: managedBy || undefined } : {}),
      } });
      toast(tr('Account {name} created', { name: iso(`@${username.trim()}`) }), 'success');
      setUsername(''); setPassword(''); setDisplayName(''); setRole('user'); setLocalOpen(false); setManagedBy(''); inval();
    }
    catch (e: any) { toast(e instanceof ApiError && e.status === 409 ? tr('Username taken') : msgOf(e, tr('Could not create account')), 'error'); }
    setBusy(false);
  };
  const patch = async (u: any, body: any, ok: string) => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: body }); toast(ok, 'success'); inval(); } catch (e: any) { toast(msgOf(e, tr('Could not update')), 'error'); } };
  const closeReset = () => { setResetting(null); setPw(''); };
  const del = async (u: any) => {
    setDeletingBusy(true);
    try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast(tr('Account removed'), 'success'); setDeleting(null); inval(); }
    // The server refuses the last admin by its code alone (bff routes/admin.ts): say that one, and only that one.
    catch (e) { toast(codeOf(e) === 'last_admin' ? tr('The last admin cannot be removed') : tr('Could not remove that account'), 'error'); }
    setDeletingBusy(false);
  };

  // Who may manage a profile: an enabled account that signs in with a credential of its own (bff routes/admin.ts mayManage).
  const managers = (data?.content ?? []).filter((m: any) => !m.disabled && (m.kind === 'password' || m.kind === 'hybrid'));
  const nameOf = (id: string): string => (data?.content ?? []).find((m: any) => m.id === id)?.display_name ?? '?';

  return (
    <div className="board">
      {ssoOnly ? (
        <div className="card grad-border p-4" data-sso-accounts>
          <h2 className="mb-2 font-display text-base font-semibold">{tr('New accounts')}</h2>
          <p className="text-sm leading-relaxed text-fog-300">
            {data?.auth?.signup
              ? tr('This server signs in through {name} only. Anyone {name} lets in gets an account the first time they sign in, so choose who in {name}.', { name: iso(provider) })
              : tr('This server signs in through {name} only, and makes no new accounts: only accounts already linked to {name} can sign in. OIDC_ALLOW_SIGNUP lets new people in.', { name: iso(provider) })}
          </p>
          {/* What those accounts start with (#208, item 6): the chips of the card below in local mode. */}
          <NewMemberDefaults sso provider={provider} signup={!!data?.auth?.signup} />
        </div>
      ) : (
      <form onSubmit={create} className="card grad-border p-4">
        <h2 className="mb-3 font-display text-base font-semibold">{tr('New account')}</h2>
        <div className="space-y-2">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr('username')} autoCapitalize="none" autoCorrect="off" className="field" />
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={tr('display name (optional)')} className="field" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder={localOpen ? tr('password (optional: for outside home)') : tr('password (min 8)')} className="field" />
          {/* Opens at home without a password: never an admin, so it replaces the role; with a password as well, the
              password lets it in from anywhere else. */}
          <button type="button" onClick={() => setLocalOpen(!localOpen)} aria-pressed={localOpen} data-local-open
            className={`btn-key w-full ${localOpen ? 'btn-key-accent' : ''}`}>{tr('Opens at home without a password')}</button>
          {localOpen ? (
            <>
              <select value={managedBy} onChange={(e) => setManagedBy(e.target.value)} className="field">
                <option value="">{tr('Managed by an admin')}</option>
                {managers.map((m: any) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
              <HomeNetwork />
            </>
          ) : (
            <div className="flex gap-2">{(['user', 'admin'] as const).map((r) => <button key={r} type="button" onClick={() => setRole(r)} className={`flex-1 rounded-xl border py-2 text-sm capitalize ${role === r ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{roleText(r)}</button>)}</div>
          )}
        </div>
        <button type="submit" disabled={busy || !username.trim() || (localOpen ? password.length > 0 && password.length < 8 : password.length < 8)} className="btn-accent mt-3 w-full disabled:opacity-50"><IcPlus width={18} height={18} /> {busy ? tr('Creating…') : tr('Create account')}</button>
      </form>
      )}
      {/* SSO-only mode's one way to make an account here: a profile with no
          password, which opens on the home network only, through a session the provider signed in or Who is reading?. */}
      {ssoOnly && data && (
        <form onSubmit={create} className="card grad-border p-4" data-sso-profile>
          <h2 className="mb-1 font-display text-base font-semibold">{tr('New profile')}</h2>
          <p className="mb-3 text-sm leading-relaxed text-fog-300">{tr('Accounts come from {name}, but a profile without a password can be made here: it opens on the home network only.', { name: iso(provider) })}</p>
          <div className="space-y-2">
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr('username')} autoCapitalize="none" autoCorrect="off" className="field" />
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={tr('display name (optional)')} className="field" />
            <select value={managedBy} onChange={(e) => setManagedBy(e.target.value)} className="field">
              <option value="">{tr('Managed by an admin')}</option>
              {managers.map((m: any) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
            <HomeNetwork />
          </div>
          <button type="submit" disabled={busy || !username.trim()} className="btn-accent mt-3 w-full disabled:opacity-50"><IcPlus width={18} height={18} /> {busy ? tr('Creating…') : tr('Create profile')}</button>
        </form>
      )}
      {/* #208, item 6: what a member who signs up starts with. A card of its own beside New account, which is an admin
          choosing and is left alone by it. After the users list has answered, which says whether the provider makes
          accounts too. */}
      {!ssoOnly && data && <NewMemberDefaults provider={provider} signup={!!data.auth?.signup} />}

      {(data?.content ?? []).map((u: any) => {
        const self = u.id === user?.id;
        const canDl = u.perms?.canDownload !== false;
        return (
          <div key={u.id} className="card grad-border p-4">
            <div className="flex items-center gap-3">
              <Avatar avatar={u.avatar} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fog-100">{u.display_name}</p>
                <p className="truncate text-[11px] text-fog-500">@{u.username}</p>
              </div>
              {!self && (
                <button onClick={() => setDeleting(u)} aria-label={tr('Remove')}
                  className="btn-key btn-key-danger h-9 w-9 px-0"><IcTrash width={16} height={16} /></button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-fog-500">
              {/* The provider's name on an account linked to it (v0.63.0), as 2FA marks the accounts that have it. */}
              {[roleText(u.role), self ? tr('you') : null, u.disabled ? tr('disabled') : null, u.totp_enabled ? '2FA' : null, u.sso && provider ? provider : null,
                u.kind === 'open' ? tr('no password, opens at home') : u.kind === 'hybrid' ? tr('no password at home') : null,
                u.managed_by ? tr('managed by {name}', { name: iso(nameOf(u.managed_by)) }) : null].filter(Boolean).join(' · ')}
            </p>
            {/* Keys (UI refresh): each acts on the account. The choices inside the library and age panels stay chips. */}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {!ssoOnly && <button onClick={() => setResetting(u)} className="btn-key">{tr('Reset')}</button>}
              {!self && (
                <>
                  {!u.local_open && <button onClick={() => patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }, tr('Role updated'))} className="btn-key">{u.role === 'admin' ? tr('Make member') : tr('Make admin')}</button>}
                  <button onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? tr('Account enabled') : tr('Account disabled'))} className="btn-key">{u.disabled ? tr('Enable') : tr('Disable')}</button>
                  {/* A member's, like the two below: an admin downloads whatever the flag says (routes/sources.ts), so on an
                      admin's card it toggled nothing -- and one the provider made carries the new-member default for
                      the day it is made a member, which read here as a refusal it is not. */}
                  {u.role !== 'admin' && <button onClick={() => patch(u, { perms: { ...u.perms, canDownload: !canDl } }, tr('Permission updated'))} className="btn-key">{canDl ? tr('Deny downloads') : tr('Allow downloads')}</button>}
                  {/* Profiles that open at home, members only: never an admin's. */}
                  {u.role !== 'admin' && <button onClick={() => patch(u, { localOpen: !u.local_open }, tr('Permission updated'))} aria-pressed={!!u.local_open}
                    className={`btn-key ${u.local_open ? 'btn-key-accent' : ''}`}>{tr('Opens at home without a password')}</button>}
                  {u.role !== 'admin' && u.local_open && u.password_login && !ssoOnly && <button onClick={() => patch(u, { removePassword: true }, tr('Password removed'))} className="btn-key">{tr('Remove password')}</button>}
                  {u.role !== 'admin' && u.kind !== 'open' && <button onClick={() => patch(u, { perms: { ...u.perms, canManageProfiles: !u.perms?.canManageProfiles } }, tr('Permission updated'))}
                    aria-pressed={!!u.perms?.canManageProfiles} className={`btn-key ${u.perms?.canManageProfiles ? 'btn-key-accent' : ''}`}>{tr('Can make profiles')}</button>}
                  {/* Library access. "All libraries" is the ABSENCE of grant rows, not a full set of them, so a
                      library added next month is visible to unrestricted accounts without editing anyone. */}
                  {u.role !== 'admin' && <LibraryAccess granted={u.libraries ?? null} onSaved={inval}
                    save={(libraries) => api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: { libraries } })} />}
                  {u.role !== 'admin' && <AgeCap cap={u.max_age_rating ?? null} onSaved={inval}
                    save={(maxAgeRating) => api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: { maxAgeRating } })} />}
                </>
              )}
            </div>
          </div>
        );
      })}

      {resetting && (
        <Modal title={tr('Change password')} onClose={closeReset}>
          <p className="mb-3 text-sm text-fog-400">@{resetting.username}</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
            placeholder={tr('New password (min 8 characters)')} className="field" />
          <div className="mt-4 flex gap-2">
            <button onClick={closeReset} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
            <button disabled={pw.length < 8}
              onClick={() => { patch(resetting, { password: pw }, tr('Password reset · sessions revoked')); closeReset(); }}
              className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Update password')}</button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={tr('Remove “{name}”?', { name: `@${deleting.username}` })}
          body={tr('Their reading history, favourites and sessions go with the account. Nothing in the library is touched and no files are deleted.')}
          confirmLabel={tr('Remove')}
          confirmText={deleting.username}
          danger
          busy={deletingBusy}
          onConfirm={() => del(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/**
 * How the server sees the admin asking (bff GET /api/admin/network), beside a profile that opens at home: whether the
 * admin is at home, and the way to the page that says which networks are (components/NetworkSettings.tsx).
 */
function HomeNetwork() {
  const { data } = useNetwork();
  if (!data) return null;
  return (
    <p className="text-[11px] leading-relaxed text-fog-500" data-home-network>
      {seenText(data)}{' '}
      <a href="/admin/?tab=server&section=local-networks" className="underline decoration-dotted underline-offset-2 hover:text-fog-300">
        {tr('Home network')}
      </a>
    </p>
  );
}

/**
 * What a member the server makes by itself starts with (#208, item 6; bff lib/memberDefaults.ts): one who signs up, or
 * who signs in through the provider for the first time while it makes accounts (OIDC_ALLOW_SIGNUP). A member card's own
 * three chips -- downloads, libraries, age limit -- with the same panels and meanings, saved to the server's settings
 * rather than to an account: what is set here is what that account's card shows on its first day.
 *
 * A card of its own after New account, which is an admin choosing and is left alone by these, as every account that
 * exists is; in SSO-only mode, inside the card that says where accounts come from. When nobody can sign up, the card
 * says so, rather than reading as a setting that does nothing.
 */
function NewMemberDefaults({ sso, provider, signup }: { sso?: boolean; provider: string; signup: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Admin → Settings' own query: one answer and one refetch for both tabs.
  const { data } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<any>('/api/admin/settings') });
  if (!data) return null;
  const d = memberDefaultsOf(data);
  // Resolves once the refetch has landed, so a chip stays busy until it shows what was saved.
  const saved = () => qc.invalidateQueries({ queryKey: ['admin-settings'] });
  const save = (patch: Partial<MemberDefaults>) => api('/api/admin/settings', { method: 'PATCH', json: { newMemberDefaults: patch } });
  const canDl = d.perms.canDownload !== false;
  const flipDownloads = async () => {
    setBusy(true);
    try { await save({ perms: canDl ? { canDownload: false } : {} }); toast(tr('Permission updated'), 'success'); await saved(); }
    catch (e) { toast(msgOf(e, tr('Could not update')), 'error'); }
    setBusy(false);
  };
  // The keys say what a new member gets, lit where that is less than everything, as LibraryAccess and AgeCap are.
  const chips = (
    <div className="mt-2.5 flex flex-wrap gap-1.5" data-member-defaults>
      <button onClick={flipDownloads} disabled={busy} className={`btn-key ${canDl ? '' : 'btn-key-accent'}`}>{canDl ? tr('Can download') : tr('No downloads')}</button>
      <LibraryAccess granted={d.libraries} save={(libraries) => save({ libraries })} onSaved={saved} nothing={tr('New members would see nothing.')} />
      <AgeCap cap={d.maxAgeRating} save={(maxAgeRating) => save({ maxAgeRating })} onSaved={saved} />
    </div>
  );
  // `id`: Admin → Settings → Server's "When someone signs up" row lands here (`?section=member-defaults`, v0.86.0).
  if (sso) {
    return (
      <div id="member-defaults" className="mt-3 scroll-mt-4 border-t border-ink-800 pt-3 lg:scroll-mt-20">
        <p className="text-[11px] leading-relaxed text-fog-500">{tr('Each new member starts with these. Existing accounts are not affected.')}</p>
        {chips}
      </div>
    );
  }
  return (
    <div id="member-defaults" className="card grad-border scroll-mt-4 p-4 lg:scroll-mt-20">
      <h2 className="mb-2 font-display text-base font-semibold">{tr('When someone signs up')}</h2>
      <p className="text-sm leading-relaxed text-fog-300">
        {provider && signup
          ? tr('A member who signs up, or signs in with {name} for the first time, starts with these.', { name: iso(provider) })
          : tr('A member who signs up starts with these.')}
      </p>
      {chips}
      <p className="mt-2.5 text-[11px] leading-relaxed text-fog-500">{tr('Existing accounts, and accounts you make here, are not affected.')}</p>
      {!joinsOnTheirOwn({ registration: !!data.allow_registration, provider: provider || null, signup }) && (
        <p className="mt-1 text-[11px] leading-relaxed text-fog-400">{tr('Nobody can sign up right now: Open registration is off in Settings.')}</p>
      )}
    </div>
  );
}

// ---- Art Review: see every series' art at a glance, fix the ugly ones in two clicks ----
interface ArtRow { id: string; title: string; books_count: number; has_banner: boolean; has_cover: boolean; override_banner: boolean; override_cover: boolean; first_page?: boolean; override_v: number | null }
interface ArtCandidate { origin: string; title: string; banner: string | null; cover: string | null }

/**
 * What a gallery tile's art is, under its title: a series whose art is its own first page (chosen, or nothing else
 * found), art set by hand, a banner found, or a cover and no banner. In the reader's words since v0.55.7.
 */
const artCaption = (r: ArtRow): string =>
  r.first_page ? tr('first-page art')
  : r.override_banner || r.override_cover ? tr('custom art')
  : r.has_banner ? tr('banner ✓')
  : r.has_cover ? tr('cover only')
  : tr('first-page art');

/** The last backfill's outcome, each count in its pair of keys: "+1 banners" was English in every language. */
const backfillLine = (job: { banners: number; covers: number; misses: number }): string => tr('Last run: {result}', {
  result: [
    job.banners === 1 ? tr('1 banner found') : tr('{n} banners found', { n: job.banners }),
    job.covers === 1 ? tr('1 cover found') : tr('{n} covers found', { n: job.covers }),
    job.misses === 1 ? tr('1 not found') : tr('{n} not found', { n: job.misses }),
  ].join(' · '),
});

function ArtReview() {
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'nobanner' | 'nocover' | 'fixed'>('nobanner');
  const [open, setOpen] = useState<ArtRow | null>(null); // series whose candidate sheet is open
  const [bust, setBust] = useState<Record<string, number>>({}); // per-series cache-bust after an apply
  const { data } = useQuery({ queryKey: ['admin-art'], queryFn: () => api<{ content: ArtRow[] }>('/api/admin/art/overview') });
  const { data: bf } = useQuery({
    queryKey: ['admin-art-backfill'],
    queryFn: () => api<{ job: any }>('/api/admin/art/backfill/status'),
    refetchInterval: (q) => (q.state.data?.job?.running ? 3000 : false),
  });
  const rows = (data?.content ?? []).filter((r) =>
    filter === 'all' ? true
    : filter === 'nobanner' ? !r.has_banner && !r.override_banner
    : filter === 'nocover' ? !r.has_cover && !r.override_cover
    : r.override_banner || r.override_cover,
  );
  const startBackfill = async () => {
    try {
      const r = await api<{ total: number }>('/api/admin/art/backfill', { method: 'POST' });
      toast(r.total === 1 ? tr('Hunting art for 1 series…') : tr('Hunting art for {n} series…', { n: r.total }), 'success', { busy: true });
      qc.invalidateQueries({ queryKey: ['admin-art-backfill'] });
    // A second backfill is refused by code with an English sentence (bff routes/admin.ts): say it in the reader's words.
    } catch (e: any) { toast(codeOf(e) === 'busy' ? tr('A backfill is already running.') : msgOf(e, tr('Could not start the backfill')), 'error'); }
  };
  const job = bf?.job;
  return (
    <div className="board">
      <div className="card grad-border full p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">{tr('Cover & banner health')}</h2>
            <p className="text-xs text-fog-500">{tr('Backfill re-hunts AniList + MangaDex for missing art. Click a series to pick art by hand.')}</p>
            <p className="mt-1 text-[11px] text-fog-500">{tr('Manual AniList actions can contact AniList even when automatic lookups are off.')}</p>
          </div>
          <button onClick={startBackfill} disabled={!!job?.running} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
            {job?.running ? tr('Backfilling {done} of {total}…', { done: job.done, total: job.total }) : tr('Backfill missing banners')}
          </button>
        </div>
        {job && !job.running && <p className="mt-2 text-xs text-fog-400">{backfillLine(job)}</p>}
      </div>
      <div className="hide-scrollbar full flex gap-1.5 overflow-x-auto pb-1">
        {([['nobanner', tr('Missing banner')], ['nocover', tr('Missing cover')], ['fixed', tr('Overridden')], ['all', tr('All')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${filter === k ? 'bg-accent text-white' : 'bg-ink-800 text-fog-300'}`}>
            {label}{k !== 'all' ? ` (${(data?.content ?? []).filter((r) => (k === 'nobanner' ? !r.has_banner && !r.override_banner : k === 'nocover' ? !r.has_cover && !r.override_cover : r.override_banner || r.override_cover)).length})` : ''}
          </button>
        ))}
      </div>
      <div className="full grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 wide:grid-cols-8">
        {rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r)} className="card overflow-hidden p-0 text-start transition hover:border-accent/40">
            <div className="relative h-16 w-full overflow-hidden bg-ink-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* As the series page shows it (v0.53.0): a banner sharp, a stand-in cover blurred -- the art being judged. */}
              <img src={`/img/series/${encodeURIComponent(r.id)}/backdrop?style=banner&rv=${bust[r.id] || 0}`} alt="" className="h-full w-full object-cover" loading="lazy" />
              {!r.has_banner && !r.override_banner && <span className="absolute end-1 top-1 rounded bg-red-600/80 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">{tr('No banner')}</span>}
            </div>
            <div className="flex items-center gap-2 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${img.seriesThumb(r.id)}&rv=${bust[r.id] || 0}`} alt="" className="h-12 w-8 shrink-0 rounded object-cover" loading="lazy" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-fog-100">{r.title}</p>
                <p className="text-[10px] text-fog-500">{artCaption(r)}</p>
              </div>
            </div>
          </button>
        ))}
      </div>
      {/* The row as the gallery has it now, not as it was when the picker opened: after Use the first page or a reset the
          picker's keys follow what the series has. */}
      {open && <ArtPicker row={(data?.content ?? []).find((r) => r.id === open.id) ?? open} onClose={() => setOpen(null)}
        onApplied={() => { bustCover(open.id); setBust((b) => ({ ...b, [open.id]: Date.now() })); qc.invalidateQueries({ queryKey: ['admin-art'] }); }} />}
    </div>
  );
}

function ArtPicker({ row, onClose, onApplied }: { row: ArtRow; onClose: () => void; onApplied: () => void }) {
  // A dialog on the notices' layer stack (lib/layers.ts): it toasts while open ("Failed to apply").
  useLayer('dialog');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-art-cand', row.id],
    queryFn: () => api<{ content: ArtCandidate[] }>(`/api/admin/art/candidates/${row.id}`),
    staleTime: 10 * 60 * 1000,
  });
  const apply = async (kind: 'cover' | 'banner', url: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind, mode: 'url', url } });
      toast(kind === 'banner' ? tr('Banner updated') : tr('Cover updated'), 'success');
      onApplied();
    } catch { toast(kind === 'banner' ? tr('Could not change the banner') : tr('Could not change the cover'), 'error'); }
    setBusy(false);
  };
  const reset = async (kind: 'cover' | 'banner') => {
    if (busy) return;
    setBusy(true);
    try { await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind, mode: 'reset' } }); toast(kind === 'banner' ? tr('Banner reset to automatic') : tr('Cover reset to automatic'), 'success'); onApplied(); }
    catch { toast(tr('Failed'), 'error'); }
    setBusy(false);
  };
  // Use the first page (v0.55.7, #168), as Edit details offers it: the series' own first page is its cover for good.
  const firstPage = async () => {
    if (busy) return;
    setBusy(true);
    try { await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind: 'cover', mode: 'first_page' } }); toast(tr('Cover updated'), 'success'); onApplied(); }
    catch { toast(tr('Could not change the cover'), 'error'); }
    setBusy(false);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={onClose}>
      {/* max-w-xl, the widest a centred panel may be: from lg up the notices' column beside it is sized to clear
          36 rem (lib/notices.ts WIDE_BESIDE_DIALOG), and at 42 rem this one's corner sat under it. */}
      <div role="dialog" aria-modal="true" aria-label={row.title} data-lenis-prevent className="glass max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{row.title}</h3>
          <button onClick={onClose} aria-label={tr('Close')} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button data-art-first-page onClick={() => firstPage()} disabled={busy || row.first_page} className="btn-key">{tr('Use the first page')}</button>
          {row.override_cover && <button onClick={() => reset('cover')} disabled={busy} className="btn-key">{tr('Reset cover to auto')}</button>}
          {row.override_banner && <button onClick={() => reset('banner')} disabled={busy} className="btn-key">{tr('Reset banner to auto')}</button>}
        </div>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Searching AniList + MangaDex…')}</p>
        ) : !(data?.content?.length) ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('No candidates found — use Edit details on the series page to paste a URL.')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data!.content.map((c, i) => (
              <div key={i} className="card overflow-hidden p-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.banner || c.cover || ''} alt="" className="h-28 w-full object-cover" loading="lazy" />
                <div className="p-2">
                  <p className="truncate text-[11px] text-fog-300">{c.title}</p>
                  <p className="text-[10px] uppercase tracking-wide text-fog-500">{c.origin}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    {c.banner && <button onClick={() => apply('banner', c.banner!)} disabled={busy} className="btn-accent flex-1 px-2 py-1 text-[11px] disabled:opacity-50">{tr('Use as banner')}</button>}
                    {c.cover && <button onClick={() => apply('cover', c.cover!)} disabled={busy} className="btn-ghost flex-1 px-2 py-1 text-[11px] disabled:opacity-50">{tr('Use as cover')}</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tasks() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ content: any[] }>('/api/admin/tasks'), refetchInterval: 5000 });
  const run = async (id: string) => {
    try {
      const r = await api<{ ok?: boolean; error?: string; started?: boolean; series?: number; books?: number }>(`/api/admin/tasks/${id}/run`, { method: 'POST' });
      // A refusal is a 200 with ok:false (the task is already running), and used to toast "Started" too.
      // `not_enabled` is reachable in one narrow window: this list polls every five seconds, so a task
      // switched off in Settings is still on screen for a moment afterwards. "Failed" would be a lie about
      // something the admin had just done on purpose.
      // ⚠️ `sweep_running` and `repair_running` (v0.41.0) are the two jobs refusing to run beside each
      // other -- the repair beside a chapter sweep, and the sweep beside a repair -- and they are the two
      // refusals here that clear by themselves. Under "Already running" each read as the task the admin
      // had just pressed being stuck, which is the opposite of what is happening and sends them restarting
      // the container. Each one names the OTHER job, or the sentence is about a task that is idle.
      if (r?.ok === false) {
        toast(r.error === 'sweep_running' ? tr('A chapter sweep is running — try again in a few minutes')
          : r.error === 'repair_running' ? tr('The library repair is running — try again in a few minutes')
          : r.error === 'busy' ? tr('Already running')
          : r.error === 'not_enabled' ? tr('That task is switched off')
          : tr('Failed'), 'error');
      }
      // ⚠️ The scan is the one task that runs to completion before answering, and it answers with its
      // counts. Toasting "Started" for it hid the only fact that mattered: in #34 a library scanned to zero
      // series and the reporter's summary was "the run now buttons don't work" -- because from the outside,
      // "Started" followed by nothing changing is indistinguishable from a button that does nothing.
      else if (typeof r?.series === 'number') {
        const s = scanState({ scanned: true, series: r.series, books: r.books }, Date.now());
        toast(s.kind === 'done' ? s.outcome : '', r.series ? 'success' : 'error');
      }
      // The verify task is detached (one stat per chapter over a share is minutes, and a request that long
      // dies at the proxy while the walk goes on), so its counts cannot be in this answer. The one place
      // they appear is the Tasks line, which this panel polls -- and the admin who just restored a database
      // is told exactly that, or "Started" followed by nothing is a button that did nothing (#34).
      else if (id === 'verify' && r?.started) toast(tr('Started — the Tasks line shows what it found when it is done.'), 'success');
      // The repair is detached for the same reason and reports the same way, so it gets the same sentence
      // rather than a bare "Started": a nightly run counts two thousand files and can replace a chapter,
      // and none of that is in this answer.
      else if (id === 'repair' && r?.started) toast(tr('Started — the Tasks line shows what it did'), 'success');
      // Rescan everything's preview says how far it has got, and then what Apply would do, in the panel under its row
      // (components/RescanTask.tsx): a "Started" toast would only point at what is already on screen.
      else if (id === 'rescan' && r?.started) qc.invalidateQueries({ queryKey: RESCAN_KEY });
      else toast(tr('Started'), 'success');
      qc.invalidateQueries({ queryKey: ['admin-tasks'] });
    } catch { toast(tr('Failed'), 'error'); }
  };
  // Chronological, per-row actions: a list, not a card grid. But an explicit column template rather than
  // `justify-between`, which at 1592px left a lake of nothing between a task's name and its own button.
  return (
    <div className="board">
      <DesktopBackups />
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((t: any) => (
          // `id`: the search palette's Rescan everything lands on its row (`?section=task-rescan`, lib/destinations.ts), clear
          // of the desktop's top bar.
          <div key={t.id} id={`task-${t.id}`} className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3.5 lg:scroll-mt-20 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto]">
            <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{tr(t.name)}</p>
            {/* Phone stacks the schedule under the name; from lg it takes a track of its own. */}
            {/* ⚠️ `remaining` is shown because the backlog is the one number that tells you whether a task is
                keeping up. The server has always sent it and nothing displayed it, so a job that had quietly
                stopped picking up new work looked identical to one with nothing to do. */}
            {/* Wraps rather than truncates: a task's result is the only record of a detached run, and the
                verify line ("one folder looked unmounted…: /library-dl, 4000 checked, 312 missing…") is
                900 px wide -- truncated, it read as a clean run on every width. */}
            <p className="col-start-1 row-start-2 min-w-0 break-words text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
              {scheduleText(t)} · {t.lastRun ? tr('last run {when}', { when: relativeTime(new Date(t.lastRun).toISOString()) }) : tr('not run yet')}
              {/* The repair's line is the last FULL run's since v0.49.0 (the nightly, or Run now here): say which. */}
              {t.lastRun && t.lastOrigin === 'nightly' ? ` ${tr('(nightly)')}` : t.lastRun && t.lastOrigin === 'manual' ? ` ${tr('(run by hand)')}` : ''}
              {taskResult(t.lastResult)}
              {typeof t.remaining === 'number' && t.remaining > 0 && (
                <span className="text-amber-300"> · {tr('{n} waiting', { n: t.remaining.toLocaleString() })}</span>
              )}
              {t.id === 'matches' && (
                <span className="mt-1 block">{tr('Manual AniList actions can contact AniList even when automatic lookups are off.')}</span>
              )}
            </p>
            {t.id === 'repair' && (
              <div className="col-start-1 row-start-3 min-w-0 lg:col-start-2 lg:row-start-2">
                <RepairTaskLines nextAt={t.nextAt} latestOther={t.latestOther} running={!!t.running} />
              </div>
            )}
            {/* v0.55.4: Rescan everything previews before it changes anything, and the preview needs the row's width. */}
            {t.id === 'rescan' && (
              <div className="col-span-full row-start-3 min-w-0 lg:row-start-2">
                <RescanPanel running={!!t.running} />
              </div>
            )}
            <button onClick={() => run(t.id)} disabled={t.running}
              className="btn-key col-start-2 row-span-2 row-start-1 justify-self-end lg:col-start-3 lg:row-span-1">
              {t.running ? tr('Running…') : t.id === 'rescan' ? tr('Start') : tr('Run now')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Uchiyomi Desktop's backups, under Tasks where the nightly backup is listed. Renders nothing without the
 * shell's bridge, so the server build's Tasks tab is unchanged.
 *
 * The backups are files in a folder on this computer, so the useful thing is to open that folder (to copy
 * one to another drive, or to find last night's). Restoring cannot happen inside the page: the shell has to
 * stop the library server, load the dump into the database and start it again (design-inapp §6), so this
 * asks first -- it replaces everything since that backup -- and then hands over to the shell's own dialog.
 */
function DesktopBackups() {
  const toast = useToast();
  const b = bridge();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!b || (typeof b.revealBackups !== 'function' && typeof b.restoreBackup !== 'function')) return null;
  const restore = async () => {
    setBusy(true);
    try { await b.restoreBackup(); setAsking(false); }
    // Electron prefixes a rejected IPC call with "Error invoking remote method '…': Error: "; the shell's own
    // sentence is what follows it.
    catch (e: any) { toast(String(e?.message || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') || tr('Could not restore that backup'), 'error'); }
    setBusy(false);
  };
  return (
    <div className="full flex flex-wrap items-center justify-end gap-2">
      {typeof b.revealBackups === 'function' && (
        <button type="button" onClick={() => b.revealBackups()} className="chip text-xs">{tr('Open backups folder')}</button>
      )}
      {typeof b.restoreBackup === 'function' && (
        <button type="button" onClick={() => setAsking(true)} className="chip text-xs">{tr('Restore a backup…')}</button>
      )}
      {asking && (
        <ConfirmDialog
          title={tr('Restore a backup?')}
          body={tr('Uchiyomi closes your library, replaces its database and settings with the backup you choose, and opens again. Everything since that backup — reading progress, new series, settings — is replaced. The manga files themselves are not touched.')}
          confirmLabel={tr('Choose a backup…')}
          danger
          busy={busy}
          onConfirm={() => { void restore(); }}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

function Activity() {
  const { data } = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ content: any[] }>('/api/admin/audit?limit=150'), refetchInterval: 8000 });
  const label = (e: string) => e.replace(/\./g, ' ').replace(/_/g, ' ');
  // A feed stays a feed -- chronological data must not be chopped into a card grid. What changes is that a
  // row is now an explicit column template, so at 1592px the detail fills the space that used to be a lake
  // between the event and its timestamp, and the 60-character truncation of the detail is no longer needed.
  return (
    <div className="board">
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((a: any) => {
          const detail = a.detail && Object.keys(a.detail).length ? JSON.stringify(a.detail) : '';
          return (
            <div key={a.id} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2.5 lg:grid-cols-[8px_minmax(0,20rem)_minmax(0,1fr)_auto]">
              <span aria-hidden className={`h-2 w-2 translate-y-1 rounded-full ${/fail|block|disable|delete/.test(a.event) ? 'bg-red-400' : /login|ok|register/.test(a.event) ? 'bg-emerald-400' : 'bg-accent'}`} />
              <p className="min-w-0 truncate text-sm text-fog-100"><span className="font-medium capitalize">{label(a.event)}</span>{a.username ? <span className="text-fog-400"> · {a.username}</span> : ''}</p>
              {/* Hidden below lg rather than reflowed: a display:none child takes no track, so the phone
                  template is the three columns it declares and the desktop one is four. */}
              <p className="hidden min-w-0 truncate font-mono text-[11px] text-fog-500 lg:block">{detail}</p>
              <p className="shrink-0 text-end text-[11px] text-fog-500">{relativeTime(a.at)}{a.ip ? ` · ${a.ip}` : ''}</p>
            </div>
          );
        })}
        {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">{tr('No activity yet.')}</p>}
      </div>
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-sessions'], queryFn: () => api<{ content: any[] }>('/api/admin/sessions') });
  const revoke = async (id: string) => { await api(`/api/admin/sessions/${id}`, { method: 'DELETE' }); toast(tr('Session revoked'), 'success'); qc.invalidateQueries({ queryKey: ['admin-sessions'] }); };
  return (
    <div className="board">
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((s: any) => (
          <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,14rem)_minmax(0,10rem)_auto]">
            <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{s.display_name || s.username}</p>
            {/* Phone folds device and ip under the name; from lg each takes its own track. */}
            <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
              {/* The stored name through the same mapping as Profile → Sessions: an older sign-in's English "Browser"
                  is not shown, and no name is "Device" in the reader's words. */}
              {shownDeviceName(s.device_name) || tr('Device')}
              <span className="lg:hidden"> · {s.ip || tr('unknown ip')} · {tr('active {when}', { when: relativeTime(s.last_seen) })}</span>
            </p>
            <p className="hidden min-w-0 truncate font-mono text-[11px] text-fog-500 lg:col-start-3 lg:row-start-1 lg:block">{s.ip || tr('unknown ip')}</p>
            <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 justify-self-end lg:col-start-4 lg:row-span-1">
              <span className="hidden text-[11px] text-fog-500 lg:inline">{tr('active {when}', { when: relativeTime(s.last_seen) })}</span>
              {/* `current` marks the caller's own session. The admin route does not send it yet, so this is
                  inert rather than wrong: without it, revoking the row you are sitting on logs you out. */}
              {s.current ? (
                <span className="flex items-center gap-1.5 text-[11px] text-fog-500">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />{tr('You')}
                </span>
              ) : (
                <button onClick={() => revoke(s.id)} className="text-xs text-red-300 hover:underline">{tr('Revoke')}</button>
              )}
            </div>
          </div>
        ))}
        {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">{tr('No active sessions.')}</p>}
      </div>
    </div>
  );
}

// `HealthItem` / `HealthCheck` live in lib/types.ts (v0.41.0): HealthActions.tsx renders an item's chips
// and this page mounts them, so declaring the shapes here would have meant that component importing from a
// Next route file which imports the component straight back. `info` items -- a source you switched off, a
// short chapter you already confirmed -- are rendered dimmed so the eye lands on the real findings.

/** Read-only audit of the library: gaps, truncated downloads, duplicates, and failing sources. */
interface DeletedRow {
  id: string; title: string; folder: string; books_count: number; deleted_at: string;
  /** Counted from lib_books: a row whose files Delete files removed has every chapter pruned and none live. */
  live_books: number; pruned_books: number;
}
/** Delete files has already been through this one: nothing on disk, every chapter row a tombstone. */
const filesGone = (r: DeletedRow) => r.live_books === 0 && r.pruned_books > 0;

/** What has been removed from the library, and the way back. Removing never touches files, so this is
 *  always reversible -- the series keeps its id, and with it everyone's progress, favourites and ratings. */
interface LibraryRow {
  id: string; name: string; path: string; n: number;
  /** Every folder it holds, the first (`path`) first (v0.55.1, #148). The default library's is empty. */
  paths?: string[];
  age_rating: number | null;
  /** Automatic, implicit title/id lookups may contact AniList for series currently filed here. */
  anilist_lookup: boolean;
  /** Reading defaults for its series (bff lib/libraryReader.ts): mode, pages per view, direction; null when it has none. */
  reader_prefs?: { mode?: string; spread?: boolean; pagedDirection?: string } | null;
  /** How many of its series were placed here by hand rather than by the folder rule. */
  pinned: number;
  /** Who can open it. Includes members with no restriction at all, who see every library. */
  members: string[];
}
interface LibraryCandidate { path: string; series: number; looksLikeSource: boolean; depth?: number }
interface FolderRow { name: string; path: string; series: number }
interface FolderPage { path: string; parent: string | null; folders: FolderRow[] }

/**
 * Libraries are declared here, never inferred from the filesystem.
 *
 * The candidate list is offered rather than a free-text box because the obvious guess is wrong on a real
 * install: the top level of a library root usually holds SOURCE folders written by the downloader, and
 * promoting one of those makes a "library" named after a scraper. Those candidates are flagged as such.
 */
/**
 * Which libraries one member may see -- or, on When someone signs up, the ones a member who signs up starts with.
 *
 * "All libraries" is the absence of grant rows, not a full set of them. That distinction matters on upgrade
 * (nobody's access changes) and later (a library created next month is visible to unrestricted accounts
 * without touching a single user row), so the toggle writes null rather than every id.
 *
 * Admins are unrestricted by definition and never get this control.
 */
/**
 * The highest age rating one member may see -- or, on When someone signs up, the one a member who signs up starts with.
 *
 * Mirrors LibraryAccess deliberately: null means no cap, the same way no grant rows means every library, so
 * an account with neither restriction behaves exactly as it did before either existed.
 *
 * The wording says "and below" because a cap is a ceiling, not a band -- and the note about unrated content
 * is there because it is the first thing a parent will ask, and finding out by discovering an unrated title
 * on a child's account would be a bad way to learn it.
 */
const AGE_CAPS = [6, 10, 13, 15, 17, 18];

function AgeCap({ cap, save: store, onSaved }: { cap: number | null; save: (next: number | null) => Promise<unknown>; onSaved: () => unknown }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (next: number | null) => {
    setBusy(true);
    try {
      await store(next);
      toast(next === null ? tr('No age limit') : tr('Limited to {age}+ and below', { age: next }), 'success');
      // Busy until the refetch has landed: a click before it would save from the old value.
      await onSaved();
    } catch (e) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };

  return (
    <>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`btn-key ${cap !== null ? 'btn-key-accent' : ''}`}>
        {cap === null ? tr('Any age rating') : tr('{age}+ and below', { age: cap })}
      </button>
      {open && (
        <div className="mt-1.5 w-full rounded-xl border border-ink-700 p-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-fog-200">{tr('No age limit')}</span>
            <input type="checkbox" checked={cap === null} disabled={busy}
              onChange={(e) => save(e.target.checked ? null : 13)}
              className="size-4 shrink-0 accent-accent" />
          </label>
          {cap !== null && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
              {AGE_CAPS.map((v) => (
                <button key={v} disabled={busy} onClick={() => save(v)}
                  className={`chip text-xs disabled:opacity-50 ${cap === v ? 'chip-active' : ''}`}>
                  {v}+
                </button>
              ))}
            </div>
          )}
          {/* Two sentences, the first in bold: `tr('Series with')` glued to an English "no rating stay visible" read
              "Series withno rating" in English and half English in every other language. */}
          <p className="mt-2 text-[11px] text-fog-500">
            <strong className="text-fog-300">{tr('Series with no rating stay visible.')}</strong>{' '}
            {tr('Most libraries carry no ratings at all, so hiding them would empty this account rather than filter it. Rate a series from its own page to have a limit apply to it.')}
          </p>
        </div>
      )}
    </>
  );
}

function LibraryAccess({ granted, save: store, onSaved, nothing }: {
  granted: string[] | null;
  save: (next: string[] | null) => Promise<unknown>;
  onSaved: () => unknown;
  /** What the panel says when none are ticked. */
  nothing?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: LibraryRow[] }>('/api/admin/libraries'),
    enabled: open,
  });
  const libs = data?.content ?? [];

  const save = async (next: string[] | null) => {
    setBusy(true);
    try {
      await store(next);
      toast(!next ? tr('All libraries') : next.length === 1 ? tr('Limited to 1 library') : tr('Limited to {n} libraries', { n: next.length }), 'success');
      // Busy until the refetch has landed: two quick ticks both worked from the old list, and the second undid the first.
      await onSaved();
    } catch (e) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };

  const toggle = (id: string) => {
    const base = granted ?? libs.map((l) => l.id);
    save(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  // Only worth showing once there is more than one library to choose between.
  return (
    <>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`btn-key ${granted ? 'btn-key-accent' : ''}`}>
        {!granted ? tr('All libraries') : granted.length === 1 ? tr('1 library') : tr('{n} libraries', { n: granted.length })}
      </button>
      {open && (
        <div className="mt-1.5 w-full rounded-xl border border-ink-700 p-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-fog-200">{tr('All libraries')}<span className="ms-1 text-fog-500">{tr('(including any added later)')}</span></span>
            {/* Not before the list has loaded: unticked over an empty list, "every library" was saved as none. */}
            <input type="checkbox" checked={!granted} disabled={busy || !data}
              onChange={(e) => save(e.target.checked ? null : libs.map((l) => l.id))}
              className="size-4 shrink-0 accent-accent" />
          </label>
          {granted && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
              {libs.map((l) => (
                <button key={l.id} disabled={busy} onClick={() => toggle(l.id)}
                  className={`chip text-xs disabled:opacity-50 ${granted.includes(l.id) ? 'chip-active' : ''}`}>
                  {l.name}
                </button>
              ))}
              {!granted.length && <p className="text-[11px] text-amber-300">{nothing ?? tr('This member currently sees nothing.')}</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Pick folders: browse what is actually on disk, and tick each one the library holds (v0.55.1, #148: several).
 *
 * The old dialog offered a fixed list of candidates and nothing else, and that list was computed from the
 * FIRST path segment only -- which on a real install holds the source names the downloader wrote. So the
 * only options offered were the ones not to pick, and the folder an admin actually wanted could not be
 * reached at all. The API always accepted any path; nothing ever asked for one.
 *
 * A row's name opens the folder; its box puts the folder in the library or takes it out (it was a "Use" key that
 * replaced the one folder). A folder another library holds is shown as taken and cannot be ticked: a folder belongs to
 * one library, though a folder inside it is free to be another's.
 */
function FolderPicker({ chosen, held, onToggle }: {
  chosen: readonly string[]; held: Map<string, string>; onToggle: (p: string) => void;
}) {
  const [at, setAt] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['admin-folders', at],
    queryFn: () => api<FolderPage>(`/api/admin/libraries/folders?path=${encodeURIComponent(at)}`),
  });

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/40" data-folder-picker>
      <div className="flex min-w-0 items-center gap-2 border-b border-ink-800 px-2.5 py-1.5">
        <button type="button" disabled={data?.parent === null} aria-label={tr('Back')}
          onClick={() => setAt(data?.parent ?? '')}
          className="btn-key h-7 w-7 px-0 text-[11px]">↑</button>
        <p className={`min-w-0 truncate text-[11px] text-fog-400 ${at ? 'font-mono' : ''}`}><bdi>{at || tr('Library root')}</bdi></p>
      </div>
      <div data-lenis-prevent className="max-h-52 overflow-y-auto p-1.5">
        {isFetching && !data ? (
          <p className="px-2 py-3 text-center text-[11px] text-fog-600">{tr('Loading…')}</p>
        ) : !data?.folders.length ? (
          <p className="px-2 py-3 text-center text-[11px] text-fog-600">{tr('No folders here')}</p>
        ) : data.folders.map((f) => {
          const holder = held.get(f.path);
          const on = chosen.includes(f.path);
          return (
            <div key={f.path} className="flex min-w-0 items-center gap-1" data-folder-row={f.path} data-folder-on={on ? '' : undefined}>
              <label className={`grid size-8 shrink-0 place-items-center ${holder && !on ? '' : 'cursor-pointer'}`}>
                <input type="checkbox" checked={on} disabled={!!holder && !on} onChange={() => onToggle(f.path)}
                  aria-label={f.name} className="size-4 accent-accent disabled:opacity-40" />
              </label>
              <button type="button" onClick={() => setAt(f.path)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1.5 text-start text-xs text-fog-200 hover:bg-ink-800/70">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <bdi className="min-w-0 truncate">{f.name}</bdi>
                    <span className="shrink-0 text-fog-600">· {f.series}</span>
                  </span>
                  {/* Under the name, not beside it: a library's name is as long as anyone made it. */}
                  {holder && <span className="block truncate text-[10px] text-fog-500" data-folder-held>{heldByText(holder)}</span>}
                </span>
                <IcChevronRight width={12} height={12} aria-hidden className="shrink-0 text-fog-600 rtl:-scale-x-100" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Create or edit one library: its name, its folders and its age rating (v0.55.1, #148: one or more folders).
 *
 * The folders are a list, each with its own key to take it out. Type one and Add it, or tick it in the browser below.
 * A folder typed and never added is saved with the rest: typing a path and pressing Create is how a library was always
 * made. The preview follows the list, so what the save would move -- over every folder -- is on screen before anyone
 * presses it. A folder another library holds says whose it is, and Save waits until it is gone.
 */
function LibraryDialog({ editing, start, libs, onClose, onSaved }: {
  editing: LibraryRow | null;
  start: { name: string; paths: string[] };
  libs: LibraryRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(editing?.name ?? start.name);
  const [paths, setPaths] = useState<string[]>(editing ? foldersOf(editing) : start.paths);
  const [typed, setTyped] = useState('');
  const [age, setAge] = useState<string>(editing?.age_rating == null ? '' : String(editing.age_rating));
  const [anilistLookup, setAniListLookup] = useState(editing?.anilist_lookup ?? true);
  const [look, setLook] = useState<Record<string, string>>(() => {
    const r = editing?.reader_prefs;
    return { mode: r?.mode ?? '', spread: r?.spread === undefined ? '' : String(r.spread), pagedDirection: r?.pagedDirection ?? '' };
  });
  const readerPrefs = () => {
    const o: Record<string, unknown> = {};
    if (look.mode) o.mode = look.mode;
    if (look.spread) o.spread = look.spread === 'true';
    if (look.pagedDirection) o.pagedDirection = look.pagedDirection;
    return Object.keys(o).length ? o : null;
  };
  const [preview, setPreview] = useState<{ series: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const isLib = editing?.id === 'lib';
  const held = useMemo(() => heldByOthers(libs, editing?.id ?? null), [libs, editing]);
  // What Save sends: the list, and a folder still in the box.
  const folders = addFolder(paths, typed);
  const unchanged = !!editing && sameFolders(folders, foldersOf(editing));
  const taken = folders.find((p) => held.has(p));
  const typedHeld = held.get(typedFolder(typed));

  // Preview follows the list, so "what will this contain" is answered before committing.
  const listKey = folders.join('\n');
  useEffect(() => {
    // Nothing to promise when the folders have not been touched: an unchanged list moves nothing, and "0 series would
    // move" reads like a warning. Nor for a folder another library holds, which the save refuses.
    if (isLib || !folders.length || unchanged || taken) { setPreview(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api<{ series: number; sample: string[] }>(`/api/admin/libraries/preview?${previewQuery(editing?.id ?? null, folders)}`)
        .then((r) => { if (alive) setPreview(r); })
        .catch(() => { if (alive) setPreview(null); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listKey` is `folders`, compared by value
  }, [listKey, isLib, unchanged, taken, editing?.id]);

  const nameFrom = (p: string) => { if (!name.trim()) setName(p.split('/').pop() || p); };
  const toggle = (p: string) => {
    if (!paths.includes(p)) nameFrom(p);
    setPaths((cur) => toggleFolder(cur, p));
  };
  const add = () => {
    const p = typedFolder(typed);
    if (!p) return;
    nameFrom(p);
    setPaths((cur) => addFolder(cur, p));
    setTyped('');
  };

  const save = async () => {
    setBusy(true);
    try {
      const ageRating = age === '' ? null : Number(age);
      if (editing) {
        const body: Record<string, unknown> = { name: name.trim(), ageRating, anilistLookup, readerPrefs: readerPrefs() };
        if (!isLib && !unchanged) body.paths = folders;
        await api(`/api/admin/libraries/${editing.id}`, { method: 'PATCH', json: body });
        toast(tr('Saved'), 'success');
      } else {
        // One request. This used to POST the library and then PATCH the rating separately, and skip the
        // PATCH entirely when the rating was null -- so a failed second call created an unrated library
        // under a "Created" toast, which is the one outcome nobody would check for.
        await api('/api/admin/libraries', { method: 'POST', json: { name: name.trim(), paths: folders, ageRating, anilistLookup, readerPrefs: readerPrefs() } });
        toast(tr('Created'), 'success');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast(msgOf(e, tr('Could not save that library')), 'error');
      setBusy(false);
    }
  };
  const canSave = !!name.trim() && (isLib || (folders.length > 0 && !taken));

  return (
    <Modal title={editing ? tr('Edit library') : tr('New library')} onClose={onClose}>
      <div data-library-dialog={editing?.id ?? 'new'}>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="field" />

        {!isLib && (
          <>
            <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Folders')}</label>
            {paths.length > 0 && (
              <ul className="mb-2 max-w-md space-y-1" data-library-folders-chosen>
                {paths.map((p) => {
                  const holder = held.get(p);
                  return (
                    <li key={p} data-library-folder={p}
                      className={`flex min-w-0 items-center gap-2 rounded-lg border py-1 ps-2.5 pe-1 ${holder ? 'border-amber-500/40' : 'border-ink-700'} bg-ink-900/40`}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs text-fog-200" title={p}><bdi>{p}</bdi></span>
                        {holder && <span className="block truncate text-[10px] text-amber-300">{heldByText(holder)}</span>}
                      </span>
                      <button type="button" onClick={() => setPaths((cur) => cur.filter((x) => x !== p))}
                        aria-label={tr('Remove {name}', { name: p })} className="btn-key h-7 w-7 px-0" data-library-folder-remove>
                        <IcX width={13} height={13} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex max-w-md gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} dir="auto"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder={tr('e.g. Manga/Seinen')} className="field min-w-0 flex-1 font-mono" data-library-folder-input />
              <button type="button" onClick={add} disabled={!typedFolder(typed)} className="btn-key h-auto self-stretch">{tr('Add')}</button>
            </div>
            {typedHeld && <p className="mt-1 text-[11px] text-amber-300">{heldByText(typedHeld)}</p>}
            <p className="mb-2 mt-1 max-w-md text-[11px] text-fog-600">
              {tr('Type a folder under your library root, or tick folders below. A library can hold several, and libraries may sit inside one another — the most specific folder wins.')}
            </p>
            <FolderPicker chosen={paths} held={held} onToggle={toggle} />
          </>
        )}

        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Age rating')}</label>
        <select value={age} onChange={(e) => setAge(e.target.value)} className="field">
          <option value="">{tr('Not rated — visible to everyone')}</option>
          {[6, 10, 13, 15, 17, 18].map((v) => <option key={v} value={String(v)}>{v}+</option>)}
        </select>
        <p className="mt-1 text-[11px] text-fog-600">
          {tr('Everything in this library inherits it. A single series can still be rated differently from its own page.')}
        </p>

        <label className="mt-3 flex max-w-md cursor-pointer items-start justify-between gap-4 rounded-lg border border-ink-700 bg-ink-900/40 p-3">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-fog-200">{tr('Look up art and metadata on AniList automatically')}</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-fog-500">
              {tr("When off, automatic lookups do not send this library's titles to AniList. Existing art and matches stay, and manual AniList actions can still connect.")}
            </span>
          </span>
          <input type="checkbox" checked={anilistLookup} onChange={(e) => setAniListLookup(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-accent" data-library-anilist-lookup />
        </label>

        <div className="mt-3 max-w-md rounded-lg border border-ink-700 bg-ink-900/40 p-3" data-library-reader>
          <span className="block text-xs font-medium text-fog-200">{tr('Reading defaults')}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-fog-500">
            {tr("Used for every series in this library, unless the series or its source has its own.")}
          </span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {([
              ['mode', tr('Reading mode'), [['vertical', tr('Webtoon (scroll)')], ['paged', tr('Paged (swipe)')]]],
              ['spread', tr('Pages per view'), [['false', tr('Single')], ['true', tr('Double spread')]]],
              ['pagedDirection', tr('Reading direction'), [['series', tr('Series default')], ['ltr', tr('Left to right')], ['rtl', tr('Right to left')]]],
            ] as const).map(([k, label, opts]) => (
              <label key={k} className="block text-[11px] text-fog-400">
                {label}
                <select value={look[k]} onChange={(e) => setLook({ ...look, [k]: e.target.value })}
                  className="field mt-1" data-library-look={k}>
                  <option value="">{tr('Use user default')}</option>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>

        {preview && (
          <p className="mt-3 text-[11px] leading-relaxed text-fog-500" data-library-preview={preview.series}>
            {previewText(preview.series, preview.sample)}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-key">{tr('Cancel')}</button>
          <button type="button" onClick={save} disabled={busy || !canSave} className="btn-key btn-key-primary" data-library-save>
            {busy ? tr('Working…') : editing ? tr('Save') : tr('Create')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LibrariesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LibraryRow | null>(null);
  // What a new library starts with: nothing, or a suggested folder and its name.
  const [start, setStart] = useState<{ name: string; paths: string[] }>({ name: '', paths: [] });
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<LibraryRow | null>(null);
  const [access, setAccess] = useState<LibraryRow | null>(null);

  const { data } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: LibraryRow[]; candidates: LibraryCandidate[] }>('/api/admin/libraries'),
  });
  const libs = data?.content ?? [];
  const candidates = data?.candidates ?? [];
  // Only to tell "nobody may open this" apart from "there is nobody yet", which on a fresh install is the
  // difference between a warning and a fact. Admins always see everything and are not members.
  const { data: people } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ content: { role: string }[] }>('/api/admin/users'),
  });
  const anyMembers = (people?.content ?? []).some((u) => u.role !== 'admin');
  // Uchiyomi Desktop keeps libraries and their age rating but not who may open them (lib/desktop.ts).
  const desktopLibs = isDesktop();
  // ['libraries'] too (v0.60.1, found in Squeaks72's fork): the Library page's library filter and the 18+ toggle read it
  // (components/AdultToggle.tsx useLibraries), and with a five-minute staleTime they kept a renamed, added or removed
  // library in this tab until then.
  const refresh = () => { for (const k of [['admin-libraries'], ['libraries'], ['admin-users'], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k }); };

  const openNew = (from = { name: '', paths: [] as string[] }) => { setStart(from); setAdding(true); setEditing(null); };
  const openEdit = (l: LibraryRow) => { setEditing(l); setAdding(false); };
  const close = () => { setAdding(false); setEditing(null); };

  const remove = async (l: LibraryRow) => {
    setBusy(true);
    try {
      await api(`/api/admin/libraries/${l.id}`, { method: 'DELETE' });
      toast(tr('Removed'), 'success');
      setConfirmDel(null);
      refresh();
    } catch (e) { toast(msgOf(e, tr('Could not remove that library')), 'error'); }
    setBusy(false);
  };

  return (
    <section className="full">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-display text-base font-semibold">{tr('Libraries')}</h3>
        <button onClick={() => openNew()} className="chip shrink-0 text-xs"><IcPlus width={13} height={13} />{tr('New library')}</button>
      </div>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-fog-500">
        {desktopLibs
          ? tr('A library is one or more folders, plus any series you file into it by hand. Give it an age rating and everything in it inherits that.')
          : tr('A library is one or more folders, plus any series you file into it by hand. Give it an age rating and everything in it inherits that, and choose who can open it.')}
      </p>

      {/* Cards rather than one divided list: at 1592px a row left a lake between a library's path and the
          buttons that act on it, and a library is a thing rather than an entry in a feed. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {libs.map((l) => (
          <div key={l.id} className="card grad-border min-w-0 p-3" data-library-card={l.id}>
            <div className="min-w-0">
              <p className="truncate text-sm text-fog-100">{l.name}</p>
              {/* Its folders: the first, then how many more (v0.55.1, #148). */}
              <LibraryFolders paths={foldersOf(l)} className="text-[11px] text-fog-500" />
              <p className="truncate text-[11px] text-fog-600">
                {l.n} {tr('series')}
                {l.pinned > 0 && <> · {l.pinned === 1 ? tr('1 filed by hand') : tr('{n} filed by hand', { n: l.pinned })}</>}
                {/* Who may open it is per-person access, which desktop does not have (one person, no members). */}
                {!desktopLibs && <>{' · '}{!anyMembers ? tr('admins only') : l.members.length ? tr('{n} can open it', { n: l.members.length }) : tr('nobody can open it')}</>}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {/* The rating is its own control on the card, not just a badge.
                  It lives inside the settings dialog, which is correct, but "Edit" gave no hint that age
                  ratings were in there -- so a rating that had never been set looked like a feature that
                  did not exist. Showing the UNRATED state is the point: no badge used to mean both
                  "everyone can see this" and "I never looked". */}
              <button onClick={() => openEdit(l)}
                className={`chip text-xs ${l.age_rating != null ? 'border-amber-500/40 text-amber-300' : ''}`}>
                {l.age_rating != null ? tr('{n}+', { n: l.age_rating }) : tr('Not rated')}
              </button>
              {!desktopLibs && <button onClick={() => setAccess(l)} className="chip text-xs">{tr('Access')}</button>}
              <button onClick={() => openEdit(l)} className="chip text-xs">{tr('Settings')}</button>
              {l.id !== 'lib' && (
                <button onClick={() => setConfirmDel(l)} className="chip text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Remove')}</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {candidates.length > 0 && (
        <>
          <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Folders you could split out')}</p>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 12).map((c) => (
              <button key={c.path} onClick={() => openNew({ name: c.path.split('/').pop() || c.path, paths: [c.path] })}
                className={`chip max-w-full text-xs ${c.looksLikeSource ? 'opacity-60' : ''}`}>
                <bdi className="min-w-0 truncate font-mono">{c.path}</bdi> <span className="text-fog-500">· {c.series}</span>
                {c.looksLikeSource && <span className="ms-1 text-amber-400">{tr('source?')}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {(adding || editing) && (
        <LibraryDialog key={editing?.id ?? 'new'} editing={editing} start={start} libs={libs} onClose={close} onSaved={refresh} />
      )}

      {access && <LibraryAccessDialog lib={access} onClose={() => setAccess(null)} onSaved={refresh} />}

      {confirmDel && (
        <ConfirmDialog
          title={tr('Remove “{name}”?', { name: confirmDel.name })}
          body={<>{tr('Its series go back to whichever library still covers their folder, or to the default. Nothing is deleted, no files are touched, and no reading progress changes.')}</>}
          confirmLabel={tr('Remove library')}
          danger
          busy={busy}
          onConfirm={() => remove(confirmDel)}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </section>
  );
}

/**
 * Who can open one library.
 *
 * The subtlety worth stating in the UI: a member with no restrictions at all can see EVERY library, so they
 * are shown as already able to open this one. Granting them is a no-op. Revoking them is not -- it has to
 * write out every other library explicitly, because "everything except this" cannot be said any other way.
 * The server does that; this just has to describe it honestly.
 */
function LibraryAccessDialog({ lib, onClose, onSaved }: { lib: LibraryRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set(lib.members));
  const { data } = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ content: any[] }>('/api/admin/users') });
  const members = (data?.content ?? []).filter((u) => u.role !== 'admin');

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/libraries/${lib.id}`, { method: 'PATCH', json: { members: [...sel] } });
      toast(tr('Saved'), 'success');
      onSaved();
      onClose();
    } catch (e) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title={tr('Who can open “{name}”?', { name: lib.name })} onClose={onClose}>
      {!members.length ? (
        <p className="text-sm text-fog-500">{tr('No members yet.')}</p>
      ) : (
        <div className="space-y-1">
          {members.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800/50">
              <span className="min-w-0 truncate text-fog-200">{u.display_name || u.username}</span>
              <input type="checkbox" checked={sel.has(u.id)} disabled={busy}
                onChange={(e) => setSel((prev) => { const n = new Set(prev); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })}
                className="size-4 shrink-0 accent-accent" />
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-fog-600">
        {tr('Admins can always see everything. A member with no limits set can open every library, including ones added later — unticking them here is what turns that into an explicit list.')}
      </p>
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">
          {busy ? tr('Working…') : tr('Save')}
        </button>
      </div>
    </Modal>
  );
}

function LibraryPanel() {
  const qc = useQueryClient();
  const [purge, setPurge] = useState<DeletedRow | null>(null);
  const [purging, setPurging] = useState(false);
  // #328: chapter files the server found gone on a library it cannot prove is there -- a folder deleted by hand looks
  // exactly like a drive that is not connected. The admin is asked, and their yes is the same call with `gone`.
  const [notThere, setNotThere] = useState<{ row: DeletedRow; n: number } | null>(null);
  const [marking, setMarking] = useState(false);

  const deleteFiles = async (r: DeletedRow, gone = false) => {
    (gone ? setMarking : setPurging)(true);
    try {
      const res = await api<DeleteFilesResult>(`/api/admin/series/${r.id}/delete-files`,
        { method: 'POST', json: gone ? { confirm: r.title, gone: true } : { confirm: r.title } });
      // Files the server could not look at are left on disk and said, with what to check (lib/deleteFiles.ts).
      const notice = deleteFilesNotice(res);
      // Nothing deleted and nothing marked: the question below says why, which a green "Deleted 0 files" would not.
      if (res.files || res.gone || res.unchecked || !res.unproven) toast(notice.message, notice.type);
      setPurge(null);
      setNotThere(!gone && res.unproven ? { row: r, n: res.unproven } : null);
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e: any) {
      // A refusal carries the actual reason and, for a permissions problem, the exact fix.
      let msg = msgOf(e, tr('Could not delete the files'));
      try { const b = JSON.parse(e?.body || '{}'); if (b.fix) msg = `${b.message} ${b.fix}`; } catch {}
      toast(msg, 'error');
      if (gone) setNotThere(null);
    }
    (gone ? setMarking : setPurging)(false);
  };
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-deleted'],
    queryFn: () => api<{ content: DeletedRow[] }>('/api/admin/series/deleted'),
  });
  const rows = data?.content || [];

  // The third step. Remove hides, Delete files lets the bytes go, Forget erases the row and everyone's
  // history on it -- the one action here that rewrites other members' stats and Wrapped, and the one with
  // no Put back. The server refuses (409) while anything could bring the series back: a live chapter row
  // (which is what an unmounted share leaves behind), a root that is not there, a folder that still holds
  // chapters. The refusal carries the fix.
  const [forget, setForget] = useState<DeletedRow | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const forgetSeries = async (r: DeletedRow) => {
    setForgetting(true);
    try {
      const res = await api<{ books: number; absorbed: number; users: number }>(`/api/admin/series/${r.id}/forget`,
        { method: 'POST', json: { confirm: r.title } });
      toast(res.users === 0 ? tr('Forgotten. Nobody had read it.')
        : res.users === 1 ? tr("Forgotten. 1 member's history on it is gone.")
        : tr("Forgotten. {n} members' history on it is gone.", { n: res.users }), 'success');
      setForget(null);
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e: any) {
      let msg = msgOf(e, tr('Could not forget it'));
      try { const b = JSON.parse(e?.body || '{}'); if (b.fix) msg = `${b.message} ${b.fix}`; } catch {}
      toast(msg, 'error');
    }
    setForgetting(false);
  };

  const restore = async (r: DeletedRow) => {
    setBusy(r.id);
    try {
      await api(`/api/admin/series/${r.id}/restore`, { method: 'POST' });
      toast(tr('“{title}” is back in the library', { title: iso(r.title) }), 'success');
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e) { toast(msgOf(e, tr('Could not restore it')), 'error'); }
    setBusy(null);
  };

  return (
    <div className="board">
      <LibrariesSection />
      {purge && (
        <ConfirmDialog
          title={tr('Delete the files for “{title}”?', { title: iso(purge.title) })}
          body={
            <>
              {/* `live_books`, not books_count: the scan wrote books_count before anything was pruned, and a
                  series with two files left and three tombstones would be told "this deletes 5". */}
              <p>
                <strong className="text-fog-100">{purge.live_books === 1 ? tr('This deletes 1 chapter file from your disk.')
                  : tr('This deletes {n} chapter files from your disk.', { n: purge.live_books })}</strong>{' '}
                {tr('It cannot be undone from here.')}
              </p>
              <p className="mt-2">{tr('Everyone’s reading progress and history are kept, so the record of having read it survives even though the files do not.')}</p>
              {/* The path is LTR text whatever the UI direction: unmarked, Arabic moved its leading slash
                  to the far end ("library-dl/mangadex/gone-for-good/"). */}
              <p className="mt-2 text-fog-500">{tr('Folder')}: <span dir="ltr">{purge.folder}</span></p>
            </>
          }
          confirmLabel={tr('Delete files')}
          confirmText={purge.title}
          danger
          busy={purging}
          onConfirm={() => deleteFiles(purge)}
          onClose={() => setPurge(null)}
        />
      )}
      {notThere && (
        <ConfirmDialog
          title={notOnDiskTitle(notThere.n)}
          body={
            <>
              <p>{tr("Uchiyomi can't tell a file you deleted from one on a drive that isn't connected right now, so it left them as they were. If you deleted or moved them yourself, mark them gone. Then you can forget the series.")}</p>
              <p className="mt-2 text-fog-500">{tr('Folder')}: <span dir="ltr">{notThere.row.folder}</span></p>
            </>
          }
          confirmLabel={tr('Mark them gone')}
          busy={marking}
          onConfirm={() => deleteFiles(notThere.row, true)}
          onClose={() => setNotThere(null)}
        />
      )}
      {forget && (
        <ConfirmDialog
          title={tr('Forget "{title}" for good?', { title: forget.title })}
          body={
            <>
              {/* The opposite of the Delete-files reassurance above, on purpose: that dialog promises the
                  history survives, and this is the step that takes it. Named per kind so nobody reads
                  "history" as "just the progress bar". */}
              <p><strong className="text-fog-100">{tr("This erases the series and everyone's reading history on it — progress, bookmarks, notes, ratings, favourites, tracker links.")}</strong></p>
              <p className="mt-2">{tr('Stats and Wrapped change. If the files ever reappear it comes back as a new series with no history. This cannot be undone.')}</p>
              <p className="mt-2 text-fog-500">{tr('Folder')}: <span dir="ltr">{forget.folder}</span></p>
            </>
          }
          confirmLabel={tr('Forget')}
          confirmText={forget.title}
          danger
          busy={forgetting}
          onConfirm={() => forgetSeries(forget)}
          onClose={() => setForget(null)}
        />
      )}
      <div className="full space-y-3">
        <p className="max-w-prose text-xs text-fog-500">
          {tr('Removing a series hides it from the library, search and the updater. Its files are left exactly where they are, and everyone’s reading progress is kept, so putting it back changes nothing else.')}
        </p>
        {isLoading ? (
          <div className="card grad-border p-4 text-sm text-fog-500">{tr('Loading…')}</div>
        ) : !rows.length ? (
          <div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Nothing has been removed.')}</div>
        ) : (
          <div className="card grad-border divide-y divide-ink-800/70 overflow-hidden">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)_auto]">
                {/* Two lines on a phone, one with an ellipsis and a tooltip on a desktop: a real title
                    ("Kaguya-sama: Love Is War – The First Kiss That Never Ends") measured 506 px against a
                    168 px column at 390, and two long-prefix titles were indistinguishable in the list. The
                    typed step in the dialog carries the full title either way. `lg:block` first, so the
                    -webkit-box the clamp needs gives way to the nowrap ellipsis. */}
                <p className="col-start-1 row-start-1 min-w-0 line-clamp-2 text-sm text-fog-100 lg:block lg:truncate" title={r.title}>{r.title}</p>
                {/* The state LEADS the caption: at 390 px the caption truncates after ~130 px, and "files
                    deleted" at its end was exactly the part cut off. The explanation is a visible second
                    line, not a title= tooltip -- a phone never shows one. The button stays "Put back": a
                    longer label ("Put back (files were deleted)") squeezed the title to "Gone F…" in German. */}
                <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
                  {filesGone(r) ? `${tr('files deleted')} · ` : ''}
                  {r.books_count === 1
                    ? tr('1 chapter · removed {when}', { when: relativeTime(r.deleted_at) })
                    : tr('{n} chapters · removed {when}', { n: r.books_count, when: relativeTime(r.deleted_at) })}
                  {' · '}{r.folder}
                </p>
                {filesGone(r) && (
                  <p className="col-span-2 col-start-1 row-start-3 min-w-0 text-[11px] text-fog-400 lg:col-span-1 lg:col-start-2 lg:row-start-2">
                    {tr('The chapter files are gone. Put back lists them as deleted from the server; Fetch again on the series page brings back the ones Uchiyomi downloaded.')}
                  </p>
                )}
                <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 gap-1.5 justify-self-end lg:col-start-3 lg:row-span-1">
                  {/* After Delete files the button still works -- the series comes back with every chapter
                      marked "Deleted from the server", which is where Fetch again lives -- and the caption
                      above says so: an unmarked "Put back" here used to restore a series whose chapters all
                      404'd. */}
                  <button onClick={() => restore(r)} disabled={busy === r.id} className="chip shrink-0 text-xs disabled:opacity-50">
                    {busy === r.id ? tr('Restoring…') : tr('Put back')}
                  </button>
                  {/* The escalation, and only ever after the reversible step. Hiding is undoable; this is not.
                      Only while a chapter row still claims a file: with every file gone it would only report
                      "Deleted 0 file(s)", and a row that never had a chapter is refused outright ("no files
                      on disk"). ⚠️ `live_books > 0`, the exact complement of Forget's `=== 0` below, so a
                      row never carries both and never a third chip: at 390 px three chips squeezed "Never
                      Had Chapters" to 21 px of title. */}
                  {r.live_books > 0 && (
                    <button onClick={() => setPurge(r)} className="chip shrink-0 text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Delete files')}</button>
                  )}
                  {/* The third step, and only once nothing is left on disk to bring the series back: the
                      files-gone row, or a row that never had a chapter. Painted rose outright rather than
                      on hover -- the other two chips are recoverable, this one is not. The server refuses
                      on its own if a folder still holds chapters or a root is not there, and the toast
                      carries its fix. */}
                  {r.live_books === 0 && (
                    <button onClick={() => setForget(r)} className="chip shrink-0 border-rose-500/40 text-xs text-rose-300 hover:border-rose-500/70 hover:text-rose-200">{tr('Forget')}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Health() {
  const [open, setOpen] = useState<string | null>(null);
  // v0.55.0: Fix everything's dialog -- the question, the run, or how the run ended.
  const [fixing, setFixing] = useState(false);
  // v0.72.0 (#254): one card per check, or one per series. This device's choice, read after mount: the static export
  // renders without localStorage. The report asks for the series while it is By series (lib/healthBySeries.ts).
  const [view, setView] = useState<HealthView>('checks');
  useEffect(() => { setView(healthView()); }, []);
  const { data, isFetching, refetch } = useQuery(healthQuery);
  const checks = data?.checks || [];
  const bad = checks.filter((c) => c.status !== 'ok').length;
  // After anything on this page changes a finding -- a repair that ENDED, an ignore -- the page is checked
  // again, and the header's mark with it: the refetch stores a new summary, and the header reads that summary.
  const qc = useQueryClient();
  const recheck = () => refetch().then(() => qc.invalidateQueries({ queryKey: ['health-summary'] }));
  const pickView = (v: HealthView) => {
    setHealthView(v);
    setView(v);
    // The cards are the same either way; By series needs the grouping, which the report carries only when asked.
    if (v === 'series' && !data?.bySeries) void refetch();
  };
  // A Needs-you item's card key, in Fix everything's end: the dialog closes, and that card opens where it is -- in the
  // By check view, which is where a card is.
  const showCheck = (id: string) => {
    setFixing(false);
    if (view !== 'checks') pickView('checks');
    setOpen(id);
    requestAnimationFrame(() => document.querySelector(`[data-health-check="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' }));
  };

  // One card per check, and a failing one earns the full width of the board -- the same severity rule the
  // overview uses, so the shape of the panel is the verdict. The repair provider holds the live run and its
  // history for every row, card and Fix everything's safe repair (lib/useRepairRun.tsx); the find provider
  // (v0.49.1) follows a "Find other sources" run for the rows that offer it and for its card under the checks; the
  // autofix provider (v0.55.0) follows Fix everything's run (lib/useAutofixRun.tsx).
  return (
    <RepairRunProvider onEnded={recheck}>
    <FindRunProvider onEnded={recheck}>
    <AutofixRunProvider onEnded={recheck}>
      <div className="board">
        {/* Wraps: at phone width the sentence and the keys do not fit on one line (v0.48.3). */}
        <div className="full flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fog-500">
            {!data ? tr('Checking your library…')
              : bad ? tr('Checks that found something: {n} of {m}', { n: bad, m: checks.length })
              : tr('Everything looks healthy')}
            {data && <> · {tr('checked {when}', { when: relativeTime(data.generatedAt) })}</>}
          </p>
          <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => refetch()} disabled={isFetching} className="btn-key">
              <IcRefresh aria-hidden width={14} height={14} />{isFetching ? tr('Checking…') : tr('Re-check')}
            </button>
            {/* v0.55.0: whenever any card has a finding -- where Fix all issues' row was, which only the repair's four
                steps could summon. */}
            <FixEverythingKey checks={checks} onOpen={() => setFixing(true)} />
          </div>
        </div>

        <LastFixLine />
        <SafeRepairLine checks={checks} />
        <RepairLiveStrip />

        {/* v0.72.0 (#254): the same findings, one card per check or one per series. */}
        <div className="full" data-health-view>
          <Segmented square label={tr('Group the findings')} value={view} onChange={pickView}
            options={[{ value: 'checks', label: tr('By check') }, { value: 'series', label: tr('By series') }]} />
        </div>
        {view === 'series' && (data?.bySeries
          ? <HealthBySeries rows={data.bySeries} checks={checks} />
          : <p role="status" className="full py-8 text-center text-sm text-fog-500">{tr('Checking your library…')}</p>)}
        {view === 'checks' && checks.map((c) => {
          const isOpen = open === c.id;
          // Notes explain important states that are deliberately not findings. A readable partial chapter, for
          // example, is absent from the active failure ledger but this note is the only place Health says where
          // it appears and when it is repaired. Keep those cards expandable even when `items` is empty -- and
          // a card with an action of its own (Scan the library now) too.
          const expandable = !!c.items.length || !!c.note || hasCardActions(c);
          const mark = healthMark(c.status);
          const rowKeys = keysFor(c.id, c.items);
          return (
            // `scroll-mt-*`: Fix everything's "Show the card" scrolls a card to the top, clear of the desktop's top bar.
            // `id`: the search palette's Cloudflare solver and Version land on their cards (`?section=check-solver`).
            <div key={c.id} id={`check-${c.id}`} data-health-check={c.id} className={`card grad-border relative scroll-mt-4 overflow-hidden lg:scroll-mt-20 ${c.status !== 'ok' ? 'full' : ''}`}>
              <StatusEdge tone={mark.tone} />
              {/* ⚠️ The disclosure is the FIRST button in the card: the end-to-end walks open a card by
                  clicking the first button inside `[data-health-check="…"]`. Every action lives in the body. */}
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : c.id)}
                aria-expanded={expandable ? isOpen : undefined}
                aria-controls={expandable ? `health-${c.id}-details` : undefined}
                disabled={!expandable}
                className="flex w-full min-w-0 items-center gap-x-3 px-4 py-3.5 text-start disabled:cursor-default"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="text-sm text-fog-100">{checkTitle(c)}</span>
                    <StatusMark {...mark} size="xs" />
                    <CardProgress checkId={c.id} />
                  </p>
                  <p dir="auto" className="mt-0.5 text-[11px] text-fog-500">{checkSummary(c)}</p>
                </div>
                {expandable && (
                  <>
                    <span className="sr-only">{isOpen ? tr('Hide details') : tr('Show details')}</span>
                    <span aria-hidden className="inline-grid shrink-0 text-fog-500 rtl:-scale-x-100">
                      <IcChevronRight width={16} height={16} className={`transition ${isOpen ? 'rotate-90' : ''}`} />
                    </span>
                  </>
                )}
              </button>
              {c.id === 'update' && <DesktopUpdateNote />}

              {/* v0.53.0: Source health draws a body of its own -- the sources the library depends on first, one line
                  and one key each, the rest folded, and its glossary at its foot (components/SourceHealthBody.tsx). */}
              {isOpen && c.id === 'sources' && (
                <div id={`health-${c.id}-details`} className="border-t border-ink-800/70">
                  <SourceHealthBody check={c} />
                </div>
              )}
              {isOpen && c.id !== 'sources' && (
                <div id={`health-${c.id}-details`} className="border-t border-ink-800/70">
                  <HealthCardActions check={c} />
                  {c.note && <p data-health-note dir="auto" className="px-4 pt-3 text-[11px] leading-relaxed text-fog-500">{checkNote(c)}</p>}
                  <div className="divide-y divide-ink-800/70">
                    {c.items.map((it, i) => (
                      <HealthRow key={rowKeys[i]} rowKey={rowKeys[i]} check={c} item={it}
                        // To the chapter the finding is about, not just its series (lib/healthLinks.ts). A duplicate
                        // pair gets one per copy, each naming its copy: two bare "Open"s cannot be told apart on a
                        // phone, where there is no tooltip. Text links, not chips: they go somewhere, they do nothing.
                        // Two lines, never cut: "Öffnen · Einstellungen der Q…" hid which settings it opens (the
                        // arrow is held to the last word by a no-break space).
                        links={healthLinks(c.id, it).map((l) => (
                          <Link key={l.href} href={l.href} className="line-clamp-2 max-w-[11rem] break-words text-end text-xs text-accent hover:underline"
                            title={l.label} aria-label={l.label ? `${tr('Open')}: ${l.label}` : undefined}
                            // A page off the app (the install guide, v0.52.0) opens beside it, never in place of it.
                            {...(/^https?:\/\//.test(l.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                            {l.label ? `${tr('Open')} · ${l.label}` : tr('Open')}{'\u00a0'}›
                          </Link>
                        ))}>
                        {/* The server's words, in the reader's language where it sent their codes (lib/said.ts) and
                            in English where it could not (a folder's own error); a title in any script: `dir="auto"`,
                            or in an Arabic page a sentence's full stop and closing bracket land at its start. */}
                        <p dir="auto" className="break-words text-sm text-fog-100">{itemTitle(it)}</p>
                        <p dir="auto" className="text-[11px] text-fog-500">{itemDetail(it)}</p>
                      </HealthRow>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <FindRunCard />
        <RepairHistory />
      </div>
      {fixing && (
        <OnBody>
          <FixEverythingDialog checks={checks} onClose={() => setFixing(false)} onShowCheck={showCheck} />
        </OnBody>
      )}
    </AutofixRunProvider>
    </FindRunProvider>
    </RepairRunProvider>
  );
}

/**
 * Under the Health "Version" card on Uchiyomi Desktop: what the SHELL knows about a newer release.
 *
 * The card above still comes from the server's own GitHub check, which is the only update path on an
 * unsigned Mac. The shell adds the half the server cannot do: on Windows it has already downloaded the
 * update (`ready` -> restart to install); on a Mac it can only point at the release page. Renders nothing
 * without the bridge, or while there is nothing newer, so the server build's card is exactly as it was.
 */
function DesktopUpdateNote() {
  const b = bridge();
  const [u, setU] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!b?.update?.status) return;
    let live = true;
    b.update.status().then((s) => { if (live) setU(s); }).catch(() => {});
    return () => { live = false; };
  }, [b]);
  if (!b || !u?.available) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-800/70 px-4 py-2.5">
      <p className="min-w-0 flex-1 text-sm text-fog-100">
        {u.version ? tr('New version available — {version}', { version: u.version }) : tr('New version available')}
      </p>
      {u.ready && typeof b.update.installNow === 'function' ? (
        <button type="button" onClick={() => b.update.installNow()} className="chip shrink-0 text-xs">{tr('Restart to update')}</button>
      ) : u.url ? (
        <a href={u.url} target="_blank" rel="noopener noreferrer" className="chip shrink-0 text-xs">{tr('Download')}</a>
      ) : null}
    </div>
  );
}
