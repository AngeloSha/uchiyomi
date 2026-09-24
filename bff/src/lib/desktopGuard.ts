/**
 * The desktop app's front door: one `onRequest` hook at the root of the server, installed only when the desktop
 * switch is on (server.ts), BEFORE any route plugin registers -- so it runs ahead of every plugin's own hooks,
 * including `authenticate`.
 *
 * 1. Host allowlist -> 421. The server listens on 127.0.0.1 only, but a web page on the internet can still make
 *    the browser on this PC talk to it by pointing a DNS name it controls at 127.0.0.1 (DNS rebinding). Such a
 *    request carries the attacker's name in `Host`; only `127.0.0.1:<port>` and `localhost:<port>` are ours.
 * 2. Hidden routes -> 404. `DESKTOP_HIDDEN_ROUTES` (lib/desktop.ts) are the ways in and the ways to manage other
 *    people and devices, none of which exist on a one-person PC app. Answered before authentication, so a
 *    hidden route reads as "there is no such thing" rather than "sign in first".
 *
 * Reintroduce by emptying HIDDEN (desktopRoutes.test.ts: the hidden routes answer) or by dropping the Host check
 * (desktopAuth.test.ts and desktopRoutes.test.ts: a foreign Host gets through); desktopSwitchHygiene.test.ts
 * pins the one `if (isDesktop()) installDesktopGuards(app)` in server.ts.
 */
import type { FastifyInstance } from 'fastify';
import { DESKTOP_HIDDEN_ROUTES, desktopHosts } from './desktop';

const HIDDEN = new Set(DESKTOP_HIDDEN_ROUTES);

/** Is `${method} ${fastify url}` hidden on desktop? HEAD is GET's shadow route in Fastify, so it is hidden with it. */
export function hiddenOnDesktop(method: string, url: string | undefined): boolean {
  if (!url) return false;
  return HIDDEN.has(`${method === 'HEAD' ? 'GET' : method} ${url}`);
}

export function installDesktopGuards(app: FastifyInstance): void {
  const hosts = new Set(desktopHosts());
  app.addHook('onRequest', async (req, reply) => {
    // Host names are case-insensitive; a missing Host (HTTP/1.0) is not ours either.
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return reply.code(421).send({ error: 'misdirected_request' });
    if (hiddenOnDesktop(req.method, req.routeOptions?.url)) return reply.code(404).send({ error: 'not_found' });
  });
}
