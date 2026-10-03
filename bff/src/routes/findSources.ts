/**
 * v0.49.1's admin routes: the other names a series goes by (lib/altTitles.ts), and Find other sources
 * (lib/findSources.ts). The idea, the name list and the name parsing are @TIGamingTV's (PR #119).
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 *
 * Server text stays English; the web words the codes (`too_short`, `non_latin`, `exists`, `busy`, `empty_scope`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { browsableIds, hideAdult, seriesVisible, viewCtxFor } from '../lib/visibility';
import { altTitleRows, recordAltTitles, refuseName, removeAltTitle, MAX_NAME_LEN } from '../lib/altTitles';
import { normTitle } from '../lib/titleMatch';
import { POSTING_ORDER_REFUSAL } from '../lib/numbering';
import { saidOf } from '../lib/said';
import {
  decideProposal, findState, promoteProposal, replacePreview, startFind, stopFind,
  type DecideRefusal, type FindProposal, type FindResult, type FindScope, type PromoteRefusal,
} from '../lib/findSources';

const REFUSED: Record<string, string> = {
  too_short: 'A name needs at least five letters or digits to be matched.',
  non_latin: 'Only names written in Latin letters can be matched.',
};

/** A review decision that did not happen (lib/findSources.ts decideProposal): its status and its words. */
const DECLINED: Record<DecideRefusal, [number, string]> = {
  not_found: [404, 'That run has no such proposal.'],
  decided: [409, 'That proposal has been decided already.'],
  posting_order: [409, POSTING_ORDER_REFUSAL],
  source_unavailable: [409, 'That source is not available for this series right now.'],
  language_differs: [409, 'That source is in another language than this series.'],
  already_followed: [409, 'The series follows that source already.'],
  full: [409, 'The series already follows as many other sources as a series may.'],
};

/**
 * A Replace review's promotion that did not happen (v0.54.0): a decision's refusals, and a switch's -- whose words
 * come as said codes from lib/findSources.ts promoteProposal (`said`), where the English below is only the fallback.
 */
const NOT_PROMOTED: Record<PromoteRefusal, [number, string]> = {
  ...DECLINED,
  moved: [409, 'This series’ main source changed meanwhile. Look again.'],
  busy: [409, 'This series is being checked right now. Try again when that ends.'],
  renumber_pending: [409, 'This series’ chapters are waiting to be renumbered. Review that on the series page first.'],
  not_followed: [409, 'This series does not follow that source. Only a source it follows can become its main source.'],
  is_main: [409, 'That source is already this series’ main source.'],
};

/**
 * One series' result as this viewer may read it: a series they may not list keeps its entry without its title, and
 * its proposals without the candidates' titles, covers and pages, which would name it as plainly (v0.51.0).
 * Reintroduce by keeping the proposals as stored: "a review-first run follows nothing" in findSources.int.test.ts
 * reads the adult series' candidate with the 18+ hide on.
 */
function shown(r: FindResult, ok: Set<string>): Omit<FindResult, 'proposals'> & { proposals?: Array<Partial<FindProposal>> } {
  if (ok.has(r.seriesId)) return r;
  const { title: _t, ...rest } = r;
  return rest.proposals ? { ...rest, proposals: rest.proposals.map(({ title: _pt, coverUrl: _c, url: _u, ...p }) => p) } : rest;
}

/** A series' names as the admin reads them: who added one by name, never by account id. */
async function titlesOf(seriesId: string) {
  const rows = await altTitleRows(seriesId);
  const ids = [...new Set(rows.map((r) => r.added_by).filter((x): x is string => !!x))];
  const names = new Map((ids.length
    ? await q<{ id: string; username: string | null }>('SELECT id::text AS id, username FROM users WHERE id::text = ANY($1)', [ids])
    : []).map((u) => [u.id, u.username]));
  return rows.map((r) => ({
    title: r.title,
    // The key DELETE takes. The web can derive it (web/lib/normTitle.ts is the same rule), but naming it here means
    // it never has to.
    norm: r.norm,
    origin: r.origin,
    addedBy: r.added_by ? names.get(r.added_by) ?? null : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Which of these series this admin may see NAMED: a run's results are a listing, so they follow the rule of
 * /api/sources/jobs' "now on …" and the repair's answers -- the entry stays, the title of a series the viewer may
 * not list (the 18+ hide, above all) goes.
 */
async function listable(req: FastifyRequest, ids: Array<string | undefined>): Promise<Set<string>> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return new Set();
  return browsableIds(list, await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) }));
}

export default async function findSourcesRoutes(app: FastifyInstance) {
  // ---- other names ----

  app.get('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    return { titles: await titlesOf(id) };
  });

  /**
   * Add a name by hand. Refused before anything is written: `non_latin` (a name in another script normalises to
   * nothing and can never be compared), `too_short` (a key under five characters is a word, not an identity), and
   * `exists` (the series already goes by it -- stored, or its own title). A name removed earlier is the admin's to
   * bring back: typed again, it returns as their own.
   */
  app.post('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ title: z.string().trim().min(1).max(MAX_NAME_LEN) }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `A name of 1 to ${MAX_NAME_LEN} characters.` });
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    const title = b.data.title;
    const refusal = refuseName(title);
    if (refusal) return reply.code(400).send({ error: refusal, message: REFUSED[refusal] });
    // recordAltTitles writes nothing for a key the series already has (unless it was removed), or for its own title:
    // both are `exists`.
    const written = await recordAltTitles(id, [title], 'admin', { userId: userIdOf(req) });
    if (!written.length) return reply.code(409).send({ error: 'exists', message: 'The series already goes by that name.' });
    await logAudit('series.alt_title.add', { userId: userIdOf(req), detail: { id, title, norm: normTitle(title) }, req });
    return { titles: await titlesOf(id) };
  });

  /**
   * Forget one name, by its key. It stays removed when the source's details are read again, whatever its origin (kept
   * as a tombstone, lib/altTitles.ts removeAltTitle); typed again by hand, it returns as the admin's own. Idempotent:
   * a key the series does not have answers the list as it is.
   */
  app.delete('/api/admin/series/:id/alt-titles/:norm', async (req, reply) => {
    const { id, norm } = req.params as { id: string; norm: string };
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    await removeAltTitle(id, norm);
    await logAudit('series.alt_title.remove', { userId: userIdOf(req), detail: { id, norm }, req });
    return { titles: await titlesOf(id) };
  });

  // ---- Find other sources ----

  /**
   * Start a run over the series named, or over every series whose MAIN source is `sourceId` (the "this source is
   * down" case Health's button sends). One at a time: 409 `busy` with the running run's id. 400 `empty_scope` when
   * nothing named is a series this admin may see. 202 with the run's id and how many series it will ask about.
   * `review: true` (v0.51.0): review first -- the same run, which follows nothing and keeps its candidates.
   * `mode: 'replace'` (v0.54.0, with `sourceId` only): Replace -- move every series off that source -- and `turnOff`
   * (Replace only, never with review) to turn it off once no series is left on it; 400 otherwise.
   */
  app.post('/api/admin/sources/find', async (req, reply) => {
    const b = z.object({
      seriesIds: z.array(z.string().min(1).max(64)).max(500).optional(),
      sourceId: z.string().min(1).max(200).optional(),
      review: z.boolean().optional(),
      mode: z.enum(['follow', 'replace']).optional(),
      turnOff: z.boolean().optional(),
    }).strict().safeParse(req.body ?? {});
    if (!b.success || (b.data.seriesIds && b.data.sourceId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Name the series ({seriesIds}) or one source ({sourceId}).' });
    }
    const replace = b.data.mode === 'replace';
    if (replace && !b.data.sourceId) return reply.code(400).send({ error: 'bad_request', message: 'Replace names the source it replaces ({sourceId}).' });
    if (b.data.turnOff && !replace) return reply.code(400).send({ error: 'bad_request', message: 'Only Replace turns a source off ({mode: "replace"}).' });
    if (b.data.turnOff && b.data.review) {
      return reply.code(400).send({ error: 'bad_request', message: 'A review moves nothing by itself, so it cannot turn the source off when it ends.' });
    }
    const scope: FindScope = b.data.sourceId ? { sourceId: b.data.sourceId } : { seriesIds: b.data.seriesIds ?? [] };
    if ('seriesIds' in scope && !scope.seriesIds.length) return reply.code(400).send({ error: 'empty_scope', message: 'No series were named.' });
    // The audit line is written when the run ends, long after this answer; the two things logAudit reads of a
    // request, its IP and user agent, are taken now (POST /api/admin/sources/check does the same).
    const h = req.headers;
    const from = { ip: req.ip, headers: { 'x-forwarded-for': h['x-forwarded-for'], 'user-agent': h['user-agent'] } } as unknown as FastifyRequest;
    // The admin's own view, without the 18+ hide: that is a tidy screen, and the scope is what they asked for.
    const r = await startFind(scope, userIdOf(req)!, await viewCtxFor(userIdOf(req), roleOf(req)), from, {
      review: b.data.review, ...(replace ? { mode: 'replace' as const, turnOff: b.data.turnOff } : {}),
    });
    if ('busy' in r) return reply.code(409).send({ error: 'busy', runId: r.busy, message: 'A Find other sources run is already going.' });
    // v0.55.0: Fix everything finds and replaces sources itself, one run after another (lib/autofix.ts).
    if ('autofix' in r) return reply.code(409).send({ error: 'autofix_running', message: 'Fix everything is running; it finds and replaces sources itself.' });
    if ('empty' in r) return reply.code(400).send({ error: 'empty_scope', message: 'None of those series can be searched for.' });
    return reply.code(202).send(r);
  });

  /**
   * Whether a run is going, the running run (or else the newest) in full, and the kept runs, newest first. Titles
   * of series this admin may not list are left out of `results`, and `current` with them. `?runId=` (v0.52.0): that
   * kept run in full instead, an earlier search reopened; 404 `not_found` when no kept run has that id.
   */
  app.get('/api/admin/sources/find', async (req, reply) => {
    const runId = (req.query as { runId?: unknown }).runId;
    if (runId !== undefined && (typeof runId !== 'string' || !runId || runId.length > 64)) {
      return reply.code(400).send({ error: 'bad_request', message: 'runId names one kept run.' });
    }
    const st = await findState({ runId });
    const run = st.run;
    if (!run && runId !== undefined) return reply.code(404).send({ error: 'not_found', message: 'That search is no longer kept.' });
    if (!run) return st;
    const ok = await listable(req, [run.current?.seriesId, ...run.results.map((r) => r.seriesId)]);
    const { current, ...rest } = run;
    return {
      ...st,
      run: {
        ...rest,
        ...(current && ok.has(current.seriesId) ? { current } : {}),
        results: run.results.map((r) => shown(r, ok)),
      },
    };
  });

  /**
   * A review-first run's proposal, decided (v0.51.0): follow it -- checked again, then the same write as every follow,
   * under the follower cap -- or dismiss it. Body `{seriesId, sourceId}`; the rest is the run's own record. 200 with
   * the series' result as it now reads; 404 `not_found`; 409 `decided` (with `state`), `posting_order`,
   * `source_unavailable`, `language_differs` (with `edition: {of, lang}`, v0.52.0), `already_followed` or `full`
   * (lib/findSources.ts decideProposal says each).
   */
  const decision = (kind: 'follow' | 'dismiss') => async (req: FastifyRequest, reply: FastifyReply) => {
    const { runId } = req.params as { runId: string };
    const b = z.object({ seriesId: z.string().min(1).max(64), sourceId: z.string().min(1).max(200) }).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Name the series and the source ({seriesId, sourceId}).' });
    const out = await decideProposal(runId, b.data.seriesId, b.data.sourceId, kind, userIdOf(req)!, await viewCtxFor(userIdOf(req), roleOf(req)));
    if ('refused' in out) {
      const [code, message] = DECLINED[out.refused];
      return reply.code(code).send({ error: out.refused, message, ...(out.state ? { state: out.state } : {}), ...(out.edition ? { edition: out.edition } : {}) });
    }
    return { result: shown(out.result, await listable(req, [out.result.seriesId])) };
  };
  app.post('/api/admin/sources/find/:runId/follow', decision('follow'));
  app.post('/api/admin/sources/find/:runId/dismiss', decision('dismiss'));

  /**
   * A Replace review's proposal made the series' main source (v0.54.0, lib/findSources.ts promoteProposal). Body
   * `{seriesId, sourceId}`. 200 with the series' result as it now reads (`promoted` on it, the proposal `promoted`);
   * 404 `not_found`; 409 `decided` (with `state`), `posting_order`, `source_unavailable`, `language_differs` (with
   * `edition`), `full`, `moved`, `busy`, `renumber_pending`, `not_followed` or `is_main`, with `messageSaid` where the
   * refusal has a code.
   */
  app.post('/api/admin/sources/find/:runId/promote', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const b = z.object({ seriesId: z.string().min(1).max(64), sourceId: z.string().min(1).max(200) }).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Name the series and the source ({seriesId, sourceId}).' });
    const out = await promoteProposal(runId, b.data.seriesId, b.data.sourceId, userIdOf(req)!, await viewCtxFor(userIdOf(req), roleOf(req)));
    if ('refused' in out) {
      const [code, message] = NOT_PROMOTED[out.refused];
      return reply.code(code).send({
        error: out.refused, message: out.said?.text ?? message, ...(out.said ? { messageSaid: saidOf(out.said) } : {}),
        ...(out.state ? { state: out.state } : {}), ...(out.edition ? { edition: out.edition } : {}),
      });
    }
    return { result: shown(out.result, await listable(req, [out.result.seriesId])) };
  });

  /**
   * What a Replace run over this source would do (v0.54.0), as the dialog says it before Start: `main` (the series
   * whose main source it is), `withBackup` (of those, the ones a working follower takes over at once), `toSearch` (the
   * ones it searches for), `postingOrder` (the ones it leaves alone), and `busy` (a Find or Replace run is going).
   */
  app.get('/api/admin/sources/:id/replace-preview', async (req) => {
    const { id } = req.params as { id: string };
    return replacePreview(id, await viewCtxFor(userIdOf(req), roleOf(req)));
  });

  /** Stop the running run at once. `stopped` is false when none was running. */
  app.post('/api/admin/sources/find/stop', async (req) => {
    const stopped = stopFind();
    if (stopped) await logAudit('source.find.stop', { userId: userIdOf(req), req });
    return { stopped };
  });
}
