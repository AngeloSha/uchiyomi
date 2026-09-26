/**
 * The desktop switch: the ONE place that reads `UCHIYOMI_DESKTOP`.
 *
 * Uchiyomi Desktop (the Electron app in desktop/) runs this same server as a child of the shell, on the user's
 * own PC, with the library on their own disk. Every server-side difference goes through `isDesktop()` or
 * through the defaults written into `process.env` below, and with the switch off every export here hands back
 * the server's own value unchanged -- the Docker build must stay byte-for-byte what it was
 * (desktopOff.test.ts, desktopSwitchHygiene.test.ts).
 *
 * ⚠️ IMPORTS ONLY fs, path AND crypto -- never ../env or ./db. env.ts imports this module first so that the
 * defaults below are in `process.env` before anything reads them (library.ts, customSites.ts and the source
 * loader capture their paths when they load); an import of env or db from here would be a cycle that runs
 * those modules before the defaults exist.
 *
 * What the shell must set (contract 1 in the desktop build brief): UCHIYOMI_DATA_DIR, PORT, DL_ROOT and a
 * per-launch UCHIYOMI_DESKTOP_SECRET of at least 32 characters. Missing any of them, the process refuses to
 * start with the reason -- a half-configured desktop server would fall back to POSIX paths like `/config`,
 * which on Windows means `C:\config`.
 */
import { mkdirSync } from 'fs';
import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';

/** The same word rule as `envFlag` in env.ts: "false", "0", "no", "off" and "" are all OFF. */
export function flagOn(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '' && /^(1|true|yes|on)$/i.test(v.trim());
}

const ON = flagOn(process.env.UCHIYOMI_DESKTOP);

/** Is this server running inside Uchiyomi Desktop? Decided once, when the process starts. */
export const isDesktop = (): boolean => ON;

/**
 * The server's wording, or the desktop app's.
 *
 * Every message that tells the reader to mount a volume, set PUID, chown or edit a compose file goes through
 * this, so the server strings stay byte-identical while the desktop app never tells someone on a laptop to
 * run `docker compose`.
 */
export function forDesktop<T>(server: T, desktop: T): T {
  return ON ? desktop : server;
}

/**
 * How soon each background job may first run after the desktop app starts.
 *
 * The server waits 10-30 minutes after a boot so a restart loop cannot become a flood and readers are served
 * first. A PC is switched on and off every day, so those waits would mean the new-chapter check rarely runs at
 * all. Still above zero on purpose: the shell's Cloudflare helper is still starting when the server boots,
 * the person who just opened the app should be served first, and the shell's restart backoff is what guards
 * against a crash loop.
 */
export const DESKTOP_FLOORS = Object.freeze({
  sweep: 2 * 60 * 1000,
  extensionCheck: 2 * 60 * 1000,
  solverHealth: 1 * 60 * 1000,
  repair: 5 * 60 * 1000,
  watchdog: 5 * 60 * 1000,
  cleanup: 5 * 60 * 1000,
  importSweep: 5 * 60 * 1000,
  installPing: 10 * 60 * 1000,
  backupCatchUp: 5 * 60 * 1000,
  healthSummary: 5 * 60 * 1000,
});
export type DesktopFloor = keyof typeof DESKTOP_FLOORS;

/** The first-run delay floor for a job: the server's own value when off, the desktop floor when on. */
export function firstRunFloor(serverMs: number, key: DesktopFloor): number {
  return ON ? DESKTOP_FLOORS[key] : serverMs;
}

/**
 * Routes that answer 404 on desktop, as `${method} ${fastify url}`. desktopGuard.ts checks them in an onRequest
 * hook at the root, BEFORE any authentication, so the answer is "no such thing" rather than "sign in".
 *
 * They are the ways in, and the ways to manage other people and other devices -- none of which exist on a
 * one-person PC app: first-run setup and password sign-in (the shell signs the window in, routes/auth.ts
 * `POST /auth/desktop`), OIDC, password/2FA/sessions, creating or changing members (the LIST stays: the
 * Library tab and the notification-target dialog read it), everyone's sessions, OPDS and API tokens, web push
 * (Electron has no push service), and the install-count preview (desktop installs are not counted).
 *
 * ⚠️ A renamed route would silently escape this list, so desktopRoutes.test.ts asserts every entry is a real
 * route of the server build.
 */
export const DESKTOP_HIDDEN_ROUTES: readonly string[] = Object.freeze([
  'GET /api/setup/status',
  'POST /api/setup',
  'POST /auth/login',
  'POST /auth/register',
  'GET /auth/oidc/start',
  'GET /auth/oidc/callback',
  'POST /auth/password',
  'POST /auth/totp/setup',
  'POST /auth/totp/enable',
  'POST /auth/totp/disable',
  'GET /auth/sessions',
  'DELETE /auth/sessions/:id',
  'POST /auth/logout-all',
  'POST /api/admin/users',
  'PATCH /api/admin/users/:id',
  'DELETE /api/admin/users/:id',
  'GET /api/admin/sessions',
  'DELETE /api/admin/sessions/:id',
  'GET /api/opds/token',
  'POST /api/opds/token',
  'PATCH /api/opds/token',
  'DELETE /api/opds/token',
  'GET /api/tokens',
  'POST /api/tokens',
  'DELETE /api/tokens/:id',
  'POST /api/push/subscribe',
  'POST /api/push/unsubscribe',
  'GET /api/admin/install-ping/preview',
]);

/** What `desktopPlan` works out from the shell's environment. */
export interface DesktopPlan {
  /** Written into process.env (the forced values and the defaults for what the shell left unset). */
  set: Record<string, string>;
  /** Directories under the data dir to create; never DL_ROOT or a LIBRARY_ROOT the shell chose (see below). */
  mkdirs: string[];
  secret: string;
  port: number;
}

/**
 * A library root as it will be stored: absolute, no trailing separator, Windows drive letter upper-cased.
 * The root is written to `lib_books.root` and compared as an exact string, so `c:\Lib\` and `C:\Lib` would
 * otherwise be two libraries holding the same files.
 */
export function normRoot(p: string, impl: typeof path = path): string {
  let r = impl.resolve(p);
  const root = impl.parse(r).root;
  while (r.length > root.length && (r.endsWith('/') || r.endsWith(impl.sep))) r = r.slice(0, -1);
  if (impl.sep === '\\' && /^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  return r;
}

/** Is one of these folders inside the other (or the same)? Case-folded: NTFS and APFS are case-insensitive. */
export function rootsOverlap(a: string, b: string, impl: typeof path = path): boolean {
  const inside = (child: string, parent: string) => {
    const rel = impl.relative(parent.toLowerCase(), child.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * Work out the desktop environment from the shell's. Pure (no filesystem, no process.env writes), so the
 * validation is testable with `path.win32` on Linux; the module body below applies it.
 *
 * Throws with every problem at once, because the person reading it is looking at a log file after the app
 * failed to open, and one missing variable at a time is three restarts.
 */
export function desktopPlan(src: NodeJS.ProcessEnv, impl: typeof path = path): DesktopPlan {
  const problems: string[] = [];
  const data = (src.UCHIYOMI_DATA_DIR || '').trim();
  const dl = (src.DL_ROOT || '').trim();
  const secret = src.UCHIYOMI_DESKTOP_SECRET || '';
  const port = Number(src.PORT);
  if (!data) problems.push('UCHIYOMI_DATA_DIR is not set');
  if (!dl) problems.push('DL_ROOT is not set');
  if (!src.PORT || !Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT is not a port number (${JSON.stringify(src.PORT ?? null)})`);
  if (secret.length < 32) problems.push('UCHIYOMI_DESKTOP_SECRET is missing or shorter than 32 characters');
  if (problems.length) throw new Error(`Uchiyomi Desktop cannot start: ${problems.join('; ')}`);

  const dataDir = impl.resolve(data);
  const j = (...p: string[]) => impl.join(dataDir, ...p);
  const set: Record<string, string> = {};
  const mkdirs: string[] = [dataDir];
  // Filled in only where the shell left them unset, so the shell (or a person debugging it) can still point
  // any one of them somewhere else.
  const fill = (k: string, v: string, mk = false) => {
    const cur = src[k];
    const val = cur !== undefined && cur.trim() !== '' ? cur : v;
    set[k] = val;
    if (mk && val === v) mkdirs.push(v);
    return val;
  };
  const config = fill('CONFIG_DIR', j('config'), true);
  fill('CACHE_DIR', j('cache'), true);
  fill('BACKUP_DIR', j('backups'), true);
  fill('SOURCES_DIR', j('sources'), true);
  fill('CUSTOM_SITES_FILE', impl.join(config, 'sites.json'));
  // Laptop numbers (owner decision): 5 GB kept free, since the library usually shares the system drive, and a
  // 4 GiB image cache instead of the server's 16.
  fill('MIN_FREE_GB', '5');
  fill('CACHE_MAX_BYTES', String(4 * 1024 * 1024 * 1024));
  fill('NODE_ENV', 'production');

  // The two library roots, normalised. LIBRARY_ROOT defaults to an EMPTY folder in the data dir: the server
  // always has a read library, and several paths (Forget's "can every root be read" proof among them) assume
  // one exists.
  // ⚠️ Only the data-dir default is created here. DL_ROOT, or a read library the shell was told about, may live
  // on an external drive; creating it while that drive is unplugged would put an empty library on the system
  // disk, and the "unmounted" checks in verify and cleanup rely on a missing root LOOKING missing.
  const dlRoot = normRoot(dl, impl);
  const libDefault = j('library');
  const libRaw = src.LIBRARY_ROOT && src.LIBRARY_ROOT.trim() ? src.LIBRARY_ROOT : libDefault;
  const libRoot = normRoot(libRaw, impl);
  if (libRaw === libDefault) mkdirs.push(libRoot);
  if (rootsOverlap(libRoot, dlRoot, impl)) {
    throw new Error(`Uchiyomi Desktop cannot start: the library folder (${dlRoot}) and the read library (${libRoot}) are inside one another, so every file would be scanned twice. Choose separate folders.`);
  }
  set.DL_ROOT = dlRoot;
  set.LIBRARY_ROOT = libRoot;

  // Forced whatever the environment says. The schedulers run only for exactly 'owned' (server.ts); the origin
  // is the one the window loads and the only one CORS, the Host guard and the sign-in handshake accept; OIDC
  // needs a redirect URL an identity provider can reach, which a loopback app does not have; and web push
  // needs a push service Electron does not have, so no VAPID keys (env.ts skips generating them too).
  set.LIBRARY_BACKEND = 'owned';
  set.PORT = String(port);
  set.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
  set.OIDC_ISSUER = '';
  set.OIDC_CLIENT_ID = '';
  set.VAPID_PUBLIC_KEY = '';
  set.VAPID_PRIVATE_KEY = '';
  return { set, mkdirs, secret, port };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// The secret's digest, never the secret: all the handshake needs is to compare against it.
let secretDigest: Buffer | null = null;
let listenPort = 0;
let osUser = '';

if (ON) {
  let plan: DesktopPlan;
  try {
    plan = desktopPlan(process.env);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[desktop] ${(e as Error).message}`);
    process.exit(1);
  }
  Object.assign(process.env, plan.set);
  for (const d of plan.mkdirs) {
    // A folder that cannot be made is reported where it is used (fsGuard names the folder and says why), which
    // is a better message than a crash here.
    try { mkdirSync(d, { recursive: true }); } catch { /* reported later by fsGuard */ }
  }
  secretDigest = sha(plan.secret);
  listenPort = plan.port;
  osUser = (process.env.UCHIYOMI_DESKTOP_USER || '').trim();
  // ⚠️ Out of the environment, so the children this process starts (pg_dump for the nightly backup) never
  // inherit it. Reintroduce by deleting this line: desktopAuth.test.ts "the secret leaves process.env" fails.
  delete process.env.UCHIYOMI_DESKTOP_SECRET;
}

/**
 * Does this header carry the shell's per-launch secret?
 *
 * Compared as SHA-256 digests with `timingSafeEqual`: both sides are then 32 bytes whatever was sent, so
 * neither the length nor the first differing byte of the secret leaks through the response time.
 * Always false when the switch is off.
 */
export function desktopSecretMatches(header: unknown): boolean {
  if (!secretDigest || typeof header !== 'string' || header.length === 0) return false;
  return timingSafeEqual(sha(header), secretDigest);
}

/** The port the desktop server listens on (0 when off). */
export const desktopPort = (): number => listenPort;

/** At most one `login.desktop_fail` audit row per this long (desktopFailAudit). */
export const DESKTOP_FAIL_AUDIT_MS = 60_000;
let failAudit = { at: Number.NEGATIVE_INFINITY, swallowed: 0 };

/**
 * Should this wrong handshake secret be written to the audit log, and as how many attempts?
 *
 * ⚠️ The handshake has no rate limit on purpose (routes/auth.ts) and nothing prunes audit_log, so a row per
 * refusal let any process on the PC grow the database as fast as it could send requests (3,744 rows in five
 * seconds). One row a minute keeps what matters -- someone is guessing, and how hard -- at a bounded cost:
 * the first wrong secret is written at once, and the first one after the minute carries every attempt
 * swallowed in between. Returns the number of attempts to record, or null to write nothing.
 *
 * `now` is a monotonic clock, injectable for the test. A clock that went backwards counts as due rather than
 * silencing the log until it catches up.
 */
export function desktopFailAudit(now: number = performance.now()): number | null {
  const since = now - failAudit.at;
  if (since >= 0 && since < DESKTOP_FAIL_AUDIT_MS) {
    failAudit.swallowed++;
    return null;
  }
  const attempts = failAudit.swallowed + 1;
  failAudit = { at: now, swallowed: 0 };
  return attempts;
}

/** The Host headers a desktop request may carry: the loopback address or `localhost`, on our port. */
export function desktopHosts(): string[] {
  return listenPort ? [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`] : [];
}

/** The signed-in person's display name on desktop: the OS account name, or "Me" when the shell did not say. */
export function desktopUserName(): string {
  return osUser || 'Me';
}

/** Did this connection come from this machine? IPv4 loopback is the whole 127/8, possibly IPv6-mapped. */
export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
