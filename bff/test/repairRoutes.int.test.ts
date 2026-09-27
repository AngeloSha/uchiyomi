// The repair's routes: the Tasks row, the Run now body, the "It's fine" button and the nightly switch.
//
// lib/repair.ts has its own tests for what the job DOES. This file is about the wiring an admin touches,
// and specifically about the three ways this pair of routes could be wrong in a way no library test would
// notice: a body that quietly widens a one-row chip into a full nightly run (a `bookId` with no `only` is
// not a smaller repair -- it is every step, with an argument four of them ignore), a refusal that says
// "busy" when the real answer is "a chapter sweep is running" (two jobs that must never overlap, and an
// admin who cannot tell which one is in the way), and a member reaching either of them at all.
//
// The run that IS started here is `only: ['gaps']` for a series id that does not exist: the gap step's
// candidate query returns nothing, so the job finishes without a single request to any site. Nothing in
// this file touches the network.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let runtime: any;
let repairState: any;
let app: any, adminTok = '', memberTok = '';

const ADMIN = 'rr-admin', MEMBER = 'rr-member';
const S = 's_rr_series', BOOK = 'b_rr_1';

const tasks = async () => (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: { authorization: adminTok } })).json().content;
const repairRow = async () => (await tasks()).find((t: any) => t.id === 'repair');
const run = (payload: any, tok = adminTok) =>
  app.inject({ method: 'POST', url: '/api/admin/tasks/repair/run', headers: { authorization: tok }, payload });
const confirmShort = (id: string, payload: any = {}, tok = adminTok) =>
  app.inject({ method: 'POST', url: `/api/admin/books/${id}/confirm-short`, headers: { authorization: tok }, payload });
const patch = (payload: any) =>
  app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { authorization: adminTok }, payload });
const settings = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { authorization: adminTok } })).json();

/** The run route is detached by design, so wait for the job rather than for a promise nobody is given. */
async function settle() {
  for (let i = 0; i < 100 && repairState.running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(repairState.running, false, 'the repair finished');
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ runtime } = (await import('../src/lib/runtime')) as any);
  ({ repairState } = (await import('../src/lib/repair')) as any);
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q('DELETE FROM users WHERE username = ANY($1::text[])', [[ADMIN, MEMBER]]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Repair Routes Fixture',$1)`, [S]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
           VALUES ($1,$2,'test',$3,'Chapter 3',3,2)`, [BOOK, S, `/test/${S}/3.cbz`]);
  const ids = await Promise.all([ADMIN, MEMBER].map(async (name, i) =>
    (await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
                              VALUES ($1,$1,$2,'x','password') RETURNING id`, [name, i ? 'user' : 'admin']))[0].id));
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: ids[0], role: 'admin' })}`;
  memberTok = `Bearer ${app.jwt.sign({ sub: ids[1], role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1::text[])', [[ADMIN, MEMBER]]).catch(() => {});
  await q('UPDATE server_settings SET repair_enabled = true, repair_last_run = NULL, repair_last_result = NULL WHERE id = 1').catch(() => {});
});

test('the Tasks panel lists the repair, its schedule and the last run it kept', { skip }, async () => {
  await q(`UPDATE server_settings SET repair_enabled = true,
             repair_last_run = now() - interval '2 hours',
             repair_last_result = '{"ok":true,"counted":7}'::jsonb WHERE id = 1`);
  const row = await repairRow();
  assert.ok(row, 'the repair is listed');
  assert.equal(row.name, 'Repair library');
  // The schedule names the interval AND the one constraint an admin would otherwise meet as a refusal.
  assert.match(row.schedule, /^every \d+h · never during a chapter sweep$/);
  assert.equal(row.running, false);
  // Persisted, like the verify's and the cleanup's: a restart must not turn the last run into "never run".
  // Reintroduce by reading only the in-memory repairState: both assertions read null on a fresh process.
  assert.ok(row.lastRun && Date.now() - row.lastRun > 60 * 60 * 1000, 'the stored run is shown');
  assert.equal(row.lastResult?.counted, 7, 'and the result it kept');
});

test('a body that would widen a one-row chip into a whole nightly run is refused', { skip }, async () => {
  // Every one of these is a plausible client bug, and every one of them would otherwise run all five steps
  // over the whole library with an argument four of them ignore.
  // Reintroduce by dropping the three refine() calls from repairBody: the last three cases start a run.
  for (const [payload, why] of [
    [{ only: ['nope'] }, 'a step that does not exist'],
    [{ only: [] }, 'an empty list is not "these steps"'],
    [{ only: ['short', 'short'] }, 'the same step twice'],
    [{ seriesId: 'x' }, 'a target with no step at all'],
    [{ bookId: 'x' }, 'a book with no step at all'],
    [{ sourceId: 'x' }, 'a source with no step at all'],
    [{ only: ['short'], seriesId: 'x' }, 'a series id on the short-chapter step'],
    [{ only: ['gaps'], bookId: 'x' }, 'a book id on the gap step'],
    [{ only: ['gaps', 'short'], seriesId: 'x' }, 'a series id on a two-step run'],
    // "Fix all issues" (v0.48.3): for the whole library only, and only where the failures step runs.
    // Reintroduce by dropping the two `now` refines: both of these start a run.
    [{ only: ['failures'], sourceId: 'x', now: true }, '"everything now" narrowed to one source'],
    [{ only: ['short', 'gaps'], now: true }, '"everything now" on steps it does not change'],
  ] as const) {
    const res = await run(payload);
    assert.equal(res.statusCode, 400, `${why}: ${res.body}`);
    assert.equal(res.json().error, 'bad_request');
  }
  assert.equal(repairState.running, false, 'and nothing was started');
});

const status = async (tok = adminTok, qs = '') =>
  app.inject({ method: 'GET', url: `/api/admin/tasks/repair/status${qs}`, headers: { authorization: tok } });
const runs = async (qs = '', tok = adminTok) =>
  app.inject({ method: 'GET', url: `/api/admin/tasks/repair/runs${qs}`, headers: { authorization: tok } });

test("a pressed Fix no longer replaces the nightly's result, and lands in the history", { skip }, async () => {
  // v0.49.0. Reintroduce by restoring the unconditional repair_last_run/repair_last_result UPDATE in
  // runRepair: the Tasks row below shows the one-step run (counted 0, only ['gaps']) instead of the nightly's.
  await q(`UPDATE server_settings SET repair_last_run = '2026-01-02T03:04:05Z', repair_last_result = '{"ok":true,"counted":7}'::jsonb WHERE id = 1`);
  const res = await run({ only: ['gaps'], seriesId: 'rr-no-such-series' });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().run;
  await settle();
  const row = await repairRow();
  assert.equal(row.lastResult?.counted, 7, "the Tasks line is still the nightly's");
  assert.equal(new Date(row.lastRun).toISOString(), '2026-01-02T03:04:05.000Z', 'and so is its time, which the nightly is armed from');
  const stored = (await q<{ at: string }>('SELECT repair_last_run AS at FROM server_settings WHERE id = 1'))[0].at;
  assert.equal(new Date(stored).toISOString(), '2026-01-02T03:04:05.000Z', 'persisted as well as shown');
  const hist = (await runs(`?id=${id}`)).json().content;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].kind, 'fill');
  assert.equal(hist[0].status, 'done');
  assert.equal(hist[0].origin, 'manual');
  assert.equal(hist[0].username, ADMIN, 'who pressed it, by name');
  assert.equal(hist[0].mine, true);
  assert.deepEqual(hist[0].result?.only, ['gaps'], 'and what it was asked to do');
  assert.deepEqual(hist[0].result?.skips?.map((k: any) => k.why), ['not_eligible'], 'including why it did nothing');
  assert.equal(row.latestOther?.id, id, "the Tasks row's latest one-off fix is this press");
  const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'library.repair' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit[0]?.detail?.seriesId, 'rr-no-such-series', 'the run is audited with what it was asked to do');
});

test('the run answer names the run, and the status route shows it finished', { skip }, async () => {
  // Reintroduce by dropping `run` from the route's answer: the uuid assertion fails, and a page that pressed
  // a 5 ms fix could never tell its own run had ended.
  const res = await run({ only: ['solver'] });
  assert.equal(res.json().ok, true);
  assert.equal(res.json().started, true);
  const id = res.json().run;
  assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await settle();
  const st = (await status()).json();
  assert.equal(st.running, false);
  assert.equal(st.run, null, 'nothing is running');
  assert.equal(st.last?.id, id, 'the run that just ended is `last`');
  assert.equal(st.recent[0]?.id, id, 'and the newest of `recent`');
  assert.equal(st.recent[0]?.kind, 'steps:solver');
  assert.equal(typeof st.enabled, 'boolean');
  assert.equal(st.sweepRunning, false);
  // What the page's action rows say BEFORE a press: the limits the code runs with, and estimates per kind.
  assert.equal(st.limits.shortMax, 20);
  assert.equal(st.limits.huntBudget, 5);
  assert.equal(st.estimates.fill.downloads, st.limits.gapChapters, 'Fill now downloads at most the gap-chapter cap');
  assert.equal(typeof st.estimates.fix_short.worstMs, 'number');
  assert.equal(st.estimates.full.worstMs, null, 'the nightly counts pages and borrows names: no honest bound');
  assert.equal(st.estimates['steps:solver'].runs >= 1, true, 'the solver run just made is history for "usually"');
  assert.equal(typeof st.estimates['steps:solver'].typicalMs, 'number');
  const plan = (await status(adminTok, '?kinds=steps:failures%2Bgaps%2Bshort%2Bsolver:now')).json();
  assert.equal(typeof plan.estimates['steps:failures+gaps+short+solver:now']?.downloads, 'number', 'a Fix all issues plan is estimated on request');
});

test('while a run is going the status route says what it is on, and only admins may ask', { skip }, async () => {
  repairState.running = true;
  repairState.live = {
    id: '00000000-0000-4000-8000-000000000001', startedAt: Date.now() - 5000, origin: 'manual', by: 'someone-else',
    kind: 'fill', only: ['gaps'], target: { seriesId: S, label: 'Repair Routes Fixture' }, steps: ['gaps'],
    step: 'gaps', stepIndex: 0, stepStartedAt: Date.now() - 4000, stepMs: {}, planned: { gaps: 1 },
    current: { kind: 'series', seriesId: S, title: 'Repair Routes Fixture', phase: 'searching', done: 0, of: 1 },
    budget: { left: 4 }, shortReserve: null, result: null,
  };
  try {
    const st = (await status()).json();
    assert.equal(st.running, true);
    assert.equal(st.run.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(st.run.mine, false, 'someone else started it');
    assert.equal('by' in st.run, false, 'and who is never sent');
    assert.equal(st.run.current.phase, 'searching');
    assert.equal(st.run.current.title, 'Repair Routes Fixture');
    assert.deepEqual(st.run.budget, { left: 4, of: 5 });
    assert.equal((await status(memberTok)).statusCode, 403, 'a member may not see what the repair is doing');
    assert.equal((await runs('', memberTok)).statusCode, 403, 'nor its history');
  } finally {
    repairState.running = false;
    repairState.live = null;
  }
  assert.equal((await runs('?id=nope')).statusCode, 400, 'an id is a uuid');
  assert.equal((await runs('?limit=500')).statusCode, 400, 'and fifty is the most one page asks for');
});

test('every task says its schedule as a sentence the page can translate', { skip }, async () => {
  const rows = await tasks();
  for (const t of rows) {
    assert.equal(typeof t.scheduleKey, 'string', `${t.id} has a key`);
    const rendered = t.scheduleKey.replace(/\{(\w+)\}/g, (_: string, k: string) => String(t.scheduleVars[k]));
    assert.equal(rendered, t.schedule, `${t.id}: the key and its values are the English sentence`);
  }
  const repair = rows.find((t: any) => t.id === 'repair');
  assert.equal(repair.scheduleKey, 'every {h}h · never during a chapter sweep');
  assert.equal('nextAt' in repair && 'latestOther' in repair && 'lastOrigin' in repair, true);
});

test('Scan library now answers what it found, and a second press within a minute says why it did not scan', { skip }, async () => {
  // Reintroduce by answering without the counts (catalog.ts): `series` is undefined.
  const catalog = (await import('../src/routes/catalog')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const c = Fastify();
  await c.register(jwt, { secret: process.env.JWT_SECRET! });
  await c.register(catalog);
  await c.ready();
  try {
    runtime.lastScan = 0;
    const scan = () => c.inject({ method: 'POST', url: '/api/refresh', headers: { authorization: adminTok } });
    const a = (await scan()).json();
    assert.equal(a.scanned, true);
    assert.equal(typeof a.series, 'number', 'how many series the scan holds');
    assert.equal(typeof a.books, 'number');
    assert.equal(typeof a.skipped, 'number', 'and how many folders it could not index');
    assert.deepEqual((await scan()).json(), { scanned: false, reason: 'rate_limited' });
  } finally {
    runtime.lastScan = 0;
    await c.close();
  }
});

test('a chapter sweep in the way is not the same answer as a repair already running', { skip }, async () => {
  // ⚠️ Two different refusals on purpose. "busy" on a press made during a sweep reads as "the repair is
  // stuck", and the page would tell an admin to wait for the wrong thing.
  // Reintroduce by dropping the `runtime.updating` check from the route: the answer is `busy`, and the
  // sweep-running sentence can never be shown.
  runtime.updating = true;
  try {
    const res = await run({ only: ['solver'] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: false, error: 'sweep_running' });
  } finally {
    runtime.updating = false;
  }
  repairState.running = true;
  try {
    assert.deepEqual((await run({ only: ['solver'] })).json(), { ok: false, error: 'busy' });
  } finally {
    repairState.running = false;
  }
});

test('and the sweep says the same thing back: a repair in the way is not a sweep that is still running', { skip }, async () => {
  // The other direction of the refusal above. Without it, pressing "Check for new chapters" during a repair
  // answers the sweep's own `busy`, which the Tasks panel words as "the previous sweep is still running" --
  // a sentence about a job that is not running, pointing the admin at the wrong thing to wait for.
  // Reintroduce by deleting the `runtime.repairing` check from the `update` branch of the route: the answer
  // is `busy` and the repair-running sentence can never be shown.
  runtime.repairing = true;
  try {
    const res = await app.inject({ method: 'POST', url: '/api/admin/tasks/update/run', headers: { authorization: adminTok } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: false, error: 'repair_running' });
  } finally {
    runtime.repairing = false;
  }
});

test('the nightly switch does not gate a run somebody asked for', { skip }, async () => {
  // Nothing the repair does is destructive -- it never deletes, merges or renumbers -- so "off" means "stop
  // doing it on your own", not "refuse when I ask". The read-chapter cleanup answers not_enabled here for
  // the opposite reason: that one deletes files.
  // Reintroduce by refusing on `repair_enabled = false` in the route: this fails with not_enabled.
  await q('UPDATE server_settings SET repair_enabled = false WHERE id = 1');
  try {
    const res = await run({ only: ['gaps'], seriesId: 'rr-no-such-series' });
    assert.equal(res.json().started, true);
    await settle();
    const row = await repairRow();
    assert.equal(row.schedule, 'switched off · on demand', 'but the schedule says it will not run by itself');
    const rec = (await runs(`?id=${res.json().run}`)).json().content[0];
    assert.equal(rec?.status, 'done', 'and the run that was asked for was not skipped');
  } finally {
    await q('UPDATE server_settings SET repair_enabled = true WHERE id = 1');
  }
});

test('the nightly switch survives a round trip through the settings page', { skip }, async () => {
  assert.equal((await settings()).repair_enabled, true, 'on by default');
  assert.equal((await patch({ repairEnabled: false })).statusCode, 200);
  assert.equal((await settings()).repair_enabled, false);
  assert.equal((await patch({ repairEnabled: true })).statusCode, 200);
  assert.equal((await settings()).repair_enabled, true);
});

test('confirm-short records the judgement, and withdrawing it clears the stamp', { skip }, async () => {
  const stamp = async () => (await q<{ at: string | null }>('SELECT short_confirmed_at AS at FROM lib_books WHERE id = $1', [BOOK]))[0].at;
  assert.equal(await stamp(), null);
  assert.deepEqual((await confirmShort(BOOK)).json(), { ok: true }, 'the default is "yes, it really is short"');
  assert.ok(await stamp(), 'the stamp is written');
  const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'book.short_confirmed' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit[0]?.detail?.confirmed, true);
  assert.equal(audit[0]?.detail?.number, 3, 'the audit row names the chapter, not just its id');
  // v0.49.0: who decided, so Health says "marked fine by an admin" rather than claiming the repair proved it.
  // Reintroduce by writing only the stamp: short_result stays null.
  const why = async () => (await q<{ r: any }>('SELECT short_result AS r FROM lib_books WHERE id = $1', [BOOK]))[0].r;
  assert.equal((await why())?.why, 'confirmed_by_admin');
  assert.equal((await why())?.by, ADMIN);

  // Withdrawing it is what the greyed row's chip does: the chapter becomes an open finding again and the
  // nightly will look at it on its next run (the repair skips a confirmed chapter entirely).
  // Reintroduce by always writing now() (ignoring `confirmed`): the stamp survives and the chapter can
  // never be re-checked.
  assert.deepEqual((await confirmShort(BOOK, { confirmed: false })).json(), { ok: true });
  assert.equal(await stamp(), null, 'and it is gone again');
  assert.equal(await why(), null, 'with who decided it');

  assert.equal((await confirmShort('b_rr_nope')).statusCode, 404, 'a chapter that is not there is not a judgement');
  assert.equal((await confirmShort(BOOK, { confirmed: 'yes' })).statusCode, 400, 'and the body is still a body');
});

test('a member can neither run the repair nor confirm a chapter', { skip }, async () => {
  assert.equal((await run({ only: ['gaps'], seriesId: S }, memberTok)).statusCode, 403);
  assert.equal((await confirmShort(BOOK, {}, memberTok)).statusCode, 403);
  assert.equal(repairState.running, false, 'and nothing started');
  assert.equal((await q<{ at: string | null }>('SELECT short_confirmed_at AS at FROM lib_books WHERE id = $1', [BOOK]))[0].at, null);
});
