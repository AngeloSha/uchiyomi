/**
 * v0.49.1's admin routes: the other names a series goes by (lib/altTitles.ts), and Find other sources
 * (lib/findSources.ts). The idea, the name list and the name parsing are @TIGamingTV's (PR #119).
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 *
 * Server text stays English; the web words the codes (`too_short`, `non_latin`, `exists`, `busy`, `empty_scope`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { browsableIds, hideAdult, seriesVisible, viewCtxFor } from '../lib/visibility';
import { altTitleRows, recordAltTitles, refuseName, removeAltTitle, MAX_NAME_LEN } from '../lib/altTitles';
import { normTitle } from '../lib/titleMatch';
import { findState, startFind, stopFind, type FindScope } from '../lib/findSources';

const REFUSED: Record<string, string> = {
  too_short: 'A name needs at least five letters or digits to be matched.',
  non_latin: 'Only names written in Latin letters can be matched.',
};

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
   * `exists` (the series already goes by it -- stored, or its own title).
   */
  app.post('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ title: z.string().trim().min(1).max(MAX_NAME_LEN) }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `A name of 1 to ${MAX_NAME_LEN} characters.` });
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    const title = b.data.title;
    const refusal = refuseName(title);
    if (refusal) return reply.code(400).send({ error: refusal, message: REFUSED[refusal] });
    // recordAltTitles writes nothing for a key the series already has, or for its own title: both are `exists`.
    const written = await recordAltTitles(id, [title], 'admin', { userId: userIdOf(req) });
    if (!written.length) return reply.code(409).send({ error: 'exists', message: 'The series already goes by that name.' });
    await logAudit('series.alt_title.add', { userId: userIdOf(req), detail: { id, title, norm: normTitle(title) }, req });
    return { titles: await titlesOf(id) };
  });

  /** Forget one name, by its key. Idempotent: a key the series does not have answers the list as it is. */
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
   */
  app.post('/api/admin/sources/find', async (req, reply) => {
    const b = z.object({
      seriesIds: z.array(z.string().min(1).max(64)).max(500).optional(),
      sourceId: z.string().min(1).max(200).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!b.success || (b.data.seriesIds && b.data.sourceId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Name the series ({seriesIds}) or one source ({sourceId}).' });
    }
    const scope: FindScope = b.data.sourceId ? { sourceId: b.data.sourceId } : { seriesIds: b.data.seriesIds ?? [] };
    if ('seriesIds' in scope && !scope.seriesIds.length) return reply.code(400).send({ error: 'empty_scope', message: 'No series were named.' });
    // The audit line is written when the run ends, long after this answer; the two things logAudit reads of a
    // request, its IP and user agent, are taken now (POST /api/admin/sources/check does the same).
    const h = req.headers;
    const from = { ip: req.ip, headers: { 'x-forwarded-for': h['x-forwarded-for'], 'user-agent': h['user-agent'] } } as unknown as FastifyRequest;
    // The admin's own view, without the 18+ hide: that is a tidy screen, and the scope is what they asked for.
    const r = await startFind(scope, userIdOf(req)!, await viewCtxFor(userIdOf(req), roleOf(req)), from);
    if ('busy' in r) return reply.code(409).send({ error: 'busy', runId: r.busy, message: 'A Find other sources run is already going.' });
    if ('empty' in r) return reply.code(400).send({ error: 'empty_scope', message: 'None of those series can be searched for.' });
    return reply.code(202).send(r);
  });

  /**
   * Whether a run is going, the running run (or else the newest) in full, and the kept runs, newest first. Titles
   * of series this admin may not list are left out of `results`, and `current` with them.
   */
  app.get('/api/admin/sources/find', async (req) => {
    const st = await findState();
    const run = st.run;
    if (!run) return st;
    const ok = await listable(req, [run.current?.seriesId, ...run.results.map((r) => r.seriesId)]);
    const { current, ...rest } = run;
    return {
      ...st,
      run: {
        ...rest,
        ...(current && ok.has(current.seriesId) ? { current } : {}),
        results: run.results.map(({ title, ...r }) => (ok.has(r.seriesId) ? { ...r, title } : r)),
      },
    };
  });

  /** Stop the running run at once. `stopped` is false when none was running. */
  app.post('/api/admin/sources/find/stop', async (req) => {
    const stopped = stopFind();
    if (stopped) await logAudit('source.find.stop', { userId: userIdOf(req), req });
    return { stopped };
  });
}
