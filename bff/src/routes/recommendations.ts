// Discover's "Recommended for you": suggestions built from the trackers a person has connected.
// The work, and the care taken not to wear out AniList and MyAnimeList, is in lib/trackerRecs.ts.
import type { FastifyInstance } from 'fastify';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { viewCtxFor, hideAdult, ADULT_RATING } from '../lib/visibility';
import { recommendationsFor } from '../lib/trackerRecs';
import { normTitle } from '../lib/trackerProviders';
import { heldFor, libraryIndex, noIndex } from '../lib/discoverIdentity';

export default async function recommendationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/discover/recommendations', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const ctx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
    // An adult title is shown only to a viewer who is neither hiding 18+ nor capped below it.
    const restrictAdult = ctx.hideAdultLibraries || (ctx.maxAgeRating !== null && ctx.maxAgeRating < ADULT_RATING);
    const out = await recommendationsFor(userIdOf(req), {
      restrictAdult,
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
