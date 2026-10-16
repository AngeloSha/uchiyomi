// Every response carries the Content-Security-Policy directives that cost the app nothing.
//
// No policy was sent at all (helmet's is off, because its defaults would block the static export's inline scripts).
// lib/securityHeaders.ts BASE_CSP sends the four that break nothing -- object-src 'none', base-uri 'self',
// frame-ancestors 'self', form-action 'self' -- on every BFF response, which in the single container includes the
// documents, and web/nginx.conf sends the same in the split layout. In nginx an add_header inside a location replaces
// the server's, so the documents' location repeats it (and the two headers the server block already had).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

test('the policy is the four safe directives, and no script or style rule that could break the app', async () => {
  const { BASE_CSP } = await import('../src/lib/securityHeaders');
  const directives = BASE_CSP.split(';').map((d) => d.trim().split(/\s+/)[0]).sort();
  assert.deepEqual(directives, ['base-uri', 'form-action', 'frame-ancestors', 'object-src']);
  assert.doesNotMatch(BASE_CSP, /default-src|script-src|style-src|img-src|connect-src/, 'a fetch directive would need the inline-script hashes first');
});

test('every BFF response carries it; a route with its own policy keeps that one', async () => {
  const { BASE_CSP, addBaseCsp } = await import('../src/lib/securityHeaders');
  const app = (await import('fastify')).default();
  addBaseCsp(app);
  app.get('/page', async (_req, reply) => reply.type('text/html').send('<!doctype html><p>hi'));
  app.get('/api/thing', async () => ({ ok: true }));
  app.get('/missing', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.get('/own', async (_req, reply) => reply.header('content-security-policy', "sandbox").send('x'));
  await app.ready();
  try {
    // Reintroduce by dropping addBaseCsp(app) from server.ts: the documents and the API answer without a policy.
    for (const url of ['/page', '/api/thing', '/missing']) {
      const r = await app.inject({ url });
      assert.equal(r.headers['content-security-policy'], BASE_CSP, `${url} has no policy`);
    }
    assert.equal((await app.inject({ url: '/own' })).headers['content-security-policy'], 'sandbox', 'a route\'s own policy was overwritten');
  } finally {
    await app.close();
  }
});

test('server.ts installs it', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(src, /\n\s*addBaseCsp\(app\);/, 'server.ts does not send the policy');
});

test('nginx sends the same policy, on the documents too', async () => {
  const { BASE_CSP } = await import('../src/lib/securityHeaders');
  const conf = readFileSync(join(__dirname, '..', '..', 'web', 'nginx.conf'), 'utf8');
  const line = `add_header Content-Security-Policy "${BASE_CSP}" always;`;
  const server = conf.slice(0, conf.search(/\n\s*location\s/));
  assert.ok(server.includes(line), 'the server block does not send the BFF\'s policy word for word');
  // The SPA location serves every document. Reintroduce by dropping the repeat: its own add_header Cache-Control
  // replaces the server's headers, and the pages go out with no policy (nor nosniff, nor a referrer policy).
  const docs = conf.slice(conf.indexOf('location / {'));
  const block = docs.slice(0, docs.indexOf('}'));
  for (const h of [line, 'add_header X-Content-Type-Options "nosniff" always;', 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;']) {
    assert.ok(block.includes(h), `the documents' location does not send: ${h}`);
  }
});
