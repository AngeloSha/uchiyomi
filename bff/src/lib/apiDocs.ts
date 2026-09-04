// The API reference, served from the spec file next to the built code.
//
// Static mode, deliberately: the spec is a hand-maintained file rather than something assembled from route
// schemas, because the routes validate with zod and carry no JSON schema for a generator to read. What keeps
// the file honest is not generation but a test -- bff/test/openapiCoverage.test.ts compares it against the
// registered routes in both directions, so a route added without its operation fails CI.
//
// The path is resolved from THIS file's directory at runtime, which is dist/lib/ in the image and src/lib/
// under tsx, so the same relative walk finds bff/openapi.yaml in both.
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const API_DOCS_PREFIX = '/api/docs';

/** Where the spec lives relative to the running code; exported so the coverage test reads the same file. */
export function specPath(): string {
  return resolve(__dirname, '..', '..', 'openapi.yaml');
}

export async function registerApiDocs(app: FastifyInstance): Promise<void> {
  const path = specPath();
  if (!existsSync(path)) {
    // A build that forgot to COPY the file must not take the whole server down over documentation.
    app.log.warn(`api docs: ${path} is missing, /api/docs not registered`);
    return;
  }
  await app.register(swagger, { mode: 'static', specification: { path, baseDir: resolve(path, '..') } });
  await app.register(swaggerUi, {
    routePrefix: API_DOCS_PREFIX,
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true, persistAuthorization: true },
  });
}
