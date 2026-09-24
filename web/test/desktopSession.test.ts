// Uchiyomi Desktop's silent sign-in, driven against the real client (lib/api.ts + lib/desktop.ts) with a
// stubbed fetch, the way apiRetry.test.ts drives the refusal rule.
//
// The desktop app has no sign-in screen: its window is signed in by the shell (`POST /auth/desktop`, the
// secret added below the page), and a refresh cookie that is gone or stale is exchanged again inside the
// same refresh. Three things must hold, and each is a way this goes wrong without anyone seeing it:
//   * only the shell's own window may try the exchange (a browser tab on the same port must not);
//   * a refused exchange is `rejected` (DesktopReconnect), not `unreachable` (a splash that retries forever);
//   * with neither desktop signal present, every answer is exactly what the server build always gave.
//
// ⚠️ ORDER MATTERS. `noteServerDesktop` is sticky for the life of the page, so the tests that need "not
// desktop" run first, then the one that proves the server's word alone is enough (before any exchange,
// which notes the flag too), then the desktop window. node:test runs a file's tests in declaration order.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

// `api.ts` seeds itself from localStorage at load, so the stub goes in before the import.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: string[] = [];
/** What the server answers, per path. `'down'` makes fetch itself reject, as it does with nothing listening. */
let answer: (path: string, nth: number) => Response | 'down' = () => json(404, {});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/\?.*$/, '');
  calls.push(`${init?.method ?? 'GET'} ${path}`);
  const a = answer(path, calls.filter((c) => c.endsWith(` ${path}`)).length);
  if (a === 'down') throw new TypeError('fetch failed');
  return a;
}) as any;

/** The preload marker (contract 3). Only its presence matters to the session code. */
const shell = (on: boolean) => {
  if (on) (globalThis as any).window = { uchiyomiDesktop: { version: 'test', platform: 'win32' } };
  else delete (globalThis as any).window;
};
/** Node 21+ has a read-only `navigator` getter; replace it outright. */
const setOnLine = (onLine: boolean | undefined) =>
  Object.defineProperty(globalThis, 'navigator', { value: onLine === undefined ? {} : { onLine }, configurable: true, writable: true });

let api: typeof import('../lib/api');
let desk: typeof import('../lib/desktop');
before(async () => {
  api = await import('../lib/api');
  desk = await import('../lib/desktop');
});

const DESKTOP_USER = { accessToken: 'desk-token', expiresIn: 900, user: { id: 'local-admin' }, refreshExpiresAt: 1, desktop: true };

// ---------------------------------------------------------------- the server build: nothing changes

test('without the shell a refused refresh is rejected, and the exchange is never tried', async () => {
  // A browser tab pointed at the desktop app's port has no marker. It must get the sign-in screen's "opens
  // in the app" line, never a request to the exchange (which would only 401 without the shell's header).
  // Reintroduce by dropping `&& desktopShell()` from the 401 branch in refreshSession: the tab calls
  // /auth/desktop, and the stub's 200 below signs it in.
  shell(false);
  calls.length = 0;
  answer = (p) => (p === '/auth/refresh' ? json(401, { error: 'invalid_refresh' }) : json(200, DESKTOP_USER));
  const r = await api.refreshSession();
  assert.deepEqual(r, { kind: 'rejected' }, 'a refused refresh without the shell was not rejected');
  assert.equal(calls.filter((c) => c === 'POST /auth/desktop').length, 0, 'a page without the shell tried the desktop exchange');
});

test('the server build answers exactly as before: authed, unreachable, and no desktop flag', async () => {
  // The control for everything below: a Docker server's answers carry no `desktop`, so nothing may start
  // treating the page as the desktop app. Reintroduce by `serverSaid = !!v || true` in noteServerDesktop:
  // "a server answer without the flag marked the page as desktop" fails.
  shell(false);
  calls.length = 0;
  answer = () => json(200, { accessToken: 'srv', expiresIn: 900, user: { id: 'u1' }, refreshExpiresAt: 2 });
  assert.deepEqual(await api.refreshSession(), { kind: 'authed', user: { id: 'u1' }, refreshExpiresAt: 2 });
  assert.equal(desk.isDesktop(), false, 'a server answer without the flag marked the page as desktop');
  answer = () => json(502, {});
  assert.deepEqual(await api.refreshSession(), { kind: 'unreachable' }, 'a 502 is no longer unreachable');
  answer = () => 'down';
  assert.deepEqual(await api.refreshSession(), { kind: 'unreachable' }, 'no server is no longer unreachable');
  assert.equal(calls.filter((c) => c === 'POST /auth/desktop').length, 0);
});

test('the server build asks once and goes offline; nothing is retried behind the splash', async () => {
  // untilReachable() wraps the boot refresh in lib/auth.tsx. Off desktop it must be ONE request, so a phone
  // on a plane still opens its downloads at once. Reintroduce by dropping `isDesktop() &&` from its loop:
  // "the server build retried" fails (and the offline launch would hang on the splash).
  // ⚠️ The fake server answers on the fourth ask, so that reintroduction FAILS here instead of looping
  // forever: an always-unreachable ask plus a no-op wait is an endless microtask loop that hangs the run.
  shell(false);
  let asked = 0;
  const waits: number[] = [];
  const r = await desk.untilReachable(async () => (++asked < 4 ? { kind: 'unreachable' as const } : { kind: 'authed' as const }),
    () => asked < 50, async (ms) => { waits.push(ms); });
  assert.equal(asked, 1, 'the server build retried an unreachable boot');
  assert.equal(r.kind, 'unreachable');
  assert.deepEqual(waits, []);
});

test('offline is still offline on a phone, and the hidden-surface helpers are inert', () => {
  // serverReachableHint() replaced five `navigator.onLine` reads; off desktop it must read exactly as they
  // did. Reintroduce by `return true` in serverReachableHint: "a phone with no network" fails.
  shell(false);
  setOnLine(false);
  assert.equal(desk.serverReachableHint(), false, 'a phone with no network is treated as reaching its server');
  setOnLine(true);
  assert.equal(desk.serverReachableHint(), true);
  setOnLine(undefined);
  assert.equal(desk.serverReachableHint(), true, 'a browser that does not say is not offline');
  assert.equal(desk.hiddenOnDesktop(desk.DESKTOP_HIDDEN.adminTabs, 'Members'), false, 'Members is hidden on the server build');
});

test('the server\'s word alone marks the page as desktop, and it sticks', async () => {
  // A browser tab has no marker, but LoginScreen reads `/auth/config`'s flag and the web must know which
  // app it is talking to. Reintroduce by deleting `noteServerDesktop(j.desktop)` from refreshSession: "the
  // server's desktop flag was ignored" fails.
  // ⚠️ HERE, before any exchange: `desktopExchange` notes the same flag, so once a desktop-window test below
  // has run the page is already "desktop" and this assertion would pass with the refresh's own note deleted
  // (it did, at the end of the file -- the reintroduction caught it).
  assert.equal(desk.isDesktop(), false, 'the page was already desktop before this test -- it would prove nothing');
  shell(false);
  answer = () => json(200, { ...DESKTOP_USER, desktop: true });
  assert.equal((await api.refreshSession()).kind, 'authed');
  assert.equal(desk.isDesktop(), true, 'the server\'s desktop flag was ignored');
  answer = () => json(200, { accessToken: 'x', user: { id: 'u' } });
  await api.refreshSession();
  assert.equal(desk.isDesktop(), true, 'the flag did not stick');
  assert.equal(desk.desktopShell(), false, 'the server\'s word counterfeited the shell marker');
});

// ---------------------------------------------------------------- the desktop window

test('in the desktop window a refused refresh is exchanged silently, in the same request chain', async () => {
  // The whole point: a refresh cookie that is gone (60 days, a cleared store, a restored backup) signs the
  // window back in with no screen at all. Reintroduce by deleting the `desktopExchange()` line from
  // refreshSession: "the window was signed out" fails.
  shell(true);
  calls.length = 0;
  answer = (p) => (p === '/auth/refresh' ? json(401, { error: 'no_refresh' }) : json(200, DESKTOP_USER));
  const r = await api.refreshSession();
  assert.equal(r.kind, 'authed', 'the window was signed out instead of exchanged');
  assert.deepEqual(calls, ['POST /auth/refresh', 'POST /auth/desktop'], 'not exactly one refresh then one exchange');
  assert.equal(api.getAccessToken(), 'desk-token', 'the exchange did not set the access token');
  assert.equal(api.getCurrentUser(), 'local-admin', 'the exchange did not record who is signed in');
  assert.equal(r.kind === 'authed' && r.user.id, 'local-admin');
});

test('a refused exchange is rejected -- the reconnect screen -- and only a server that is down is unreachable', async () => {
  // 401 (wrong or missing secret), 403 (foreign Origin), 404 (not from this machine) are the server saying
  // no; retrying them forever behind a splash would be a window that never opens. Reintroduce by returning
  // `unreachable` for 401 in desktopExchange: "an exchange refused with 401 was not rejected" fails.
  shell(true);
  for (const status of [401, 403, 404]) {
    calls.length = 0;
    answer = (p) => (p === '/auth/refresh' ? json(401, {}) : json(status, { error: 'no' }));
    assert.deepEqual(await api.refreshSession(), { kind: 'rejected' }, `an exchange refused with ${status} was not rejected`);
    assert.equal(calls.filter((c) => c === 'POST /auth/desktop').length, 1, `a ${status} exchange was retried`);
  }
  answer = (p) => (p === '/auth/refresh' ? json(401, {}) : json(503, {}));
  assert.deepEqual(await api.refreshSession(), { kind: 'unreachable' }, 'a 503 from the exchange is a verdict rather than a restart');
  answer = (p) => (p === '/auth/refresh' ? json(401, {}) : 'down');
  assert.deepEqual(await api.refreshSession(), { kind: 'unreachable' }, 'an exchange with no server behind it is a verdict');
  // A 403 from the REFRESH (a disabled account) is not an invitation to exchange: only a lost cookie is.
  calls.length = 0;
  answer = (p) => (p === '/auth/refresh' ? json(403, { error: 'disabled' }) : json(200, DESKTOP_USER));
  assert.deepEqual(await api.refreshSession(), { kind: 'rejected' });
  assert.equal(calls.filter((c) => c === 'POST /auth/desktop').length, 0, 'a 403 refresh tried the exchange');
});

test('refreshes that fire together share one exchange', async () => {
  // `online`, `visibilitychange` and the 12-minute timer can fire at once; each exchange mints a refresh
  // token, so three of them would leave two orphaned sessions per wake-up. Reintroduce by moving the
  // exchange outside the `refreshing` singleton: "three refreshes made more than one exchange" fails.
  shell(true);
  calls.length = 0;
  answer = (p) => (p === '/auth/refresh' ? json(401, {}) : json(200, DESKTOP_USER));
  const all = await Promise.all([api.refreshSession(), api.refreshSession(), api.refreshSession()]);
  assert.ok(all.every((r) => r.kind === 'authed'));
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 1, 'three refreshes made more than one refresh');
  assert.equal(calls.filter((c) => c === 'POST /auth/desktop').length, 1, 'three refreshes made more than one exchange');
});

test('a request whose session died on desktop is re-signed and retried, not failed', async () => {
  // The existing bare-401 retry in raw() now reaches the exchange through refreshSession. Reintroduce by
  // deleting the `desktopExchange()` line: the request throws ApiError 401 instead of returning.
  shell(true);
  calls.length = 0;
  answer = (p, nth) => (p === '/auth/refresh' ? json(401, {})
    : p === '/auth/desktop' ? json(200, DESKTOP_USER)
    : nth === 1 ? json(401, { error: 'unauthorized' }) : json(200, { ok: true }));
  assert.deepEqual(await api.api('/api/home'), { ok: true }, 'the request was not retried after the exchange');
  assert.deepEqual(calls, ['GET /api/home', 'POST /auth/refresh', 'POST /auth/desktop', 'GET /api/home']);
});

test('on desktop the splash keeps asking while the server starts: 1, 2, 4 … 30 seconds', async () => {
  // The desktop server is a process on this computer that is starting, or restarting after the extension
  // engine installed; "unreachable" there means "not yet". Reintroduce by deleting the for-loop in
  // untilReachable: "the desktop splash gave up after one try" fails.
  shell(true);
  let asked = 0;
  const waits: number[] = [];
  const r = await desk.untilReachable(async () => (++asked < 4 ? { kind: 'unreachable' as const } : { kind: 'authed' as const }),
    () => true, async (ms) => { waits.push(ms); });
  assert.equal(r.kind, 'authed', 'the desktop splash gave up after one try');
  assert.equal(asked, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(desk.desktopRetryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  // An unmounted provider stops asking.
  let alive = true;
  asked = 0;
  await desk.untilReachable(async () => { asked++; if (asked === 2) alive = false; return { kind: 'unreachable' as const }; },
    () => alive, async () => {});
  assert.equal(asked, 2, 'the retry outlived the provider');
});

test('no Wi-Fi is not no server on desktop', () => {
  // The library is on this computer: `navigator.onLine === false` there must never open the offline
  // screen. Reintroduce by dropping `isDesktop() ||` from serverReachableHint.
  shell(true);
  setOnLine(false);
  assert.equal(desk.serverReachableHint(), true, 'no Wi-Fi was read as no server on desktop');
  assert.equal(desk.hiddenOnDesktop(desk.DESKTOP_HIDDEN.adminTabs, 'Members'), true);
  assert.equal(desk.hiddenOnDesktop(desk.DESKTOP_HIDDEN.adminTabs, 'Activity'), false, 'Activity is hidden on desktop');
  setOnLine(undefined);
});

test('the console rail loses exactly the hidden tabs, and a group left empty', () => {
  // Pure. Reintroduce by dropping `.filter((g) => g.tabs.length > 0)`: an empty "People" eyebrow would sit
  // over nothing if both its tabs were hidden.
  const groups = [
    { id: 'server', label: 'Server', tabs: ['Overview', 'Tasks'] },
    { id: 'people', label: 'People', tabs: ['Members', 'Sessions'] },
    { id: 'more', label: 'More', tabs: ['Members', 'Activity'] },
  ] as const;
  assert.deepEqual(desk.visibleGroups(groups, desk.DESKTOP_HIDDEN.adminTabs), [
    { id: 'server', label: 'Server', tabs: ['Overview', 'Tasks'] },
    { id: 'more', label: 'More', tabs: ['Activity'] },
  ], 'the rail kept a hidden tab or an empty group');
});
