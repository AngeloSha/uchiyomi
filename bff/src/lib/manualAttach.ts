// Attaching and detaching a source by hand, with a person's eyes as the judge.
//
// Every other way to follow a source asks a machine first: the fill scan and Find other sources lay a candidate's chapter
// numbers over the series' own and need MIN_HAVE (3) of them to line up (lib/fill.ts, lib/findSources.ts `too_few`), and the
// add-time auto-follow wants a title match plus a numbering verdict. A series with one chapter -- or none -- can never pass
// that, which is exactly the series that most needs a new source. Here the person has searched, looked at the cover and the
// chapter count, and chosen: that is the judgement, so none of the numeric gates apply. The gates that guard what is NOT a
// matter of opinion all stay -- the source must be loaded, enabled and within the account's age reach, the language guard,
// posting-order numbering, a run inside the series, a pending renumber -- and so does the follower cap on a plain follow.
//
//   as 'follower'  the source joins series_sources (added_by = the person, so the sheet says "also checked", not "followed for you").
//   as 'main'      the source becomes the main source (lib/mainSource.ts does the swap). The row is written first, past the cap
//                  -- the swap removes it again -- so a series already at the cap can still be moved. `old` is what becomes of
//                  the old main, as for Make main; a move defaults to dropping it.
//   no main yet    a series with no source at all (scanned from disk, or detached) takes the pick as its main whichever was asked.
//
// Detaching the main source: promote a follower when there is one (the old main is dropped), otherwise leave the series with
// no source. Files, progress and the folder never move either way -- the same promise as every other source change.
import type { FastifyRequest } from 'fastify';
import { one, q, tx } from './db';
import { getSource } from './sources';
import { logAudit } from './audit';
import { seriesVisible, sourceAllowedFor, type ViewCtx } from './visibility';
import { MAX_FOLLOWERS, followJudged } from './autoFollow';
import { runsInside } from './updater';
import { renumberRunning } from './numbering';
import { effectiveLang, followGuard, sourceLanguage } from './seriesLang';
import { editionFollowing } from './editions';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { standingRows } from './sourceStanding';
import { refileFailures } from './chapterFailures';
import { switchMainSource, type OldMain } from './mainSource';

export type AttachRefusal =
  | 'not_found' | 'is_main' | 'posting_order' | 'renumber_pending' | 'busy' | 'source_unavailable'
  | 'language_differs' | 'cap' | 'moved' | 'no_main';

export interface AttachRefused {
  refused: AttachRefusal;
  message: string;
  edition?: { of: string; lang: string; existing?: { id: string; lang: string } };
}
export interface Attached { ok: true; as: 'follower' | 'main'; from?: string | null; old?: 'kept' | 'dropped' }

const no = (refused: AttachRefusal, message: string, extra: Partial<AttachRefused> = {}): AttachRefused => ({ refused, message, ...extra });

const REFUSALS: Record<Exclude<AttachRefusal, 'language_differs'>, string> = {
  not_found: 'That series is not there.',
  is_main: 'That is already the series’ own main source.',
  posting_order: 'This series is numbered by posting order, so it takes its chapters from its numbering source alone.',
  renumber_pending: 'A renumber is waiting on this series. Finish or cancel it first.',
  busy: 'This series is being checked right now. Try again in a minute.',
  source_unavailable: 'That source is not available right now.',
  cap: `This series already follows ${MAX_FOLLOWERS} other sources. Detach one first, or make the new one the main source.`,
  moved: 'The main source changed while that was happening. Reopen the sheet and try again.',
  no_main: 'This series has no main source to detach.',
};

type Pre = {
  title: string; source_id: string | null; source_series_id: string | null; numbering: string | null;
  numbering_pending: string | null; renumber_plan: unknown; deleted_at: string | null; merged_into: string | null; lang: string | null;
};
const PRE = 'title, source_id, source_series_id, numbering, numbering_pending, renumber_plan, deleted_at, merged_into, lang';

export interface AttachOpts { ctx: ViewCtx; userId: string | null; old?: OldMain; req?: FastifyRequest }
export interface AttachPick { source: string; sourceSeriesId: string; title?: string | null }

export async function attachManual(seriesId: string, pick: AttachPick, as: 'follower' | 'main', opts: AttachOpts): Promise<Attached | AttachRefused> {
  if (!(await seriesVisible(seriesId, opts.ctx))) return no('not_found', REFUSALS.not_found);
  const pre = await one<Pre>(`SELECT ${PRE} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!pre || pre.deleted_at || pre.merged_into) return no('not_found', REFUSALS.not_found);
  if (pick.source === pre.source_id) return no('is_main', REFUSALS.is_main);
  if (pre.numbering === 'posting_order') return no('posting_order', REFUSALS.posting_order);
  if (pre.numbering_pending || pre.renumber_plan || renumberRunning(seriesId)) return no('renumber_pending', REFUSALS.renumber_pending);
  if (runsInside(seriesId) > 0) return no('busy', REFUSALS.busy);
  const src = getSource(pick.source);
  const standing = await standingRows([pick.source]);
  if (!src || standing.get(pick.source)?.disabled || !sourceAllowedFor(src, opts.ctx.maxAgeRating)) {
    return no('source_unavailable', REFUSALS.source_unavailable);
  }
  if (!(await followGuard(seriesId))(pick.source)) {
    const theirs = sourceLanguage(pick.source);
    const ours = effectiveLang(pre.lang, pre.source_id);
    const existing = await editionFollowing(seriesId, pick.source, opts.ctx);
    return no('language_differs',
      existing
        ? `That source is in ${theirs}, this series is in ${ours}. The ${existing.lang} edition already follows it — open that one.`
        : `That source is in ${theirs}, this series is in ${ours}. Add it as its own ${theirs} edition instead.`,
      { edition: { of: seriesId, lang: theirs, ...(existing ? { existing } : {}) } });
  }
  const theirTitle = pick.title?.trim() || null;
  const audit = (detail: Record<string, unknown>) => logAudit('series.attach_source', {
    userId: opts.userId, detail: { id: seriesId, title: pre.title, source: pick.source, sourceSeriesId: pick.sourceSeriesId, theirTitle, ...detail }, req: opts.req,
  });

  // ---- no main source yet: the pick becomes it ----
  if (!pre.source_id) {
    const done = await tx<boolean>(async (qq) => {
      const [row] = await qq<{ source_id: string | null; deleted_at: string | null; merged_into: string | null }>(
        'SELECT source_id, deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
      if (!row || row.deleted_at || row.merged_into || row.source_id) return false;
      await qq('UPDATE lib_series SET source_id = $2, source_series_id = $3 WHERE id = $1', [seriesId, pick.source, pick.sourceSeriesId]);
      await qq('DELETE FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, pick.source]);
      return true;
    });
    if (!done) return no('moved', REFUSALS.moved);
    await audit({ as: 'main', from: null });
    scheduleHealthSummaryRefresh();
    return { ok: true, as: 'main', from: null };
  }

  // ---- a plain follower ----
  if (as === 'follower') {
    const r = await followJudged(seriesId, { source: pick.source, name: src.name, sourceSeriesId: pick.sourceSeriesId, theirTitle, coverage: null }, { addedBy: opts.userId });
    if (r === 'gone') return no('not_found', REFUSALS.not_found);
    if (r === 'cap') return no('cap', REFUSALS.cap);
    await audit({ as: 'follower' });
    return { ok: true, as: 'follower' };
  }

  // ---- the new main: write the row past the cap, then let the swap move it ----
  const had = await one<{ source_series_id: string }>('SELECT source_series_id FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, pick.source]);
  const wrote = await tx<boolean>(async (qq) => {
    const [row] = await qq<{ deleted_at: string | null; merged_into: string | null }>('SELECT deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!row || row.deleted_at || row.merged_into) return false;
    await qq(
      `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (series_id, source_id) DO UPDATE SET source_series_id = EXCLUDED.source_series_id, title = EXCLUDED.title,
         added_by = COALESCE(EXCLUDED.added_by, series_sources.added_by)`,
      [seriesId, pick.source, pick.sourceSeriesId, theirTitle, opts.userId]);
    return true;
  });
  if (!wrote) return no('not_found', REFUSALS.not_found);
  const out = await switchMainSource(seriesId, pick.source, { old: opts.old ?? 'drop', ctx: opts.ctx, userId: opts.userId, via: 'manual', req: opts.req });
  if ('refused' in out) {
    if (!had) await q('DELETE FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, pick.source]).catch(() => {});
    return no(out.refused === 'not_followed' ? 'moved' : out.refused as AttachRefusal, out.said?.text ?? REFUSALS.moved, out.edition ? { edition: out.edition } : {});
  }
  await audit({ as: 'main', from: out.from, old: out.old });
  return { ok: true, as: 'main', from: out.from, old: out.old };
}

export interface Detached { ok: true; promoted: string | null }

/** Detach the main source: a follower takes over when the series has one; otherwise the series is left with no source. */
export async function detachMain(seriesId: string, opts: AttachOpts): Promise<Detached | AttachRefused> {
  if (!(await seriesVisible(seriesId, opts.ctx))) return no('not_found', REFUSALS.not_found);
  const pre = await one<Pre>(`SELECT ${PRE} FROM lib_series WHERE id = $1`, [seriesId]);
  if (!pre || pre.deleted_at || pre.merged_into) return no('not_found', REFUSALS.not_found);
  if (!pre.source_id) return no('no_main', REFUSALS.no_main);
  if (pre.numbering_pending || pre.renumber_plan || renumberRunning(seriesId)) return no('renumber_pending', REFUSALS.renumber_pending);
  if (runsInside(seriesId) > 0) return no('busy', REFUSALS.busy);
  const followers = await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [seriesId]);
  if (followers.length) {
    const standing = await standingRows(followers.map((f) => f.source_id));
    const ranked = [...followers].sort((a, b) => Number(!!standing.get(a.source_id)?.disabled) - Number(!!standing.get(b.source_id)?.disabled));
    let last: AttachRefused | null = null;
    for (const f of ranked) {
      const out = await switchMainSource(seriesId, f.source_id, { old: 'drop', ctx: opts.ctx, userId: opts.userId, via: 'manual', req: opts.req });
      if (!('refused' in out)) {
        await logAudit('series.detach_main', { userId: opts.userId, detail: { id: seriesId, title: pre.title, source: pre.source_id, promoted: f.source_id }, req: opts.req });
        return { ok: true, promoted: f.source_id };
      }
      last = no(out.refused as AttachRefusal, out.said?.text ?? REFUSALS.moved);
      if (out.refused !== 'source_unavailable' && out.refused !== 'language_differs') break;
    }
    return last!;
  }
  const from = pre.source_id;
  const done = await tx<boolean>(async (qq) => {
    const [row] = await qq<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!row || row.source_id !== from) return false;
    await qq('UPDATE lib_series SET source_id = NULL, source_series_id = NULL WHERE id = $1', [seriesId]);
    await qq('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [seriesId, from]);
    await refileFailures(qq, [seriesId]);
    return true;
  });
  if (!done) return no('moved', REFUSALS.moved);
  await logAudit('series.detach_main', { userId: opts.userId, detail: { id: seriesId, title: pre.title, source: from, promoted: null }, req: opts.req });
  scheduleHealthSummaryRefresh();
  return { ok: true, promoted: null };
}
