import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, userIdOf } from '../lib/auth';
import { externalReaderSettings, externalReaderCounts } from '../lib/externalReading';
import { q } from '../lib/db';

export default async function externalReaders(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.get('/api/external-readers', async req => {
    const uid=userIdOf(req);
    const counts=await externalReaderCounts(uid);
    return {...await externalReaderSettings(uid),supported:process.env.LIBRARY_BACKEND!=='komga',byReader:counts};
  });
  app.put('/api/external-readers', async (req,reply) => {
    if(process.env.LIBRARY_BACKEND==='komga')return reply.code(409).send({error:'external_readers_unsupported'});
    const body=z.object({externalReadingStats:z.boolean().optional(),opdsEstimatedBookmarks:z.boolean().optional()}).strict().safeParse(req.body);
    if(!body.success)return reply.code(400).send({error:'bad_request'});
    await q(`INSERT INTO app_settings(user_id,data) VALUES($1,$2::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET data=app_settings.data||EXCLUDED.data`,[userIdOf(req),JSON.stringify(body.data)]);
    return externalReaderSettings(userIdOf(req));
  });
}
