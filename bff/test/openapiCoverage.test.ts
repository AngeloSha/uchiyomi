// The API reference cannot drift from the API.
//
// bff/openapi.yaml is hand-maintained, and docs/api.md's route list was too -- at 181 of 182 routes, with
// nothing holding it there. This makes both a tested claim: every route Fastify actually registers must
// appear in the spec, every spec path must be a real route, and the same in both directions for the docs'
// route list. A route added without its operation fails here, not in a user's client.
//
// The route table is collected with an `onRoute` hook rather than by parsing printRoutes() -- that is a
// tree drawing meant for eyes -- and the app is built without a database: the route plugins only validate
// env on load, so a placeholder DSN is enough to register them and read the table back.
//
// The third test boots the documentation server itself, because "the file is right" and "the server serves
// it" are different claims, and the second one has a COPY line in two Dockerfiles behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
process.env.LIBRARY_BACKEND ||= 'owned';

const REPO = join(__dirname, '..', '..');
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const key = (m: string, p: string) => `${m.toUpperCase()} ${p}`;
/** `:id` in Fastify is `{id}` in OpenAPI; everything else compares as written. */
const toOpenApi = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');

/** Every route the real plugins register, as the server registers them. */
async function registeredRoutes(): Promise<Set<string>> {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const app = Fastify();
  const seen = new Set<string>();
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
      if (m === 'HEAD') continue; // Fastify adds a HEAD for every GET; it is not an operation anyone documents
      seen.add(key(m, toOpenApi(r.url)));
    }
  });
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  // In server.ts's order. server.ts itself is not importable here (it starts listening on load), so its two
  // inline routes are added by hand below and pinned by a separate assertion.
  for (const mod of ['auth', 'admin', 'catalog', 'images', 'personal', 'downloads', 'sources', 'opds']) {
    await app.register((await import(`../src/routes/${mod}`)).default);
  }
  await app.ready();
  await app.close();
  seen.add('GET /livez');
  seen.add('GET /healthz');
  return seen;
}

/** The spec's operations. */
function specRoutes(): { ops: Set<string>; spec: any } {
  const spec = parseYaml(readFileSync(join(REPO, 'bff', 'openapi.yaml'), 'utf8'));
  const ops = new Set<string>();
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const m of Object.keys(item)) if (METHODS.has(m.toUpperCase())) ops.add(key(m, p));
  }
  return { ops, spec };
}

/** The routes docs/api.md lists in its code blocks -- two per line is the house layout. */
function documentedRoutes(): Set<string> {
  const md = readFileSync(join(REPO, 'docs', 'api.md'), 'utf8');
  const out = new Set<string>();
  let inCode = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (!inCode) continue;
    for (const m of line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/g)) out.add(key(m[1], toOpenApi(m[2])));
  }
  return out;
}

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

test('every registered route is in the spec, and every spec path is a route', async () => {
  const live = await registeredRoutes();
  const { ops } = specRoutes();
  // Reintroduce by adding any app.get() to a route file without touching openapi.yaml.
  assert.deepEqual(diff(live, ops), [], 'routes the server registers that openapi.yaml does not describe');
  assert.deepEqual(diff(ops, live), [], 'operations in openapi.yaml that no route serves');
  assert.ok(live.size >= 180, `only ${live.size} routes registered -- did a plugin fail to load?`);
});

test('server.ts really does add the two inline routes the table assumes', () => {
  const server = readFileSync(join(REPO, 'bff', 'src', 'server.ts'), 'utf8');
  assert.match(server, /app\.get\('\/livez'/);
  assert.match(server, /app\.get\('\/healthz'/);
  // And nothing else: a third inline route would be invisible to the first test.
  const inline = [...server.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[2]);
  assert.deepEqual(inline.sort(), ['/healthz', '/livez'], 'server.ts registers routes the coverage test does not know about');
});

test('the docs route list matches the API, in both directions', async () => {
  const live = await registeredRoutes();
  const docs = documentedRoutes();
  // Reintroduce by adding a route and not listing it in docs/api.md -- which is exactly how the list sat
  // one short for a release.
  assert.deepEqual(diff(live, docs), [], 'routes missing from the code blocks in docs/api.md');
  assert.deepEqual(diff(docs, live), [], 'routes listed in docs/api.md that do not exist');
});

test('every operation says what it does, where it belongs, what it answers, and how it is gated', () => {
  const { ops, spec } = specRoutes();
  const schemes = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
  const tags = new Set((spec.tags ?? []).map((t: any) => t.name));
  const problems: string[] = [];
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const [m, op] of Object.entries<any>(item)) {
      if (!METHODS.has(m.toUpperCase())) continue;
      const k = key(m, p);
      if (!op.summary?.trim()) problems.push(`${k}: no summary`);
      if (!op.tags?.length) problems.push(`${k}: no tag`);
      for (const t of op.tags ?? []) if (!tags.has(t)) problems.push(`${k}: tag ${t} is not declared`);
      if (!op.responses || !Object.keys(op.responses).length) problems.push(`${k}: no responses`);
      if (!Array.isArray(op.security)) problems.push(`${k}: security not stated (an empty list means public, on purpose)`);
      for (const req of op.security ?? []) for (const s of Object.keys(req)) if (!schemes.has(s)) problems.push(`${k}: security scheme ${s} is not declared`);
      if (p.startsWith('/api/admin/') && !JSON.stringify(op.security).includes('bearer')) problems.push(`${k}: admin route not gated by bearer`);
      if (p.startsWith('/opds') && !JSON.stringify(op.security).includes('opdsBasic')) problems.push(`${k}: OPDS route not gated by opdsBasic`);
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`);
  assert.ok(ops.size >= 180);
  // The served spec names a version; it must be the one the server actually is. Reintroduce by bumping
  // package.json for a release and forgetting the yaml: the reference then claims to be an older API.
  const pkg = JSON.parse(readFileSync(join(REPO, 'bff', 'package.json'), 'utf8'));
  assert.equal(spec.info?.version, pkg.version, 'openapi.yaml info.version is not the package version');
});

test('the documentation server serves the UI and the spec', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerApiDocs, API_DOCS_PREFIX, specPath } = await import('../src/lib/apiDocs');
  assert.equal(specPath(), join(REPO, 'bff', 'openapi.yaml'), 'the runtime resolves the spec somewhere else than the test reads it');
  const app = Fastify();
  await registerApiDocs(app);
  await app.ready();
  try {
    const ui = await app.inject({ method: 'GET', url: `${API_DOCS_PREFIX}/` });
    assert.equal(ui.statusCode, 200, `the UI answered ${ui.statusCode}`);
    assert.match(ui.headers['content-type'] as string, /text\/html/);
    // Reintroduce by deleting the COPY in a Dockerfile: the file is missing, registerApiDocs logs and skips,
    // and this route answers 404 -- which is why the runtime path check above and this request both exist.
    const json = await app.inject({ method: 'GET', url: `${API_DOCS_PREFIX}/json` });
    assert.equal(json.statusCode, 200);
    const spec = json.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/api/home'], 'the served spec is not the one in the repo');
  } finally {
    await app.close();
  }
});
