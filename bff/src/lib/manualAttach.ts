// Attaching and detaching a source by hand, with a person's eyes as the judge of the numbers (#243, @Squeaks72).
//
// Every other way to follow a source asks a machine first: the fill scan and Find other sources lay a candidate's chapter
// numbers over the series' own and need MIN_HAVE (3) of them to line up (lib/fill.ts, lib/findSources.ts `too_few`), and the
// add-time auto-follow wants a title match plus a numbering verdict. A series with one chapter -- or none -- can never pass
// that, which is exactly the series that most needs a new source. Here the person has searched, looked at the cover and the
// chapter count, and chosen: that is the judgement of the NUMBERS, so none of the numeric gates apply.
//
// The pair itself is still never taken on trust (lib/mainSource.ts says why: the next sweep fetches whatever it lists into
// the series' folder). The server asks the source for the pick (`getSeries`, under the source's own budget) and its own
// title must be ours or one of our other names (lib/autoFollow.ts titleMatch, judgeCandidate's step) -- else
// `title_differs`, unless the person, shown that, answers with `force`. What is stored is what the source calls it, never
// what the request says. A source that cannot say what the title is (no answer, no title) is `unreachable`, force or not:
// there is nothing to attach. A title the source rates adults-only follows the add's rule: refused to an account capped
// below 18, and it makes the series 18+ (never lowering a rating).
//
// The gates that guard what is NOT a matter of opinion all stay -- the source must be loaded, switched on, not cooling and
// within the account's age reach, the language guard, posting-order numbering, a run inside the series, a pending renumber
// -- and so does the follower cap on a plain follow.
//
//   as 'follower'  the source joins series_sources (added_by = the person, so the sheet says "also checked", not "followed
//                  for you"), through followJudged and its cap.
//   as 'main'      lib/mainSource.ts switchMainSource moves the series to the checked pair inside its one transaction (its
//                  `pick`), so nothing is written before the switch: a refused move leaves a follower row of that source
//                  exactly as it was. `old` is what becomes of the old main, as for Make main; a move defaults to dropping it.
//   no main yet    a series with no source at all (scanned from disk, or detached) takes the pick as its main whichever was
//                  asked.
//
// Detaching the main source: posting order refuses (the series takes its chapters from its numbering source alone, and
// detaching would strand it: nothing could attach a new main to it), then a follower is promoted when there is one (the
// old main is dropped), otherwise the series is left with no source. Files, progress and the folder never move either way.
import type { FastifyRequest } from 'fastify';
import { one, q, tx } from './db';
import { getSource } from './sources';
import { logAudit } from './audit';
import { seriesVisible, sourceAllowedFor, ADULT_RATING, type ViewCtx } from './visibility';
import { MAX_FOLLOWERS, bounded, followJudged, titleMatch } from './autoFollow';
import { altTitlesFor } from './altTitles';
import { runsInside } from './updater';
import { renumberRunning } from './numbering';
import { effectiveLang, followGuard, sourceLanguage } from './seriesLang';
import { canonLang } from './lang';
import { editionFollowing } from './editions';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { standingOf, standingRows } from './sourceStanding';
import { refileFailures } from './chapterFailures';
import { switchMainSource, type OldMain, type MainRefused } from './mainSource';
import { adultContentRating } from './ageRating';
import { budgetFor } from './sources/budget';
import { say, type Part } from './said';

export type AttachRefusal =
  | 'not_found' | 'is_main' | 'posting_order' | 'renumber_pending' | 'busy' | 'source_unavailable' | 'cooling'
  | 'language_differs' | 'cap' | 'moved' | 'no_main' | 'title_differs' | 'unreachable';

export interface AttachRefused {
  refused: AttachRefusal;
  /** What the refusal says, as a said code (lib/said.ts); absent for `not_found`. */
  said?: Part;
  /** `language_differs`: the follow route's edition to add instead, or the one the work holds. */
  edition?: { of: string; lang: string; existing?: { id: string; lang: string } };
  /** `title_differs`: what the source calls the pick, for the question that may answer with `force`. */
  theirTitle?: string;
}
export interface Attached {
  ok: true;
  as: 'follower' | 'main';
  from?: string | null;
  old?: 'kept' | 'dropped';
  /** What the source calls the pick: what was stored. */
  theirTitle: string;
}

const no = (refused: AttachRefusal, said?: Part, extra: Partial<AttachRefused> = {}): AttachRefused =>
  ({ refused, ...(said ? { said } : {}), ...extra });

/** How long the source may take to say what the pick is: the add dialog's lookup, widened for a solver (budgetFor). */
const ATTACH_LOOKUP_MS = 20_000;

type Pre = {
  title: string; source_id: string | null; source_series_id: string | null; numbering: string | null;
  numbering_pending: string | null; renumber_plan: unknown; deleted_at: string | null; merged_into: string | null; lang: string | null;
};
const PRE = 'title, source_id, source_series_id, numbering, numbering_pending, renumber_plan, deleted_at, merged_into, lang';

export interface AttachOpts { ctx: ViewCtx; userId: string | null; old?: OldMain; req?: FastifyRequest }
export interface AttachPick {
  source: string;
  sourceSeriesId: string;
  /** The person has seen the source call it something else, and attaches it anyway (`title_differs` answered). */
  force?: boolean;
}

/** The series' own checks, shared by attach and detach: the answer when one refuses, else the row. */
async function preflight(seriesId: string, ctx: ViewCtx): Promise<Pre | AttachRefused> {
  if (!(await seriesVisible(seriesId, ctx))) return no('not_found');
  const pre = await one<Pre>(`SELECT ${PRE} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!pre || pre.deleted_at || pre.merged_into) return no('not_found');
  if (pre.numbering === 'posting_order') return no('posting_order', say('numbering.postingRefusal'));
  if (pre.numbering_pending || pre.renumber_plan || renumberRunning(seriesId)) return no('renumber_pending', say('main.renumberPending'));
  if (runsInside(seriesId) > 0) return no('busy', say('renumber.checking'));
  return pre;
}

/** A switch's refusal in this module's terms (`not_followed` cannot happen with a pick: read as the main having moved). */
const fromSwitch = (out: MainRefused): AttachRefused =>
  out.refused === 'not_found' || !out.said ? no('not_found')
    : out.refused === 'not_followed' ? no('moved', say('main.moved'))
    : no(out.refused, out.said, out.edition ? { edition: out.edition } : {});

export async function attachManual(seriesId: string, pick: AttachPick, as: 'follower' | 'main', opts: AttachOpts): Promise<Attached | AttachRefused> {
  const pre = await preflight(seriesId, opts.ctx);
  if ('refused' in pre) return pre;
  if (pick.source === pre.source_id) return no('is_main', say('main.isMain'));
  const src = getSource(pick.source);
  const standing = (await standingRows([pick.source])).get(pick.source);
  if (!src || standing?.disabled || !sourceAllowedFor(src, opts.ctx.maxAgeRating)) return no('source_unavailable', say('main.unavailable'));
  // A source in a cooldown is not asked anything, by hand or not: the cooldown is the site asking for room.
  if (standing?.blocked_until && new Date(standing.blocked_until).getTime() > Date.now()) return no('cooling', say('attach.cooling', { name: src.name }));
  if (!(await followGuard(seriesId))(pick.source)) {
    const theirs = sourceLanguage(pick.source);
    const ours = effectiveLang(pre.lang, pre.source_id);
    const existing = await editionFollowing(seriesId, pick.source, opts.ctx);
    return no('language_differs',
      existing ? say('follow.languageDiffersEdition', { theirs, ours, edition: existing.lang }) : say('follow.languageDiffers', { theirs, ours }),
      { edition: { of: seriesId, lang: theirs, ...(existing ? { existing } : {}) } });
  }

  // ---- the pair, from the source itself ----
  // Reintroduce by storing the request's title and skipping the lookup: "a pick whose own title is another work is refused
  // until the person insists" in manualAttach.int.test.ts attaches it.
  let found: { title?: string; contentRating?: string } | null = null;
  try {
    found = await bounded(src.getSeries(pick.sourceSeriesId), budgetFor(src, ATTACH_LOOKUP_MS));
  } catch { found = null; }
  const theirTitle = found?.title?.trim() || '';
  if (!theirTitle) return no('unreachable', say('attach.unreachable', { name: src.name }));
  const adult = adultContentRating(found?.contentRating);
  // The add's per-title age rule: MangaDex as a whole is not an adult source, its erotica is.
  if (adult && opts.ctx.maxAgeRating !== null && opts.ctx.maxAgeRating < ADULT_RATING) return no('source_unavailable', say('main.unavailable'));
  const match = titleMatch(theirTitle, { title: pre.title, altTitles: await altTitlesFor(seriesId) });
  if (!match && !pick.force) return no('title_differs', say('attach.titleDiffers', { name: src.name, title: theirTitle }), { theirTitle });

  const audit = (detail: Record<string, unknown>) => logAudit('series.attach_source', {
    userId: opts.userId,
    detail: { id: seriesId, title: pre.title, source: pick.source, sourceSeriesId: pick.sourceSeriesId, theirTitle, ...(match ? {} : { forced: true }), ...detail },
    req: opts.req,
  });
  // 18+ when its source says so, as the add stores it: GREATEST never lowers a rating, and an admin's override still wins.
  const rate = async () => { if (adult) await q('UPDATE lib_series SET age_rating = GREATEST(age_rating, $2::int) WHERE id = $1', [seriesId, ADULT_RATING]); };

  // ---- a plain follower ----
  if (as === 'follower' && pre.source_id) {
    const r = await followJudged(seriesId, { source: pick.source, name: src.name, sourceSeriesId: pick.sourceSeriesId, theirTitle, coverage: null }, { addedBy: opts.userId });
    if (r === 'gone') return no('not_found');
    if (r === 'cap') return no('cap', say('attach.cap', { n: MAX_FOLLOWERS }));
    await rate();
    await audit({ as: 'follower' });
    return { ok: true, as: 'follower', theirTitle };
  }

  // ---- the new main (or the first one): the switch writes the checked pair in its own transaction ----
  const out = await switchMainSource(seriesId, pick.source, {
    old: opts.old ?? 'drop', ctx: opts.ctx, userId: opts.userId, via: 'manual', req: opts.req,
    expect: pre.source_id, pick: { ref: pick.sourceSeriesId },
  });
  if ('refused' in out) return fromSwitch(out);
  await rate();
  await audit({ as: 'main', from: out.from, old: out.old });
  return { ok: true, as: 'main', from: out.from, ...(out.from ? { old: out.old } : {}), theirTitle };
}

export interface Detached { ok: true; promoted: string | null }

/** Detach the main source: a follower takes over when the series has one; otherwise the series is left with no source. */
export async function detachMain(seriesId: string, opts: AttachOpts): Promise<Detached | AttachRefused> {
  const pre = await preflight(seriesId, opts.ctx);
  if ('refused' in pre) return pre;
  if (!pre.source_id) return no('no_main', say('detach.noMain'));
  const from = pre.source_id;
  const followers = await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [seriesId]);
  if (followers.length) {
    // A follower that still carries the series first (usable or cooling), in follow order; the rest after.
    const standing = await standingRows(followers.map((f) => f.source_id));
    const off = (id: string) => Number(!['usable', 'cooling'].includes(standingOf(id, standing.get(id))));
    const ranked = [...followers].sort((a, b) => off(a.source_id) - off(b.source_id));
    let last: AttachRefused | null = null;
    for (const f of ranked) {
      const out = await switchMainSource(seriesId, f.source_id, { old: 'drop', ctx: opts.ctx, userId: opts.userId, via: 'manual', req: opts.req, expect: from });
      if (!('refused' in out)) {
        await logAudit('series.detach_main', { userId: opts.userId, detail: { id: seriesId, title: pre.title, source: from, promoted: f.source_id }, req: opts.req });
        return { ok: true, promoted: f.source_id };
      }
      last = fromSwitch(out);
      if (out.refused !== 'source_unavailable' && out.refused !== 'language_differs') break;
    }
    return last!;
  }
  const done = await tx<AttachRefused | true>(async (qq) => {
    const [row] = await qq<Pre>(`SELECT ${PRE} FROM lib_series WHERE id = $1 FOR UPDATE`, [seriesId]);
    if (!row || row.deleted_at || row.merged_into) return no('not_found');
    if (row.source_id !== from) return no('moved', say('main.moved'));
    if (row.numbering === 'posting_order') return no('posting_order', say('numbering.postingRefusal'));
    if (row.numbering_pending || row.renumber_plan) return no('renumber_pending', say('main.renumberPending'));
    // The language stays what it reads as now, as a main-source switch keeps it (lib/mainSource.ts): one inferred from the
    // main source is pinned before the source goes, or the series would change language by the way.
    if (canonLang(row.lang) === null && effectiveLang(null, from) !== effectiveLang(null, null)) {
      await qq('UPDATE lib_series SET lang = $2 WHERE id = $1', [seriesId, effectiveLang(null, from)]);
    }
    await qq('UPDATE lib_series SET source_id = NULL, source_series_id = NULL WHERE id = $1', [seriesId]);
    // The unfollow's rule: the listing rows it carried go with it, or a member could still fetch through it.
    await qq('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [seriesId, from]);
    await refileFailures(qq, [seriesId]);
    return true;
  });
  if (done !== true) return done;
  await logAudit('series.detach_main', { userId: opts.userId, detail: { id: seriesId, title: pre.title, source: from, promoted: null }, req: opts.req });
  scheduleHealthSummaryRefresh();
  return { ok: true, promoted: null };
}
