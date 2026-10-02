/**
 * v0.51.0's admin route for the automatic banner (lib/autoHero.ts): Shuffle, a new seed and a new banner.
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so it is admin-only
 * structurally, like routes/findSources.ts.
 */
import type { FastifyInstance } from 'fastify';
import { userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { seriesVisible, viewCtxFor } from '../lib/visibility';
import { shuffleHero } from '../lib/autoHero';

export default async function autoHeroRoutes(app: FastifyInstance) {
  /**
   * Other chapters and other pages: `{ok: true, seed}`, the seed the web's banner URL now carries. The banner is made
   * before the seed changes, so `{ok: false, error: 'not_made'}` leaves the series with the one it had. 404 for a
   * series that is not there; 409 `not_automatic` for one that may not have an automatic banner (a real banner, or
   * 18+ by any rule).
   */
  app.post('/api/admin/series/:id/hero/shuffle', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    const r = await shuffleHero(id);
    if (!r) return reply.code(409).send({ error: 'not_automatic' });
    if (r.ok) await logAudit('series.hero_shuffle', { userId: userIdOf(req), detail: { id, seed: r.seed }, req });
    return r;
  });
}
