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
  // Reintroduce by answering without the counts (catalog.ts): `series` is undefined. Or by dropping the role
  // check on them: 'a member is told no library counts'.
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
    // A member presses the same button (home, library, the top bar) and learns that it scanned -- not how big
    // the whole library is, restricted and 18+ libraries included.
    runtime.lastScan = 0;
    const m = (await c.inject({ method: 'POST', url: '/api/refresh', headers: { authorization: memberTok } })).json();
    assert.equal(m.scanned, true);
    assert.deepEqual(Object.keys(m).sort(), ['libraries', 'scanned'], 'a member is told no library counts');
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

test('an admin who hides 18+ reads no adult title in the repair\'s answers', { skip }, async () => {
  // Every place a repair names a series follows the listing rule (admin.ts `listable`): the target, the series
  // it is on, and the skips of the running run, of the Tasks line's result, of the latest one-off fix and of the
  // last full run. Reintroduce by sending any one of them as it is stored: its assertion below names the field.
  const { clearRunDigest } = await import('../src/lib/repairRuns');
  const LIB = 'rr-adult-lib', AS = 's_rr_adult', TITLE = 'Rr Hidden Adult Title';
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,$1,$1,18) ON CONFLICT (id) DO UPDATE SET age_rating = 18`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [AS]);
  await q(`INSERT INTO lib_series (id, source, title, folder, library_id) VALUES ($1,'test',$2,$1,$3)`, [AS, TITLE, LIB]);
  const skips = [{ step: 'short', target: { seriesId: AS, bookId: 'b_rr_adult', title: TITLE, number: 3 }, why: 'folder_busy' }];
  // `notes` name series by title alone: planted too, or the history's assertion below could not fail (the
  // integration-1 review's probe). Reintroduce by sending notes as stored in the runs route: 'the history' fails.
  const notes = { replaced: [`${TITLE} ch 3 (2 -> 20)`], confirmed: [], followed: [`${TITLE} -> rp-b`], upgraded: [] };
  // A Fix everything run (v0.55.0) names series in its lines by title alone, as notes do, and Recent repairs reads its
  // record from the history. Reintroduce by sending it as stored (admin.ts, the runs route): 'the history' fails.
  const merged = { code: 'autofix.item.merged', params: { from: TITLE, into: `${TITLE} (copy)` } };
  const autofixResult = {
    phaseIndex: 9, log: [merged],
    summary: { green: true, again: false, done: [{ kind: 'merged', n: 1, said: { code: 'autofix.done.merged', params: { n: 1 } }, items: [merged] }], clears: [], needsYou: [] },
  };
  const planted = await q<{ id: string }>(
    `INSERT INTO repair_runs (id, started_at, finished_at, origin, kind, target, status, ms, result, notes) VALUES
       (gen_random_uuid(), now(), now(), 'nightly', 'full', '{}'::jsonb, 'done', 5, $1::jsonb, $3::jsonb),
       (gen_random_uuid(), now(), now(), 'manual', 'fill', $2::jsonb, 'done', 5, $1::jsonb, $3::jsonb),
       (gen_random_uuid(), now(), now(), 'manual', 'autofix', '{}'::jsonb, 'done', 5, $4::jsonb, NULL) RETURNING id`,
    [JSON.stringify({ skips }), JSON.stringify({ seriesId: AS, label: TITLE }), JSON.stringify(notes), JSON.stringify(autofixResult)]);
  clearRunDigest();
  const was = { finishedAt: repairState.finishedAt, lastResult: repairState.lastResult };
  repairState.finishedAt = Date.now();
  repairState.lastResult = { skips };
  repairState.running = true;
  repairState.live = {
    id: '00000000-0000-4000-8000-000000000002', startedAt: Date.now(), origin: 'manual', by: null,
    kind: 'fill', only: ['gaps'], target: { seriesId: AS, label: TITLE }, steps: ['gaps'],
    step: 'gaps', stepIndex: 0, stepStartedAt: Date.now(), stepMs: {}, planned: {},
    current: { kind: 'series', seriesId: AS, title: TITLE, phase: 'searching', done: 0, of: 1 },
    budget: null, shortReserve: null, result: { skips },
  };
  try {
    const st = (await status()).json();
    assert.equal(st.run.target.label, undefined, 'status: the running run\'s target');
    assert.equal(st.run.current.title, undefined, 'status: the series it is on');
    assert.equal(st.run.skips[0].target.title, undefined, 'status: the running run\'s skips');
    assert.equal(st.lastFull.result.skips[0].target.title, undefined, 'status: the last full run\'s skips');
    assert.ok(!JSON.stringify(st).includes(TITLE), 'status: nowhere else either');
    const row = (await (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: { authorization: adminTok } })).json())
      .content.find((t: any) => t.id === 'repair');
    assert.equal(row.lastResult.skips[0].target.title, undefined, 'Tasks: the Tasks line\'s result');
    assert.equal(row.latestOther.target.label, undefined, 'Tasks: the latest one-off fix\'s target');
    assert.equal(row.latestOther.result.skips[0].target.title, undefined, 'Tasks: the latest one-off fix\'s skips');
    assert.ok(!JSON.stringify(row).includes(TITLE), 'Tasks: nowhere else either');
    assert.ok(!(await runs()).body.includes(TITLE), 'the history');
    // The same admin with "Show 18+" on reads every one of them.
    const shown = (await status(adminTok, '?adult=1')).json();
    assert.equal(shown.run.current.title, TITLE);
    assert.equal(shown.lastFull.result.skips[0].target.title, TITLE);
    // On the parsed field: the run's target label carries the title too, so a match anywhere in the body would pass
    // with the notes dropped for everyone (integration-2 review).
    const revealed = (await runs('?adult=1')).json().content.find((r: any) => r.id === planted[1].id);
    assert.ok(String(revealed?.notes?.replaced?.[0] ?? '').includes(TITLE), 'the notes too, with the reveal on');
    // The Fix everything row: its lines that name no series stay for both, the ones that do only with the reveal on.
    const hiddenFix = (await runs(`?id=${planted[2].id}`)).json().content[0];
    assert.equal(hiddenFix?.result?.summary?.done?.[0]?.said?.code, 'autofix.done.merged', 'PREMISE: the Fix everything row is in the history');
    assert.deepEqual(hiddenFix.result.log, [], 'the history: a Fix everything run\'s log');
    const shownFix = (await runs(`?adult=1&id=${planted[2].id}`)).json().content[0];
    assert.deepEqual(shownFix?.result?.summary?.done?.[0]?.items, [merged], 'a Fix everything run\'s lines, with the reveal on');
  } finally {
    repairState.running = false;
    repairState.live = null;
    Object.assign(repairState, was);
    await q('DELETE FROM repair_runs WHERE id = ANY($1)', [planted.map((r) => r.id)]);
    await q('DELETE FROM lib_series WHERE id = $1', [AS]);
    await q('DELETE FROM libraries WHERE id = $1', [LIB]);
    clearRunDigest();
  }
});

test('Fix everything\'s lines are held to the series they name, for an admin who hides 18+ (v0.55.1)', { skip }, async () => {
  // v0.55.0 left out every line naming a series by title for an admin without the reveal, adult or not. Each now carries
  // the ids of the series it names (`seriesIds`), and only a line naming a series that admin's reach hides goes -- in
  // the history, the run's own route and the newest run's. Judged on the series as it stands: a merge names the series
  // it merged away, which no listing shows any more. Reintroduce v0.55.0's rule in lib/autofix.ts scrubbed: "a line
  // naming a series that is not 18+ is kept" fails; nameableIds -> browsableIds in admin.ts nameable: "a merge of a
  // series that is not 18+ is still said" fails; drop `named` from the newest run's route: "the newest run" fails.
  const { clearRunDigest } = await import('../src/lib/repairRuns');
  const LIB = 'rr-adult-lib2', AS = 's_rr_adult2', M = 's_rr_merged', D = 's_rr_deleted_adult';
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,$1,$1,18) ON CONFLICT (id) DO UPDATE SET age_rating = 18`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[AS, M, D]]);
  await q(`INSERT INTO lib_series (id, source, title, folder, library_id) VALUES ($1,'test','Rr Adult Two',$1,$2)`, [AS, LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, library_id, deleted_at) VALUES ($1,'test','Rr Deleted Adult',$1,$2, now())`, [D, LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, merged_into) VALUES ($1,'test','Rr Merged Away',$1,$2)`, [M, S]);
  const line = (code: string, params: Record<string, unknown>) => ({ code, params });
  const renumbered = line('autofix.item.renumbered', { title: 'Repair Routes Fixture', seriesIds: [S] });
  const merged = line('autofix.item.merged', { from: 'Rr Merged Away', into: 'Repair Routes Fixture', seriesIds: [M, S] });
  const linked = line('autofix.item.linked', { a: 'Rr Adult Two', b: 'Repair Routes Fixture', seriesIds: [AS, S] });
  const deleted = line('autofix.item.deleted', { title: 'Rr Deleted Adult', n: 2, seriesIds: [D] });
  const gone = line('autofix.item.renumbered', { title: 'Rr Gone Altogether', seriesIds: ['s_rr_gone'] });
  const legacy = line('autofix.item.merged', { from: 'Rr Legacy', into: 'Repair Routes Fixture' });
  const tested = line('autofix.item.tested', { name: 'rr-src', ok: true });
  const all = [renumbered, merged, linked, deleted, gone, legacy, tested];
  const record = {
    phaseIndex: 9, log: all,
    summary: { green: true, again: false, clears: [], needsYou: [],
      done: [{ kind: 'merged', n: 1, said: { code: 'autofix.done.merged', params: { n: 1 } }, items: [renumbered, merged, linked] }] },
  };
  const [{ id }] = await q<{ id: string }>(
    `INSERT INTO repair_runs (id, started_at, finished_at, origin, kind, target, status, ms, result)
     VALUES (gen_random_uuid(), now() + interval '1 minute', now() + interval '1 minute', 'manual', 'autofix', '{}'::jsonb, 'done', 5, $1::jsonb) RETURNING id`,
    [JSON.stringify(record)]);
  clearRunDigest();
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url, headers: { authorization: adminTok } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  try {
    const hidden = (await get(`/api/admin/tasks/repair/runs?id=${id}`)).content[0].result;
    assert.ok(hidden.log.some((l: any) => l.code === 'autofix.item.renumbered' && l.params.seriesIds?.[0] === S), 'a line naming a series that is not 18+ is kept');
    assert.ok(hidden.log.some((l: any) => l.code === 'autofix.item.merged' && l.params.from === 'Rr Merged Away'), 'a merge of a series that is not 18+ is still said');
    assert.deepEqual(hidden.log, [renumbered, merged, tested], 'the history: what is left out is what names an 18+ series, one gone, or carries no ids');
    assert.deepEqual(hidden.summary.done[0].items, [renumbered, merged], 'the history: the done lines\' items');
    // The run's own route, and the newest run's: the same rule.
    assert.deepEqual((await get(`/api/admin/health/autofix/${id}`)).log, [renumbered, merged, tested], 'the run\'s own route');
    const newest = await get('/api/admin/health/autofix');
    assert.equal(newest.last?.id, id, 'PREMISE: the planted run is the newest');
    assert.deepEqual(newest.last.log, [renumbered, merged, tested], 'the newest run');
    // The same admin with the reveal on reads every line, the 18+ ones and the old one included.
    assert.deepEqual((await get(`/api/admin/tasks/repair/runs?adult=1&id=${id}`)).content[0].result.log, all, 'the reveal shows every line');
    assert.deepEqual((await get(`/api/admin/health/autofix/${id}?adult=1`)).log, all);
  } finally {
    await q('DELETE FROM repair_runs WHERE id = $1', [id]);
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[AS, M, D]]);
    await q('DELETE FROM libraries WHERE id = $1', [LIB]);
    clearRunDigest();
  }
});

test('a kept Fix everything run\'s `tried`, which names series, is in no answer (v0.55.1)', { skip }, async () => {
  // Lane C keeps the packages a run searched in vain WITH the series each was searched for (`tried: [{pkg, lang,
  // series}]`), for the next runs' "never twice in a month" (lib/autofix.ts recentlyTried). The history sent the record as
  // stored, so every admin -- one who hides 18+ too -- read the ids of every series the run looked for, and nothing in the
  // web reads it. Reintroduce by sending it as stored (scrubAutofixRecord keeping `tried`): "the history leaves
  // `tried` out" fails, with the reveal on and off.
  const { clearRunDigest } = await import('../src/lib/repairRuns');
  const tried = [{ pkg: 'eu.kanade.tachiyomi.extension.en.rrpackage', lang: 'en', series: [S] }];
  const record = { phaseIndex: 9, log: [], tried, summary: { green: true, again: false, clears: [], needsYou: [], done: [] } };
  const [{ id }] = await q<{ id: string }>(
    `INSERT INTO repair_runs (id, started_at, finished_at, origin, kind, target, status, ms, result)
     VALUES (gen_random_uuid(), now() + interval '2 minutes', now() + interval '2 minutes', 'manual', 'autofix', '{}'::jsonb, 'done', 5, $1::jsonb) RETURNING id`,
    [JSON.stringify(record)]);
  clearRunDigest();
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url, headers: { authorization: adminTok } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  try {
    for (const url of [`/api/admin/tasks/repair/runs?id=${id}`, `/api/admin/tasks/repair/runs?adult=1&id=${id}`]) {
      const result = (await get(url)).content[0].result;
      assert.equal(result.phaseIndex, 9, `PREMISE: the planted record (${url})`);
      assert.ok(!('tried' in result), `the history leaves \`tried\` out (${url})`);
    }
    for (const url of [`/api/admin/health/autofix/${id}`, `/api/admin/health/autofix/${id}?adult=1`]) {
      assert.ok(!('tried' in (await get(url))), `the run's own route leaves it out (${url})`);
    }
    const newest = await get('/api/admin/health/autofix');
    assert.equal(newest.last?.id, id, 'PREMISE: the planted run is the newest');
    assert.ok(!('tried' in newest.last), 'and so does the newest run\'s');
    // Kept all the same: the next run reads it from the row.
    const [row] = await q<{ result: any }>('SELECT result FROM repair_runs WHERE id = $1', [id]);
    assert.deepEqual(row.result.tried, tried, 'the record keeps it for the next runs');
  } finally {
    await q('DELETE FROM repair_runs WHERE id = $1', [id]);
    clearRunDigest();
  }
});

test("the Tasks line's origin is null while the history has not caught up with the run it shows", { skip }, async () => {
  // The integration-1 review: the run check had no test of its own -- removed, the test above still passed. A result
  // naming a run the history's newest full run is not (the history lags a run that has just written the Tasks line)
  // has no origin to show: another run's would be a lie. Reintroduce `lastFull?.origin ?? null` in the Tasks route:
  // this reads 'manual'.
  const was = { finishedAt: repairState.finishedAt, lastResult: repairState.lastResult };
  const { clearRunDigest } = await import('../src/lib/repairRuns');
  const earlier = (await q<{ id: string }>(
    `INSERT INTO repair_runs (id, started_at, finished_at, origin, kind, target, status, ms)
     VALUES (gen_random_uuid(), now(), now(), 'manual', 'full', '{}'::jsonb, 'done', 5) RETURNING id`))[0].id;
  clearRunDigest();
  repairState.finishedAt = Date.now();
  repairState.lastResult = { ok: true, counted: 1, run: '00000000-0000-4000-8000-00000000abcd' };
  try {
    const row = await repairRow();
    assert.equal(row.lastResult?.run, '00000000-0000-4000-8000-00000000abcd');
    assert.equal(row.lastOrigin, null, "the Tasks line's origin is null while the history has not caught up with the run it shows");
  } finally {
    Object.assign(repairState, was);
    await q('DELETE FROM repair_runs WHERE id = $1', [earlier]);
    clearRunDigest();
  }
});

test("the Tasks line's origin is the run it shows, a nightly the switch turned away included", { skip }, async () => {
  // A nightly the switch turned away still writes the Tasks line (repair.int.test.ts, 'a full run is the Tasks
  // line'), so the origin beside it must be that run's. Reintroduce by leaving skipped runs out of the history's
  // lastFull (repairRuns.ts runDigest): the origin is not the nightly's.
  const { runRepair } = await import('../src/lib/repair');
  const was = { finishedAt: repairState.finishedAt, lastResult: repairState.lastResult };
  const earlier = (await q<{ id: string }>(
    `INSERT INTO repair_runs (id, started_at, finished_at, origin, kind, target, status, ms)
     VALUES (gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour', 'manual', 'full', '{}'::jsonb, 'done', 5) RETURNING id`))[0].id;
  await q('UPDATE server_settings SET repair_enabled = false WHERE id = 1');
  try {
    const r = await (runRepair(undefined) as Promise<any>);
    assert.equal(r.skipped, 'disabled');
    const row = await repairRow();
    assert.equal(row.lastResult?.skipped, 'disabled', 'the Tasks line is the nightly the switch turned away');
    assert.equal(row.lastOrigin, 'nightly', 'and so is the origin beside it, not the manual run before it');
  } finally {
    await q('UPDATE server_settings SET repair_enabled = true WHERE id = 1');
    await q('DELETE FROM repair_runs WHERE id = $1', [earlier]);
    Object.assign(repairState, was);
  }
});
