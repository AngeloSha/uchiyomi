// The Content-Security-Policy every response carries, here and in web/nginx.conf (the split layout's documents).
import type { FastifyInstance } from 'fastify';

/**
 * The directives that cost the app nothing: no plugins (`object-src`), no `<base>` from injected markup re-pointing
 * every relative URL (`base-uri`), framing by this origin only (`frame-ancestors`, what X-Frame-Options: SAMEORIGIN
 * already says, for browsers that read only CSP), and forms that submit nowhere else (`form-action`; the app's forms
 * all submit through fetch). Script and style sources are left out on purpose: the static export's inline scripts
 * need per-build hashes first, and a policy that broke the app would help nobody.
 *
 * ⚠️ web/nginx.conf repeats this string; securityHeaders.test.ts holds the two together.
 */
export const BASE_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";

/** Send BASE_CSP on every response that does not already carry a policy of its own. */
export function addBaseCsp(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', BASE_CSP);
    return payload;
  });
}
