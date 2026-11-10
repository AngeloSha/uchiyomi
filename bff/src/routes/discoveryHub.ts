import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actsAsAdmin, authenticate, roleOf, userIdOf } from '../lib/auth';
import { one } from '../lib/db';
import { hideAdult, viewCtxFor } from '../lib/visibility';
import { clearDiscoveryChoice, DiscoveryChoiceError, discoveryState, resetHiddenDiscovery, setDiscoveryChoice, setDiscoveryTab, validDiscoveryKey } from '../lib/discoveryHub';

const tabBody = z.object({ tab: z.enum(['for-you', 'sources']) }).strict();
// item is only a title hint for title-keyed tracker suggestions. Metadata/rating/art supplied by the client is ignored.
const choiceBody = z.object({ saved: z.boolean().optional(), hidden: z.boolean().optional(),
  item: z.object({ title: z.string().trim().min(1).max(600) }).passthrough().optional(),
}).strict().refine((v) => v.saved !== undefined || v.hidden !== undefined);

export default async function discoveryHubRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req, reply) => {
    const me = await one<{ perms: { canDownload?: boolean } | null }>('SELECT perms FROM users WHERE id=$1', [userIdOf(req)]);
    if (!me || !actsAsAdmin(req) && me.perms?.canDownload === false) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to add series." });
    }
    reply.header('cache-control', 'private, no-store');
    reply.header('vary', '*');
  });
  app.get('/api/discover/state', async (req) => discoveryState(userIdOf(req), await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) })));
  app.patch('/api/discover/state', async (req, reply) => {
    const body = tabBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Choose For you or Sources.' });
    await setDiscoveryTab(userIdOf(req), body.data.tab);
    return { tab: body.data.tab };
  });
  app.put('/api/discover/items/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const body = choiceBody.safeParse(req.body);
    if (!validDiscoveryKey(key) || !body.success) return reply.code(400).send({ error: 'bad_request', message: 'Choose a valid Discover title and action.' });
    try {
      const ctx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
      return { ok: true, ...await setDiscoveryChoice(userIdOf(req), ctx, key, { saved: body.data.saved, hidden: body.data.hidden, title: body.data.item?.title }) };
    } catch (e) {
      if (e instanceof DiscoveryChoiceError) return reply.code(e.status).send({ error: e.status === 404 ? 'not_found' : 'conflict', message: e.message });
      throw e;
    }
  });
  app.delete('/api/discover/items/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!validDiscoveryKey(key)) return reply.code(400).send({ error: 'bad_request', message: 'Choose a valid Discover title.' });
    await clearDiscoveryChoice(userIdOf(req), key);
    return { ok: true };
  });
  app.delete('/api/discover/hidden', async (req) => {
    await resetHiddenDiscovery(userIdOf(req));
    return { ok: true };
  });
}
