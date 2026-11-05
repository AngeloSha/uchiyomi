import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { APP_ROUTER_OPTIONS } from '../src/lib/httpLimits';

test('encoded long job folders reach both dismiss and cancel without truncation', async () => {
  const app = Fastify({ routerOptions: APP_ROUTER_OPTIONS });
  app.delete('/api/sources/jobs/:folder', async req => req.params);
  app.post('/api/sources/jobs/:folder/cancel', async req => req.params);
  const folder = 'Source/' + 'A manga title with spaces and 漫画 '.repeat(14);
  try {
    for (const [method, suffix] of [['DELETE', ''], ['POST', '/cancel']] as const) {
      const response = await app.inject({ method, url: `/api/sources/jobs/${encodeURIComponent(folder)}${suffix}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { folder });
    }
    const tooLong = await app.inject({ method: 'DELETE', url: '/api/sources/jobs/' + 'a'.repeat(8192) });
    assert.equal(tooLong.statusCode, 414, 'router parameters remain bounded');
  } finally { await app.close(); }
});
