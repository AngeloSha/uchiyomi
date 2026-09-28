/**
 * Every chapter the server is downloading, and what came in today, whatever started it (bff
 * lib/downloadActivity.ts) -- the `activity` field of `GET /api/sources/jobs` -- and, since v0.49.0, what
 * Library -> Downloads, the Library ring and the series band make of the whole response.
 *
 * The pill used to know only the jobs a button started, which in practice meant an add from Discover. A
 * source followed from "Find missing chapters" downloads at the series' next check; the scheduled check
 * downloads for every series; so do Check now, the repair and a bulk "Fetch newest" -- and none of it showed
 * anywhere. These are the rules for showing it, apart from the components, so a test can hold them.
 *
 * ⚠️ THE SLOW ARCHIVE (#117, origin `archive`) IS NOT A DOWNLOAD IN PROGRESS, as far as these rules go. It
 * fetches a chapter every quarter of an hour or so, for days: counted like any other download it would turn
 * the Library ring for a week, poll the server every 2.5 s for a week, and put a Running cover up for every
 * chapter it takes. The owner's call: the ring animates for normal downloads only, and the archive lives in
 * Queued with a still mark. So `downloadSections` puts it in Queued, `navRing` never counts or turns for it
 * (it shows the still "slow" mark when the archive is all that works), and `jobsPollInterval` never speeds
 * up for it. One rule, three readers, each with its own test in serverDownloads.test.ts.
 */
import { t as tr } from './i18n';
import { chaptersLeft } from './chapterRows';
import { downloadsLabel, finished, runTitle, type JobCard, type RunCard } from './jobs';
import { kindLabel } from './healthCopy';
import { ringFraction, type RingValue } from './ring';
import { archiveItems, type ArchiveItem, type ArchiveView } from './archive';
import type { AutoFollow } from './types';
import type { Said } from './said';

export type Origin = 'add' | 'fetch' | 'fill' | 'check' | 'sweep' | 'repair' | 'bulk' | 'refetch' | 'server' | 'archive';

export interface ActivityEntry {
  id: number;
  seriesId: string | null;
  /** The series folder: what a job card is keyed by, so one chapter is never shown twice. */
  folder: string;
  title: string;
  number: number;
  /** The source's display name. */
  source: string;
  origin: Origin;
  status: 'queued' | 'downloading' | 'done' | 'partial' | 'failed';
  startedAt: number;
  finishedAt?: number;
  pages?: number;
  reason?: string;
  /** v0.49.1: `reason` as codes lib/said.ts words; absent for a download's own error, shown as sent. */
  reasonSaid?: Said[];
  mine?: boolean;
}

export interface Activity { active: ActivityEntry[]; recent: ActivityEntry[] }

/** What started a download, in the words the person would use for it. */
export function originLabel(o: Origin): string {
  switch (o) {
    case 'add': return tr('Added from Discover');
    case 'fetch': return tr('Fetch');
    case 'fill': return tr('Find missing chapters');
    case 'check': return tr('Check for new chapters');
    case 'sweep': return tr('Scheduled check');
    case 'repair': return tr('Library repair');
    case 'bulk': return tr('Fetch newest');
    case 'refetch': return tr('Fetch again');
    case 'archive': return tr('Slow archive');
    default: return tr('The server');
  }
}

/**
 * Chapter numbers as a short span: `Ch. 12–14, 16`. Runs of consecutive whole numbers fold into a range;
 * a half chapter stands alone, since 12.5 between 12 and 13 is not what a range promises.
 */
export function chapterSpan(numbers: readonly number[]): string {
  const ns = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ns.length;) {
    let j = i;
    while (j + 1 < ns.length && Number.isInteger(ns[j]) && ns[j + 1] === ns[j] + 1) j++;
    parts.push(j > i + 1 ? `${ns[i]}–${ns[j]}` : j === i + 1 ? `${ns[i]}, ${ns[j]}` : `${ns[i]}`);
    i = j + 1;
  }
  return parts.length ? tr('Ch. {n}', { n: parts.join(', ') }) : '';
}

export interface ActivityGroup {
  key: string;
  seriesId: string | null;
  title: string;
  /** What landed: saved whole, or saved with pages missing. */
  numbers: number[];
  /**
   * Which of `numbers` the slow archive brought (#117). Came in today sums them up in one line per series
   * ("Slow archive: 12 chapters today") rather than listing a back catalogue number by number.
   */
  archived: number[];
  /** A slow archive of this series that finished today with nothing left behind: said once, on its tile. */
  archiveFinished?: ArchiveItem;
  partial: number;
  failed: ActivityEntry[];
  origins: Origin[];
  /** The newest finish in the group: what the list is ordered by. */
  at: number;
}

/**
 * What came in, one line per series: "Solo Leveling · Ch. 180–182 · Scheduled check · 2 h ago". A chapter
 * that failed and then landed from another source is shown once, as landed.
 */
export function groupRecent(recent: readonly ActivityEntry[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const e of recent) {
    const key = e.seriesId ?? e.folder;
    let g = groups.get(key);
    if (!g) {
      g = { key, seriesId: e.seriesId, title: e.title, numbers: [], archived: [], partial: 0, failed: [], origins: [], at: 0 };
      groups.set(key, g);
    }
    if (e.status === 'done' || e.status === 'partial') {
      g.numbers.push(e.number);
      if (isArchive(e)) g.archived.push(e.number);
      if (e.status === 'partial') g.partial++;
    } else if (e.status === 'failed') g.failed.push(e);
    if (!g.origins.includes(e.origin)) g.origins.push(e.origin);
    g.at = Math.max(g.at, e.finishedAt ?? e.startedAt);
  }
  for (const g of groups.values()) {
    const landed = new Set(g.numbers);
    // Failed once, then taken from another source: that chapter is here, and a red line about it would lie.
    g.failed = g.failed.filter((f) => !landed.has(f.number));
  }
  return [...groups.values()].filter((g) => g.numbers.length || g.failed.length).sort((a, b) => b.at - a.at);
}

/** The server downloads a job card does not already show: each chapter is listed once. */
export function beyondJobs(active: readonly ActivityEntry[], jobFolders: ReadonlySet<string>): ActivityEntry[] {
  return active.filter((e) => !jobFolders.has(e.folder));
}

/** The slow archive's (#117): never a download in progress to the ring, the poll or Running (see the top). */
export const isArchive = (e: Pick<ActivityEntry, 'origin'>): boolean => e.origin === 'archive';

/**
 * A job card as `GET /api/sources/jobs` sends it since v0.49.0 (bff routes/sources.ts `Job`): the series it
 * fills (the card's own, else the folder's row), the chapters a failed one did not land, and an add's cover.
 */
export interface DownloadJob extends JobCard {
  seriesId?: string;
  /**
   * What kind of job it is: an add, a Fetch, a fill ("Find missing chapters") or an admin's Fetch again. The
   * server sets `left` only on a failed Fetch or add, the two whose chapters POST /api/sources/fetch can take
   * again, so Try again is offered exactly there; this says which kind of job the others were.
   */
  origin?: Origin;
  /** On a failed Fetch or add: what it did not land, at most 300, for Try again through POST /api/sources/fetch. */
  left?: number[];
  /** An add's cover as its source gave it, before the series has a thumbnail of its own. */
  cover?: { source: string; url: string };
  /** The add-time auto-follow (v0.36.0) riding on the card; the only job a nothing-yet add leaves behind. */
  autoFollow?: AutoFollow;
}

/** The whole answer. */
export interface SourceJobs<J extends DownloadJob = DownloadJob> {
  content: J[];
  runs?: RunCard[];
  activity?: Activity;
  /** The slow archive's queue (#117), as this viewer may see it: lib/archive.ts reads it. */
  archive?: ArchiveView;
}

/**
 * One series in Running or Queued: a cover with a ring, like an app install. One tile per series, whatever
 * brought it -- a person's job card and the chapters in flight for it are one cover, never two.
 */
export interface Tile<J extends DownloadJob = DownloadJob> {
  /** seriesId, else the folder: an add's first chapter has no series row yet. */
  key: string;
  seriesId: string | null;
  folder: string;
  title: string;
  /** A person's download (an add, a Fetch), when that is what this is. */
  job?: J;
  /** Its chapters the server has in flight, in the order they started. */
  entries: ActivityEntry[];
  /** The slow archive's: drawn still and amber, in Queued, never on the ring. */
  archive: boolean;
  /**
   * The archive's own row for this series, when the server sent one (#117): its progress, its ETA, and who
   * may pause or stop it. A tile built from archive activity alone has none -- an archive stopped while its
   * last chapter was still coming in.
   */
  item?: ArchiveItem;
  /** What the cover's ring shows: the job's done/total, or a turn while nothing says how much is left. */
  progress: RingValue;
}

/** A row in Needs attention: something that failed and what can be done about it. */
export type Attention<J extends DownloadJob = DownloadJob> =
  | { kind: 'job'; key: string; seriesId: string | null; title: string; job: J; retry: number[]; dismiss: boolean }
  | { kind: 'chapters'; key: string; seriesId: string | null; title: string; failed: ActivityEntry[]; retry: number[] }
  | { kind: 'run'; key: string; run: RunCard; dismiss: boolean }
  /** A slow archive whose source keeps refusing or is gone, a full disk, a week paused, or one finished with gaps. */
  | { kind: 'archive'; key: string; seriesId: string; title: string; item: ArchiveItem };

export interface Sections<J extends DownloadJob = DownloadJob> {
  running: Tile<J>[];
  queued: Tile<J>[];
  attention: Attention<J>[];
  /** The server's own runs: the scheduled check, the repair, a bulk Fetch newest. A failed one is in attention. */
  tasks: RunCard[];
  /** What landed today, one line per series (`groupRecent`), the slow archive's chapters included. */
  cameIn: ActivityGroup[];
  /** Downloads stopped by their Cancel: `done`, with the reason saying how far they got. */
  stopped: J[];
}

/** What POST /api/sources/fetch takes at most in one go (the route's FILL_MAX_CHAPTERS). */
const RETRY_MAX = 300;
const uniqueSorted = (ns: readonly number[]) => [...new Set(ns)].sort((a, b) => a - b).slice(0, RETRY_MAX);

/**
 * Library -> Downloads, in the owner's five sections: Running, Queued (the slow archive included), Needs
 * attention, Server tasks, Came in today.
 *
 * - A person's running job is ONE Running tile with its own chapters' entries, and it stays in Running between
 *   chapters (its line says who it waits for): covers that hop between sections on every poll read as noise.
 * - Chapters the server fetches that no job shows (the scheduled check, a followed source's check, the repair)
 *   are grouped per series: Running once one is downloading, Queued while all of them wait their turn.
 * - The slow archive is Queued, whatever it is doing: one cover per archived series, from its row in the
 *   `archive` object (lib/archive.ts archiveItems), after what is moving now, in the order they were queued.
 *   Its chapters in flight join that cover rather than making a second one; archive activity with no row
 *   (an archive stopped while its last chapter came in) keeps a cover of its own until it lands.
 * - Needs attention: failed job cards (the server sends them to their starter and admins only), chapters that
 *   could not be saved and did not land later (not the archive's, which retries them itself, and not a
 *   series that is being fetched again right now), an archive the server flags, and a run that ended in error.
 * - Came in today: what landed, one line per series, the archive's chapters summed up on it, and an archive
 *   that finished today with nothing left behind.
 */
export function downloadSections<J extends DownloadJob>(d: Partial<SourceJobs<J>> | undefined, { admin }: { admin: boolean }): Sections<J> {
  const jobs = d?.content ?? [];
  const active = d?.activity?.active ?? [];
  const recent = d?.activity?.recent ?? [];
  const runs = d?.runs ?? [];
  const running: Tile<J>[] = [];
  const queued: Tile<J>[] = [];

  const live = jobs.filter((j) => j.status === 'downloading').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const j of live) {
    running.push({
      key: j.seriesId ?? j.folder, seriesId: j.seriesId ?? null, folder: j.folder, title: j.title, job: j,
      entries: active.filter((e) => e.folder === j.folder), archive: false, progress: ringFraction(j.done, j.total),
    });
  }
  // The archive's rows first: its chapters in flight belong on the row's own cover, never on a second one.
  const archive = archiveItems(d?.archive, { admin });
  const rowOf = new Map(archive.filter((a) => a.section !== 'today').map((a) => [a.seriesId, a]));
  const onRow = new Map<string, ActivityEntry[]>();
  // Reintroduce by building these from `active` instead of `beyondJobs(...)`: a person's add is two covers.
  const groups = new Map<string, Tile<J>>();
  for (const e of beyondJobs(active, new Set(live.map((j) => j.folder)))) {
    // Reintroduce by dropping this: "two covers for one archived series" in serverDownloads.test.ts -- one from
    // the row, one from its chapter in flight.
    const row = isArchive(e) && e.seriesId ? rowOf.get(e.seriesId) : undefined;
    if (row) { onRow.set(row.seriesId, [...(onRow.get(row.seriesId) ?? []), e]); continue; }
    // The archive keyed apart, so a series the scheduled check is also on is not drawn still.
    const key = `${isArchive(e) ? 'a' : 'n'}:${e.seriesId ?? e.folder}`;
    let t = groups.get(key);
    if (!t) {
      t = { key: e.seriesId ?? e.folder, seriesId: e.seriesId, folder: e.folder, title: e.title, entries: [], archive: isArchive(e), progress: 'spin' };
      groups.set(key, t);
    }
    t.entries.push(e);
  }
  const byStart = (a: Tile<J>, b: Tile<J>) => (a.entries[0]?.startedAt ?? 0) - (b.entries[0]?.startedAt ?? 0);
  for (const t of [...groups.values()].sort(byStart)) {
    if (!t.archive && t.entries.some((e) => e.status === 'downloading')) running.push(t);
    else queued.push(t);
  }
  for (const a of archive) {
    if (a.section !== 'queued') continue;
    const entries = onRow.get(a.seriesId) ?? [];
    queued.push({
      key: a.seriesId, seriesId: a.seriesId, folder: entries[0]?.folder ?? '', title: a.title, entries, archive: true, item: a,
      progress: a.progress,
    });
  }

  // "Being fetched right now": an archive that is only queued is not, or a paused one would hide a series'
  // failed chapters from Needs attention for as long as it stays paused.
  const busy = new Set([...running, ...queued].filter((t) => !t.item || t.entries.length > 0).map((t) => t.key));
  const attention: Attention<J>[] = [];
  const failedJobs = jobs.filter((j) => j.status === 'error').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const j of failedJobs) {
    const seriesId = j.seriesId ?? null;
    attention.push({
      kind: 'job', key: `job:${j.folder}`, seriesId, title: j.title, job: j,
      // Nothing to retry by without a series: an add whose first chapter never landed has no row to fetch into.
      retry: seriesId ? uniqueSorted(j.left ?? []) : [], dismiss: admin || !!j.mine,
    });
  }
  const shownJob = new Set(failedJobs.flatMap((j) => [j.folder, j.seriesId ?? '']).filter(Boolean));
  for (const g of groupRecent(recent.filter((e) => !isArchive(e)))) {
    if (!g.failed.length || busy.has(g.key) || shownJob.has(g.key) || g.failed.some((f) => shownJob.has(f.folder))) continue;
    attention.push({
      kind: 'chapters', key: `ch:${g.key}`, seriesId: g.seriesId, title: g.title, failed: g.failed,
      retry: g.seriesId ? uniqueSorted(g.failed.map((f) => f.number)) : [],
    });
  }
  for (const a of archive) {
    if (a.section === 'attention') attention.push({ kind: 'archive', key: `archive:${a.seriesId}`, seriesId: a.seriesId, title: a.title, item: a });
  }
  for (const r of runs.filter((x) => x.status === 'error')) {
    attention.push({ kind: 'run', key: `run:${r.kind}`, run: r, dismiss: admin || !!r.mine });
  }

  const tasks = runs.filter((r) => r.status !== 'error')
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
  const cameIn = groupRecent(recent).filter((g) => g.numbers.length > 0);
  // A finished archive is said on its series' tile, or on a tile of its own when nothing of it landed today.
  for (const a of archive) {
    if (a.section !== 'today') continue;
    const g = cameIn.find((x) => x.seriesId === a.seriesId);
    if (g) { g.archiveFinished = a; continue; }
    const at = Date.parse(a.entry.finishedAt ?? '');
    cameIn.push({
      key: a.seriesId, seriesId: a.seriesId, title: a.title, numbers: [], archived: [], partial: 0, failed: [], origins: ['archive'],
      at: Number.isFinite(at) ? at : 0, archiveFinished: a,
    });
  }
  cameIn.sort((a, b) => b.at - a.at);
  const stopped = finished(jobs).filter((j) => j.cancelled);
  return { running, queued, attention, tasks, cameIn, stopped };
}

/**
 * A run's name on its Server tasks card. The scheduled check, a bulk Fetch newest and a full repair go by their
 * kind; a repair a Health key started says what kind of run it is and what it is about -- "Gap fill · Walk Gap",
 * "Longer-copy search · Walk Tale · Ch. 3" -- in Health's own words (healthCopy.ts kindLabel), so this card and Recent
 * repairs never name one run two ways. Every Health key starts a repair run, and a card reading "Library repair"
 * for each could not be told from the nightly. With no series the viewer may list (the server drops the label
 * for the 18+ hide) it is the press alone, "Fill now"; a server older than v0.49.0 sends no kind at all.
 */
export function runName(r: Pick<RunCard, 'kind' | 'repairKind' | 'label' | 'number'>): string {
  if (r.kind !== 'repair' || !r.repairKind || r.repairKind === 'full') return runTitle(r.kind);
  return kindLabel(r.repairKind, { label: r.label, number: r.number });
}

/**
 * What Library -> Downloads draws: skeletons while the first answer is on its way; an error with a retry when it
 * could not be had -- a 500 or a timeout used to read "Nothing is being fetched right now", as if all were
 * quiet; the empty state when there is truly nothing; else the sections. An answer already in hand wins over a
 * refetch that failed after it. Reintroduce by dropping the error branch: "a failed read says so" in
 * serverDownloads.test.ts reads 'empty'.
 */
export function viewState(q: { data?: unknown; isLoading: boolean; isError: boolean }, s: Sections<DownloadJob>): 'loading' | 'error' | 'empty' | 'list' {
  if (!q.data && q.isLoading) return 'loading';
  if (!q.data && q.isError) return 'error';
  const empty = !s.running.length && !s.queued.length && !s.attention.length && !s.tasks.length && !s.cameIn.length && !s.stopped.length;
  return empty ? 'empty' : 'list';
}

/** What the Library ring shows: the tab's icon on a phone, the button beside the Updates bell on a desktop. */
export interface NavRing {
  /** Anything to draw at all: work running, the slow archive alone, or something that failed. */
  show: boolean;
  progress: RingValue;
  /** Series in Running: the number of covers that section shows, which changes far less often than a chapter count. */
  count: number;
  /** The amber dot: a download of this viewer's failed (every failed card, to an admin -- the server decides). */
  attention: boolean;
  /** Only the slow archive is working: the calm, still mark, never a turning ring. */
  slow: boolean;
  /** Its title and screen-reader name: "Fetching 7 chapters", "Checking for new chapters", "2 failed". */
  label: string;
}

/**
 * The Library ring. Fills with the running jobs' chapters (done / total over all of them); with no job, with
 * the running run's progress once it has sized itself; otherwise it turns. Nothing to draw when nothing runs
 * and nothing failed. A run that cannot download (`downloads: false`), a "Find other sources" run (it follows,
 * it fetches nothing) and the slow archive never turn it.
 */
export function navRing(d: Partial<SourceJobs> | undefined): NavRing {
  const s = downloadSections(d, { admin: false });
  const jobs = s.running.filter((t) => t.job).map((t) => t.job!);
  // Reintroduce by dropping the kind: the admin's Library ring turns for hours while a find run follows sources.
  const runs = (d?.runs ?? []).filter((r) => r.status === 'running' && r.downloads !== false && r.kind !== 'find_sources');
  const serverChapters = [...s.running, ...s.queued].filter((t) => !t.job && !t.archive).reduce((n, t) => n + t.entries.length, 0);
  // Reintroduce by counting the archive's chapters here: a week-long archive turns the ring for a week.
  const active = jobs.length > 0 || serverChapters > 0 || runs.length > 0;
  // The still mark says the archive is WORKING: a paused one, or one the admin paused for everyone, is not.
  // Reintroduce by dropping `live`: "a paused archive puts no mark on the ring" in serverDownloads.test.ts.
  const slow = !active && s.queued.some((t) => t.archive && (t.item ? t.item.live : true));
  const failed = (d?.content ?? []).filter((j) => j.status === 'error').length;
  const progress: RingValue = jobs.length ? ringFraction(jobs.reduce((n, j) => n + Math.min(j.done, j.total), 0), jobs.reduce((n, j) => n + j.total, 0))
    : runs.length ? ringFraction(runs[0].done, runs[0].total)
    : active || slow ? 'spin'
    : 'idle';
  // What is moving first, then what failed: the dot is amber whatever else the ring shows, so the words say both.
  const label = [
    downloadsLabel(jobs.length, chaptersLeft(jobs), runs, 0, serverChapters) ?? (slow ? tr('Archiving slowly') : ''),
    failed ? (failed === 1 ? tr('1 failed') : tr('{n} failed', { n: failed })) : '',
  ].filter(Boolean).join(' · ');
  return { show: active || slow || failed > 0, progress, count: active ? s.running.length : 0, attention: failed > 0, slow, label };
}

/**
 * How often the one poller (lib/useServerDownloads.ts, mounted once in AppShell) asks: every 2.5 s while a
 * chapter is coming in, 5 s while only one of the server's runs is going (a series and a half apart can be an
 * hour), 30 s otherwise. The pill's rule, with the slow archive left out: it downloads for days.
 */
export function jobsPollInterval(d: Partial<SourceJobs> | undefined): number {
  // Reintroduce by dropping the activity clause: the scheduled check's chapters come in at 30 s and the ring freezes.
  if ((d?.content ?? []).some((j) => j.status === 'downloading') || (d?.activity?.active ?? []).some((e) => !isArchive(e))) return 2500;
  if ((d?.runs ?? []).some((r) => r.status === 'running')) return 5000;
  return 30_000;
}

/**
 * How many of this series' chapters have landed today: the series band watches it rise, and re-reads the
 * chapter list when it does, so a grey row turns into a chapter whoever's download brought it.
 */
export function landedFor(d: Partial<SourceJobs> | undefined, seriesId: string, folder?: string): number {
  return (d?.activity?.recent ?? []).filter((e) => (e.status === 'done' || e.status === 'partial')
    && (e.seriesId === seriesId || (!!folder && e.folder === folder))).length;
}

/**
 * Whether the series band re-reads the chapter list, and what it has now seen (`landedFor`, or null while there is
 * no answer yet). Only once more of this series has landed than it last saw: never on the first answer -- on a
 * cold load of a series page the downloads poll answers after the page has read its chapters itself, and
 * today's landings are already in that read -- and not when the count drops as the day ages out. Reintroduce by
 * comparing against 0 before the first answer: "the first answer re-reads the page" in serverDownloads.test.ts.
 */
export function shouldReload(seen: number | null, landed: number | null): { reload: boolean; seen: number | null } {
  if (landed === null) return { reload: false, seen };
  if (seen === null) return { reload: false, seen: landed };
  return { reload: landed > seen, seen: landed };
}

/** What the series band last saw: the count, and the series it counted for. */
export interface BandSeen { id: string; n: number | null }

/**
 * `shouldReload` for the band, which stays mounted when the app moves from one series to another: the series page
 * is not keyed by id, so /series/?id=A to ?id=B in the client keeps the band and what it saw of A. Measured against
 * A's count, B's first answer (0 -> 2 of today's landings) re-read B's chapters right after B's page read them --
 * the very re-read the first-answer rule exists to stop. So a count belongs to its series, and a new series starts
 * from a first answer.
 */
export function bandReload(seen: BandSeen | null, seriesId: string, landed: number | null): { reload: boolean; seen: BandSeen } {
  const step = shouldReload(seen?.id === seriesId ? seen.n : null, landed);
  return { reload: step.reload, seen: { id: seriesId, n: step.seen } };
}

/**
 * This series' tile, its failed download and its slow archive, for the band above its chapter list. `tile` is a
 * person's job or the server's chapters first, the archive's only when that is all there is; `archive` is the
 * archive's row whether it is Queued or under Needs attention, which the band shows on a line of its own with
 * Pause, Resume and Stop -- the series page's one place to watch an archive.
 */
export function bandFor<J extends DownloadJob>(s: Sections<J>, seriesId: string, folder?: string): {
  tile?: Tile<J>; failed?: Extract<Attention<J>, { kind: 'job' }>; archive?: ArchiveItem;
} {
  const ours = (id: string | null, f: string) => id === seriesId || (!!folder && f === folder);
  const tiles = [...s.running, ...s.queued].filter((t) => ours(t.seriesId, t.folder));
  const tile = tiles.find((t) => !t.archive) ?? tiles[0];
  const failed = s.attention.find((a): a is Extract<Attention<J>, { kind: 'job' }> => a.kind === 'job' && ours(a.seriesId, a.job.folder));
  const archive = tiles.find((t) => t.item)?.item
    ?? s.attention.find((a): a is Extract<Attention<J>, { kind: 'archive' }> => a.kind === 'archive' && a.seriesId === seriesId)?.item;
  return { tile, failed, archive };
}

/**
 * The one line under a Running or Queued cover, and the band's sentence: the chapter coming in and from where,
 * or who it is waiting for. "Stopping after this chapter…" wins while a Cancel is pending.
 */
export function tileStatus(t: Pick<Tile, 'job' | 'entries'>): string {
  if (t.job?.cancelRequested) return tr('Stopping after this chapter…');
  const now = t.entries.find((e) => e.status === 'downloading');
  if (now) return tr('Ch. {n} · {source}', { n: now.number, source: now.source });
  const next = t.entries.find((e) => e.status === 'queued');
  if (next) return tr('Waiting for {source}', { source: next.source });
  return '';
}
