// The slow archive's routes (#117): queue series to be fetched slowly, pause, resume or stop one, and read the
// queue. Registered from INSIDE routes/sources.ts's plugin (registerArchiveRoutes), never on its own: that
// plugin's preHandler is what refuses an account without canDownload and resolves the viewer, and a second copy
// of that check here would be a second place for it to drift.
//
// The server-wide pause and the pacing are not here: they are the whole server's politeness towards every site,
// so they live in PATCH /api/admin/settings, behind the admin guard (lib/archive.ts ARCHIVE_SETTINGS_SHAPE).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { browsableIds, type ViewCtx } from '../lib/visibility';
import { enqueueArchive, archiveAct, archiveView, archiveSeriesIds, type EnqueueOutcome } from '../lib/archive';

/** How many series one request may queue: the Library's "select all" is bounded the same way elsewhere. */
export const ARCHIVE_MAX_SERIES = 500;

export function registerArchiveRoutes(app: FastifyInstance, vc: (req: FastifyRequest) => ViewCtx): void {
  /**
   * The queue as this viewer may see it: the same object GET /api/sources/jobs carries as `archive`, for a
   * surface that wants the archive alone. Filtered by browsable() by series id, after the shared cache.
   */
  app.get('/api/sources/archive', async (req) => {
    const ok = await browsableIds(await archiveSeriesIds(), vc(req));
    return archiveView((id) => ok.has(id), userIdOf(req));
  });

  /**
   * Queue series to be fetched slowly. Each id answers for itself -- one the viewer cannot see is `not_found`
   * and names no title, exactly as for no series at all -- so the Library's bulk action can say "12 queued, 3
   * had nothing older to fetch" in one round trip.
   */
  app.post('/api/sources/archive', async (req, reply) => {
    const b = z.object({ seriesIds: z.array(z.string().min(1).max(200)).min(1).max(ARCHIVE_MAX_SERIES) }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const ids = [...new Set(b.data.seriesIds)];
    const me = userIdOf(req);
    const results: Array<{ id: string; title?: string; outcome: EnqueueOutcome }> = [];
    for (const id of ids) {
      const outcome = await enqueueArchive(id, me, vc(req));
      results.push({ id, outcome });
    }
    // Titles for everything but not_found, which must not say whether a series it cannot see exists.
    const named = results.filter((r) => r.outcome !== 'not_found').map((r) => r.id);
    if (named.length) {
      const titles = new Map((await q<{ id: string; title: string }>('SELECT id, title FROM lib_series WHERE id = ANY($1::text[])', [named])
        .catch(() => [])).map((r) => [r.id, r.title]));
      for (const r of results) if (r.outcome !== 'not_found' && titles.has(r.id)) r.title = titles.get(r.id);
    }
    const queued = results.filter((r) => r.outcome === 'queued').map((r) => r.id);
    if (queued.length) await logAudit('download.archive', { userId: me, detail: { seriesIds: queued }, req });
    return { results };
  });

  const act = (what: 'pause' | 'resume' | 'stop') => async (req: FastifyRequest, reply: any) => {
    const { seriesId } = req.params as { seriesId: string };
    const r = await archiveAct(what, seriesId, { userId: userIdOf(req), admin: roleOf(req) === 'admin', ctx: vc(req) });
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'forbidden') return reply.code(403).send({ error: 'forbidden', message: 'Only the person who queued this archive, or an admin, may change it.' });
    if (r === 'done') return reply.code(409).send({ error: 'done', message: 'This archive has finished.' });
    if (what === 'stop') await logAudit('download.archive_stop', { userId: userIdOf(req), detail: { seriesId }, req });
    return { ok: true };
  };
  /** Stop taking chapters for this series until resumed; a chapter in flight finishes. Its boundary stays. */
  app.post('/api/sources/archive/:seriesId/pause', act('pause'));
  app.post('/api/sources/archive/:seriesId/resume', act('resume'));
  /**
   * Stop an archive, or dismiss a finished one. What landed stays; the rest goes back to the sweep, which fetches
   * below the floor again as it did before the archive was queued.
   */
  app.delete('/api/sources/archive/:seriesId', act('stop'));
}
