// What a client is told when something goes wrong.
//
// `server.ts` has always had a `setErrorHandler` whose whole job is to keep internals off the wire: map a
// KomgaError to its real status, log 5xx server-side, and reply with a bare `{ error: 'internal' }` instead
// of whatever the exception happened to say. It was registered AFTER the `await app.register(...)` calls, and
// Fastify resolves a route's error handler from the encapsulation context that existed when that route was
// registered -- so it applied to nothing, and every route fell through to Fastify's default handler, which
// replies with the raw `err.message`.
//
// Found by driving the real API: `PUT /api/ratings/:id` with the wrong field name answered
//
//   500 {"statusCode":500,"error":"Internal Server Error","message":"[{\"code\":\"invalid_type\",
//        \"expected\":\"number\",\"received\":\"undefined\",\"path\":[\"stars\"],...}]"}
//
// which is the wrong status (the client's body was malformed, not the server) and hands back the schema.
//
// These tests pin ORDER, not just behaviour: they register a route before setting the handler exactly the way
// server.ts used to, because that is the mistake, and it is invisible in a test that only checks the handler
// in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

test('a malformed body is answered 400, without echoing the schema', { skip }, async (t) => {
  const Fastify = (await import('fastify')).default;
  const { z, ZodError } = await import('zod');

  const schema = z.object({ stars: z.number().int().min(1).max(10) });

  // Exactly the handler server.ts installs.
  const install = (app: any) =>
    app.setErrorHandler((err: any, req: any, reply: any) => {
      if (err instanceof ZodError) {
        return reply.code(400).send({
          error: 'bad_request',
          fields: err.issues.map((i: any) => i.path.join('.')).filter(Boolean),
        });
      }
      const status = err.statusCode || 500;
      if (status >= 500) req.log.error(err);
      return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
    });

  await t.test('handler first: the client gets 400 and no internals', async () => {
    const app = Fastify({ logger: false });
    install(app);
    await app.register(async (i: any) => {
      i.put('/r', async (req: any) => schema.parse(req.body ?? {}));
      i.get('/boom', async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); });
    });
    await app.ready();

    const bad = await app.inject({ method: 'PUT', url: '/r', payload: { rating: 9 } });
    assert.equal(bad.statusCode, 400, 'a malformed body is the client\'s error, not a server fault');
    const body = bad.json();
    assert.equal(body.error, 'bad_request');
    assert.deepEqual(body.fields, ['stars'], 'name the field, do not paste the schema');
    assert.ok(!bad.body.includes('invalid_type'), 'the raw ZodError leaked to the client');
    assert.ok(!bad.body.includes('expected'), 'the expected type leaked to the client');

    const boom = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(boom.statusCode, 500);
    assert.equal(boom.json().error, 'internal', 'a 5xx must not describe itself');
    assert.ok(!boom.body.includes('ECONNREFUSED'), 'the internal error message leaked');
    assert.ok(!boom.body.includes('10.0.0.5'), 'an internal address leaked to the client');
    await app.close();
  });

  await t.test('THE BUG: handler set after the routes applies to none of them', async () => {
    // This is what server.ts did. It is here so the fix cannot be quietly undone by moving the call back.
    const app = Fastify({ logger: false });
    await app.register(async (i: any) => {
      i.put('/r', async (req: any) => schema.parse(req.body ?? {}));
    });
    install(app);                                  // <-- too late
    await app.ready();

    const r = await app.inject({ method: 'PUT', url: '/r', payload: { rating: 9 } });
    assert.equal(r.statusCode, 500, 'registering the handler late is what produced a 500 here');
    assert.ok(r.body.includes('invalid_type'), 'and this is the schema dump it produced');
    await app.close();
  });
});

test('server.ts installs its error handler before it registers any route', () => {
  // The static half. The two orderings differ by one line and produce identical-looking code, so the
  // difference has to be asserted rather than reviewed.
  const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const handlerAt = src.indexOf('app.setErrorHandler(');
  const firstRouteAt = src.search(/await app\.register\((?:auth|admin|catalog|image|personal|download|source|opds)Routes\)/);

  assert.notEqual(handlerAt, -1, 'server.ts no longer sets an error handler at all');
  assert.notEqual(firstRouteAt, -1, 'could not find the route registrations');
  assert.ok(
    handlerAt < firstRouteAt,
    'setErrorHandler runs after the first route registration, so it applies to no route -- ' +
      'internal error messages and schema dumps go straight to clients again',
  );
});
