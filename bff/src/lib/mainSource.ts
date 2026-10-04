// Making a followed source a series' main source (v0.54.0): the one place `lib_series.source_id` moves after the add.
//
// Until this, nothing could: Find other sources only added followers, so after aqua went offline its 195 series kept it
// as their main source in every count, filter, queue and Health row, and the only way off it was adding each series a
// second time and merging the copies. The owner, after a full Find run: "i have to go one by one ... and find
// replacement sources". The Sources sheet's Make main and the Replace run (lib/findSources.ts) both come here.
//
// Only a source the series already FOLLOWS can be promoted (`not_followed` otherwise): its row is the "same series?"
// judgement already made -- by a fill-scan plan, the add's auto-follow or a Find run -- and the sweep already merges
// its chapters. Promoting it changes the tie-breaks and the label, not which chapters arrive. A bare (source, id) pair
// is never taken on trust, here as on the follow route.
//
// What moves and what stays:
//   - the pair (`source_id`, `source_series_id`) moves, inside one transaction holding the series row's lock -- the
//     lock followJudged (lib/autoFollow.ts) and linkEdition take, so a hunt's or a Find run's follow, an edition link
//     and a second switch all wait their turn. The promoted row leaves series_sources;
//   - the old main stays as the LAST follower (the `created_at` default) when it still carries the series -- usable or
//     cooling (lib/sourceStanding.ts) -- and the cap has room, or is dropped with its listing rows (the unfollow's rule)
//     and its ledger rows filed under the new main, their tries starting again (v0.55.3, lib/chapterFailures.ts
//     refileFailures), so a chapter capped against it gets its tries from the new main, and Health and Fix everything
//     read it as the new main's (chapter_failures is keyed by number, not by source: it would otherwise stay capped
//     against a source the series no longer reads);
//   - the series' language is pinned when it was only inferred from the main source and the new one says otherwise
//     (lib/seriesLang.ts effectiveLang): the language guard, editions, Komga's `language` and Edit details all read it,
//     and a switch must not change it by the way. An edition always states its language, so the (work, language)
//     index is untouched;
//   - `source_checked_at` / `source_chapters` / `source_missing` stay: they are the merged count and the series' last
//     check, not the old main's own figures, and the next check restamps them. The folder, `web`, the cover, the
//     reading direction, the description's other names and the floor are facts about the work: none moves. Downloads
//     keep landing in the series' folder, so ids and progress survive.
// Refused, each with its code: the main itself; a source it does not follow; posting order (the series takes its
// chapters from the numbering source alone, and another site's posts are not its numbers -- every cross-source path
// refuses it); a pending renumber; a run inside the series right now (lib/updater.ts runsInside: it read the old pair
// at its start and would write its listing and stamps from it); a target not loaded, switched off, or beyond the acting
// admin's age reach; a target in another language (the follow route's refusal, with the edition to add); and `moved`,
// when the main changed under the transaction (or, for Replace, is no longer the source being replaced).
import type { FastifyRequest } from 'fastify';
import { one, tx } from './db';
import { getSource } from './sources';
import { logAudit } from './audit';
import { seriesVisible, sourceAllowedFor, type ViewCtx } from './visibility';
import { MAX_FOLLOWERS } from './autoFollow';
import { renumberRunning } from './numbering';
import { runsInside } from './updater';
import { effectiveLang, followGuard, sourceLanguage } from './seriesLang';
import { canonLang } from './lang';
import { editionFollowing } from './editions';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { carries, standingOf, standingRows } from './sourceStanding';
import { say, type Part } from './said';
import { refileFailures } from './chapterFailures';

/** What becomes of the old main: `auto` keeps it while it still carries the series; `keep` and `drop` decide. */
export type OldMain = 'auto' | 'keep' | 'drop';

export type MainRefusal =
  | 'not_found' | 'is_main' | 'not_followed' | 'posting_order' | 'renumber_pending' | 'busy' | 'source_unavailable'
  | 'language_differs' | 'moved';

export interface MainSwitched {
  ok: true;
  from: string | null;
  fromRef: string | null;
  to: string;
  toRef: string;
  old: 'kept' | 'dropped';
  /** The language the series was pinned to, when the switch would otherwise have changed it. */
  langPinned?: string;
  /** Listing rows of the old main that went with it: a refresh is owed when there were any. */
  listingDropped: number;
}

export interface MainRefused {
  refused: MainRefusal;
  /** What the refusal says, as a said code (lib/said.ts); absent for `not_found`. */
  said?: Part;
  /** `language_differs`: the follow route's edition to add instead, or the one the work holds. */
  edition?: { of: string; lang: string; existing?: { id: string; lang: string } };
}

export interface SwitchOpts {
  old?: OldMain;
  /** Who acts: their view decides `not_found`, their age reach `source_unavailable`. */
  ctx: ViewCtx;
  userId: string | null;
  /** Where the switch came from, for the audit line: the Sources sheet, a Replace run, or a review's Make main. */
  via: 'manual' | 'replace' | 'review';
  runId?: string;
  /** The main source the caller saw. A Replace run passes the source it replaces: a series moved off it since is `moved`. */
  expect?: string;
  req?: FastifyRequest;
}

const refuse = (refused: MainRefusal, said?: Part, extra: Partial<MainRefused> = {}): MainRefused =>
  ({ refused, ...(said ? { said } : {}), ...extra });

const SAID: Record<Exclude<MainRefusal, 'not_found' | 'language_differs'>, () => Part> = {
  is_main: () => say('main.isMain'),
  not_followed: () => say('main.notFollowed'),
  posting_order: () => say('numbering.postingRefusal'),
  renumber_pending: () => say('main.renumberPending'),
  busy: () => say('renumber.checking'),
  source_unavailable: () => say('main.unavailable'),
  moved: () => say('main.moved'),
};
const refusal = (r: Exclude<MainRefusal, 'not_found' | 'language_differs'>) => refuse(r, SAID[r]());

type Row = {
  source_id: string | null; source_series_id: string | null; title: string; lang: string | null; numbering: string | null;
  numbering_pending: string | null; renumber_plan: unknown; deleted_at: string | null; merged_into: string | null;
};
const ROW = 'source_id, source_series_id, title, lang, numbering, numbering_pending, renumber_plan, deleted_at, merged_into';

/**
 * Make `to` -- a source the series follows -- its main source. Never refreshes the listing itself: the route reads the
 * answer's source list first (a follow is not a check: routes/admin.ts says why), and a Replace run paces its refreshes.
 */
export async function switchMainSource(seriesId: string, to: string, opts: SwitchOpts): Promise<MainSwitched | MainRefused> {
  // ---- the checks, before anything is locked, each with its own answer ----
  if (!(await seriesVisible(seriesId, opts.ctx))) return refuse('not_found');
  const pre = await one<Row>(`SELECT ${ROW} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!pre) return refuse('not_found');
  if (opts.expect !== undefined && pre.source_id !== opts.expect) return refusal('moved');
  if (to === pre.source_id) return refusal('is_main');
  const target = await one<{ source_series_id: string }>(
    'SELECT source_series_id FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, to]);
  if (!target?.source_series_id) return refusal('not_followed');
  if (pre.numbering === 'posting_order') return refusal('posting_order');
  if (pre.numbering_pending || pre.renumber_plan || renumberRunning(seriesId)) return refusal('renumber_pending');
  // Reintroduce by dropping it: "a check inside the series" in mainSource.int.test.ts is answered 200.
  if (runsInside(seriesId) > 0) return refusal('busy');
  const standing = await standingRows([to, ...(pre.source_id ? [pre.source_id] : [])]);
  const src = getSource(to);
  if (!src || standing.get(to)?.disabled || !sourceAllowedFor(src, opts.ctx.maxAgeRating)) return refusal('source_unavailable');
  // The follow route's guard and its refusal, word for word: a source in another language is that language's edition.
  if (!(await followGuard(seriesId))(to)) {
    const theirs = sourceLanguage(to);
    const ours = effectiveLang(pre.lang, pre.source_id);
    const existing = await editionFollowing(seriesId, to, opts.ctx);
    return refuse('language_differs',
      existing ? say('follow.languageDiffersEdition', { theirs, ours, edition: existing.lang }) : say('follow.languageDiffers', { theirs, ours }),
      { edition: { of: seriesId, lang: theirs, ...(existing ? { existing } : {}) } });
  }
  // The old main stays a follower only while it still carries the series, unless the caller decided.
  const from = pre.source_id;
  const keepOld = !!from && !!pre.source_series_id
    && (opts.old === 'keep' || (opts.old !== 'drop' && carries(standingOf(from, standing.get(from)))));

  // ---- the switch, under the series row's lock ----
  type Done = { r: MainSwitched; promoted: { coverage: number | null; added_by: string | null }; failuresMoved: number };
  const out = await tx<Done | MainRefused>(async (qq) => {
    const [row] = await qq<Row>(`SELECT ${ROW} FROM lib_series WHERE id = $1 FOR UPDATE`, [seriesId]);
    if (!row || row.deleted_at || row.merged_into) return refuse('not_found');
    // Another switch, or a Replace run, got here first: what was checked above is about a main that is gone.
    if (row.source_id !== from) return refusal('moved');
    if (row.numbering === 'posting_order') return refusal('posting_order');
    if (row.numbering_pending || row.renumber_plan) return refusal('renumber_pending');
    const follows = await qq<{ source_id: string; source_series_id: string; coverage: number | null; added_by: string | null }>(
      'SELECT source_id, source_series_id, coverage, added_by FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id FOR UPDATE',
      [seriesId]);
    const promoted = follows.find((f) => f.source_id === to);
    if (!promoted?.source_series_id) return refusal('not_followed');

    // The language, pinned only when the switch would change what it reads as. Reintroduce by dropping it: "the
    // series keeps its language" in mainSource.int.test.ts reads the server's unstated language after the switch.
    let langPinned: string | undefined;
    if (canonLang(row.lang) === null) {
      const was = effectiveLang(null, from);
      if (was !== effectiveLang(null, to)) {
        await qq('UPDATE lib_series SET lang = $2 WHERE id = $1', [seriesId, was]);
        langPinned = was;
      }
    }
    await qq('UPDATE lib_series SET source_id = $2, source_series_id = $3 WHERE id = $1', [seriesId, to, promoted.source_series_id]);
    // The promoted row, and a row older than the follow route's rule that names the old main itself.
    // Reintroduce by dropping it: "a follower becomes the main source" in mainSource.int.test.ts finds the new main still
    // followed -- its row fills the cap, so the old main is dropped rather than kept.
    await qq('DELETE FROM series_sources WHERE series_id = $1 AND source_id = ANY($2::text[])', [seriesId, [to, ...(from ? [from] : [])]]);
    // Kept as the last follower, under the cap: promotion freed a slot, so it fits unless the series follows more
    // sources than a series may (a row from before the cap). Reintroduce by dropping the count: "the demotion never
    // takes a series past the follower cap" reads three followers.
    let kept = false;
    if (keepOld) {
      const ins = await qq<{ source_id: string }>(
        `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
         SELECT $1::text, $2::text, $3::text, $4::text, NULL, $5::uuid
          WHERE (SELECT count(*) FROM series_sources WHERE series_id = $1 AND source_id <> $2) < $6::int
         RETURNING source_id`,
        [seriesId, from, pre.source_series_id, row.title, opts.userId, MAX_FOLLOWERS]);
      kept = ins.length > 0;
    }
    let listingDropped = 0;
    if (!kept && from) {
      // The unfollow's rule: the rows a dropped source carried go with it, or a member could still fetch through it.
      // Reintroduce by dropping it: "a switched-off old main is dropped" finds its listing rows.
      listingDropped = (await qq('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2 RETURNING number', [seriesId, from])).length;
    }
    // Failures follow the series (v0.55.3, lib/chapterFailures.ts): the chapters a dropped old main failed -- and any
    // row still filed under a source the series no longer uses -- are the new main's now, filed under it with their
    // tries starting again (the repair's reset shape, first_at kept). v0.54.0 reset them where they were: the sweep
    // tried them through the new main, but Health listed them under a source the series no longer reads, and Fix
    // everything's failures step, which skips a source failing at its pages, left them to "Needs you" run after run.
    // A kept old main is still the series' own: its rows stay as they are. Reintroduce by dropping it: "its capped
    // chapters get another try, filed under the new main" in mainSource.int.test.ts finds chapter 7 capped, under ms-a.
    const failuresMoved = await refileFailures(qq, [seriesId]);
    return {
      r: {
        ok: true as const, from, fromRef: pre.source_series_id, to, toRef: promoted.source_series_id,
        old: kept ? 'kept' as const : 'dropped' as const, ...(langPinned ? { langPinned } : {}), listingDropped,
      },
      promoted: { coverage: promoted.coverage, added_by: promoted.added_by },
      failuresMoved,
    };
  });
  if ('refused' in out) return out;
  await logAudit('series.main_source', {
    userId: opts.userId,
    detail: {
      id: seriesId, title: pre.title, from, fromRef: pre.source_series_id, to, toRef: out.r.toRef, old: out.r.old,
      coverage: out.promoted.coverage, addedBy: out.promoted.added_by, ...(out.r.langPinned ? { langPinned: out.r.langPinned } : {}),
      ...(out.failuresMoved ? { failuresMoved: out.failuresMoved } : {}),
      via: opts.via, ...(opts.runId ? { runId: opts.runId } : {}),
    },
    req: opts.req,
  });
  // Health's sources and "can no longer update" rows count main sources: the header catches up now, not in 6 h.
  scheduleHealthSummaryRefresh();
  return out.r;
}

