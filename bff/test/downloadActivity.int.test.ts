// Every chapter the server downloads, whatever started it (lib/downloadActivity.ts): the downloads view.
//
// The pill used to know only the jobs a button started. A source followed from "Find missing chapters"
// downloads at the series' next check, the scheduled check downloads for every series, and so do Check now,
// the repair and a bulk "Fetch newest" -- none of it showed anywhere. So:
//
//   - what started a download travels with it (AsyncLocalStorage), through awaits and timers;
//   - a download is recorded at downloadChapter, where every path ends: queued, downloading, done or failed,
//     and a file already on disk leaves no trace;
//   - a chapter that arrived incomplete is `partial` only once its caller keeps it, `failed` if it never does;
//   - GET /api/sources/jobs lists it to the viewers who can browse that series, and a folder that is not a
//     series yet (an add's first chapter) only to its starter and an admin.
//
// The first tests need no database; the rest are skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-activity-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('what started a download travels with it, through awaits and timers', async () => {
  const { withOrigin, currentOrigin } = await import('../src/lib/downloadActivity');
  assert.deepEqual(currentOrigin(), { origin: 'server', by: null }, 'nothing set: the server');
  const seen = await withOrigin('sweep', 'u1', async () => {
    await sleep(2);
    return new Promise<ReturnType<typeof currentOrigin>>((r) => setTimeout(() => r(currentOrigin()), 2));
  });
  // Reintroduce by storing the origin in a module variable: two runs at once would take each other's.
  assert.deepEqual(seen, { origin: 'sweep', by: 'u1' });
  const [a, b] = await Promise.all([
    withOrigin('check', 'x', async () => { await sleep(5); return currentOrigin().origin; }),
    withOrigin('add', 'y', async () => { await sleep(1); return currentOrigin().origin; }),
  ]);
  assert.deepEqual([a, b], ['check', 'add'], 'two downloads at once keep their own origins');
  assert.equal(currentOrigin().origin, 'server', 'and nothing leaks out afterwards');
});

test('queued, downloading, then done or failed; a file already on disk leaves no trace', async () => {
  const act = await import('../src/lib/downloadActivity');
  act.clearActivity();
  const id = act.withOrigin('fill', 'me', () => act.beginDownload({ folder: 'F', title: 'T', number: 3, source: 's' }));
  assert.equal(act.listActivity().active[0].status, 'queued');
  act.startedDownload(id);
  assert.equal(act.listActivity().active[0].status, 'downloading');
  act.endDownload(id, { status: 'done', pages: 20 });
  const { active, recent } = act.listActivity();
  assert.equal(active.length, 0);
  assert.equal(recent[0].status, 'done');
  assert.equal(recent[0].origin, 'fill');
  const skipped = act.beginDownload({ folder: 'F', title: 'T', number: 4, source: 's' });
  act.endDownload(skipped, 'skipped');
  assert.equal(act.listActivity().recent.length, 1, 'a skip must not list every chapter a sweep did not fetch');
});

test('an incomplete chapter is partial once kept, and failed if it never is', async () => {
  const act = await import('../src/lib/downloadActivity');
  act.clearActivity();
  const kept = act.beginDownload({ folder: 'F', title: 'T', number: 5, source: 's' });
  const hold = { missing: [3, 4], write: async () => ({ pages: 20, missing: [3, 4] }) };
  act.holdPartial(kept, hold);
  assert.equal(act.listActivity().active.length, 1, 'still open while the caller decides');
  await hold.write();
  assert.equal(act.listActivity().recent[0].status, 'partial');
  assert.match(act.listActivity().recent[0].reason!, /2 pages missing/);
  // v0.49.1: and as its code, which the downloads view words in the reader's language (lib/said.ts). Read back from
  // the English too, which is all a restart keeps (lib/activityLog.ts). Reintroduce the bare English reason: no code.
  assert.deepEqual(act.listActivity().recent[0].reasonSaid, [{ code: 'activity.saved', params: { n: 2 } }]);
  assert.deepEqual(act.reasonSaidOf('arrived with 1 page missing; not kept'),
    [{ code: 'activity.arrived', params: { n: 1 } }, { code: 'activity.notKept' }]);
  assert.equal(act.reasonSaidOf('HTTP 404 on page 3'), undefined, 'a download\'s own error is shown as sent, never guessed at');

  const dropped = act.beginDownload({ folder: 'F', title: 'T', number: 6, source: 's' });
  act.holdPartial(dropped, { missing: [1], write: async () => ({ pages: 9, missing: [1] }) });
  const later = act.listActivity(Date.now() + 11 * 60_000);
  assert.equal(later.active.length, 0, 'a hold nobody wrote must not stay "downloading" forever');
  assert.equal(later.recent.find((e) => e.number === 6)?.status, 'failed');
});

test('a chapter that lands whole after landing with holes is no longer partial, and only that chapter', async () => {
  // Came in today counted "1 chapter saved with pages missing" from the day's entries, and kept counting the first
  // landing after a later one -- a refetch, the completion pass's other copy -- had written the chapter whole
  // (v0.49.1). Reintroduce by dropping the healFinished call in endDownload: the first entry still reads partial.
  const act = await import('../src/lib/downloadActivity');
  act.clearActivity();
  const partialOf = async (folder: string, n: number) => {
    const id = act.beginDownload({ folder, title: 'T', number: n, source: 's' });
    const hold = { missing: [2], write: async () => ({ pages: 10, missing: [2] }) };
    act.holdPartial(id, hold);
    await hold.write();
  };
  await partialOf('F', 7);
  await partialOf('F', 8);
  await partialOf('G', 7);
  const whole = act.beginDownload({ folder: 'F', title: 'T', number: 7, source: 's2' });
  act.endDownload(whole, { status: 'done', pages: 10 });
  const said = (folder: string, n: number) => act.listActivity().recent.filter((e) => e.folder === folder && e.number === n).map((e) => [e.status, e.reason]);
  assert.deepEqual(said('F', 7), [['done', undefined], ['done', undefined]], 'a chapter that landed whole later is still saved with pages missing');
  assert.deepEqual(said('F', 8), [['partial', 'saved with 1 page missing']], 'another chapter of the series is healed with it');
  assert.deepEqual(said('G', 7), [['partial', 'saved with 1 page missing']], 'the same number in another series is healed with it');
  // What the completion pass calls when it fills the holes in place, with no download to say so.
  assert.equal(act.healFinished('F', 8), 1);
  assert.equal(act.healFinished('F', 8), 0, 'twice is once');
  assert.deepEqual(said('F', 8), [['done', undefined]]);
  act.clearActivity();
});

test('a healed chapter loses the codes of its reason with the English', async () => {
  // A reason goes out twice since v0.49.1, as English and as codes (reasonSaid). The heal deleted only the English,
  // so a healed entry still sent the codes of "saved with 1 page missing". Reintroduce by keeping reasonSaid in
  // healFinished: "a healed entry sends no codes" fails.
  const act = await import('../src/lib/downloadActivity');
  act.clearActivity();
  const id = act.beginDownload({ folder: 'H', title: 'T', number: 3, source: 's' });
  const hold = { missing: [2], write: async () => ({ pages: 10, missing: [2] }) };
  act.holdPartial(id, hold);
  await hold.write();
  const entry = () => act.listActivity().recent.find((e) => e.folder === 'H' && e.number === 3);
  assert.deepEqual(entry()?.reasonSaid, [{ code: 'activity.saved', params: { n: 1 } }], 'PREMISE: a partial entry carries its codes');
  assert.equal(act.healFinished('H', 3), 1);
  assert.equal(entry()?.reason, undefined);
  assert.equal(entry()?.reasonSaid, undefined, 'a healed entry sends no codes');
  act.clearActivity();
});

// ---------------------------------------------------------------------------------------------- the route
const SRC = 'act-src';
const LIB_A = 'lib_act_a';
const LIB_B = 'lib_act_b';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
let q: any;
const ids = { admin: '', member: '', other: '' };

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter({
    id: SRC, name: 'Zzz Activity',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
    async listChapters() { return []; },
    async getPageUrls(chId: string) { return [1, 2].map((i) => `https://example.invalid/${chId}/${i}.png`); },
    async latest() { return []; },
  } as any);
  for (const l of [LIB_A, LIB_B]) await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$1,$1) ON CONFLICT (id) DO NOTHING`, [l]);
  await q(`DELETE FROM users WHERE username LIKE 'act-%'`);
  const mk = async (u: string, role: string) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [u, role]))[0].id as string;
  ids.admin = await mk('act-admin', 'admin');
  ids.member = await mk('act-member', 'user');
  ids.other = await mk('act-other', 'user');
  // The member may open library A only.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids.member, LIB_A]);
  for (const [id, lib] of [['s_act_a', LIB_A], ['s_act_b', LIB_B]]) {
    await q('DELETE FROM lib_series WHERE id = $1', [id]);
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'Zzz',$1,$1,0,$2)`, [id, lib]);
    mkdirSync(join(ROOT, id), { recursive: true });
  }
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id IN ('s_act_a','s_act_b')`).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'act-%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B]]).catch(() => {});
});

test('a download is recorded where every path ends, with what started it, and shown to who may see the series', { skip }, async () => {
  const act = await import('../src/lib/downloadActivity');
  const { downloadChapter } = await import('../src/lib/downloader');
  act.clearActivity();
  const chapter = (n: number) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SRC}-${n}` });
  // A followed source's chapter arriving through Check now; one for the library the member cannot open; and
  // an add's first chapter, whose folder is not a series yet.
  await act.withOrigin('check', ids.admin, () => downloadChapter({ sourceId: SRC, seriesFolder: 's_act_a', chapter: chapter(1), meta: { series: 'Series A' } }));
  await act.withOrigin('sweep', null, () => downloadChapter({ sourceId: SRC, seriesFolder: 's_act_b', chapter: chapter(1), meta: { series: 'Series B' } }));
  await act.withOrigin('add', ids.other, () => downloadChapter({ sourceId: SRC, seriesFolder: 'act-new/Brand New', chapter: chapter(1), meta: { series: 'Brand New' } }));
  // Already on disk: nothing came in, so nothing is listed.
  await act.withOrigin('sweep', null, () => downloadChapter({ sourceId: SRC, seriesFolder: 's_act_a', chapter: chapter(1), meta: { series: 'Series A' } }));

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  const seen = async (id: string, role: string) =>
    ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` } }))
      .json().activity.recent as any[]).map((e) => `${e.title}:${e.origin}:${e.status}${e.seriesId ? `:${e.seriesId}` : ''}`).sort();
  try {
    // Reintroduce by dropping the recording in downloadChapter: all three lists are empty.
    assert.deepEqual(await seen(ids.admin, 'admin'),
      ['Brand New:add:done', 'Series A:check:done:s_act_a', 'Series B:sweep:done:s_act_b'], 'an admin sees every download');
    // Reintroduce by dropping `shown` in activityFor: the member sees Series B, from a library they cannot open.
    assert.deepEqual(await seen(ids.member, 'user'), ['Series A:check:done:s_act_a'], 'a member sees only series they can browse');
    assert.deepEqual(await seen(ids.other, 'user'), ['Brand New:add:done', 'Series A:check:done:s_act_a', 'Series B:sweep:done:s_act_b'],
      'an unrestricted member sees the library, and their own add before it is a series');
    const member = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${app.jwt.sign({ sub: ids.member, role: 'user' })}` } })).json();
    assert.ok(!(member.activity.recent as any[]).some((e) => e.title === 'Brand New'), "an add's first chapter is its starter's and an admin's");
    assert.ok(!(member.activity.recent as any[]).some((e) => 'by' in e), 'who started a download is not sent, only `mine`');
  } finally {
    await app.close();
  }
});
