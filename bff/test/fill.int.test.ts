// Filling a series' missing chapters, driven through the real routes.
//
// The one that matters most is the metadata test. `downloadChapter` writes `meta.series` into the CBZ's
// ComicInfo <Series>, and every persistScan re-reads the FIRST chapter's ComicInfo and overwrites the series
// row's title, summary, author, status, genres and web from it (lib/library.ts, ON CONFLICT DO UPDATE). A
// fill repairs the START of a series, so it writes the new first chapter. Pass the candidate's title as meta
// and the series silently renames itself for everyone on the next scan -- and it fires when the match is
// RIGHT, because a right match is usually under a different English title. That is not a hypothetical: the
// series that prompted this feature is listed as "Mr Devourer, Please Act Like a Final Boss" elsewhere.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-fill-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = root;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_fill', SERIES = 's_fill_1', FOLDER = 'Rich Source/Filled Series';
const RICH = 'fill-rich';      // has 1..10
const POOR = 'fill-poor';      // has only 8..10, which is what our library was built from
const WRONG = 'fill-wrong';    // a different series that numbers 1..3
const USER = 'fill-admin';
let q: any, app: any, tok: string, uid: string;

const page = (n: number) => ({ sourceId: `c/${n}`, number: n, title: `Chapter ${n}` });

/**
 * PNG magic plus padding. The padding is load-bearing: the downloader drops any response under 256 bytes as
 * a blocked or empty page, so a real 68-byte 1x1 PNG is discarded and the chapter reports zero pages.
 */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  if (String(u).includes('example.invalid')) {
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return realFetch(u, init);
}) as typeof fetch;

function fake(id: string, name: string, nums: number[], title: string) {
  return {
    id, name,
    async search() { return [{ sourceId: `${id}-s`, source: id, title, coverUrl: undefined }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title }; },
    async listChapters() { return nums.map(page); },
    async getPageUrls() { return ['https://example.invalid/p1.jpg']; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  await migrate();

  registerAdapter(fake(RICH, 'Rich Source', [1,2,3,4,5,6,7,8,9,10,11], 'Filled Series Deluxe Edition') as any);
  registerAdapter(fake(POOR, 'Poor Source', [8,9,10,11], 'Filled Series') as any);
  registerAdapter(fake(WRONG, 'Wrong Source', [1,2,3], 'Filled Series') as any);

  // A previous run's failed downloads leave these fakes marked blocked in source_health, and a blocked source
  // is (correctly) not offered -- which would make this file fail for a reason that has nothing to do with it.
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[RICH, POOR, WRONG]]);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Fill',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, summary, author)
           VALUES ($1,'T!fill','Filled Series',$2,4,$3,$4,'poor-s','Our summary','Our author')`,
    [SERIES, FOLDER, LIB, POOR]);
  for (const n of [8, 9, 10, 11]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root)
             VALUES ($1,$2,'T!fill',$3,$4,$5,'/library') ON CONFLICT (id) DO NOTHING`,
      [`b_fill_${n}`, SERIES, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('DELETE FROM users WHERE username = $1', [USER]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                  VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.ready();
  tok = `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}`;
});

after(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[RICH, POOR, WRONG]]).catch(() => {});
});

const scan = (body: any = {}) =>
  app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: { authorization: tok }, payload: { seriesId: SERIES, ...body } });

test('the scan finds the hole and says who can fill it', { skip }, async (t) => {
  const res = await scan();
  assert.equal(res.statusCode, 200);
  const j = res.json();

  await t.test('it reports the gap we actually have', () => {
    assert.deepEqual(j.gaps.map((g: any) => [g.lo, g.hi]), [], 'no interior gap: 8..11 is one run');
    assert.equal(j.have.count, 4);
  });

  await t.test('a source that carries our numbering is accepted, under its own title', () => {
    const rich = j.candidates.find((c: any) => c.source === RICH);
    assert.ok(rich, 'the rich source was found by title');
    assert.notEqual(rich.title, 'Filled Series',
      'the candidate must carry ITS title, not ours: that difference is the whole hazard');
    assert.equal(rich.coverage, 1, 'it lists every chapter we hold');
  });

  await t.test('a source with a different story is refused, not offered', () => {
    const wrong = j.candidates.find((c: any) => c.source === WRONG);
    assert.ok(wrong, 'it is still shown, so the person can see why');
    assert.equal(wrong.why, 'numbering_mismatch');
    assert.ok(wrong.coverage < 0.9, `coverage ${wrong.coverage} is the evidence shown`);
  });

  await t.test('a plan id is issued, and the chapter urls are not in the response', () => {
    assert.match(j.planId, /^fp_/);
    assert.ok(!JSON.stringify(j).includes('c/9'), 'no chapter URL may cross the wire');
  });
});

test('THE METADATA HAZARD: a fill must not rename the series', { skip }, async () => {
  // A real interior gap to repair: drop chapter 9, leaving 8,10,11 -- still above MIN_HAVE, with a hole.
  await q('DELETE FROM lib_books WHERE series_id = $1 AND number = 9', [SERIES]);
  const j = (await scan()).json();
  const rich = j.candidates.find((c: any) => c.source === RICH);
  assert.ok(rich.fillable.includes(9), `chapter 9 should be offered, got ${JSON.stringify(rich.fillable)}`);

  // Same plan, a number it never offered. Chapter 1 sits below everything we hold, so it is extrapolation
  // rather than repair and was deliberately not on the list. Trusting the body here would let a client fetch
  // anything it could name from any source in the plan.
  const sneaky = await app.inject({
    method: 'POST', url: '/api/sources/fill', headers: { authorization: tok },
    payload: { planId: j.planId, source: RICH, sourceSeriesId: rich.sourceSeriesId, numbers: [1] },
  });
  assert.equal(sneaky.statusCode, 400, 'a number that was not offered must be refused');
  assert.equal(sneaky.json().error, 'not_offered');

  const res = await app.inject({
    method: 'POST', url: '/api/sources/fill', headers: { authorization: tok },
    payload: { planId: j.planId, source: RICH, sourceSeriesId: rich.sourceSeriesId, numbers: [9] },
  });
  assert.equal(res.statusCode, 200, res.body);
  // The fill answers as soon as it has decided; the work happens after. Poll rather than guess a duration.
  let written: string[] = [];
  for (let i = 0; i < 40; i++) {
    written = existsSync(join(root, FOLDER)) ? readdirSync(join(root, FOLDER)) : [];
    if (written.some((f) => f.includes('Chapter 9'))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: tok } })).json();
  assert.ok(written.some((f) => f.includes('Chapter 9')),
    `chapter 9 should be on disk, saw ${JSON.stringify(written)}; job: ${JSON.stringify(jobs.content || jobs)}`);

  // Read the ComicInfo straight out of the archive: this is the exact value persistScan will later read back
  // and copy over the series row, which is the whole point of the assertion below.
  const AdmZip = (await import('adm-zip')).default;
  const xml = new AdmZip(join(root, FOLDER, 'Chapter 9.cbz')).readAsText('ComicInfo.xml');
  assert.match(xml, /<Series>Filled Series<\/Series>/,
    'the CBZ must carry OUR series name. The candidate is called "Filled Series Deluxe Edition"; writing that ' +
    'here would rename this series for everyone on the next persistScan.');
  assert.doesNotMatch(xml, /Deluxe/, 'not a trace of the candidate title may reach the archive');
  assert.match(xml, /Our summary/, 'and our summary, for the same reason');
});


test('a stale plan is refused rather than re-derived', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/sources/fill', headers: { authorization: tok },
    payload: { planId: 'fp_deadbeefdeadbeef', source: RICH, sourceSeriesId: `${RICH}-s`, numbers: [9] },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'plan_stale');
});


/**
 * A source with a failure streak is still OFFERED, and the dialog is told.
 *
 * The scan gated on `blocked_until` alone. Once a cooldown lapsed the source came back as a clean
 * `why='ok'`, whatever its record: live, WeebCentral had 403'd on every image byte since June, never once
 * completed a download, and rendered as a confident "Fetch 12 chapters" button. Hiding it instead would
 * deadlock it -- `consecutive` is cleared only by reportOk, which fires only after a download succeeds.
 *
 * Reintroduce by dropping the `health:` field from the candidate: the first assertion below fails.
 */
test('a source with a streak is offered with its record attached, not hidden', { skip }, async () => {
  await q(`INSERT INTO source_health (source_id, status, consecutive, last_fail_at, last_ok_at, blocked_until)
           VALUES ($1, 'rate_limited', 3, now(), NULL, now() - interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET status = 'rate_limited', consecutive = 3, last_fail_at = now(),
             last_ok_at = NULL, blocked_until = now() - interval '1 hour'`, [RICH]);
  let rich = (await scan()).json().candidates.find((c: any) => c.source === RICH);
  assert.ok(rich, 'the source is still in the list');
  // Whatever the verdict says about its chapters, the streak itself must not have decided anything.
  assert.notEqual(rich.why, 'blocked', 'a lapsed cooldown is not a block: a warning is not a filter');
  assert.ok(['ok', 'nothing_to_fill', 'numbering_mismatch'].includes(rich.why), `judged on its chapters, got ${rich.why}`);
  assert.ok(rich.health, 'and the dialog is told what it is dealing with');
  assert.equal(rich.health.status, 'rate_limited');
  assert.equal(rich.health.consecutive, 3);
  assert.equal(rich.health.lastOkAt, null, 'never completed a download here: the fact that would have saved a person from WeebCentral');
  assert.ok(!('lastError' in rich.health) && !JSON.stringify(rich).includes('last_error'),
    'last_error carries internal hostnames and this route is not admin-only');

  await q('DELETE FROM source_health WHERE source_id = $1', [RICH]);
  rich = (await scan()).json().candidates.find((c: any) => c.source === RICH);
  assert.equal(rich.health, null, 'a clean source carries no warning');
});
