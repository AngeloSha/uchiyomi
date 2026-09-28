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
import { solverPingShared, solverUrl } from './sources/flaresolverr';
import { getSource } from './sources';
import { suwayomiConfigured } from './sources/suwayomi/client';
import { lastSuwayomiLoad } from './sources/suwayomi/register';
import { engineState, type EngineState } from './sources/suwayomi/engineState';
import { extensionEngineCheck } from './engineHealth';
import { env } from '../env';
import { gapsOf } from './fill';
import { CHAPTER_RETRY_CAP } from './updater';
import { diagnose, currentError, type DiagnosisCode } from './sourceDiagnosis';
import { openFailures, stageLines, type Stage, type StageLine, type Stages } from './sourceEvidence';
import { haveNumbers } from './libraryNumbers';
import { DL_ROOT, LIBRARY_ROOT, lastScanReport, QUIET_WALK, type WalkIssue, type WalkReason } from './library';
import { countsAsMissing, downloadCensus, fsTypeOf, type Census } from './downloadCensus';
import { applyIgnores, keepIgnoresAlive, loadIgnores, noIgnores, type Finding, type IgnorableCheck, type IgnoreCtx } from './healthIgnore';
import { chapterFileRel } from './downloader';
import { forDesktop, isDesktop } from './desktop';
import { archiveHoles, archiveTakes, type ArchiveHoles } from './archiveBoundaries';
import { renumberRunning, type NumberingNote } from './numbering';
import { detailOf, joined, noteOf, own, say, saidOf, summaryOf, type Part, type Said } from './said';

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
  | 'fix_short' | 'confirm_short' | 'delete' | 'fill' | 'retry' | 'test' | 'unblock' | 'disable' | 'merge' | 'solver_reset'
  | 'ignore' | 'unignore'
  // #72: point the extension engine's own Cloudflare helper at Uchiyomi's (POST /api/admin/extensions/solver).
  | 'engine_solver'
  // #116, the numbering check: `renumber` shows the file-by-file plan of the series' pending (or proposed)
  // numbering change and applies it on a confirmation (GET, then POST {mode, confirm: true}, to
  // /api/admin/series/{id}/numbering); `keep_numbers` records the admin's choice of the source's own numbers
  // (POST {mode: 'source'}) -- nothing renamed for a proposal, the undo's plan for a series already renumbered.
  | 'renumber' | 'keep_numbers';

export interface HealthItem {
  seriesId?: string;
  /** Every series this item is about. The duplicates check needs both, so a merge can act on them. */
  seriesIds?: string[];
  titles?: string[];
  title: string;
  detail: string;
  /**
   * v0.49.1: `detail` as codes the web words in the reader's language (lib/said.ts), and `title` where the server
   * wrote it in English rather than naming something ("Cloudflare helper", "Downloads / (the folder itself)").
   * Absent: shown as sent -- a folder's own error, a row from before v0.49.1.
   */
  detailSaid?: Said[];
  titleSaid?: Said;
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
  /**
   * What an Ignore of this finding is recorded under (lib/healthIgnore.ts): stable across runs, per check --
   * `series:ID`, `source:ID`, `folder:PATH`, `anilist:ID`. Absent: this finding cannot be ignored.
   */
  key?: string;
  /** An admin chose to stop being told about this, and when. The item is then `info`. */
  ignored?: { at: string; by: string | null };
  /**
   * v0.49.0: what the last attempt at this finding found, as data the page renders in the reader's language
   * -- "tried today 03:12: 3 sources asked, 2 answered, no longer copy", "still missing 6-8: no other source
   * lists them", "failing since 12 Sep, reset for another try". The gap `detail` no longer carries the
   * repair's conclusion as an English suffix; it is here. `fixed` stays, for what greys the row.
   */
  outcome?: HealthOutcome;
  /**
   * v0.49.0: what an action on this row will and will not do, said BEFORE it is pressed -- "updates are
   * paused: Fill now fetches these once", "the source is cooling down until 14:20: Retry now resets the
   * count but cannot ask it yet".
   */
  caveats?: HealthCaveat[];

  // ---- #115 (v0.49.0), Source health rows only. Kept together and apart from the fields other workstreams add.
  /** What each stage was last seen doing (search, chapters, pages, images), from lib/sourceEvidence.ts. */
  evidence?: StageLine[];
  /** The last deliberate live check: the Test button ('test') or the daily check ('sweep'). */
  tested?: { at: string; by: 'test' | 'sweep' | null; state: 'pass' | 'fail' | 'inconclusive' | null; stage: Stage | null };
  /**
   * The verdict behind the row, admin half included: one verdict on screen, from the stored evidence. `reason` is
   * worded by its `code`; `fixSaid` (v0.49.1) is the fix's own code (lib/sourceDiagnosis.ts FixCode).
   */
  diagnosis?: { code: DiagnosisCode; reason: string; fix: string; fixSaid?: Said };
  /** How many series use the source (primaries and followers). */
  series?: number;
}

/**
 * The last attempt at a finding, per check. Every field comes from a stored row the repair wrote (gaps_result,
 * lib_books.short_result, chapter_failures), so it survives a reload and a restart.
 */
export type HealthOutcome =
  | {
      kind: 'gaps';
      /** When the repair concluded, not when it stamped the series (that is before the search). */
      at: string | null;
      /**
       * huntCandidates' verdict, as lib/repair.ts stores it: followed | no_candidate | cap | off | cooldown | listed |
       * posting_order (#116: the series is numbered by posting order, and no other source can fill it). Or
       * `archiving` (#117), from no search at all: every missing number is listed below the boundary of the series'
       * slow archive, which is fetching them (not paused). `at` is null then, and the counts are zero.
       */
      why: string | null;
      followed: string | null;
      coverage: number | null;
      /** Gap chapters that landed, and every chapter the fetch landed. */
      fetched: number;
      landed: number;
      /** Gap chapters a followed source lists, left for the sweep. */
      sweep: number;
      capped: number;
      /** Ranges nobody lists, as "11-13". */
      unfillable: string[];
      /** Gap numbers the search was about. */
      scanned: number;
    }
  | {
      kind: 'short';
      at: string | null;
      /**
       * The repair's verdict (replaced | confirmed | no_longer_copy | source_silent | hunt_cooldown | no_searches |
       * hunt_off | download_failed), `partial` for a chapter saved with placeholder pages, or `confirmed_by_admin`.
       */
      why: string;
      asked?: number;
      answered?: number;
      best?: number;
      hunt?: string;
      /** For `partial`: how many pages are placeholders. */
      missing?: number;
      by?: string | null;
    }
  | {
      kind: 'failures';
      /** The oldest first failure among the source's chapters, and the latest attempt. */
      firstAt: string;
      lastAt: string;
      attempts: number;
      /** Every row is back at zero attempts: a reset is waiting for the sweep (or a re-check) to try them. */
      resetPending: boolean;
    };

/**
 * What an action on a row will not be able to do, and why. `until` for a cooldown. `archiving` (#117): the gap is
 * being fetched by the series' slow archive, and Fill now fetches it at once, at normal pace, instead.
 */
export interface HealthCaveat {
  action: HealthAction;
  code: 'updates_paused' | 'source_cooling_down' | 'source_off' | 'archiving';
  until?: string;
}

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthStatus;
  /** one-line human summary, already pluralised */
  summary: string;
  /** what this check cannot see — shown so nobody reads more into a green result than it deserves */
  note?: string;
  /** v0.49.1: `summary` and `note` as codes the web words in the reader's language (lib/said.ts). */
  summarySaid?: Said[];
  noteSaid?: Said[];
  items: HealthItem[];
  /** #115, 'sources' only: how long one Test may take (the smoke test's wall plus the homepage probe). */
  testMs?: number;
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

/** A summary's "; 2 ignored": the findings an admin chose to stop being told about (lib/healthIgnore.ts). */
const ignoredPart = (n: number): Part | null => (n ? say('ignored', { n }) : null);
/** A note's " 3 more not shown.": the rows past the slice. */
const hiddenPart = (n: number): Part | null => (n > 0 ? joined('sentence', say('hidden', { n })) : null);

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
  landed?: number;
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
  /** Automatic updates on: off, nothing but Fill now will ever fetch its gaps (a caveat on that row). */
  autoUpdate: boolean;
  /** What the series' slow archive (#117) is going to fetch of its holes, and whether it is paused; null for none. */
  archive: ArchiveHoles | null;
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
  const series = await q<{ id: string; title: string; gaps_checked_at: string | null; gaps_result: StoredGaps | null; auto_update: boolean }>(
    `SELECT ls.id, ls.title, ls.gaps_checked_at, ls.gaps_result, ls.auto_update
       FROM lib_series ls WHERE ${visibleToAll('ls')} ORDER BY ls.title`,
  );
  // One read for every archive: a handful of rows, where a per-series query would double the page's cost.
  const archiving = await archiveHoles(undefined, CHAPTER_RETRY_CAP);
  const out: HeldSeries[] = [];
  for (const s of series) {
    out.push({
      id: s.id,
      title: s.title,
      numbers: await haveNumbers(s.id),
      gapsCheckedAt: s.gaps_checked_at,
      gapsResult: s.gaps_result ?? null,
      autoUpdate: s.auto_update !== false,
      archive: archiving.get(s.id) ?? null,
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
    // #116: another site numbers these posts its own way, so nothing is searched for (lib/sourceHunt.ts).
    case 'posting_order': return 'this series is numbered by posting order, so no other source is searched';
    default: return 'checked';
  }
}

/**
 * The repair's verdicts that mean "asked, and the answer was no": conditions another run tonight cannot change on
 * its own -- nobody else lists the chapters, the series already follows as many sources as it may, searching is
 * switched off, or (#116) the series is numbered by posting order, which no other site's numbers line up with.
 */
const ANSWERED = new Set(['no_candidate', 'cap', 'off', 'posting_order']);

/**
 * Missing runs of chapter numbers: either the source never had them, or a download failed.
 *
 * Computed by `gapsOf`, the same function the fill dialog uses, and nothing else. There used to be a second
 * implementation here in SQL that filtered `WHERE number > 0`, so on a series shaped `0, 93..141` this page
 * said "no gaps" while "find missing chapters" offered to fetch 92 -- both green in their own tests. Two
 * definitions of one fact is how that happens; there is now one. The numbers themselves come from
 * `haveNumbers` for the same reason (see heldBySeries above).
 */
async function chapterGaps(held: HeldSeries[], ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = held
    .map((s) => {
      const gaps = gapsOf(s.numbers);
      const numbers: number[] = [];
      for (const g of gaps) for (let n = g.lo; n <= g.hi && numbers.length < MAX_NUMBERS; n++) numbers.push(n);
      return { s, gaps, missing: gaps.reduce((n, g) => n + g.count, 0), numbers };
    })
    .filter((r) => r.missing > 0)
    .sort((a, b) => b.missing - a.missing);

  const items: Array<HealthItem & { members?: string[] }> = rows.map((r) => {
    const ranges = rangeText(r.gaps);
    const g = r.s.gapsResult;
    // ⚠️ When the CONCLUSION was reached (gaps_result.at), not when the series was stamped: the stamp is
    // written before the search (lib/repair.ts stepGaps), so while a run is on this series the stamp is
    // new and the stored result is still the previous run's -- and greyed "fresh" on the stamp, last
    // week's answer read as tonight's. The stamp is the fallback for a result that predates `at`.
    const checked = g?.at && Number.isFinite(Date.parse(g.at)) ? new Date(g.at)
      : r.s.gapsCheckedAt ? new Date(r.s.gapsCheckedAt) : null;
    const fresh = !!checked && Date.now() - checked.getTime() < GAPS_FRESH_MS;
    // A conclusion is about the library as it was when the search ran. One more chapter has landed since,
    // so the hole may have moved: ask again rather than keep showing last night's answer.
    const unchanged = !!g && g.have_count === r.s.numbers.length;
    // "Asked, and the answer was no." A cooldown is NOT in the list (ANSWERED), deliberately and for the same
    // reason the repair will not confirm a short chapter on one: not having asked is not an answer.
    const answered = !!g && ANSWERED.has(String(g.why));
    // Every missing chapter is already listed on a source we follow, so this is the chapter sweep's job.
    // ⚠️ Still only while the conclusion is fresh: a hole the sweep was going to fetch a fortnight ago and
    // still has not is a finding again, not a promise.
    const sweepsIt = !!g && typeof g.sweep === 'number' && r.missing > 0 && g.sweep >= r.missing;
    // #117: the series' slow archive is fetching the numbers listed below its boundary a few an hour, so a hole it
    // takes whole is its work in progress, not a finding -- and not a search, which is why the repair's gap step
    // leaves such a series alone (lib/repair.ts stepGaps). Its outcome says so in place of whatever an older search
    // concluded. Only what it will really fetch (lib/archiveBoundaries.ts archiveHoles): a hole reaching above the
    // boundary, or holding a number the source does not list, stays a finding -- the sweep owns the part above, and
    // nothing fetches the unlisted one. So does every hole of a PAUSED archive: nothing is fetching those now, and
    // "being archived" over them for weeks hid them. Reintroduce by dropping `archived`: "a gap below an active
    // archive's boundary is the archive's" in health.int.test.ts finds a live finding; by counting every number
    // below the boundary, or a paused archive, its "not listed" and "paused" assertions read archiving.
    const takes = r.gaps.map((x) => archiveTakes(r.s.archive ?? undefined, x.lo, x.hi));
    const archived = !!r.s.archive && !r.s.archive.paused && r.gaps.every((x, i) => takes[i] === x.count);
    const info = archived || (fresh && ((answered && unchanged) || sweepsIt));
    const what = g ? gapConclusion(g) : null;
    // What Fill now will do that the row would not otherwise say: fetch at once, at normal pace, numbers the
    // archive was going to fetch slowly (it passes ignoreArchiveBoundary, lib/repair.ts), and fetch a paused
    // series' gaps, which nothing else ever will.
    const caveats: HealthCaveat[] = [
      ...(!r.s.autoUpdate ? [{ action: 'fill' as const, code: 'updates_paused' as const }] : []),
      ...(takes.some((n) => n > 0) ? [{ action: 'fill' as const, code: 'archiving' as const }] : []),
    ];
    return {
      seriesId: r.s.id,
      title: r.s.title,
      // The conclusion is `outcome` now, rendered by the page in the reader's language; the detail is the
      // finding alone.
      ...detailOf([say('gaps.detail', { n: r.missing, ranges: ranges.length > 90 ? ranges.slice(0, 90) + '…' : ranges })]),
      numbers: r.numbers,
      actions: ['fill'] as HealthAction[],
      ...(archived ? {
        outcome: {
          kind: 'gaps' as const, at: null, why: 'archiving', followed: null, coverage: null,
          fetched: 0, landed: 0, sweep: 0, capped: 0, unfillable: [], scanned: 0,
        },
      } : g ? {
        outcome: {
          kind: 'gaps' as const,
          at: checked ? checked.toISOString() : null,
          why: g.why ?? null,
          followed: g.followed ?? null,
          coverage: typeof g.coverage === 'number' ? g.coverage : null,
          fetched: Number(g.fetched) || 0,
          landed: Number(g.landed) || 0,
          sweep: Number(g.sweep) || 0,
          capped: Number(g.capped) || 0,
          unfillable: Array.isArray(g.unfillable) ? g.unfillable.map(String) : [],
          scanned: Number(g.scanned) || 0,
        },
      } : {}),
      // Fill now works on a paused series (it names the series, lib/repair.ts), but nothing else will ever
      // fetch its gaps: the row says so before anyone presses. Reintroduce by dropping it: "a paused series'
      // gap carries the updates_paused caveat" in health.int.test.ts fails.
      ...(caveats.length ? { caveats } : {}),
      // Ignored while every missing run lies inside a run that was missing when it was ignored: a gap that
      // shrinks (or splits) stays quiet, a newly missing chapter is a new finding. As runs, not one entry per
      // number: a single chapter numbered 9001 by mistake is a gap of nine thousand (lib/healthIgnore.ts).
      key: `series:${r.s.id}`,
      members: r.gaps.map((g) => `${g.lo}-${g.hi}`),
      // An older search's answer is not what is happening to an archived hole: the outcome above is.
      ...(checked && what && !archived ? { fixed: { at: checked.toISOString(), what } } : {}),
      ...(info ? { info: true } : {}),
    };
  });
  const ignored = applyIgnores('chapter-gaps', items, ctx);
  const { items: shown, hidden } = truncate(items);
  const live = items.filter((i) => !i.info).length;
  const archiving = items.filter((i) => i.info && !i.ignored && i.outcome?.kind === 'gaps' && i.outcome.why === 'archiving').length;
  const quiet = items.length - live - ignored - archiving;
  return {
    id: 'chapter-gaps',
    title: 'Chapter gaps',
    status: verdict(items),
    ...summaryOf([
      live ? say('gaps.live', { n: live }) : say('gaps.none'),
      quiet > 0 && say('gaps.quiet', { n: quiet }),
      archiving > 0 && say('gaps.archiving', { n: archiving }),
      ignoredPart(ignored),
    ]),
    ...noteOf([say('gaps.note'), hiddenPart(hidden)]),
    items: shown,
  };
}

/** How long a series numbered by posting order on its own is listed (for reference) after the change. */
const NUMBERED_SHOWN_MS = 14 * DAY_MS;

/**
 * Chapter numbering (#116): series whose chapters wait for a numbering change an admin has to see first, and the
 * ones Uchiyomi numbered by posting order on its own lately.
 *
 * A series in a library is never renamed unattended (the owner's rule for v0.49.0, lib/numbering.ts): the detector
 * finding a source that gives many different posts one number marks it `numbering_pending`, and from then on it
 * downloads nothing until someone reviews the plan -- which, before this check, only its own series page said. So
 * each waiting series is a finding here, by name, with `renumber` (the plan, then its confirmation) and, for a
 * change nobody asked for, `keep_numbers` (the source's numbers, as a choice the detector never undoes). A renumber
 * a crash interrupted and the next check could not finish holds the series the same way, and is a finding with no
 * key to press: the check that finishes it is the way out. Numbered automatically in the last two weeks and a
 * detector's hint on a source-numbered series are listed too; a strong verdict an admin chose to ignore, for
 * reference. Absent when no series has anything to say about its numbering.
 */
async function numberingCheck(): Promise<HealthCheck | null> {
  const rows = await q<{
    id: string; title: string; source_name: string | null; source_id: string | null;
    numbering: 'source' | 'posting_order' | null; numbering_by: 'auto' | 'manual' | null; numbering_source: string | null;
    numbering_pending: 'posting_order' | 'source' | 'remap' | null; numbering_note: NumberingNote | null;
    journal: boolean; changed_at: string | null;
  }>(
    `SELECT ls.id, ls.title, ls.source AS source_name, ls.source_id, ls.numbering, ls.numbering_by, ls.numbering_source,
            ls.numbering_pending, ls.numbering_note, (ls.renumber_plan IS NOT NULL) AS journal, ls.numbering_changed_at AS changed_at
       FROM lib_series ls
      WHERE ${visibleToAll('ls')}
        AND (ls.numbering IS NOT NULL OR ls.numbering_pending IS NOT NULL OR ls.renumber_plan IS NOT NULL
             OR ls.numbering_note->>'verdict' IN ('strong', 'hint'))
      ORDER BY ls.title`,
  ).catch(() => []);
  if (!rows.length) return null;
  const now = Date.now();
  const items: HealthItem[] = [];
  for (const r of rows) {
    const note = r.numbering_note;
    const src = r.numbering_source ?? note?.source ?? r.source_id;
    // The source as a person knows it: the loaded adapter's name, else the name the series was added under when
    // this is its own source (an extension the engine is not serving right now), else the id. Null when there is no
    // source to name at all: the English says "Its source", the web its own words for it.
    const name = (src && getSource(src)?.name) || (src && src === r.source_id ? r.source_name : null) || src || null;
    const shared = note && note.posts
      ? note.biggest
        ? say('numbering.sharedMost', { name, extras: note.extras, posts: note.posts, most: note.biggest.posts, number: note.biggest.number })
        : say('numbering.shared', { name, extras: note.extras, posts: note.posts })
      : say('numbering.sharedMany', { name });
    const base = { seriesId: r.id, title: r.title, ...(src ? { sourceId: src } : {}) };
    const held = joined('sentence', say('numbering.held'));
    const auto = r.numbering_by !== 'manual';
    let item: HealthItem | null = null;
    if (r.journal && renumberRunning(r.id)) {
      // Its journal is on the row from the first rename to the commit, and Health read every journal as a crash's
      // (v0.49.1): "interrupted" while the confirmed renumber was still applying. A greyed line while it runs: nothing
      // waits for anyone, and it ends by itself.
      // Reintroduce by answering "interrupted" for it: "while a confirmed renumber applies" in numbering.int.test.ts.
      item = { ...base, detail: `Its confirmed renumber is being applied now. ${held.text}`, info: true };
    } else if (r.journal) {
      item = { ...base, ...detailOf([say('numbering.interrupted'), held]) };
    } else if (r.numbering_pending === 'remap') {
      item = { ...base, ...detailOf([say('numbering.remap', { name }), held]), actions: ['renumber'] };
    } else if (r.numbering_pending === 'posting_order') {
      item = auto
        ? { ...base, ...detailOf([shared, say('numbering.reviewWaits'), held]), actions: ['renumber', 'keep_numbers'] }
        : { ...base, ...detailOf([say('numbering.askedWaits'), held]), actions: ['renumber'] };
    } else if (r.numbering_pending === 'source') {
      item = { ...base, ...detailOf([say('numbering.sourceWaits', { name }), held]), actions: ['renumber'] };
    } else if (r.numbering === 'posting_order' && auto) {
      const at = r.changed_at ? Date.parse(r.changed_at) : NaN;
      if (Number.isFinite(at) && now - at < NUMBERED_SHOWN_MS) {
        item = { ...base, ...detailOf([shared, say('numbering.since', { at: new Date(at).toISOString() })]), actions: ['keep_numbers'], info: true };
      }
    } else if (r.numbering !== 'posting_order' && note?.verdict === 'hint' && auto) {
      item = { ...base, ...detailOf([shared, say('numbering.hint')]), actions: ['renumber', 'keep_numbers'] };
    } else if (r.numbering === 'source' && !auto && note?.verdict === 'strong') {
      item = { ...base, ...detailOf([shared, say('numbering.kept')]), actions: ['renumber'], info: true };
    }
    if (item) items.push(item);
  }
  if (!items.length) return null;
  const live = items.filter((i) => !i.info).length;
  const numbered = items.filter((i) => i.info && i.actions?.includes('keep_numbers')).length;
  const { items: shown, hidden } = truncate(items);
  return {
    id: 'numbering',
    title: 'Chapter numbering',
    status: verdict(items),
    ...summaryOf([
      live ? say('numbering.live', { n: live }) : say('numbering.none'),
      numbered > 0 && say('numbering.lately', { n: numbered }),
    ]),
    ...noteOf([say('numbering.note'), hiddenPart(hidden)]),
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
    root: string | null; file: string; short_confirmed_at: string | null; missing_pages: number[] | null;
    short_result: { at?: string; why?: string; asked?: number; answered?: number; best?: number; hunt?: string; by?: string | null } | null;
  }>(
    `SELECT b.id, b.series_id, ls.title, ls.folder, b.number::float8 AS number, b.pages, b.root, b.file,
            b.short_confirmed_at, b.missing_pages, b.short_result
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
    // Saved with placeholder pages (lib/partial.ts): the chapter sweep re-fetches those, up to 10 a night,
    // and the repair's short step skips the chapter (`missing_pages IS NULL`), so "Fix" on it did nothing at
    // all. Offered "It's fine" only, and the outcome says why. Reintroduce by offering fix_short again:
    // "a chapter with placeholder pages is not offered Fix" in health.int.test.ts fails.
    const partial = Array.isArray(r.missing_pages) && r.missing_pages.length > 0;
    const res = r.short_result;
    const byAdmin = res?.why === 'confirmed_by_admin';
    const outcome: HealthOutcome | null = partial
      ? { kind: 'short', at: null, why: 'partial', missing: r.missing_pages!.length }
      : res?.why
      ? {
          kind: 'short', at: res.at ?? null, why: String(res.why),
          ...(typeof res.asked === 'number' ? { asked: res.asked } : {}),
          ...(typeof res.answered === 'number' ? { answered: res.answered } : {}),
          ...(typeof res.best === 'number' ? { best: res.best } : {}),
          ...(res.hunt ? { hunt: String(res.hunt) } : {}),
          ...(res.by !== undefined ? { by: res.by } : {}),
        }
      : null;
    return {
      seriesId: r.series_id,
      bookId: r.id,
      number: Number(r.number),
      title: r.title,
      ...detailOf([say('short.detail', { number: Number(r.number), pages: r.pages })]),
      // Confirmed rows keep exactly one chip, and it is the one that undoes the confirmation: the repair
      // skips a chapter somebody has already called short, so "Fix" on one would do nothing at all.
      actions: confirmed || partial ? ['confirm_short'] : owned ? ['fix_short', 'confirm_short'] : ['confirm_short'],
      ...(outcome ? { outcome } : {}),
      ...(confirmed
        ? {
            info: true,
            fixed: { at: confirmed.toISOString(), what: byAdmin ? 'marked fine by an admin' : 'confirmed short at the source' },
          }
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
    ...summaryOf([
      live ? say('short.live', { n: live }) : say('short.none'),
      quiet > 0 && say('short.quiet', { n: quiet }),
    ]),
    ...noteOf([say('short.note'), hiddenPart(hidden)]),
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
async function chapterFailures(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  let readFailed = false;
  const rows = await q<{
    source_id: string; chapters: number; series: number; since: string; last_at: string; attempts: number; capped: number;
    latest_title: string; latest_number: number; latest_status: string; latest_reason: string | null; failing: string[];
    blocked_until: string | null; disabled: boolean;
  }>(
    // `since` is the FIRST failure (first_at, v0.49.0; `at` is the latest attempt and a Retry now moves it
    // to now). COALESCE for rows from before the column, and rows a v0.48.4 rollback writes.
    // The source's own health row joins for the Retry caveats: a cooldown (and until when) or switched off.
    `SELECT f.source_id,
            -- What an ignore of this source's row covers: a newly failing chapter is a new finding.
            array_agg(f.series_id || ':' || f.number ORDER BY f.series_id, f.number) AS failing,
            count(*)::int AS chapters,
            count(DISTINCT f.series_id)::int AS series,
            min(COALESCE(f.first_at, f.at)) AS since,
            max(f.at) AS last_at,
            max(f.attempts)::int AS attempts,
            count(*) FILTER (WHERE f.attempts >= ${CHAPTER_RETRY_CAP})::int AS capped,
            (array_agg(ls.title  ORDER BY f.at DESC))[1] AS latest_title,
            (array_agg(f.number  ORDER BY f.at DESC))[1] AS latest_number,
            (array_agg(f.status  ORDER BY f.at DESC))[1] AS latest_status,
            (array_agg(f.reason  ORDER BY f.at DESC))[1] AS latest_reason,
            max(h.blocked_until) FILTER (WHERE h.blocked_until > now()) AS blocked_until,
            COALESCE(bool_or(h.disabled), false) AS disabled
       FROM chapter_failures f JOIN lib_series ls ON ls.id = f.series_id AND ${visibleToAll('ls')}
       LEFT JOIN source_health h ON h.source_id = f.source_id
      GROUP BY f.source_id ORDER BY chapters DESC`,
  ).catch(() => { readFailed = true; return [] as any[]; });
  const all: Array<HealthItem & { members?: string[] }> = rows.map((r) => ({
    title: sourceLabel(r.source_id),
    sourceId: r.source_id,
    key: `source:${r.source_id}`,
    members: r.failing ?? [],
    // One chip, and it is the repair's failures step for THIS source: it clears the attempt counts whatever
    // their age and re-checks up to ten of the source's series. The nightly does the same thing on its own
    // for rows that have sat at the cap for a week -- this is "the site is back up, try now".
    actions: ['retry'] as HealthAction[],
    outcome: {
      kind: 'failures' as const,
      firstAt: new Date(r.since).toISOString(),
      lastAt: new Date(r.last_at).toISOString(),
      attempts: r.attempts,
      resetPending: r.attempts === 0,
    },
    // What Retry now will not be able to do right now: it resets the counts either way, but it asks nothing
    // of a source in a cooldown or switched off (lib/repair.ts stepFailures). Said before it is pressed.
    ...(r.blocked_until
      ? { caveats: [{ action: 'retry' as const, code: 'source_cooling_down' as const, until: new Date(r.blocked_until).toISOString() }] }
      : r.disabled ? { caveats: [{ action: 'retry' as const, code: 'source_off' as const }] } : {}),
    ...detailOf([say('failures.detail', {
      n: r.chapters, series: r.series, since: new Date(r.since).toISOString(), tries: r.attempts, capped: r.capped, cap: CHAPTER_RETRY_CAP,
      title: r.latest_title, number: Number(r.latest_number), status: r.latest_status,
      // 160, not 80: since v0.40.0 the reason ends with the evidence -- ` (page 80: 200 image/webp 88 B;
      // page 12: 404)` -- and that tail is the part that says WHICH theory is right. At 80 it was cut. The
      // downloader's own words, which the web shows as they are.
      reason: r.latest_reason ? String(r.latest_reason).slice(0, 160) : null,
    })]),
  }));
  const ignored = applyIgnores('chapter-failures', all, ctx, !readFailed);
  const live = rows.filter((_, i) => !all[i].info);
  const items = [...all].sort((a, b) => Number(!!a.info) - Number(!!b.info)).slice(0, 20);
  const total = live.reduce((n, r) => n + r.chapters, 0);
  return {
    id: 'chapter-failures',
    title: 'Chapters that would not download',
    status: verdict(all),
    ...summaryOf([
      live.length ? say('failures.live', { n: total, m: live.length }) : say('failures.none'),
      ignoredPart(ignored),
    ]),
    // The note's last sentence is not about a failure row: a chapter saved short is on disk and readable, so it is
    // not in this ledger at all. Said here because this is where an admin looks for "why is a chapter not whole".
    ...noteOf([say('failures.note', { cap: CHAPTER_RETRY_CAP }), hiddenPart(rows.length - 20)]),
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
export async function frozenSeries(ctx: IgnoreCtx = noIgnores(), engine: EngineState = engineState()): Promise<HealthCheck> {
  let readFailed = false;
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
  ).catch(() => { readFailed = true; return [] as any[]; });
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
  // Why a series' source cannot reach it. Enabled yet unregistered is the third case: dropped by
  // SUWAYOMI_MAX_SOURCES, which the cap check names but a series page cannot see.
  const why = (r: typeof rows[number], p: { n: number; source: string }): Part =>
    r.switched_off ? say('frozen.switchedOff', p) : r.still_enabled ? say('frozen.overLimit', p) : say('frozen.uninstalled', p);
  // #72: with no engine answering, EVERY extension series is unrouted, and the rules above then blamed the source
  // limit (enabled, so "over the limit") or a missing install. The engine is the reason, and the fix is the
  // engine: its own row (engineHealth.ts) and Admin → Extensions say how to bring it back.
  const engineWhy = (r: typeof rows[number]): boolean => !!r.source_id?.startsWith('sw:') && engine !== 'up';
  const found: HealthItem[] = frozen.map((r) => {
    const p = { n: r.books_count, source: r.source_id ?? '' };
    return {
      seriesId: r.id,
      title: r.title,
      key: `series:${r.id}`,
      ...detailOf([!r.source_id
        ? say('frozen.noSource', { n: r.books_count })
        : engineWhy(r)
          ? say(engine === 'unreachable' ? 'frozen.engineDown' : 'frozen.engineOff', p)
          : why(r, p)]),
    };
  });
  const ignored = applyIgnores('frozen-series', found, ctx, !readFailed);
  const stuck = found.filter((i) => !i.info).length;
  const items = [...found].sort((a, b) => Number(!!a.info) - Number(!!b.info)).slice(0, 20);
  for (const r of covered.slice(0, 20)) {
    items.push({
      seriesId: r.id,
      title: r.title,
      ...detailOf([say('frozen.following', { source: r.source_id, names: followed.get(r.id)! })]),
      info: true,
    });
  }
  return {
    id: 'frozen-series',
    title: 'Series that can no longer update',
    status: stuck ? 'warn' : 'ok',
    ...summaryOf([
      stuck ? say('frozen.live', { n: stuck }) : say('frozen.none'),
      covered.length > 0 && say('frozen.covered', { n: covered.length }),
      ignoredPart(ignored),
    ]),
    ...noteOf([
      frozen.some((r) => engineWhy(r)) && say('frozen.engineNote'),
      joined('sentence', say('frozen.note')),
      hiddenPart(frozen.length - 20),
    ]),
    items,
  };
}

/**
 * A source as a person knows it: its name, not `sw:2499…` (#115: a raw id reads as "no problems" to someone
 * looking for Manga Ball). The registered adapter's name, then the name the engine gave it when it was
 * registered (`suwayomi_sources.name`, for one that is not loaded now), then the id. `sourceId` stays the key
 * every action uses.
 */
export function sourceLabel(id: string, engineName?: string | null): string {
  return getSource(id)?.name || engineName || id;
}

const iso = (t: string | number | Date) => new Date(t).toISOString();

async function sourceTrouble(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; status: string; consecutive: number; disabled: boolean;
    blocked_until: string | null; last_error: string | null; empty_streak: number; last_ok_at: string | null;
    last_fail_at: string | null; last_slow_at: string | null; slow_streak: number;
    stages: Stages | null; live_at: string | null; live_by: 'test' | 'sweep' | null;
    live_state: 'pass' | 'fail' | 'inconclusive' | null; live_code: string | null; live_stage: Stage | null;
    engine_name: string | null;
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
            sh.last_fail_at, sh.last_slow_at, sh.slow_streak,
            -- #115: what Test, the daily check and ordinary use have seen, per stage (lib/sourceEvidence.ts).
            sh.stages, sh.live_at, sh.live_by, sh.live_state, sh.live_code, sh.live_stage,
            -- The engine's name for an extension source that is not registered right now (sourceLabel).
            (SELECT sn.name FROM suwayomi_sources sn WHERE 'sw:' || sn.source_id = sh.source_id LIMIT 1) AS engine_name,
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
      WHERE sh.status <> 'ok' OR sh.disabled = true OR sh.empty_streak >= 3 OR sh.slow_streak >= 3
         OR sh.live_state IN ('fail', 'inconclusive') OR sh.stages::text LIKE '%failAt%'
         OR EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE 'sw:' || ss.source_id = sh.source_id AND NOT ss.enabled)
      ORDER BY 4 DESC, sh.consecutive DESC`,
  );
  const now = Date.now();
  // A source the operator switched off themselves is not a fault, and reading it as one is how a health
  // page trains people to ignore it. Contributor PR #39 spotted this while adding language hiding: turning
  // off thirty Russian sources made the page amber with thirty "problems" that were the operator's own
  // decision. They stay listed, greyed, so the count is still visible; the verdict comes from the rest.
  //
  // The second quiet case, and the bigger one on the live server: a source NOTHING uses that only has TRAFFIC
  // trouble. Ten of twelve not-ok rows there were sources that only ever appeared in Discover, failed once, and
  // held this check amber ever since. Still listed, and still a finding the moment it is in a cooldown or
  // somebody adds a series to it. ⚠️ Since v0.49.0 (#115) that greying no longer covers a CONFIRMED failure --
  // a failed Test or daily check, or three failures in a row at one stage: those are findings whether or not a
  // series uses the source, because "source health must reflect failing sources" and the one-off Discover blips
  // that made the page cry wolf are exactly what the streak rule filters out.
  const unused = (r: typeof rows[number]) =>
    !r.disabled && r.series === 0 && !(r.blocked_until && new Date(r.blocked_until).getTime() > now);
  const traffic = (r: typeof rows[number]) => r.status !== 'ok' || r.empty_streak >= 3 || r.slow_streak >= 3;
  const WEEK = 7 * DAY_MS;
  let off = 0, idle = 0, unfinished = 0, untested = 0;
  const items: Array<HealthItem & { members?: string[] }> = [];
  for (const r of rows) {
    // Evidence counts only for a source that is loaded: an uninstalled extension's series are the frozen-series
    // check's business, and its last test is about something that no longer exists here.
    const loaded = !!getSource(r.source_id);
    const open = loaded ? openFailures(r.stages, now).filter((f) => f.confirmed) : [];
    const failing = open.filter((f) => !f.stale);
    const inconclusive = loaded && r.live_state === 'inconclusive' && !!r.live_at && now - new Date(r.live_at).getTime() < WEEK;
    const stale = open.length > 0 && !failing.length;
    if (!r.disabled && !failing.length && !traffic(r) && !inconclusive && !stale) continue; // nothing to say

    const until = r.blocked_until ? new Date(r.blocked_until).getTime() : 0;
    // A block whose deadline has passed is not actually holding anything back; say so rather than
    // leaving the operator thinking the source is still down.
    const state = r.disabled
      ? say('sources.turnedOff')
      : until && until < now
        ? say('sources.expired', { status: r.status })
        : until
          ? say('sources.until', { status: r.status, until: iso(until) })
          : say('sources.status', { status: r.status });
    // The plain-language cause and its fix, rather than the raw string. This page is admin-only, so it gets the
    // operator half of the diagnosis, which is the half that names what to actually go and do.
    //
    // `last_error` outlives the failure it describes: `reportOk` never clears it, so a source listed here for an
    // empty streak, with a success more recent than its last failure, would otherwise be diagnosed from the words
    // of its last bad afternoon and the operator sent to fix a Cloudflare problem that ended days ago.
    // currentError() is that rule, shared with the Test button and the daily check.
    const lead = failing[0];
    const d = diagnose(
      {
        status: r.status as any, lastError: currentError(r), consecutive: r.consecutive,
        lastOkAt: r.last_ok_at, emptyStreak: r.empty_streak ?? 0, blockedUntil: r.blocked_until, disabled: r.disabled,
        slowStreak: r.slow_streak ?? 0, budgetMs: env.SOURCE_LATEST_TIMEOUT_MS,
      },
      // The confirmed failure is live evidence of the most specific kind: its stage and its own error.
      lead && !r.disabled ? { adapterOk: false, failure: { stage: lead.stage, kind: lead.kind, error: lead.error } } : undefined,
    );
    const uses = say('sources.uses', { n: r.series });
    const tested = r.live_at ? say('sources.tested', { at: iso(r.live_at), by: r.live_by }) : null;
    let detail: Part[];
    let info = false;
    let members: string[] = [];
    if (r.disabled) {
      off++;
      info = true;
      detail = [state, uses];
    } else if (failing.length) {
      // Leads with the stage: "Search failing since …" is what an admin looking for Manga Ball needs first. The
      // reason is a sentence of its own, so what follows it starts the next one: appended as "; last tested",
      // it read "…needs a check from an admin.; last tested …".
      const rest = [tested, uses].filter((p): p is Part => !!p);
      detail = [
        say('sources.failing', { stage: lead.stage, since: iso(lead.since), also: failing.slice(1).map((f) => f.stage) }),
        ...(d.reason ? [joined('dash', say('sources.reason', { diagnosis: d.code }))] : []),
        joined(d.reason ? 'sentence' : 'dashCap', rest[0]),
        ...rest.slice(1),
      ];
      // What an Ignore covers: the failing stages. A NEW stage failing is a new finding (healthIgnore covered()).
      members = failing.map((f) => f.stage);
    } else if (traffic(r)) {
      info = unused(r);
      if (info) idle++;
      detail = [
        state, uses,
        ...(d.code === 'ok' ? [] : [joined('dash', d.fix ? own(d.fixSaid, d.fix) : say('sources.reason', { diagnosis: d.code }))]),
      ];
    } else if (inconclusive) {
      unfinished++;
      info = true;
      detail = [say('sources.inconclusive', { stage: r.live_stage ?? 'search' }), tested, uses].filter((p): p is Part => !!p);
    } else {
      untested++;
      info = true;
      const days = Math.floor((now - new Date(open[0].at).getTime()) / DAY_MS);
      detail = [say('sources.stale', { stage: open[0].stage, at: iso(open[0].at), days }), uses];
    }
    items.push({
      title: sourceLabel(r.source_id, r.engine_name),
      sourceId: r.source_id,
      ...detailOf(detail),
      // Test always: it is the one action that answers "is this still true?", and it records, never escalates.
      // Clear block whenever there is a block to clear, expired or not -- clearing also wipes the escalation
      // memory (consecutive), which is what makes the next cooldown fifteen minutes instead of seventy-five.
      // Turn off only for a source that is not already off, by either of the two routes.
      actions: [
        'test',
        ...(r.blocked_until ? ['unblock' as const] : []),
        ...(r.disabled ? [] : ['disable' as const]),
      ] as HealthAction[],
      // Only a real finding can be ignored: a source switched off, used by nothing, or merely untested is quiet.
      ...(info ? { info: true } : { key: `source:${r.source_id}`, members }),
      evidence: stageLines(r.stages),
      ...(r.live_at ? { tested: { at: new Date(r.live_at).toISOString(), by: r.live_by, state: r.live_state, stage: r.live_stage } } : {}),
      diagnosis: { code: d.code, reason: d.reason, fix: d.fix, ...(d.fixSaid ? { fixSaid: d.fixSaid } : {}) },
      series: r.series,
    });
  }
  const ignored = applyIgnores('sources', items, ctx);
  const live = items.filter((i) => !i.info).length;
  return {
    id: 'sources',
    title: 'Source health',
    status: live ? 'warn' : 'ok',
    ...summaryOf([
      live ? say('sources.live', { n: live })
        // Never "all responding" over a source that is failing unused, or that nobody could test to the end.
        : idle + unfinished + untested ? say('sources.unused') : say('sources.none'),
      off > 0 && say('sources.off', { n: off }),
      idle > 0 && say('sources.idle', { n: idle }),
      unfinished > 0 && say('sources.unfinished', { n: unfinished }),
      ignoredPart(ignored),
    ]),
    ...noteOf([say('sources.note')]),
    testMs: env.SOURCE_TEST_TIMEOUT_MS + 8000,
    items,
  };
}

/** The same manga added twice, spotted by two local series resolving to one AniList entry. */
async function duplicateSeries(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
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
  const items: Array<HealthItem & { members?: string[] }> = rows.map((r) => {
      const keep = keepOf(r.ids);
      return {
        seriesId: r.ids[0],
        seriesIds: r.ids,
        titles: r.titles.split(' + '),
        title: r.titles,
        keep,
        // Ignored while the copies are the same ones: a third copy of the entry is a new finding.
        key: `anilist:${r.external_id}`,
        members: [...r.ids].sort(),
        // Only a pair gets the chip. Three copies of one entry is two merges in an order somebody has to
        // choose, and a button that quietly picks one is how a library loses a series it cannot get back.
        ...(r.ids.length === 2 ? { actions: ['merge' as const] } : {}),
        ...detailOf([say('dupes.same'), r.ids.length > 2 && say('dupes.copies', { n: r.ids.length })]),
      };
    });
  const ignored = applyIgnores('duplicates', items, ctx);
  const live = items.filter((i) => !i.info).length;
  return {
    id: 'duplicates',
    title: 'Duplicate series',
    status: verdict(items),
    ...summaryOf([live ? say('dupes.live', { n: live }) : say('dupes.none'), ignoredPart(ignored)]),
    ...noteOf([say('dupes.note')]),
    items,
  };
}

/** percentile_cont(0.5), in JS: the interpolated median, so this check and the SQL it replaced agree. */
function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/** Chapter numbers far beyond the rest of the series: the sidebar-widget scraping bug's signature. */
async function outlierChapters(held: HeldSeries[], ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
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

  const items: Array<HealthItem & { members?: string[] }> = [];
  let readFailed = false;
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
    ).catch(() => { readFailed = true; return [] as Array<{ id: string; number: number }>; });
    if (!books.length) continue;
    items.push({
      seriesId: r.s.id,
      title: r.s.title,
      ...detailOf([say('outliers.detail', { n: books.length, top: Number(books[0].number), median: Math.round(r.med) })]),
      bookIds: books.slice(0, MAX_BOOK_IDS).map((b) => b.id),
      numbers: books.slice(0, MAX_BOOK_IDS).map((b) => Number(b.number)),
      actions: ['delete'],
      // Ignored while the chapters are these ones -- a chapter numbered 9001 that really is 9001 (a
      // hundred-volume series' specials), say. Another out-of-range chapter is a new finding.
      key: `series:${r.s.id}`,
      members: books.map((b) => b.id).sort(),
    });
  }
  const ignored = applyIgnores('outliers', items, ctx, !readFailed);
  const live = items.filter((i) => !i.info).length;
  items.sort((a, b) => Number(!!a.info) - Number(!!b.info));
  return {
    id: 'outliers',
    title: 'Impossible chapter numbers',
    status: verdict(items, 'problem'),
    ...summaryOf([live ? say('outliers.live', { n: live }) : say('outliers.none'), ignoredPart(ignored)]),
    ...noteOf([say('outliers.note'), hiddenPart(items.length - MAX_ITEMS)]),
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

/** Lives in lib/said.ts now, with the sentence it is part of; re-exported for the callers that import it here. */
export { solverVersionLabel } from './said';

export async function solverHealth(): Promise<HealthCheck> {
  // The ping the extension engine row reads too (engineHealth.ts): the two rows cannot disagree about the solver.
  const ping = await solverPingShared();
  const blaming = await solverBlaming();

  const url = solverUrl();
  if (!ping.ok) {
    const error = ping.error || null;
    return {
      id: 'solver',
      title: 'Cloudflare solver',
      status: blaming.length ? 'problem' : 'warn',
      // ⚠️ Desktop: the helper's address carries its access token as the path, so it is named, never
      // printed (a screenshot in a bug report would hand the token to anyone who reads it) -- nor sent as a
      // parameter for the page to print.
      ...summaryOf([say('solver.down', { url: isDesktop() ? undefined : url, error })]),
      ...noteOf([say('solver.downNote')]),
      // The solver itself is the first item, not just the sources blaming it. Every other check on this page
      // holds "no items means ok", and a solver that is simply absent has nothing to list -- so without this
      // it would report a warning with an empty body, which reads as a page bug rather than a finding.
      items: [
        {
          title: forDesktop(url, 'Cloudflare helper'),
          ...(isDesktop() ? { titleSaid: saidOf(say('solver.helper')) } : {}),
          ...detailOf([say('solver.notAnswering', { error })]),
        },
        // No "Reset solver sessions" chip while it is down. The reset clears what THIS process remembers
        // about a solver that is answering; on one that is not, it would be a button that reports success
        // and changes nothing, which is worse than no button. The repair's solver step refuses for the
        // same reason.
        ...blaming.map((id) => ({ title: sourceLabel(id), sourceId: id, ...detailOf([say('solver.names')]) })),
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
    ...summaryOf([blaming.length
      ? say('solver.blaming', { n: blaming.length })
      : say('solver.ready', { version: ping.version ?? null, latest: behind ? latest : null })]),
    ...noteOf([blaming.length > 0 && say('solver.failingNote')]),
    items: [
      // `info`: this row and `status: 'ok'` coexist on purpose, see the note above. Without the flag it
      // contradicted the page's "no items means ok" rule, and the health test could only hold that rule
      // because no test machine ever had an out-of-date solver.
      ...(behind
        ? [{ title: `v${ping.version} → v${latest}`, ...detailOf([say('solver.behind')]), info: true }]
        : []),
      // The solver answers, so the stale part is what this process remembers about it: a cf_clearance
      // cookie Cloudflare has since rotated, and origins stamped unsolvable. That is what the chip clears,
      // along with this source's cooldown. It cannot restart the container -- Uchiyomi has no access to
      // other containers, by design -- so the note above still names the restart as the operator's job.
      ...blaming.map((id) => ({
        title: sourceLabel(id),
        sourceId: id,
        ...detailOf([say('solver.inside')]),
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
      ...summaryOf([running ? say('version.offRunning', { version: running }) : say('version.off')]),
      ...noteOf([say('version.offNote')]),
      items: [],
    };
  }

  const latest = await latestRelease(APP_REPO);
  const behind = isBehind(running, latest);
  return {
    id: 'update', title: 'Version', status: 'ok',
    ...summaryOf([!running ? say('version.unknown')
      : behind ? say('version.behind', { version: running, latest: latest! })
      : latest ? say('version.current', { version: running })
      : say('version.running', { version: running })]),
    // ⚠️ Said out loud, because "up to date" and "we could not ask" look identical on a page and only one of
    // them is a reason to relax. GitHub being unreachable or rate-limited is a normal Tuesday.
    ...noteOf([!latest && say('version.unasked')]),
    // `info` for the same reason as the solver's version row: advisory, and never the reason the page is amber.
    items: behind
      ? [{ title: `v${running} → ${latest}`, ...detailOf([say('version.newer')]), info: true }]
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
  const title = say('cap.title');
  return {
    id: 'extension-cap',
    title: 'Extension source limit',
    status: skipped ? 'warn' : 'ok',
    // "0 of 25" is a measurement only when the engine answered; after a failed load it is the absence of
    // one, and the cap warning would silently vanish for the length of an outage.
    ...summaryOf([skipped
      ? say('cap.over', { n: skipped, cap })
      : load && !load.reachable
        ? say('cap.unreachable', { cap })
        : say('cap.inUse', { n: load?.registered ?? 0, cap })]),
    ...noteOf([say('cap.note')]),
    items: skipped
      ? [{ title: title.text, titleSaid: saidOf(title), ...detailOf([say('cap.detail', { n: skipped, cap })]) }]
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
    return { id: 'library-scan', title: 'Library scan', status: 'ok', ...summaryOf([say('scan.none')]), ...noteOf([where]), items: [] };
  }
  const n = r.skippedTotal;
  const w = r.walkProblems;
  // A folder as the rows name it: which root, and where under it.
  const label = (root: 'library' | 'downloads', folder: string) => {
    const t = say('folder', { root, folder });
    return { title: t.text, titleSaid: saidOf(t) };
  };
  return {
    id: 'library-scan',
    title: 'Library scan',
    status: n || w ? 'problem' : 'ok',
    ...summaryOf([n || w ? say('scan.problems', { n, w }) : say('scan.indexed', { series: r.series, books: r.books })]),
    ...noteOf([
      say('scan.note'),
      r.sharedIds > 0 && joined('sentence', say('scan.shared', { n: r.sharedIds })),
      r.removed > 0 && joined('sentence', say('scan.removed', { n: r.removed })),
      where && joined('sentence', where),
    ]),
    items: [
      // The database's own refusal, which only it can word: shown as sent.
      ...r.skipped.map((k) => ({ ...label(k.root, k.folder), detail: k.error })),
      ...r.walk.map((i) => ({
        ...label(i.root, i.folder),
        ...detailOf([walkPart(i)]),
        ...(QUIET_WALK.has(i.reason) ? { info: true } : {}),
      })),
    ].slice(0, MAX_ITEMS),
  };
}

/**
 * What the walk said about one folder (lib/library.ts WalkIssue), in Health's words. An issue without its
 * `params` (built before v0.49.1, or by a test by hand) says its own `detail`.
 */
function walkPart(i: { reason: WalkReason; detail: string; params?: WalkIssue['params'] }): Part {
  const p = i.params ?? {};
  switch (i.reason) {
    case 'unreadable': return p.failed !== undefined ? say('walk.failed', { error: p.failed }) : say('walk.unreadable', { error: i.detail });
    case 'stat': return say('walk.stat', { error: i.detail });
    case 'loop': return say('walk.loop', p.ancestor !== undefined ? { ancestor: p.ancestor } : { detail: i.detail });
    case 'unchecked': return p.n !== undefined ? say('walk.unchecked', { n: p.n, names: p.names ?? [] }) : say('text', { text: i.detail });
    case 'depth': return p.n !== undefined && p.max !== undefined ? say('walk.depth', { n: p.n, max: p.max }) : say('text', { text: i.detail });
    case 'limit': return p.max !== undefined ? say('walk.limit', { max: p.max }) : say('text', { text: i.detail });
  }
}

/** Which filesystem each root is on: the first thing anyone needs to know about a folder that goes missing. */
async function rootsNote(): Promise<Part | null> {
  const [lib, dl] = await Promise.all([fsTypeOf(LIBRARY_ROOT), fsTypeOf(DL_ROOT)]);
  return lib || dl ? say('roots', { library: lib, downloads: dl }) : null;
}

/**
 * The downloads check's notes: what it compared, and what the numbers leave out. Apart so a test can hand it a
 * census; the check itself needs a disk and a database.
 */
export function downloadsNotes(
  c: Pick<Census, 'root' | 'fsType' | 'noScan' | 'scanCapped' | 'pending' | 'removed' | 'truncated'>, strays: number,
): string[] {
  return downloadsNoteParts(c, strays).map((p) => p.text);
}

/** downloadsNotes' sentences, with their codes for the web: one part each, joined as sentences. */
function downloadsNoteParts(
  c: Pick<Census, 'root' | 'fsType' | 'noScan' | 'scanCapped' | 'pending' | 'removed' | 'truncated'>, strays: number,
): Part[] {
  return [
    say('missing.compared', { root: c.root, fs: c.fsType ?? null }),
    // v0.49.0: the card has its own Scan now. Reintroduce the Tasks route: "the downloads check points at its own
    // Scan now" in healthNotes.test.ts reads Admin → Tasks.
    ...(c.noScan ? [say('missing.noScan')] : []),
    ...(c.scanCapped ? [say('missing.capped')] : []),
    ...(c.pending ? [say('missing.pending', { n: c.pending })] : []),
    ...(c.removed ? [say('missing.removed', { n: c.removed })] : []),
    ...(strays ? [say('missing.strays', { n: strays })] : []),
    ...(c.truncated ? [say('missing.truncated')] : []),
  ].map((p, i) => (i ? joined('sentence', p) : p));
}

/**
 * Every chapter file in the downloads folder that is not in the library (#109), with the reason when the scan
 * knows one. Compares the disk with the database directly (lib/downloadCensus.ts), so it does not depend on the
 * scanner having noticed what it dropped -- which is exactly what it failed to do for #109, twice.
 */
async function downloadsMissing(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const base = { id: 'downloads-missing', title: 'Downloads missing from the library' };
  const c = await downloadCensus().catch((e) => e as Error);
  if (c instanceof Error) {
    return { ...base, status: 'warn', ...summaryOf([say('missing.error', { error: String(c.message).slice(0, 160) })]), items: [] };
  }
  // What needs someone: everything but a stray file of the person's own where the scan never reads chapters
  // (lib/downloadCensus.ts countsAsMissing). Those are listed, dimmed, and never turn the check red -- the only
  // way to clear one would be to move the person's own file.
  const strays = c.missing.filter((m) => !countsAsMissing(m)).length;
  const title = (folder: string) => {
    const t = say('folder', { root: 'downloads', folder });
    return { title: t.text, titleSaid: saidOf(t) };
  };
  const all: Array<HealthItem & { members?: string[] }> = [
    ...c.unreadable.map((u) => ({
      ...title(u.folder), ...detailOf([say('missing.folderUnreadable', { error: u.error })]),
      key: `unreadable:${u.folder}`,
    })),
    ...c.missing.map((m) => ({
      ...title(m.folder),
      ...detailOf([
        say('missing.files', { n: m.files.length, files: m.files.slice(0, 3), cut: m.files.length > 3 }),
        m.reason ? joined('colon', own(m.reasonSaid, m.reason)) : null,
      ]),
      ...(m.seriesId ? { seriesId: m.seriesId } : {}),
      // Ignored while the files are these ones: another chapter landing in the folder unseen is a new finding.
      ...(countsAsMissing(m) ? { key: `folder:${m.folder}`, members: m.files } : { info: true }),
    })),
  ];
  const ignored = applyIgnores('downloads-missing', all, ctx);
  const live = c.missing.filter((m) => countsAsMissing(m) && all.some((it) => it.key === `folder:${m.folder}` && !it.info));
  const n = live.reduce((k, m) => k + m.files.length, 0);
  const unread = all.filter((it) => it.key?.startsWith('unreadable:') && !it.info).length;
  const { items } = truncate(all);
  return {
    ...base,
    status: n || unread ? 'problem' : 'ok',
    ...summaryOf([
      n ? say('missing.live', { n, m: live.length })
        : unread ? say('missing.unreadable', { n: unread })
        : say('missing.none', { checked: c.files }),
      ignoredPart(ignored),
    ]),
    ...noteOf(downloadsNoteParts(c, strays)),
    items,
  };
}

// ---- report -----------------------------------------------------------------

export async function runHealthChecks(): Promise<HealthReport> {
  // The two checks that reason about chapter NUMBERS share one read of what every series holds, because
  // that read applies the override and tombstone rules per series and is the expensive part of this page.
  const held = await heldBySeries();
  // What an admin chose to ignore (lib/healthIgnore.ts), read once for the whole run.
  const ctx = await loadIgnores();
  // Independent read-only queries: run them together rather than serially.
  const checks = (await Promise.all([
    chapterGaps(held, ctx),
    // #116: null when no series has anything to say about its numbering.
    numberingCheck(),
    shortChapters(),
    outlierChapters(held, ctx),
    duplicateSeries(ctx),
    sourceTrouble(ctx),
    chapterFailures(ctx),
    frozenSeries(ctx),
    solverHealth(),
    updateCheck(),
    libraryScan(),
    downloadsMissing(ctx),
    ...(suwayomiConfigured() ? [extensionCap()] : []),
    // #72: the engine itself; null when there is none and nothing depends on one (lib/engineHealth.ts).
    extensionEngineCheck().catch(() => null),
  ])).filter((c): c is HealthCheck => c !== null);
  await keepIgnoresAlive(ctx);
  // worst first, so the page opens on whatever needs attention
  const rank: Record<HealthStatus, number> = { problem: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => rank[a.status] - rank[b.status]);
  return { generatedAt: new Date().toISOString(), checks };
}

/**
 * One finding, as its check sees it right now: what the Ignore route records. Recomputed rather than taken from
 * the page, because the page carries at most a hundred of a gap's numbers and an ignore must cover all of them.
 * Null when the finding is no longer there.
 */
export async function findingOf(check: IgnorableCheck, key: string): Promise<Finding | null> {
  const ctx = noIgnores();
  switch (check) {
    case 'chapter-gaps': await chapterGaps(await heldBySeries(), ctx); break;
    case 'outliers': await outlierChapters(await heldBySeries(), ctx); break;
    case 'chapter-failures': await chapterFailures(ctx); break;
    case 'sources': await sourceTrouble(ctx); break;
    case 'frozen-series': await frozenSeries(ctx); break;
    case 'duplicates': await duplicateSeries(ctx); break;
    case 'downloads-missing': await downloadsMissing(ctx); break;
  }
  return ctx.found.get(`${check}\u0000${key}`) ?? null;
}
