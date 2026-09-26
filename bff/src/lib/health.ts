// Library health checks.
//
// The point of this file is to tell the operator about problems they would otherwise only discover by
// opening a chapter and finding it broken. Every check here was written against the real library and
// tuned until it stopped producing false positives, because a health page that cries wolf gets ignored
// and is worse than no health page at all.
//
// Two traps found while building it, both preserved as comments where they bite:
//  * `lib_books.pages` is filled in lazily on first read, so "pages = 0" means "never opened", not "broken".
//  * decimal chapters (12.5, 44.6) are overwhelmingly legitimate side-stories and "Notice!" pages, which are
//    genuinely one image long. Only whole-numbered chapters are worth flagging as too short.
import { q, one } from './db';
import { visibleToAll } from './visibility';
import { latestSolverVersion } from './solverVersion';
import { isBehind, latestRelease } from './githubRelease';
import { appVersion } from './appVersion';
import { solverPing, solverUrl } from './sources/flaresolverr';
import { getSource } from './sources';
import { suwayomiConfigured } from './sources/suwayomi/client';
import { lastSuwayomiLoad } from './sources/suwayomi/register';
import { env } from '../env';
import { gapsOf } from './fill';
import { CHAPTER_RETRY_CAP } from './updater';
import { diagnose } from './sourceDiagnosis';
import { haveNumbers } from './libraryNumbers';
import { DL_ROOT, LIBRARY_ROOT, lastScanReport, QUIET_WALK, type WalkReason } from './library';
import { downloadCensus, fsTypeOf } from './downloadCensus';
import { chapterFileRel } from './downloader';
import { forDesktop } from './desktop';

export type HealthStatus = 'ok' | 'warn' | 'problem';

/**
 * What an admin can do about one finding, from the finding itself.
 *
 * Every one of these is an EXISTING route the Health page now points at, plus the repair's own steps, and
 * the split between them is the release's whole argument: `fix_short`, `fill`, `retry` and `solver_reset`
 * run one step of the nightly repair for one row (reversible or provable, so a button is safe), while
 * `delete` and `merge` are the two the nightly never does by itself and an admin confirms.
 * `confirm_short` is the only one that records a JUDGEMENT rather than doing work ("this really is a
 * two-page chapter"), and it is a toggle: an item that already carries `fixed` is asking to be re-checked.
 */
export type HealthAction =
  | 'fix_short' | 'confirm_short' | 'delete' | 'fill' | 'retry' | 'test' | 'unblock' | 'disable' | 'merge' | 'solver_reset';

export interface HealthItem {
  seriesId?: string;
  /** Every series this item is about. The duplicates check needs both, so a merge can act on them. */
  seriesIds?: string[];
  titles?: string[];
  title: string;
  detail: string;
  /**
   * Listed for reference, never a reason to warn. A check's status is decided by the items WITHOUT this
   * flag, so a source the operator switched off, or a version that is merely behind, can be shown without
   * turning the page amber. Before this, "no items means ok" was the page's one invariant and both of
   * those cases quietly broke it.
   */
  info?: boolean;
  /** The one chapter this item is about (short chapters), so its chip can name it to the repair. */
  bookId?: string;
  /** Several chapters (impossible numbers), capped: what Delete chapter(s) would act on. */
  bookIds?: string[];
  /** The chapter number this item is about, for the sentence the chip's confirmation shows. */
  number?: number;
  /** The missing chapter numbers (gaps), capped -- the payload must stay a page, not a library. */
  numbers?: number[];
  /** The source this item is about, so Test / Clear block / Turn off / Retry need no parsing of `title`. */
  sourceId?: string;
  /** Of `seriesIds`, the one the merge should keep: more live chapters, then more readers, then older. */
  keep?: string;
  /** What an admin can do about this item, in the order the chips are shown. */
  actions?: HealthAction[];
  /**
   * Something has already been decided or done about this finding, and WHEN. It is what turns a row grey
   * rather than amber: a chapter confirmed short at the source, a gap every reachable source was asked
   * about. Kept as data rather than folded into `detail` so the page can show it as a state.
   */
  fixed?: { at: string; what: string };
}

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthStatus;
  /** one-line human summary, already pluralised */
  summary: string;
  /** what this check cannot see — shown so nobody reads more into a green result than it deserves */
  note?: string;
  items: HealthItem[];
}

export interface HealthReport {
  generatedAt: string;
  checks: HealthCheck[];
}

const MAX_ITEMS = 50; // keep the payload sane; the summary always reports the true total
/** The most gap numbers one item carries. A "Fill now" chip needs to NAME them; it does not need 4,000. */
const MAX_NUMBERS = 100;
/** The most chapters one Delete chip acts on, and the most an admin can sensibly read in a confirmation. */
const MAX_BOOK_IDS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a repair's conclusion about a gap stays a conclusion rather than a finding again. */
const GAPS_FRESH_MS = 7 * DAY_MS;

/**
 * ⚠️ FINDINGS FIRST, always, before the slice. A check's status is decided by the items WITHOUT `info`
 * (the page's one invariant, pinned in health.int.test.ts), so a check holding sixty greyed rows and three
 * real ones could cut the real ones off and report a warning with nothing in it -- which reads as a page
 * bug rather than as a finding. Sorting by severity first costs nothing and makes the slice safe whatever
 * order the check itself built its rows in.
 */
function truncate<T extends { info?: boolean }>(rows: T[]): { items: T[]; hidden: number } {
  const ordered = [...rows].sort((a, b) => Number(!!a.info) - Number(!!b.info));
  return { items: ordered.slice(0, MAX_ITEMS), hidden: Math.max(0, rows.length - MAX_ITEMS) };
}

/** A check's verdict, from the items that are findings: the invariant, written once. */
const verdict = (items: HealthItem[], bad: HealthStatus = 'warn'): HealthStatus =>
  items.some((i) => !i.info) ? bad : 'ok';

/**
 * The shape lib/repair.ts stores in `lib_series.gaps_result`.
 *
 * Every field is optional on purpose: this is JSON written by another process, possibly by an older
 * release, and a health page that can throw because a stored row predates a field is a health page that
 * disappears exactly when something is wrong. Nothing here is trusted beyond being read.
 */
interface StoredGaps {
  at?: string;
  have_count?: number;
  scanned?: number;
  followed?: string | null;
  coverage?: number | null;
  fetched?: number;
  sweep?: number;
  capped?: number;
  unfillable?: string[];
  why?: string;
}

/** One series' held chapter numbers, plus what the nightly repair last concluded about its gaps. */
interface HeldSeries {
  id: string;
  title: string;
  numbers: number[];
  gapsCheckedAt: string | null;
  gapsResult: StoredGaps | null;
}

/**
 * What every visible series HOLDS, read once and shared by the two checks that reason about numbering.
 *
 * `haveNumbers` (lib/libraryNumbers.ts) is the one definition of that, and it applies two rules this page
 * used to get wrong in both directions: a chapter an admin renumbered through the series page still had its
 * old number reported as impossible, and a chapter they deliberately deleted still counted as a hole this
 * page told them to fill -- a finding that could not be cleared by doing what it asked.
 *
 * One small indexed read per series rather than one grouped query, for the same reason the repair's gap
 * step does it that way: the rules are per series, and quoting the shared definition is worth more than
 * flattening it into a join nobody can check against it. The gaps and the impossible-number checks share
 * this one pass, so the cost is paid once per report, not twice.
 */
async function heldBySeries(): Promise<HeldSeries[]> {
  const series = await q<{ id: string; title: string; gaps_checked_at: string | null; gaps_result: StoredGaps | null }>(
    `SELECT ls.id, ls.title, ls.gaps_checked_at, ls.gaps_result
       FROM lib_series ls WHERE ${visibleToAll('ls')} ORDER BY ls.title`,
  );
  const out: HeldSeries[] = [];
  for (const s of series) {
    out.push({
      id: s.id,
      title: s.title,
      numbers: await haveNumbers(s.id),
      gapsCheckedAt: s.gaps_checked_at,
      gapsResult: s.gaps_result ?? null,
    });
  }
  return out;
}

/** "1, 3-7, 12" from [1,3,4,5,6,7,12] -- how this page has always written a set of chapter numbers. */
function rangeText(gaps: Array<{ lo: number; hi: number }>): string {
  return gaps.map((g) => (g.lo === g.hi ? String(g.lo) : `${g.lo}-${g.hi}`)).join(', ');
}

// ---- individual checks ------------------------------------------------------

/**
 * What the nightly repair concluded about one series' gaps, in words an admin can act on.
 *
 * `why` comes from the search itself (lib/repair.ts stores huntCandidates' verdict), and the three that
 * mean "asked, and the answer was no" are what turn the finding grey. `listed` is the fourth quiet one for
 * a different reason: the chapters ARE on a source we follow, so the ordinary chapter sweep will fetch
 * them and a search would have been wasted requests.
 *
 * ⚠️ Each sentence has to describe the verdict it is printed under, and two of them once described the
 * other one's. `cap` is sourceHunt's "this series already follows MAX_FOLLOWERS sources" -- a permanent
 * fact about the series, nothing to do with the night's budget -- and it was rendered "the nightly ran out
 * of searches", which invites the admin to wait for tomorrow's run for an answer that will never change.
 * `cooldown` is the 24 h stamp on this one series, and it is NOT the spent-budget case: the gap step stops
 * before it asks with an empty budget rather than storing a verdict about a search that never ran
 * (lib/repair.ts's stepGaps), so "searched too recently" is true of every cooldown that reaches this page.
 */
function gapConclusion(g: StoredGaps): string {
  switch (g.why) {
    case 'followed':
      return g.followed
        ? `now following ${g.followed}${g.fetched ? `, ${g.fetched} fetched` : ''}`
        : 'a source that can fill them was followed';
    case 'no_candidate': return 'no other source lists them';
    case 'cap': return 'this series already follows as many sources as it can';
    case 'off': return 'searching other sources is switched off';
    case 'cooldown': return 'searched too recently to search again';
    case 'listed': return 'a source you already follow lists them, so the next chapter sweep will fetch them';
    default: return 'checked';
  }
}

/**
 * Missing runs of chapter numbers: either the source never had them, or a download failed.
 *
 * Computed by `gapsOf`, the same function the fill dialog uses, and nothing else. There used to be a second
 * implementation here in SQL that filtered `WHERE number > 0`, so on a series shaped `0, 93..141` this page
 * said "no gaps" while "find missing chapters" offered to fetch 92 -- both green in their own tests. Two
 * definitions of one fact is how that happens; there is now one. The numbers themselves come from
 * `haveNumbers` for the same reason (see heldBySeries above).
 */
async function chapterGaps(held: HeldSeries[]): Promise<HealthCheck> {
  const rows = held
    .map((s) => {
      const gaps = gapsOf(s.numbers);
      const numbers: number[] = [];
      for (const g of gaps) for (let n = g.lo; n <= g.hi && numbers.length < MAX_NUMBERS; n++) numbers.push(n);
      return { s, gaps, missing: gaps.reduce((n, g) => n + g.count, 0), numbers };
    })
    .filter((r) => r.missing > 0)
    .sort((a, b) => b.missing - a.missing);

  const items: HealthItem[] = rows.map((r) => {
    const ranges = rangeText(r.gaps);
    const g = r.s.gapsResult;
    const checked = r.s.gapsCheckedAt ? new Date(r.s.gapsCheckedAt) : null;
    const fresh = !!checked && Date.now() - checked.getTime() < GAPS_FRESH_MS;
    // A conclusion is about the library as it was when the search ran. One more chapter has landed since,
    // so the hole may have moved: ask again rather than keep showing last night's answer.
    const unchanged = !!g && g.have_count === r.s.numbers.length;
    // "Asked, and the answer was no." All three are conditions another run tonight cannot change on its
    // own: nobody else lists the chapters, the series already follows as many sources as it may, or
    // searching is switched off. A cooldown is NOT in this list, deliberately and for the same reason the
    // repair will not confirm a short chapter on one: not having asked is not an answer.
    const answered = !!g && ['no_candidate', 'cap', 'off'].includes(String(g.why));
    // Every missing chapter is already listed on a source we follow, so this is the chapter sweep's job.
    // ⚠️ Still only while the conclusion is fresh: a hole the sweep was going to fetch a fortnight ago and
    // still has not is a finding again, not a promise.
    const sweepsIt = !!g && typeof g.sweep === 'number' && r.missing > 0 && g.sweep >= r.missing;
    const info = fresh && ((answered && unchanged) || sweepsIt);
    const what = g ? gapConclusion(g) : null;
    return {
      seriesId: r.s.id,
      title: r.s.title,
      detail: `${r.missing} missing — ${ranges.length > 90 ? ranges.slice(0, 90) + '…' : ranges}`
        + (checked && what ? `; ${what}, checked ${checked.toISOString().slice(0, 10)}` : ''),
      numbers: r.numbers,
      actions: ['fill'] as HealthAction[],
      ...(checked && what ? { fixed: { at: checked.toISOString(), what } } : {}),
      ...(info ? { info: true } : {}),
    };
  });
  const { items: shown, hidden } = truncate(items);
  const live = items.filter((i) => !i.info).length;
  const quiet = items.length - live;
  return {
    id: 'chapter-gaps',
    title: 'Chapter gaps',
    status: verdict(items),
    summary: (live
      ? `${live} series ${live === 1 ? 'has' : 'have'} missing chapters`
      : 'No gaps that need attention')
      + (quiet ? `; ${quiet} already looked into` : ''),
    note:
      'Gaps are normal when a source skipped a number or a series is still being downloaded. "Fill now" runs the ' +
      'repair\'s gap search for one series: it looks for another source that carries our numbering on both sides of ' +
      'the hole, follows it and fetches. A series it has already asked about is greyed with what it found.' +
      (hidden ? ` ${hidden} more not shown.` : ''),
    items: shown,
  };
}

/** Whole-numbered chapters that turned out to be one or two images: almost always a failed download. */
async function shortChapters(): Promise<HealthCheck> {
  // Decimal chapters are excluded on purpose: ".5" entries are usually author notices, legitimately 1 page.
  // A tombstone is excluded too -- those bytes are gone on purpose (or already reported as missing by the
  // verify task), and a page count taken before they went says nothing about anything anybody can fix.
  const rows = await q<{
    id: string; series_id: string; title: string; folder: string; number: number; pages: number;
    root: string | null; file: string; short_confirmed_at: string | null;
  }>(
    `SELECT b.id, b.series_id, ls.title, ls.folder, b.number::float8 AS number, b.pages, b.root, b.file,
            b.short_confirmed_at
       FROM lib_books b JOIN lib_series ls ON ls.id = b.series_id AND ${visibleToAll('ls')}
      WHERE b.pages BETWEEN 1 AND 2 AND b.number = floor(b.number) AND b.pruned_at IS NULL
      ORDER BY ls.title, b.number`,
  );
  const item = (r: typeof rows[number]): HealthItem => {
    // "Fix" replaces the file, so it is offered ONLY for a file this server downloaded and named itself:
    // the download root, under exactly the name chapterFileRel writes. Somebody's own copy in the read
    // library is never ours to replace -- for that, the only honest chip is "It's fine".
    const owned = r.root === DL_ROOT && r.file === chapterFileRel(r.folder, Number(r.number));
    const confirmed = r.short_confirmed_at ? new Date(r.short_confirmed_at) : null;
    return {
      seriesId: r.series_id,
      bookId: r.id,
      number: Number(r.number),
      title: r.title,
      detail: `Chapter ${r.number} has ${r.pages} page${r.pages === 1 ? '' : 's'}`,
      // Confirmed rows keep exactly one chip, and it is the one that undoes the confirmation: the repair
      // skips a chapter somebody has already called short, so "Fix" on one would do nothing at all.
      actions: confirmed ? ['confirm_short'] : owned ? ['fix_short', 'confirm_short'] : ['confirm_short'],
      ...(confirmed
        ? { info: true, fixed: { at: confirmed.toISOString(), what: 'confirmed short at the source' } }
        : {}),
    };
  };
  const items = rows.map(item);
  const { items: shown, hidden } = truncate(items);
  const live = items.filter((i) => !i.info).length;
  const quiet = items.length - live;
  return {
    id: 'short-chapters',
    title: 'Suspiciously short chapters',
    status: verdict(items, 'problem'),
    summary: (live
      ? `${live} chapter${live === 1 ? '' : 's'} contain only one or two images`
      : 'No truncated chapters found')
      + (quiet ? `; ${quiet} confirmed short at the source` : ''),
    note:
      'Counted nightly by the repair task, which opens the chapter files nobody has read yet, so this is no longer ' +
      'limited to chapters someone has opened. Half-chapters are excluded since author notices really are one page. ' +
      '"Fix" replaces the chapter only if another source has a longer copy; "It\'s fine" records that it really is ' +
      'this short, and the nightly stops looking at it.' +
      (hidden ? ` ${hidden} more not shown.` : ''),
    items: shown,
  };
}

/** Sources that are failing or blocked, and how much of the library depends on them. */
/**
 * Chapters the updater or a fill could not save, by source.
 *
 * Rows clear themselves when the chapter lands (persistScan), so what is listed here is what is STILL
 * failing, and how many times it has been tried. Before the ledger existed one night's sweep lost 164 of 226
 * series to a single chapter and no surface, not even the log, said so.
 */
async function chapterFailures(): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; chapters: number; series: number; since: string; attempts: number; capped: number;
    latest_title: string; latest_number: number; latest_status: string; latest_reason: string | null;
  }>(
    `SELECT f.source_id,
            count(*)::int AS chapters,
            count(DISTINCT f.series_id)::int AS series,
            min(f.at) AS since,
            max(f.attempts)::int AS attempts,
            count(*) FILTER (WHERE f.attempts >= ${CHAPTER_RETRY_CAP})::int AS capped,
            (array_agg(ls.title  ORDER BY f.at DESC))[1] AS latest_title,
            (array_agg(f.number  ORDER BY f.at DESC))[1] AS latest_number,
            (array_agg(f.status  ORDER BY f.at DESC))[1] AS latest_status,
            (array_agg(f.reason  ORDER BY f.at DESC))[1] AS latest_reason
       FROM chapter_failures f JOIN lib_series ls ON ls.id = f.series_id AND ${visibleToAll('ls')}
      GROUP BY f.source_id ORDER BY chapters DESC`,
  ).catch(() => [] as any[]);
  const items: HealthItem[] = rows.slice(0, 20).map((r) => ({
    title: r.source_id,
    sourceId: r.source_id,
    // One chip, and it is the repair's failures step for THIS source: it clears the attempt counts whatever
    // their age and re-checks up to ten of the source's series. The nightly does the same thing on its own
    // for rows that have sat at the cap for a week -- this is "the site is back up, try now".
    actions: ['retry'] as HealthAction[],
    detail:
      `${r.chapters} chapter${r.chapters === 1 ? '' : 's'} in ${r.series} series since ` +
      `${new Date(r.since).toISOString().slice(0, 10)}, tried up to ${r.attempts} time${r.attempts === 1 ? '' : 's'}` +
      `${r.capped ? `, ${r.capped} left alone after ${CHAPTER_RETRY_CAP}` : ''}; ` +
      `latest: "${r.latest_title}" ch ${r.latest_number} (${r.latest_status}` +
      // 160, not 80: since v0.40.0 the reason ends with the evidence -- ` (page 80: 200 image/webp 88 B;
      // page 12: 404)` -- and that tail is the part that says WHICH theory is right. At 80 it was cut.
      `${r.latest_reason ? `: ${String(r.latest_reason).slice(0, 160)}` : ''})`,
  }));
  const total = rows.reduce((n, r) => n + r.chapters, 0);
  return {
    id: 'chapter-failures',
    title: 'Chapters that would not download',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${total} chapter${total === 1 ? '' : 's'} across ${rows.length} source${rows.length === 1 ? '' : 's'} keep failing`
      : 'Every attempted chapter landed',
    note:
      'One entry per source, counting chapters still missing after an attempt and how often each has been tried. ' +
      `They clear themselves the moment the chapter lands. After ${CHAPTER_RETRY_CAP} failed tries the nightly sweep leaves a chapter alone ` +
      'until the nightly repair gives it another chance a week later; "Retry now" does that for this source at once, ' +
      'and "Find missing chapters" on the series still fetches it on purpose. ' +
      // Not a failure row: a chapter saved short is on disk and readable, so it is not in this ledger at
      // all. Said here because this is where an admin looks for "why is a chapter not whole".
      'A chapter saved with pages missing is listed on its series page and re-tried by the sweep, up to 10 a night.' +
      (rows.length > 20 ? ` ${rows.length - 20} more not shown.` : ''),
    items,
  };
}

/**
 * Series whose source no longer exists, so the updater and the fill can never reach them.
 *
 * `updateSeries` returns `unrouted` for these every night and the sweep prints the count and discards it.
 * Their chapters read fine, their health row (if any) says `ok` because nothing ever failed -- nothing was
 * ever asked -- and the fill scan never even pins them. Live: one series, 31 chapters, frozen since its
 * extension was uninstalled twelve days earlier, and no surface anywhere said so.
 */
async function frozenSeries(): Promise<HealthCheck> {
  const rows = await q<{ id: string; title: string; source_id: string | null; books_count: number; switched_off: boolean; still_enabled: boolean }>(
    // A source that is still installed but switched off (by hand, or by hiding its language) is a different
    // finding from one that is gone: the fix is a button, not a reinstall.
    `SELECT ls.id, ls.title, ls.source_id, ls.books_count,
            EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE 'sw:' || ss.source_id = ls.source_id AND NOT ss.enabled) AS switched_off,
            EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE 'sw:' || ss.source_id = ls.source_id AND ss.enabled) AS still_enabled
       FROM lib_series ls
      WHERE ls.auto_update AND ${visibleToAll('ls')}
        AND (ls.source_id IS NULL OR ls.source_series_id IS NULL OR ls.source_id NOT IN (SELECT source_id FROM suwayomi_sources WHERE enabled)
             OR ls.source_id LIKE 'sw:%')
      ORDER BY ls.books_count DESC`,
  ).catch(() => [] as any[]);
  // The SQL over-selects on purpose (it cannot know which adapters are loaded); the loaded registry decides.
  const unrouted = rows.filter((r) => !r.source_id || !getSource(r.source_id));
  // A series whose primary is gone but which follows another source that IS loaded still updates: the
  // updater merges the followers' lists, so a dead primary costs it nothing but that one listing. Reported
  // as reference, not as a fault -- the fix (re-point the primary, or leave it) is a tidy-up, not a repair.
  // Reintroduce by dropping this read (every row of `unrouted` frozen): "a dead primary with a live follower
  // is not frozen" in health.int.test.ts fails -- the fixture is listed as a warning.
  const followed = new Map<string, string[]>();
  if (unrouted.length) {
    const extra = await q<{ series_id: string; source_id: string }>(
      'SELECT series_id, source_id FROM series_sources WHERE series_id = ANY($1::text[]) ORDER BY created_at',
      [unrouted.map((r) => r.id)],
    ).catch(() => [] as { series_id: string; source_id: string }[]);
    for (const e of extra) {
      const src = getSource(e.source_id);
      if (!src) continue;
      followed.set(e.series_id, [...(followed.get(e.series_id) ?? []), src.name]);
    }
  }
  const frozen = unrouted.filter((r) => !followed.has(r.id));
  const covered = unrouted.filter((r) => followed.has(r.id));
  const why = (r: typeof rows[number]) =>
    // Enabled yet unregistered is the third case: dropped by SUWAYOMI_MAX_SOURCES, which the cap check
    // above names but a series page cannot see.
    r.switched_off ? 'switched off' : r.still_enabled ? forDesktop('over the source limit (SUWAYOMI_MAX_SOURCES)', 'over the source limit') : 'no longer installed';
  const items: HealthItem[] = frozen.slice(0, 20).map((r) => ({
    seriesId: r.id,
    title: r.title,
    detail: r.source_id
      ? `${r.books_count} chapters; its source ${r.source_id} is ${why(r)}`
      : `${r.books_count} chapters; no source recorded`,
  }));
  for (const r of covered.slice(0, 20)) {
    items.push({
      seriesId: r.id,
      title: r.title,
      detail: `primary ${r.source_id ?? '(none)'} gone; still following ${followed.get(r.id)!.join(', ')}`,
      info: true,
    });
  }
  return {
    id: 'frozen-series',
    title: 'Series that can no longer update',
    status: frozen.length ? 'warn' : 'ok',
    summary: (frozen.length
      ? `${frozen.length} series ${frozen.length === 1 ? 'has' : 'have'} no working source`
      : 'Every series has a working source') +
      (covered.length ? `; ${covered.length} lost ${covered.length === 1 ? 'its' : 'their'} primary but still follow${covered.length === 1 ? 's' : ''} another` : ''),
    note:
      'These read fine, but nothing can fetch new chapters for them and "find missing chapters" will not offer ' +
      'their own source. Switch the source back on, re-add the extension, or re-point the series at a source that carries it.' +
      (frozen.length > 20 ? ` ${frozen.length - 20} more not shown.` : ''),
    items,
  };
}

async function sourceTrouble(): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; status: string; consecutive: number; disabled: boolean;
    blocked_until: string | null; last_error: string | null; empty_streak: number; last_ok_at: string | null;
    last_fail_at: string | null; last_slow_at: string | null;
    series: number;
  }>(
    `SELECT sh.source_id, sh.status, sh.consecutive,
            -- Two ways a source is off on purpose: the Providers button (source_health.disabled) and a hidden
            -- language (suwayomi_sources.enabled = false, which also unregisters it, so nothing ever probes
            -- it again and a stale 'down' row would otherwise keep this check amber for good).
            (sh.disabled OR EXISTS (SELECT 1 FROM suwayomi_sources ss
                                      WHERE 'sw:' || ss.source_id = sh.source_id AND NOT ss.enabled)) AS disabled,
            sh.blocked_until, sh.last_error,
            sh.empty_streak, sh.last_ok_at,
            -- When the stored error was written, so a success that came AFTER it can be told apart from one
            -- that came before (reportFail and reportSlow stamp these; nothing ever clears last_error).
            sh.last_fail_at, sh.last_slow_at,
            -- ls.source_id, NOT ls.source: the former is the adapter id ('aqua'), the latter is the
            -- display name as it was at add time ('Aqua Manga (EN)'). This compared a name to an id, so it
            -- matched nothing and every row of this check has always reported "0 series use it".
            -- Followers count as well as primaries (series_sources), and a series counts ONCE however many
            -- ways it reaches this source: since v0.31.0 a series can follow several sources, so counting
            -- primaries alone called a source nobody-uses while it was the only one carrying ten series --
            -- and this check now greys a source on exactly that number.
            (SELECT count(*) FROM lib_series ls
              WHERE ${visibleToAll('ls')}
                AND (ls.source_id = sh.source_id
                     OR EXISTS (SELECT 1 FROM series_sources ss2
                                 WHERE ss2.series_id = ls.id AND ss2.source_id = sh.source_id)))::int AS series
       FROM source_health sh
      WHERE sh.status <> 'ok' OR sh.disabled = true OR sh.empty_streak >= 3
         OR EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE 'sw:' || ss.source_id = sh.source_id AND NOT ss.enabled)
      ORDER BY 4 DESC, sh.consecutive DESC`,
  );
  const now = Date.now();
  // A source the operator switched off themselves is not a fault, and reading it as one is how a health
  // page trains people to ignore it. Contributor PR #39 spotted this while adding language hiding: turning
  // off thirty Russian sources made the page amber with thirty "problems" that were the operator's own
  // decision. They stay listed, greyed, so the count is still visible; the verdict comes from the rest.
  //
  // The second quiet case, and the bigger one on the live server: a source NOTHING uses. Ten of twelve
  // not-ok rows there are sources that only ever appeared in Discover, failed once, and have held this
  // check amber ever since -- a fault nobody can fix by fixing anything, because no series depends on it.
  // Still listed, and still a real finding the moment it is in a cooldown or somebody adds a series to it.
  const unused = (r: typeof rows[number]) =>
    !r.disabled && r.series === 0 && !(r.blocked_until && new Date(r.blocked_until).getTime() > now);
  const live = rows.filter((r) => !r.disabled && !unused(r));
  const off = rows.filter((r) => r.disabled).length;
  const idle = rows.filter((r) => !r.disabled && unused(r)).length;
  return {
    id: 'sources',
    title: 'Source health',
    status: live.length ? 'warn' : 'ok',
    summary: (live.length
      ? `${live.length} source${live.length === 1 ? ' is' : 's are'} failing or blocked`
      : 'All sources responding normally')
      + (off ? `; ${off} turned off by you` : '')
      + (idle ? `; ${idle} no series use` : ''),
    note: 'A blocked source usually means the site returned 403 or a Cloudflare challenge we could not solve. '
        + 'If several fail at once and all of them mention the solver, check the solver rather than the sites. '
        + 'A source no series uses is listed for reference only: nothing in your library depends on it.',
    items: rows.map((r) => {
      const until = r.blocked_until ? new Date(r.blocked_until).getTime() : 0;
      // A block whose deadline has passed is not actually holding anything back; say so rather than
      // leaving the operator thinking the source is still down.
      const state = r.disabled
        ? 'turned off by you'
        : until && until < now
          ? `block expired, will retry on next use (was ${r.status})`
          : until
            ? `${r.status} until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')}`
            : r.status;
      // The plain-language cause and its fix, rather than the raw string. This page is admin-only, so it
      // gets the operator half of the diagnosis, which is the half that names what to actually go and do.
      //
      // `last_error` outlives the failure it describes: `reportOk` never clears it, so a source listed here
      // for an empty streak, with a success more recent than its last failure, would otherwise be diagnosed
      // from the words of its last bad afternoon and the operator sent to fix a Cloudflare problem that ended
      // days ago. The stored-error rules run before the empty-streak one, so the stale string would even
      // hide the live finding. When the last success is newer than the last failure, the error is history.
      const at = (t: string | null) => (t ? new Date(t).getTime() : 0);
      const errorIsHistory = at(r.last_ok_at) > Math.max(at(r.last_fail_at), at(r.last_slow_at));
      const d = diagnose({
        status: r.status as any, lastError: errorIsHistory ? null : r.last_error, consecutive: r.consecutive,
        lastOkAt: r.last_ok_at, emptyStreak: r.empty_streak ?? 0,
        blockedUntil: r.blocked_until, disabled: r.disabled,
      });
      const why = d.code === 'ok' ? '' : ` — ${d.fix || d.reason}`;
      return {
        title: r.source_id,
        sourceId: r.source_id,
        detail: `${state}; ${r.series ? `${r.series} series use it` : 'no series use it'}${why}`,
        // Test always: it is the one action that answers "is this still true?", and it is read-only.
        // Clear block whenever there is a block to clear, expired or not -- clearing also wipes the
        // escalation memory (consecutive), which is what makes the next cooldown fifteen minutes instead of
        // seventy-five. Turn off only for a source that is not already off, by either of the two routes.
        actions: [
          'test',
          ...(r.blocked_until ? ['unblock' as const] : []),
          ...(r.disabled ? [] : ['disable' as const]),
        ] as HealthAction[],
        ...(r.disabled || unused(r) ? { info: true } : {}),
      };
    }),
  };
}

/** The same manga added twice, spotted by two local series resolving to one AniList entry. */
async function duplicateSeries(): Promise<HealthCheck> {
  const rows = await q<{ external_id: string; titles: string; ids: string[] }>(
    `SELECT t.external_id, string_agg(ls.title, ' + ' ORDER BY ls.title) AS titles,
            array_agg(ls.id ORDER BY ls.title) AS ids
       FROM series_trackers t JOIN lib_series ls ON ls.id = t.series_id AND ${visibleToAll('ls')}
      WHERE t.provider = 'anilist'
      GROUP BY t.external_id HAVING count(*) > 1
      ORDER BY count(*) DESC`,
  );
  // Which copy should survive a merge. A merge is ONE-WAY and it moves everything (progress, bookmarks,
  // trackers, chapters) into the survivor, so the suggestion has to be the copy that would lose the most by
  // being the one absorbed: most live chapters first, then the one people have actually read, and an older
  // row as the tie-break because it is the one whose id is in everybody's links and history.
  // ⚠️ A suggestion only. The merge itself is never automatic -- an admin confirms it, naming both titles.
  const ids = [...new Set(rows.flatMap((r) => r.ids))];
  const rank = new Map<string, { books: number; readers: number; created: number }>();
  if (ids.length) {
    const stats = await q<{ id: string; books: number; readers: number; created_at: string }>(
      `SELECT ls.id, ls.created_at,
              (SELECT count(*) FROM lib_books b WHERE b.series_id = ls.id AND b.pruned_at IS NULL)::int AS books,
              (SELECT count(*) FROM read_progress rp WHERE rp.series_id = ls.id)::int AS readers
         FROM lib_series ls WHERE ls.id = ANY($1::text[])`,
      [ids],
    ).catch(() => []);
    for (const s of stats) rank.set(s.id, { books: s.books, readers: s.readers, created: new Date(s.created_at).getTime() });
  }
  const keepOf = (group: string[]): string =>
    [...group].sort((a, b) => {
      const x = rank.get(a) ?? { books: 0, readers: 0, created: 0 };
      const y = rank.get(b) ?? { books: 0, readers: 0, created: 0 };
      return y.books - x.books || y.readers - x.readers || x.created - y.created;
    })[0];
  return {
    id: 'duplicates',
    title: 'Duplicate series',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${rows.length} title${rows.length === 1 ? ' appears' : 's appear'} to be in the library twice`
      : 'No duplicates found',
    note:
      'Detected by two series matching the same AniList entry, so it catches copies added from different ' +
      'sources under different names. Progress tracking works best with one copy of each. Merging is one-way and ' +
      'never automatic: the nightly repair leaves these alone and you confirm each one.',
    items: rows.map((r) => {
      const keep = keepOf(r.ids);
      return {
        seriesId: r.ids[0],
        seriesIds: r.ids,
        titles: r.titles.split(' + '),
        title: r.titles,
        keep,
        // Only a pair gets the chip. Three copies of one entry is two merges in an order somebody has to
        // choose, and a button that quietly picks one is how a library loses a series it cannot get back.
        ...(r.ids.length === 2 ? { actions: ['merge' as const] } : {}),
        detail: 'Same AniList entry'
          + (r.ids.length > 2 ? `; ${r.ids.length} copies — merge them one pair at a time` : ''),
      };
    }),
  };
}

/** percentile_cont(0.5), in JS: the interpolated median, so this check and the SQL it replaced agree. */
function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/** Chapter numbers far beyond the rest of the series: the sidebar-widget scraping bug's signature. */
async function outlierChapters(held: HeldSeries[]): Promise<HealthCheck> {
  const rows = held
    .map((s) => {
      // Positive numbers only, as the SQL this replaced did: a chapter 0 is a legitimate prologue and
      // including it would drag the median down towards nothing.
      const nums = s.numbers.filter((n) => n > 0).sort((a, b) => a - b);
      if (!nums.length) return null;
      const med = median(nums);
      const hi = nums[nums.length - 1];
      const limit = Math.max(med * 4, med + 500);
      if (!(hi > limit)) return null;
      return { s, med, hi, limit };
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => b.hi - a.hi);

  const items: HealthItem[] = [];
  for (const r of rows) {
    // The rows behind the numbers, so the Delete chip can name them. Same override rule as haveNumbers
    // (the same COALESCE, spelled out only because HAVE_SQL answers with numbers and a delete needs ids),
    // and one deliberate difference: `pruned_at IS NULL`, not `heldBooks`.
    //
    // ⚠️ The two checks mean different things by a tombstone, and this is the one place it shows. For a GAP
    // a deliberate deletion is HELD -- the bytes went on purpose and the sweep must not fetch them back. For
    // an impossible chapter number, deleting the chapter IS the fix: keeping the row in the finding would
    // mean the Delete chip could never clear the thing it was pressed on, which is precisely the complaint
    // this release started from ("a renumber or a delete does not clear the finding"). A series whose only
    // out-of-range chapters are already deleted therefore drops out of the check entirely.
    const books = await q<{ id: string; number: number }>(
      `SELECT b.id, COALESCE(o.number, b.number)::float8 AS number
         FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id
        WHERE b.series_id = $1 AND b.pruned_at IS NULL AND COALESCE(o.number, b.number) > $2
        ORDER BY 2 DESC`,
      [r.s.id, r.limit],
    ).catch(() => []);
    if (!books.length) continue;
    items.push({
      seriesId: r.s.id,
      title: r.s.title,
      detail: `${books.length} chapter(s) up to ${books[0].number}, but the series sits around ${Math.round(r.med)}`,
      bookIds: books.slice(0, MAX_BOOK_IDS).map((b) => b.id),
      numbers: books.slice(0, MAX_BOOK_IDS).map((b) => Number(b.number)),
      actions: ['delete'],
    });
  }
  return {
    id: 'outliers',
    title: 'Impossible chapter numbers',
    status: verdict(items, 'problem'),
    summary: items.length
      ? `${items.length} series ${items.length === 1 ? 'has' : 'have'} chapters numbered far beyond the rest`
      : 'No out-of-range chapters',
    note:
      'Catches chapters scraped from a site\'s sidebar widget, which belong to a different series. The parser ' +
      'now guards against this, so anything here predates that fix. Deleting is never automatic and the nightly ' +
      'repair never renumbers: "Delete chapter(s)" removes the files (a bookmarked chapter is refused), and a ' +
      'wrong number can be corrected on the series page instead.' +
      (items.length > MAX_ITEMS ? ` ${items.length - MAX_ITEMS} more not shown.` : ''),
    items: items.slice(0, MAX_ITEMS),
  };
}

/**
 * The Cloudflare solver, as its own line.
 *
 * When it dies, every source behind it fails and each records the failure against ITSELF, so the operator
 * sees four broken websites and nothing pointing at the one container they all share. On this install it
 * ran for 62 days with Docker's default 64 MB of shared memory, which is far too little for Chrome: it kept
 * crashing mid-challenge, and the app dutifully reported that the sites were blocking us.
 */
/**
 * Sources whose own recorded failure blames the solver: the correlation that turns "four sites are broken"
 * into "one container is broken".
 *
 * Exported because the nightly repair's solver step asks the same question before it clears anything --
 * resetting the solver's remembered sessions is only worth doing when something is actually failing inside
 * it. Two copies of this query is how the gap check and the fill dialog once ended up disagreeing about
 * what a gap was, so there is one.
 */
export async function solverBlaming(): Promise<string[]> {
  const rows = await q<{ source_id: string }>(
    `SELECT source_id FROM source_health
      WHERE disabled = false AND last_error ILIKE '%flaresolverr%'
        AND (status <> 'ok' OR blocked_until > now())`,
  ).catch(() => []);
  return rows.map((r) => r.source_id);
}

/**
 * " (v3.4.6)" for FlareSolverr, whose versions are numbers; the desktop helper's is `uchiyomi-desktop-0.44.0`,
 * deliberately not semver-shaped (desktop/src/solver/server.ts), and read "vuchiyomi-desktop-…" with the v.
 */
export function solverVersionLabel(version?: string): string {
  if (!version) return '';
  return ` (${/^\d/.test(version) ? 'v' : ''}${version})`;
}

export async function solverHealth(): Promise<HealthCheck> {
  const ping = await solverPing();
  const blaming = await solverBlaming();

  const url = solverUrl();
  if (!ping.ok) {
    return {
      id: 'solver',
      title: 'Cloudflare solver',
      status: blaming.length ? 'problem' : 'warn',
      // ⚠️ Desktop: the helper's address carries its access token as the path, so it is named, never
      // printed (a screenshot in a bug report would hand the token to anyone who reads it).
      summary: forDesktop(`Not answering at ${url}`, 'Not answering') + (ping.error ? ` (${ping.error})` : ''),
      note: forDesktop(
        'Sources on Cloudflare-protected sites cannot work without it. Check the container is running '
          + 'and that FLARESOLVERR_URL points at it.',
        "Sources on Cloudflare-protected sites cannot work without it. Uchiyomi's built-in Cloudflare helper "
          + "isn't answering; quit and reopen Uchiyomi.",
      ),
      // The solver itself is the first item, not just the sources blaming it. Every other check on this page
      // holds "no items means ok", and a solver that is simply absent has nothing to list -- so without this
      // it would report a warning with an empty body, which reads as a page bug rather than a finding.
      items: [
        { title: forDesktop(url, 'Cloudflare helper'), detail: ping.error ? `not answering (${ping.error})` : 'not answering' },
        // No "Reset solver sessions" chip while it is down. The reset clears what THIS process remembers
        // about a solver that is answering; on one that is not, it would be a button that reports success
        // and changes nothing, which is worse than no button. The repair's solver step refuses for the
        // same reason.
        ...blaming.map((id) => ({ title: id, sourceId: id, detail: 'failing, and its recorded error names the solver' })),
      ],
    };
  }
  // ⚠️ Advisory only, and it must stay that way: `latestSolverVersion` answers null when GitHub is
  // unreachable, rate-limited or unrecognisable, and `isBehind` answers false whenever either side cannot be
  // parsed. Being out of date is worth SAYING; it is never worth turning a working solver into a warning,
  // and a health page must not be able to fail because github.com is having an afternoon.
  const latest = await latestSolverVersion();
  const behind = isBehind(ping.version, latest);
  return {
    id: 'solver',
    title: 'Cloudflare solver',
    status: blaming.length ? 'warn' : 'ok',
    summary: blaming.length
      ? `Answering, but ${blaming.length} source${blaming.length === 1 ? '' : 's'} recently failed inside it`
      : `Ready${solverVersionLabel(ping.version)}${behind ? ` — v${latest} is available` : ''}`,
    note: blaming.length
      ? forDesktop(
        'It responds, but it has been failing mid-request. Chrome needs far more than Docker\'s default '
        + '64 MB of shared memory (set shm_size: 1gb), and the solver leaks memory, so it wants a restart.',
        'It responds, but it has been failing mid-request; quit and reopen Uchiyomi to restart it.',
      )
      : undefined,
    items: [
      // `info`: this row and `status: 'ok'` coexist on purpose, see the note above. Without the flag it
      // contradicted the page's "no items means ok" rule, and the health test could only hold that rule
      // because no test machine ever had an out-of-date solver.
      ...(behind
        ? [{ title: `v${ping.version} → v${latest}`, detail: 'a newer solver is out; Cloudflare changes often break older ones', info: true }]
        : []),
      // The solver answers, so the stale part is what this process remembers about it: a cf_clearance
      // cookie Cloudflare has since rotated, and origins stamped unsolvable. That is what the chip clears,
      // along with this source's cooldown. It cannot restart the container -- Uchiyomi has no access to
      // other containers, by design -- so the note above still names the restart as the operator's job.
      ...blaming.map((id) => ({
        title: id,
        sourceId: id,
        detail: 'its last failure happened inside the solver',
        actions: ['solver_reset' as const],
      })),
    ],
  };
}

/** The repo releases are published from. A constant, not a setting: a "check for updates" pointed at an
 *  operator-supplied url is an arbitrary outbound request wearing a friendly name. */
const APP_REPO = 'AngeloSha/uchiyomi';

/**
 * Is there a newer Uchiyomi?
 *
 * ⚠️ ADVISORY ONLY, exactly like the solver's version row: `status` is always `ok`, because being a version
 * behind is not a fault and an update notice that turns the admin page amber trains people to ignore it.
 * The same rule is written at solverHealth().
 *
 * ⚠️ THIS SENDS NOTHING ABOUT THIS INSTALL. It is a GET of a public GitHub releases URL; GitHub learns an
 * IP, which is unavoidable for any update check, and the answer is compared locally. The opt-in install
 * count is a separate switch to a separate host -- see lib/installPing.ts for why they must never merge.
 *
 * Off is genuinely off: `update_check = false` makes no request at all, and says so rather than pretending
 * to be up to date.
 */
async function updateCheck(): Promise<HealthCheck> {
  const running = appVersion();
  const row = await one<{ on: boolean }>('SELECT update_check AS on FROM server_settings WHERE id = 1')
    .catch(() => null);
  const on = row?.on !== false;

  if (!on) {
    return {
      id: 'update', title: 'Version', status: 'ok',
      summary: running ? `Running v${running} — update checks are off` : 'Update checks are off',
      note: 'Nothing is requested while this is off. Turn it on under Settings → Server to be told when a release is out.',
      items: [],
    };
  }

  const latest = await latestRelease(APP_REPO);
  const behind = isBehind(running, latest);
  return {
    id: 'update', title: 'Version', status: 'ok',
    summary: !running ? 'Could not read the running version'
      : behind ? `Running v${running} — ${latest} is available`
      : latest ? `Running v${running} — up to date`
      : `Running v${running}`,
    // ⚠️ Said out loud, because "up to date" and "we could not ask" look identical on a page and only one of
    // them is a reason to relax. GitHub being unreachable or rate-limited is a normal Tuesday.
    note: latest ? undefined : 'GitHub could not be reached just now, so this is not a clean bill of health.',
    // `info` for the same reason as the solver's version row: advisory, and never the reason the page is amber.
    items: behind
      ? [{ title: `v${running} → ${latest}`, detail: 'a newer release is published; see the changelog before upgrading', info: true }]
      : [],
  };
}

/**
 * Enabled extension sources that are NOT registered because SUWAYOMI_MAX_SOURCES was reached.
 *
 * The cap is the right default -- search fans out to every registered source -- but hitting it used to be
 * one console.warn at boot and nothing else: the panel counted the enabled sources, search reached fewer,
 * and the difference was nowhere. Only runs when there is an engine; without one the check would be a
 * permanent green line about a limit that cannot be reached.
 */
async function extensionCap(): Promise<HealthCheck> {
  const load = lastSuwayomiLoad();
  const skipped = load?.skipped ?? 0;
  const cap = env.SUWAYOMI_MAX_SOURCES;
  return {
    id: 'extension-cap',
    title: 'Extension source limit',
    status: skipped ? 'warn' : 'ok',
    // "0 of 25" is a measurement only when the engine answered; after a failed load it is the absence of
    // one, and the cap warning would silently vanish for the length of an outage.
    summary: skipped
      ? `${skipped} enabled source${skipped === 1 ? ' is' : 's are'} not registered — over the limit of ${cap}`
      : load && !load.reachable
        ? `engine unreachable at the last load; nothing is registered (limit ${cap})`
        : `${load?.registered ?? 0} of ${cap} extension sources in use`,
    note: forDesktop(
      'Every registered source is searched at once, which is why there is a limit. Hiding the languages you do not read ' +
        'is the cheap way under it; SUWAYOMI_MAX_SOURCES raises it.',
      'Every registered source is searched at once, which is why there is a limit. Hide the languages you don\'t read ' +
        'to get under it.',
    ),
    items: skipped
      ? [forDesktop(
        { title: 'SUWAYOMI_MAX_SOURCES', detail: `${skipped} enabled sources not registered; the limit is ${cap}. Hide languages you do not read, or raise the limit.` },
        { title: 'Source limit', detail: `${skipped} enabled sources not registered; the limit is ${cap}. Hide the languages you don't read.` },
      )]
      : [],
  };
}

/**
 * Folders the last library scan could not index (#109).
 *
 * The scan now steps over a folder it cannot index instead of stopping (lib/library.ts persistScan), which
 * keeps the rest of the library current -- and would leave that one folder's chapters silently missing, on
 * disk and absent from the series page, if nothing said so. The error is the scanner's own, so the admin
 * has something to act on (a file to replace, a permission to fix) rather than a symptom.
 *
 * v0.48.2: and what the WALK left out, before any folder reached the database -- a folder it could not read,
 * entries it could not check, the folder cap. v0.48.0 reported the database's refusals only, so a download
 * the walk dropped left this check green while the chapters stayed missing.
 */
async function libraryScan(): Promise<HealthCheck> {
  const r = lastScanReport();
  const where = await rootsNote();
  if (!r) {
    return { id: 'library-scan', title: 'Library scan', status: 'ok', summary: 'no scan has run since the server started', note: where, items: [] };
  }
  const n = r.skippedTotal;
  const w = r.walkProblems;
  const s = (k: number, one: string, many: string) => (k === 1 ? one : many);
  const parts = [
    ...(n ? [`could not index ${n} folder${s(n, '', 's')}`] : []),
    ...(w ? [`left out ${w} folder${s(w, '', 's')} or file${s(w, '', 's')} it could not read`] : []),
  ];
  const label = (root: 'library' | 'downloads', folder: string) =>
    `${root === 'downloads' ? 'Downloads' : 'Library'} / ${folder || '(the folder itself)'}`;
  const notes = [
    'Runs after every download, sweep and manual scan. Every other folder is still indexed when one fails.',
    ...(r.sharedIds
      ? [`${r.sharedIds} folder${s(r.sharedIds, ' shares', 's share')} a disk id with another folder (Unraid user shares and some network drives report ids like this). All of them were scanned; before v0.48.2 each one was skipped, with everything in it.`]
      : []),
    ...(r.removed ? [`${r.removed} folder${s(r.removed, ' belongs', 's belong')} to series someone removed, and ${s(r.removed, 'was', 'were')} left alone; Admin → Removed puts a series back.`] : []),
    ...(where ? [where] : []),
  ];
  return {
    id: 'library-scan',
    title: 'Library scan',
    status: n || w ? 'problem' : 'ok',
    summary: parts.length
      ? `the last scan ${parts.join(' and ')}; ${n + w === 1 ? 'its' : 'their'} chapters are on disk but not in the library`
      : `the last scan indexed ${r.series} series, ${r.books} chapters`,
    note: notes.join(' '),
    items: [
      ...r.skipped.map((k) => ({ title: label(k.root, k.folder), detail: k.error })),
      ...r.walk.map((i) => ({
        title: label(i.root, i.folder),
        detail: WALK_WORDS[i.reason](i.detail),
        ...(QUIET_WALK.has(i.reason) ? { info: true } : {}),
      })),
    ].slice(0, MAX_ITEMS),
  };
}

const WALK_WORDS: Record<WalkReason, (detail: string) => string> = {
  unreadable: (d) => `could not be read (${d}), so nothing in it is in the library`,
  unchecked: (d) => d,
  stat: (d) => `could not be checked (${d}), so nothing in it is in the library`,
  loop: (d) => `not scanned twice: ${d}`,
  depth: (d) => d,
  limit: (d) => d,
};

/** Which filesystem each root is on: the first thing anyone needs to know about a folder that goes missing. */
async function rootsNote(): Promise<string | undefined> {
  const [lib, dl] = await Promise.all([fsTypeOf(LIBRARY_ROOT), fsTypeOf(DL_ROOT)]);
  const parts = [...(lib ? [`Library: ${lib}`] : []), ...(dl ? [`Downloads: ${dl}`] : [])];
  return parts.length ? `${parts.join(' · ')}.` : undefined;
}

/**
 * Every chapter file in the downloads folder that is not in the library (#109), with the reason when the scan
 * knows one. Compares the disk with the database directly (lib/downloadCensus.ts), so it does not depend on the
 * scanner having noticed what it dropped -- which is exactly what it failed to do for #109, twice.
 */
async function downloadsMissing(): Promise<HealthCheck> {
  const base = { id: 'downloads-missing', title: 'Downloads missing from the library' };
  const c = await downloadCensus().catch((e) => e as Error);
  if (c instanceof Error) {
    return { ...base, status: 'warn', summary: `could not be checked just now: ${String(c.message).slice(0, 160)}`, items: [] };
  }
  const n = c.missingFiles;
  const s = (k: number, one: string, many: string) => (k === 1 ? one : many);
  const notes = [
    `Every chapter file under ${c.root}${c.fsType ? ` (${c.fsType})` : ''}, against the library.`,
    ...(c.pending ? [`${c.pending} landed after the last scan began and ${s(c.pending, 'waits', 'wait')} for the next one.`] : []),
    ...(c.removed ? [`${c.removed} belong${s(c.removed, 's', '')} to series someone removed (Admin → Removed puts one back).`] : []),
    ...(c.truncated ? ['The folder is too big to check completely; the counts are a floor.'] : []),
  ];
  return {
    ...base,
    status: n || c.unreadable.length ? 'problem' : 'ok',
    summary: n
      ? `${n} downloaded chapter${s(n, '', 's')} in ${c.missing.length} folder${s(c.missing.length, '', 's')} ${s(n, 'is', 'are')} on disk but not in the library`
      : c.unreadable.length
        ? `${c.unreadable.length} folder${s(c.unreadable.length, '', 's')} in the downloads could not be read`
        : `all ${c.files} chapter file${s(c.files, '', 's')} in the downloads folder are in the library`,
    note: notes.join(' '),
    items: [
      ...c.unreadable.map((u) => ({ title: `Downloads / ${u.folder || '(the folder itself)'}`, detail: `could not be read (${u.error})` })),
      ...c.missing.map((m) => ({
        title: `Downloads / ${m.folder || '(the folder itself)'}`,
        detail: `${m.files.length} chapter${s(m.files.length, '', 's')} not in the library (${m.files.slice(0, 3).join(', ')}${m.files.length > 3 ? ', …' : ''})${m.reason ? `: ${m.reason}` : ''}`,
        ...(m.seriesId ? { seriesId: m.seriesId } : {}),
      })),
    ].slice(0, MAX_ITEMS),
  };
}

// ---- report -----------------------------------------------------------------

export async function runHealthChecks(): Promise<HealthReport> {
  // The two checks that reason about chapter NUMBERS share one read of what every series holds, because
  // that read applies the override and tombstone rules per series and is the expensive part of this page.
  const held = await heldBySeries();
  // Independent read-only queries: run them together rather than serially.
  const checks = await Promise.all([
    chapterGaps(held),
    shortChapters(),
    outlierChapters(held),
    duplicateSeries(),
    sourceTrouble(),
    chapterFailures(),
    frozenSeries(),
    solverHealth(),
    updateCheck(),
    libraryScan(),
    downloadsMissing(),
    ...(suwayomiConfigured() ? [extensionCap()] : []),
  ]);
  // worst first, so the page opens on whatever needs attention
  const rank: Record<HealthStatus, number> = { problem: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => rank[a.status] - rank[b.status]);
  return { generatedAt: new Date().toISOString(), checks };
}
