'use client';
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Img } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { CoverProgress, ProgressRing } from '@/components/ProgressRing';
import { EmptyState } from '@/components/EmptyState';
import { IcAlert, IcHourglass, IcX } from '@/components/icons';
import { ART } from '@/lib/art';
import { t as tr } from '@/lib/i18n';
import { joinPart, reasonText } from '@/lib/said';
import { durationText, relativeTime } from '@/lib/format';
import { jobNoteLines, type JobCardNotes } from '@/lib/jobNotes';
import { fetchingToast, mayCancel, repairStepLabel, runProgress, type RunCard } from '@/lib/jobs';
import { seriesHref } from '@/lib/healthLinks';
import { ringFraction, ringValueText } from '@/lib/ring';
import {
  chapterSpan, downloadSections, originLabel, runName, runWaitLine, tileStatus, viewState, type ActivityGroup, type Attention, type Origin, type SourceJobs,
  type Tile,
} from '@/lib/serverDownloads';
import { kickDownloads, useServerDownloads } from '@/lib/useServerDownloads';
import { archiveProgressText } from '@/lib/archive';
import { ArchiveAttentionRow, ArchiveQueueNote, ArchiveTile } from '@/components/ArchiveQueue';
import { reviewHref } from '@/lib/findSources';

// lib/serverDownloads.ts DownloadJob's fields, spelled out beside the notes so this stays the one Job type the
// notes pin (partialSurfaces.test.ts) reads.
interface Job extends JobCardNotes {
  folder: string; title: string; total: number; done: number; status: string; reason?: string;
  startedAt?: number; finishedAt?: number; mine?: boolean; cancelRequested?: boolean; cancelled?: boolean;
  seriesId?: string; left?: number[]; cover?: { source: string; url: string }; origin?: Origin;
}

/** The Library grid's columns, one step wider: the filter sidebar is not shown beside this view. */
const GRID = 'grid grid-cols-3 gap-x-3 gap-y-5 px-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 lg:gap-x-4 lg:px-0 xl:grid-cols-7 2xl:grid-cols-8 3xl:grid-cols-9 4xl:grid-cols-10';
/**
 * Needs attention, Server tasks and the stopped downloads: one card each, side by side where there is room.
 *
 * ⚠️ `grid-cols-1` below lg, never an implicit column. An implicit `auto` column grows to its widest card's
 * min-content, and a `truncate` line is as wide as its whole text: at 390 px a German one-row repair ("Suche nach
 * längeren Kopien · Walk Tale · Kap. 4") pushed the page 135 px sideways and its Abbrechen off the screen.
 * `repeat(1, minmax(0, 1fr))` holds the column to the page, so the name truncates as it was meant to.
 */
const ROWS = 'grid grid-cols-1 gap-3 px-4 lg:grid-cols-2 lg:px-0 2xl:grid-cols-3';
/** Came in today shows this many covers before "Show all {n}": a big morning is a hundred series. */
const CAME_IN_FIRST = 24;

/**
 * Library -> Downloads (v0.49.0): everything the server is fetching, whoever started it, as the owner asked for
 * it -- each series its cover with a ring filling like an app install, in five sections: Running, Queued (the
 * slow archive included), Needs attention, Server tasks, Came in today. It took over from the floating pill,
 * which showed the same things in a 20rem popover, and from the Offline tab's "On the server", which put the
 * server's downloads on a page about this device's copies.
 *
 * What goes where is lib/serverDownloads.ts `downloadSections`, where a test can reach it; this only draws it.
 * The data is the one ['source-jobs'] query AppShell polls, asked again when the view opens.
 *
 * Who sees what is the server's: a member gets the series they can open, their own failed downloads and their
 * own bulk runs, and is offered Cancel and Dismiss on their own work only; an admin sees and acts on all of it.
 *
 * No scroller of its own -- the page scrolls -- so nothing here needs `data-lenis-prevent`.
 */
export function ServerDownloadsView({ focusFolder }: { focusFolder?: string | null }) {
  const { user, isAdmin } = useAuth();
  const mayAdd = canDownload(user);
  const qc = useQueryClient();
  const toast = useToast();
  const { data: raw, isLoading, isError, refetch } = useServerDownloads({ fresh: true });
  const data = raw as SourceJobs<Job> | undefined;
  const jobs = data?.content ?? [];
  const s = downloadSections(data, { admin: isAdmin });
  const [allCameIn, setAllCameIn] = useState(false);
  // Names for the "took chapter 12 from …" lines. Asked for only once a card has a switch to name, and only by a
  // viewer who may download, which is who the route answers.
  const { data: sources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: mayAdd && jobs.some((j) => !!j.switched?.length),
  });
  const nameOf = (id: string) => sources?.content.find((x) => x.id === id)?.name ?? id;

  const call = async (path: string, method: 'POST' | 'DELETE') => {
    try { await api(path, { method }); } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    void kickDownloads(qc);
  };
  const cancelJob = (folder: string) => call(`/api/sources/jobs/${encodeURIComponent(folder)}/cancel`, 'POST');
  const dismissJob = (folder: string) => call(`/api/sources/jobs/${encodeURIComponent(folder)}`, 'DELETE');
  // A "Find other sources" run stops through its own route (v0.49.1), at once.
  const cancelRun = (kind: string) => call(kind === 'find_sources' ? '/api/admin/sources/find/stop' : `/api/sources/runs/${kind}/cancel`, 'POST');
  const dismissRun = (kind: string) => call(`/api/sources/runs/${kind}`, 'DELETE');
  // Try again is a Fetch of what did not land: the same route, the same checks (the series' visibility, its
  // listing, the 300 cap, a 409 while the series is busy), and a new job that takes the failed card's place.
  const retry = async (seriesId: string, numbers: number[]) => {
    try {
      const res = await api<{ folder: string; total: number }>('/api/sources/fetch', { method: 'POST', json: { seriesId, numbers } });
      toast(fetchingToast(res.total), 'info', { busy: true });
    } catch (e) { toast(msgOf(e, tr('Could not start.')), 'error'); }
    void kickDownloads(qc);
  };

  // The tile an "Open in library" was sent to, scrolled into view once: the add dialog lands here when the
  // series has no row yet to open.
  const scrolled = useRef(false);
  const focusRef = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'center' });
  }, []);

  const state = viewState({ data, isLoading, isError }, s);
  if (state === 'loading') {
    return (
      <div className={`${GRID} pt-5`} aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div data-downloads-error className="flex flex-col items-center px-6 py-16 text-center">
        <IcAlert width={28} height={28} className="text-amber-300" aria-hidden />
        <p className="mt-3 font-display text-lg font-semibold text-fog-50">{tr('Could not load the downloads')}</p>
        <p className="mt-1 max-w-xs text-sm text-fog-400">{tr('The server did not answer. Try again in a moment.')}</p>
        <button type="button" onClick={() => void refetch()} className="btn-key btn-key-primary mt-4">{tr('Try again')}</button>
      </div>
    );
  }
  if (state === 'empty') {
    return (
      <div data-downloads-empty>
        <EmptyState art={ART.emptyDownloads} title={tr('Nothing is being fetched right now.')}
          sub={tr('Series you add, chapters you fetch and what the scheduled check finds show up here as they come in.')} />
      </div>
    );
  }
  const cameIn = allCameIn ? s.cameIn : s.cameIn.slice(0, CAME_IN_FIRST);
  return (
    <div className="space-y-8 pb-10 pt-5" data-downloads-view>
      {s.running.length > 0 && (
        // 'Running now', not 'Running': that word is one repair run's status (healthCopy runStatusWord), and a
        // heading over a list is a plural in the languages that mark number.
        <Section id="running" title={tr('Running now')} n={s.running.length}>
          <div className={GRID}>
            {s.running.map((t) => (
              <DownloadTile key={t.key} t={t} section="running" admin={isAdmin} nameOf={nameOf} onCancel={cancelJob}
                focusRef={focusFolder && t.folder === focusFolder ? focusRef : undefined} />
            ))}
          </div>
        </Section>
      )}
      {s.queued.length > 0 && (
        <Section id="queued" title={tr('Queued')} n={s.queued.length}>
          {/* The slow archive's pace and its server-wide pause, once there is an archive here to be paced (#117). */}
          {data?.archive && s.queued.some((t) => t.item) && <ArchiveQueueNote view={data.archive} admin={isAdmin} />}
          <div className={GRID}>
            {s.queued.map((t) => (t.item
              ? <ArchiveTile key={`a:${t.key}`} item={t.item} view={data?.archive} />
              : (
                <DownloadTile key={`${t.archive ? 'a' : 'n'}:${t.key}`} t={t} section="queued" admin={isAdmin} nameOf={nameOf} onCancel={cancelJob}
                  focusRef={focusFolder && t.folder === focusFolder ? focusRef : undefined} />
              )))}
          </div>
        </Section>
      )}
      {s.attention.length > 0 && (
        <Section id="attention" title={tr('Needs attention')} n={s.attention.length}>
          <ul className={ROWS}>
            {s.attention.map((a) => (a.kind === 'archive'
              ? <ArchiveAttentionRow key={a.key} item={a.item} view={data?.archive} admin={isAdmin} />
              : (
                <AttentionRow key={a.key} a={a} nameOf={nameOf} onRetry={retry} onDismissJob={dismissJob} onDismissRun={dismissRun}
                  focusRef={focusFolder && a.kind === 'job' && a.job.folder === focusFolder ? focusRef : undefined} />
              )))}
          </ul>
          {/* The chapter-level failures age out of this list after a day; the ledger of the ones that keep
              failing, with what to do about each, is Health's. */}
          {isAdmin && s.attention.some((a) => a.kind === 'chapters') && (
            <p className="mx-4 mt-2 text-[12px] text-fog-500 lg:mx-0">
              <Link href="/admin/?tab=Health" className="hover:text-fog-200 hover:underline">{tr('Chapters that keep failing are listed under Admin → Health.')}</Link>
            </p>
          )}
        </Section>
      )}
      {s.tasks.length > 0 && (
        <Section id="tasks" title={tr('Server tasks')} n={s.tasks.length}>
          <ul className={ROWS}>
            {s.tasks.map((r) => (
              <TaskRow key={r.kind} r={r} admin={isAdmin} onCancel={cancelRun} onDismiss={dismissRun} />
            ))}
          </ul>
        </Section>
      )}
      {(s.cameIn.length > 0 || s.stopped.length > 0) && (
        <Section id="today" title={tr('Came in today')} n={s.cameIn.length}>
          {s.cameIn.length > 0 && (
            <div className={GRID}>
              {cameIn.map((g) => <CameInTile key={g.key} g={g} />)}
            </div>
          )}
          {!allCameIn && s.cameIn.length > CAME_IN_FIRST && (
            <div className="mt-4 px-4 lg:px-0">
              <button type="button" onClick={() => setAllCameIn(true)} className="btn-key">{tr('Show all {n}', { n: s.cameIn.length })}</button>
            </div>
          )}
          {/* A download stopped by its Cancel: what landed is above; this is how far it got, and its Dismiss. */}
          {s.stopped.length > 0 && (
            <ul className={`${ROWS} mt-4`}>
              {s.stopped.map((j) => (
                <li key={j.folder} className="card flex min-w-0 items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p dir="auto" className="truncate text-sm text-fog-100">{j.title}</p>
                    <p dir="auto" className="mt-0.5 text-[12px] text-fog-400">{reasonText(j) || tr('Cancelled; what landed is kept.')}</p>
                  </div>
                  {(isAdmin || j.mine) && (
                    <button type="button" onClick={() => dismissJob(j.folder)} className="btn-key">{tr('Dismiss')}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ id, title, n, children }: { id: string; title: string; n: number; children: React.ReactNode }) {
  return (
    <section data-downloads-section={id} aria-labelledby={`dl-${id}`}>
      <h2 id={`dl-${id}`} className="mb-3 flex items-baseline gap-2 px-5 font-display text-base font-semibold text-fog-100 lg:px-0 lg:text-lg">
        {title}<span className="text-sm font-medium tabular-nums text-fog-500">{n}</span>
      </h2>
      {children}
    </section>
  );
}

/** A cover for a Running or Queued tile: the series' thumbnail, else an add's source cover before its first scan. */
function coverOf(t: Pick<Tile<Job>, 'seriesId' | 'job'>): { src: string; fallback?: string } {
  if (t.seriesId) return { src: img.seriesThumb(t.seriesId) };
  if (!t.job?.cover) return { src: '' };
  const { source, url } = t.job.cover;
  return { src: sourceCover(source, url), fallback: url };
}

function DownloadTile({ t, section, admin, nameOf, onCancel, focusRef }: {
  t: Tile<Job>; section: 'running' | 'queued'; admin: boolean; nameOf: (id: string) => string;
  onCancel: (folder: string) => void; focusRef?: (el: HTMLElement | null) => void;
}) {
  const job = t.job;
  const cover = coverOf(t);
  const status = tileStatus(t);
  // A person's download says how far it has got in the ring; the server's own chapters and the archive say what
  // started them, since "Scheduled check" or "Slow archive" is what tells two such covers apart.
  const caption = job && job.total > 0 ? `${Math.min(job.done, job.total)}/${job.total}` : undefined;
  const origin = t.archive ? tr('Slow archive') : !job && t.entries[0] ? originLabel(t.entries[0].origin) : '';
  const label = [t.title, job ? ringValueText(job.done, job.total) : '', status, origin].filter(Boolean).join(' · ');
  const face = (
    <div className={`grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border ${focusRef ? 'border-accent ring-2 ring-accent/60' : 'border-ink-700/60'}`}>
      <Img src={cover.src} fallbackSrc={cover.fallback} alt="" className="h-full w-full" />
      <CoverProgress state={section === 'running' ? 'running' : 'waiting'} progress={t.progress} caption={caption} label={label}
        tone={t.archive ? 'amber' : undefined} static={t.archive}
        glyph={t.archive ? <IcHourglass width={18} height={18} /> : undefined} />
    </div>
  );
  return (
    <div ref={focusRef} data-download-tile data-state={section} data-folder={t.folder} className="relative min-w-0">
      {t.seriesId ? <Link href={`/series/?id=${encodeURIComponent(t.seriesId)}`} className="block">{face}</Link> : face}
      {job && mayCancel(job, admin) && (
        // Round, and the size of a fingertip: stops the download after the chapter in flight, never mid-file.
        <button type="button" onClick={() => onCancel(job.folder)} title={tr('Cancel')} aria-label={`${tr('Cancel')} · ${t.title}`}
          className="absolute end-1.5 top-1.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-ink-950/85 text-fog-200 ring-1 ring-white/15 transition hover:text-rose-300">
          <IcX width={14} height={14} />
        </button>
      )}
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-200">{t.title}</p>
      {status && <p className={`mt-0.5 truncate text-[11px] ${job?.cancelRequested ? 'text-fog-300' : 'text-fog-500'}`}>{status}</p>}
      {origin && <p className="truncate text-[11px] text-fog-500">{origin}</p>}
      {/* What the job did that the ring cannot show: a chapter taken from another source, one saved short. */}
      {job && jobNoteLines(job, nameOf).map((line, i) => (
        <p key={i} className="mt-0.5 text-[11px] leading-snug text-fog-400">{line}</p>
      ))}
    </div>
  );
}

function AttentionRow({ a, nameOf, onRetry, onDismissJob, onDismissRun, focusRef }: {
  a: Exclude<Attention<Job>, { kind: 'archive' }>; nameOf: (id: string) => string;
  onRetry: (seriesId: string, numbers: number[]) => void; onDismissJob: (folder: string) => void; onDismissRun: (kind: string) => void;
  focusRef?: (el: HTMLElement | null) => void;
}) {
  if (a.kind === 'run') {
    const r = a.run;
    return (
      <li data-attention="run" className="card flex min-w-0 items-start gap-3 px-4 py-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-300"><IcAlert width={18} height={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fog-100">{runName(r)}</p>
          <p dir="auto" className="mt-0.5 text-[12px] leading-relaxed text-amber-300">{reasonText(r) || tr('Stopped.')}</p>
          {runProgress(r) && <p className="mt-0.5 text-[11px] tabular-nums text-fog-500">{runProgress(r)}</p>}
          {a.dismiss && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => onDismissRun(r.kind)} className="btn-key">{tr('Dismiss')}</button>
            </div>
          )}
        </div>
      </li>
    );
  }
  const thumb = a.seriesId ? { src: img.seriesThumb(a.seriesId) } : a.kind === 'job' ? coverOf({ seriesId: null, job: a.job }) : { src: '' };
  return (
    <li ref={focusRef} data-attention={a.kind} data-folder={a.kind === 'job' ? a.job.folder : undefined}
      className={`card flex min-w-0 items-start gap-3 px-4 py-3 ${focusRef ? 'border-accent/60 ring-2 ring-accent/40' : ''}`}>
      <Img src={thumb.src} fallbackSrc={thumb.fallback} alt="" className="h-[60px] w-10 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        {/* `dir="auto"`, as every series title here: the page's direction cut an English title at its start in Arabic. */}
        <p dir="auto" className="truncate text-sm font-medium text-fog-100">{a.title}</p>
        {a.kind === 'job' ? (
          <>
            {/* The reason has always been recorded; the strip used to say only "Download stopped." for every cause.
                In the reader's language since v0.49.1 (lib/said.ts), but a source's name or a site's own error in
                it can be in any script: `dir="auto"`, or in an Arabic page its full stop would jump to the front. */}
            <p dir="auto" className="mt-0.5 text-[12px] leading-relaxed text-amber-300">{reasonText(a.job) || tr('Fetch stopped. Try another source or wait.')}</p>
            {jobNoteLines(a.job, nameOf).map((line, i) => <p key={i} className="mt-0.5 text-[11px] leading-snug text-fog-400">{line}</p>)}
            {/* Which kind of download it was: a fill or a Fetch again has no Try again (the server sends no
                `left` for them), and this says why the card is not like the others. */}
            {a.job.origin && <p className="mt-0.5 text-[11px] text-fog-500">{originLabel(a.job.origin)}</p>}
          </>
        ) : (
          <>
            {a.failed.slice(0, 3).map((f) => (
              <p key={f.id} dir="auto" className="mt-0.5 text-[12px] leading-relaxed text-amber-300">
                {f.reason ? joinPart(tr('Ch. {n} could not be saved', { n: f.number }), reasonText(f), 'colon') : tr('Ch. {n} could not be saved', { n: f.number })}
              </p>
            ))}
            {a.failed.length > 3 && <p className="mt-0.5 text-[11px] text-fog-500">{tr('and {n} more', { n: a.failed.length - 3 })}</p>}
            <p className="mt-0.5 text-[11px] text-fog-500">{[...new Set(a.failed.map((f) => originLabel(f.origin)))].join(', ')}</p>
          </>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {a.seriesId && a.retry.length > 0 && (
            <button type="button" onClick={() => onRetry(a.seriesId!, a.retry)} className="btn-key">{tr('Try again')}</button>
          )}
          {a.kind === 'job' && a.dismiss && (
            <button type="button" onClick={() => onDismissJob(a.job.folder)} className="btn-key">{tr('Dismiss')}</button>
          )}
          {a.seriesId && <Link href={`/series/?id=${encodeURIComponent(a.seriesId)}`} className="btn-key">{tr('Open')}</Link>}
        </div>
      </div>
    </li>
  );
}

function TaskRow({ r, admin, onCancel, onDismiss }: { r: RunCard; admin: boolean; onCancel: (kind: string) => void; onDismiss: (kind: string) => void }) {
  const running = r.status === 'running';
  const mine = admin || !!r.mine;
  const step = r.kind === 'repair' && running ? repairStepLabel(r.step) : '';
  const name = runName(r);
  // A Health press is about one series -- the way to it (the server drops it for a viewer who may not list that
  // series) -- and what any repair did is kept under Health's Recent repairs, an admin's way to it.
  const history = admin && r.kind === 'repair';
  // A "Find other sources" search steps series by series, stops at once when asked, and keeps what it found on its
  // review -- where the admin chooses what to follow -- a press away, while it runs and after.
  const find = r.kind === 'find_sources';
  // ONE sentence split around its placeholder, so the series name is its own bidi run (<bdi>): inside the Arabic
  // sentence a title ending in "!" printed the "!" at the wrong end of the name.
  const [nowBefore, nowAfter] = tr('Now: {title}').split('{title}');
  const wait = runWaitLine(r);
  return (
    <li data-task={r.kind} data-state={r.status} className="card flex min-w-0 items-start gap-3 px-4 py-3">
      <ProgressRing progress={running ? ringFraction(r.done, r.total) : r.status === 'done' ? 1 : 'idle'} size="bar"
        tone={r.status === 'cancelled' ? 'muted' : 'accent'} label={name} valueText={runProgress(r)} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fog-100" data-task-name>{name}</p>
        {step && <p className="mt-0.5 truncate text-[12px] text-fog-300">{step}</p>}
        {runProgress(r) && <p className="mt-0.5 text-[11px] tabular-nums text-fog-500">{runProgress(r)}</p>}
        {/* A find run waiting for a sweep, a repair or the daily check says so, rather than name the series it did last.
            The series' title is cut in its own box and direction: cut as part of the line, which takes the page's, an
            Arabic page's ellipsis took the START of an English title ("الآن: …e until the line runs out of screen").
            The words around it keep their own spaces, which a flex item would drop at its end. */}
        {wait
          ? <p className="mt-0.5 truncate text-[11px] text-fog-400" data-task-waiting>{wait}</p>
          : running && r.current?.title && (
            <p className="mt-0.5 flex min-w-0 text-[11px] text-fog-400" data-task-now>
              <span className="shrink-0 whitespace-pre">{nowBefore}</span>
              <bdi dir="auto" className="block min-w-0 truncate">{r.current.title}</bdi>
              {nowAfter && <span className="shrink-0 whitespace-pre">{nowAfter}</span>}
            </p>
          )}
        <p className="mt-0.5 text-[11px] text-fog-500">
          {running
            ? tr('Started {time} ago', { time: durationText(Date.now() - r.startedAt) })
            : relativeTime(new Date(r.finishedAt ?? r.startedAt).toISOString())}
        </p>
        {/* A find search stops at once -- the series in flight stays unsearched -- so it says the plain word, never
            "after this series". */}
        {running && r.cancelRequested && <p className="mt-0.5 text-[11px] text-fog-300">{find ? tr('Stopping…') : tr('Stopping after this chapter…')}</p>}
        {/* A stopped find search downloaded nothing: what it found stays on its review, and it can search on. */}
        {r.status === 'cancelled' && <p className="mt-0.5 text-[11px] text-fog-400">{find ? tr('Stopped before it finished') : tr('Cancelled; what landed is kept.')}</p>}
        {r.status === 'done' && r.reason && <p dir="auto" className="mt-0.5 text-[11px] text-fog-400">{reasonText(r)}</p>}
        {(r.seriesId || history || (find && admin && r.runId)) && (
          <p className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
            {r.seriesId && <Link href={seriesHref(r.seriesId, r.number)} className="text-accent hover:underline">{tr('Open')} ›</Link>}
            {history && <Link href="/admin/?tab=Health#repairs" className="text-accent hover:underline">{tr('Recent repairs')} ›</Link>}
            {find && admin && r.runId && (
              <Link href={reviewHref(r.runId)} data-find-review className="text-accent hover:underline">{tr('Review')} ›</Link>
            )}
          </p>
        )}
      </div>
      {mine && running && !r.cancelRequested && (
        <button type="button" onClick={() => onCancel(r.kind)} className="btn-key">{find ? tr('Stop') : tr('Cancel')}</button>
      )}
      {mine && !running && (
        <button type="button" onClick={() => onDismiss(r.kind)} className="btn-key">{tr('Dismiss')}</button>
      )}
    </li>
  );
}

/**
 * What landed today, one cover per series: a full ring gone to a check, like an installed app. The slow
 * archive's chapters are summed up on a line of their own (#117) -- a back catalogue listed number by number
 * would crowd out everything else that came in -- and an archive that finished says so.
 */
function CameInTile({ g }: { g: ActivityGroup }) {
  const archived = g.archived;
  const own = g.numbers.filter((n) => !archived.includes(n));
  const summed = archived.length > 0 || !!g.archiveFinished;
  const face = (
    <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60">
      <Img src={g.seriesId ? img.seriesThumb(g.seriesId) : ''} alt="" className="h-full w-full" />
      <CoverProgress state="done" label={`${g.title} · ${chapterSpan(g.numbers)}`} />
    </div>
  );
  return (
    <div data-came-in className="min-w-0">
      {g.seriesId ? <Link href={`/series/?id=${encodeURIComponent(g.seriesId)}`} className="block">{face}</Link> : face}
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-200">{g.title}</p>
      {/* The time beside the chapters, the origins on their own line: "Added from Discover" alone fills a
          390 px tile, and the time is what a phone cut off when they shared one. */}
      <p className="mt-0.5 truncate text-[11px] text-fog-400">{[chapterSpan(own), relativeTime(new Date(g.at).toISOString())].filter(Boolean).join(' · ')}</p>
      {archived.length > 0 && (
        <p className="line-clamp-2 text-[11px] leading-snug text-amber-300/90">
          {archived.length === 1 ? tr('Slow archive: 1 chapter today') : tr('Slow archive: {n} chapters today', { n: archived.length })}
        </p>
      )}
      {g.archiveFinished && <p className="line-clamp-2 text-[11px] leading-snug text-amber-300/90">{archiveProgressText(g.archiveFinished.entry)}</p>}
      <p className="truncate text-[11px] text-fog-500">{g.origins.filter((o) => !(summed && o === 'archive')).map(originLabel).join(', ')}</p>
      {/* The job cards' own words for it ("2 chapters saved with pages missing"), one and many. */}
      {jobNoteLines({ partial: g.partial }).map((line, i) => <p key={i} className="text-[11px] text-fog-500">{line}</p>)}
    </div>
  );
}
