// Discover's "Recommended for you" (#248, @Squeaks72): suggestions built from the trackers a person has connected.
// The work, and the care taken not to wear out AniList and MyAnimeList, is in lib/trackerRecs.ts.
import type { FastifyInstance } from 'fastify';
import { actsAsAdmin, authenticate, userIdOf, roleOf } from '../lib/auth';
import { one } from '../lib/db';
import { viewCtxFor, hideAdult } from '../lib/visibility';
import { recommendationsFor } from '../lib/trackerRecs';
import { normTitle } from '../lib/trackerProviders';
import { heldFor, libraryIndex, noIndex } from '../lib/discoverIdentity';

export default async function recommendationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /**
   * Behind Discover's canDownload rule (routes/sources.ts's hook, which this file is not under): a list of things to add,
   * so an account that may not add series is refused before anything reads its trackers -- it must not spend its
   * token, and the server's shared hourly budgets, on suggestions it cannot act on. Only the literal `false` denies,
   * an admin is exempt, and an unreadable account row denies, as there.
   * Reintroduce by dropping it: "a member who may not add series is refused, and nothing is asked" in
   * recommendationsRoute.int.test.ts answers 200.
   */
  app.addHook('preHandler', async (req, reply) => {
    const me = await one<{ role: string; perms: { canDownload?: boolean } | null }>(
      'SELECT role, perms FROM users WHERE id = $1', [userIdOf(req)]).catch(() => null);
    if (!me) return reply.code(403).send({ error: 'forbidden', message: 'Could not check your permissions.' });
    if (!actsAsAdmin(req) && me.perms?.canDownload === false) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to add series." });
    }
  });

  app.get('/api/discover/recommendations', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    // The viewer as every Discover rail judges them: the age cap, the 18+ reveal, the admin's adult genres and the
    // libraries they may browse (lib/trackerRecs.ts viewerJudge and its local seeds).
    const ctx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
    const out = await recommendationsFor(userIdOf(req), {
      ctx,
      // Which of these names the library already holds, asked of the index Discover answers from (v0.56.0, which
      // replaced routes/sources.ts inLibrary): a name, or a name the services know to be the same work. No source or
      // id to go on here -- a suggestion is a title, not a listing -- so the name is the whole of the evidence. A
      // library that cannot be read holds nothing, and nothing is left out.
      inLibrary: async (titles) => {
        const idx = await libraryIndex().catch(() => noIndex());
        const held = new Set<string>();
        for (const t of titles) if (heldFor(idx, { source: '', sourceId: '', title: t }).length) held.add(normTitle(t));
        return held;
      },
    });
    return out;
  });
}
