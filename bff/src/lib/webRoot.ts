// Serve the web app from the API process, when they are packaged together.
//
// This exists to answer a fair question: everyone else ships one container. Komga is one (Spring serves its
// own Angular build), Kavita is one, Jellyfin is one, every *arr is one. A separate nginx purely to hand out
// static files is unusual for this class of app, and it is the topology that produced the port-dropping
// redirect that broke every deep link on the documented default port.
//
// It is OPT-IN and additive: with WEB_ROOT unset this module does nothing at all, and the two-container
// setup behaves exactly as before. One code path, chosen by whether the files are there.
//
// Everything below has an nginx.conf line it is replacing. Where the behaviour differs the comment says so,
// because "we moved the static server" is only safe if the headers came with it.
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Where the built web export lives, when it is bundled. Unset means "not bundled": serve nothing.
 *
 * Read on each call rather than captured at module load. Load-time capture is what makes LIBRARY_ROOT
 * awkward to test -- scan.int.test.ts has to set it before the first import of library.ts and says so -- and
 * it made this module's own tests need a cache-busting import that behaved differently across Node versions.
 * Nothing here is hot enough for an env read to matter.
 */
export const webRoot = (): string => process.env.WEB_ROOT || '';

const YEAR = 60 * 60 * 24 * 365;
const WEEK = 60 * 60 * 24 * 7;

/**
 * Cache-Control, matching nginx.conf rule for rule.
 *
 * The service worker and the manifest must never be cached or an install pins itself to an old build and
 * stops receiving updates -- which is a support burden that looks like "the app is broken" rather than
 * "your browser kept a file".
 */
function cacheControl(urlPath: string): string {
  if (urlPath === '/sw.js') return 'no-cache, no-store, must-revalidate';
  if (urlPath === '/manifest.webmanifest') return 'no-cache';
  if (urlPath.startsWith('/_next/static/')) return `public, max-age=${YEAR}, immutable`;
  if (urlPath.startsWith('/icons/')) return `public, max-age=${WEEK}`;
  return 'no-cache';
}

export function webRootConfigured(): boolean {
  const root = webRoot();
  return !!root && existsSync(join(root, 'index.html'));
}

/**
 * Mount the static export.
 *
 * Registered LAST, so every API route wins on a path collision. That ordering is the one thing that could
 * silently break the API, so it is asserted in webRoot.test.ts rather than left to the reader.
 */
export async function registerWebRoot(app: FastifyInstance): Promise<void> {
  if (!webRootConfigured()) return;
  const root = webRoot();

  const fastifyStatic = (await import('@fastify/static')).default;

  await app.register(fastifyStatic, {
    root,
    // nginx sent `Location: /path/` relative (absolute_redirect off). @fastify/static's own redirect builds
    // an absolute URL the same way nginx did, so it is turned off and handled below instead.
    redirect: false,
    index: false,
    wildcard: false,
    setHeaders(res: any, filePath: string) {
      const rel = '/' + filePath.slice(root.length).replace(/^\/+/, '');
      res.setHeader('Cache-Control', cacheControl(rel));
      if (rel.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  });

  /**
   * The SPA fallback, which is nginx's `try_files $uri $uri/ $uri.html /index.html`.
   *
   * Next's static export writes /library/index.html for the route /library, so a bare /library has to find
   * it without a redirect. nginx did that by adding a trailing slash and 301-ing, which is exactly what
   * dropped the port; resolving it in-process removes the redirect entirely rather than fixing it.
   */
  app.setNotFoundHandler(async (req, reply) => {
    // Never swallow an API 404 into the app shell: a client expecting JSON must not receive HTML.
    const p = req.url.split('?')[0];
    if (/^\/(api|auth|img|opds|healthz)\b/.test(p)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found' });
    }

    const clean = p.replace(/\/+$/, '');
    for (const candidate of [`${clean}/index.html`, `${clean}.html`]) {
      const rel = candidate.replace(/^\/+/, '');
      if (rel && existsSync(join(root, rel))) {
        reply.header('Cache-Control', 'no-cache');
        return reply.sendFile(rel);
      }
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
}
