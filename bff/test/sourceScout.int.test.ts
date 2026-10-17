// The scout (v0.80.0, lib/sourceScout.ts) against a real scratch database: which series it looks for, where it looks,
// what it remembers, what it follows, and the bounds it keeps.
//
// The owner's ask: when a site rate-limits, blocks or stalls, find the series on another installed source and carry on
// from it. Each case below pins one of the rules that make that safe to do on the server's own initiative, with the
// reintroduction that breaks it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.SCAN_CONCURRENCY = '2';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const TITLE = 'Scouted Tale';
const MAIN = 'sct-main';
/** On MAIN's image server (the same rate group): it cools with MAIN, and is never asked on its behalf. */
const TWIN = 'sct-twin';
/** Answers every search with nothing. */
const NOPE = 'sct-nope';
/** Its search finds the title, and the series behind it is another one (its own page says so): not this one. */
const WRONG = 'sct-wrong';
/** This series, listing 1..12. */
const GOOD = 'sct-good';
/** Followers that are broken (their chapter list fails), for the limit. */
const BROKE = ['sct-broke-1', 'sct-broke-2', 'sct-broke-3'];
const ALL = [MAIN, TWIN, NOPE, WRONG, GOOD, ...BROKE];
const SER = 's_sct_series', LIB = 'lib_sct';
const searched = new Map<string, number>();
let gate: Promise<void> | null = null;
let q: any;
let sc: typeof import('../src/lib/sourceScout');

const list = (id: string, upTo = 12) => Array.from({ length: upTo }, (_, i) => ({ sourceId: `${id}-c${i + 1}`, number: i + 1, title: `Chapter ${i + 1}` }));
const adapter = (id: string, o: { hit?: string | null; real?: string; rateGroup?: string; upTo?: number } = {}) => ({
  id, name: id, ...(o.rateGroup ? { rateGroup: o.rateGroup } : {}),
  async search() {
    searched.set(id, (searched.get(id) ?? 0) + 1);
    if (gate) await gate;
    return o.hit ? [{ sourceId: `${id}-series`, source: id, title: o.hit }] : [];
  },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: o.real ?? o.hit ?? TITLE }; },
  async listChapters() { return list(id, o.upTo ?? 12); },
  async getPageUrls(chId: string) { return [`https://example.invalid/${chId}.png`]; },
  async latest() { return []; },
});

/** The series: MAIN lists 1..12, chapters 1..9 are here, 10..12 are not. */
async function seed(): Promise<void> {
  await q('DELETE FROM lib_series WHERE id = $1', [SER]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, source_checked_at, source_missing, finish_missing)
           VALUES ($1,'T!sct',$2,$1,9,$3,$4,'sct-main-series',true,now(),3,3)`, [SER, TITLE, LIB, MAIN]);
  for (let n = 1; n <= 12; n++) {
    const chosen = { sourceId: `${MAIN}-c${n}`, source: MAIN, number: n };
    const copy = { sourceId: `${MAIN}-c${n}`, source: MAIN, groups: [], scanlator: null, lang: null, pages: null, publishedAt: null };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`, [SER, n, MAIN, JSON.stringify(chosen), n <= 9 ? 'held' : 'available', JSON.stringify([copy])]);
  }
}
const cool = (id: string) => q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until) VALUES ($1, 'rate_limited', 1, now() + interval '1 hour')
  ON CONFLICT (source_id) DO UPDATE SET status = 'rate_limited', blocked_until = now() + interval '1 hour'`, [id]);
/** Confirmed failing at its chapter list (lib/sourceStanding.ts): cannot carry a series. */
const breakIt = (id: string) => q(`INSERT INTO source_health (source_id, status, stages) VALUES ($1, 'ok', $2::jsonb)
  ON CONFLICT (source_id) DO UPDATE SET stages = EXCLUDED.stages, blocked_until = NULL`,
  [id, JSON.stringify({ chapters: { failAt: new Date().toISOString(), failBy: 'test', streak: 3, kind: 'error', error: 'gone' } })]);
const follows = async () => (await q('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY source_id', [SER])).map((r: any) => r.source_id);
const verdicts = async () => Object.fromEntries((await q('SELECT source_id, verdict FROM scout_verdicts WHERE series_id = $1', [SER])).map((r: any) => [r.source_id, r.verdict]));

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const sources = await import('../src/lib/sources');
  sources.registerAdapter(adapter(MAIN, { rateGroup: 'sct-twins' }) as any);
  sources.registerAdapter(adapter(TWIN, { hit: TITLE, rateGroup: 'sct-twins' }) as any);
  sources.registerAdapter(adapter(NOPE) as any);
  sources.registerAdapter(adapter(WRONG, { hit: TITLE, real: 'Some Other Tale' }) as any);
  sources.registerAdapter(adapter(GOOD, { hit: TITLE }) as any);
  sc = await import('../src/lib/sourceScout');
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Scout',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
});

beforeEach(async () => {
  if (!DSN) return;
  searched.clear();
  gate = null;
  sc._resetScout();
  sc._setScoutLimits({ perHour: 40, maxSources: 12, maxSearches: 16, wallMs: 180_000 });
  await q('UPDATE server_settings SET auto_follow_on_failure = true WHERE id = 1');
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]);
  await q(`DELETE FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1`, [SER]).catch(() => {});
  // Every other monitored series stays out of the idle pick.
  await q(`UPDATE lib_series SET auto_update = false WHERE id <> $1`, [SER]);
  await seed();
  await cool(MAIN);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = $1', [SER]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a series its main cannot serve is scouted, and the source that has its chapters is followed', { skip }, async () => {
  const out = await sc.runScout(SER);
  assert.equal(out.verdict, 'followed', JSON.stringify(out));
  assert.equal(out.followed?.source, GOOD);
  assert.equal(out.followed?.brings, 3, 'it lists 10, 11 and 12');
  assert.deepEqual(await follows(), [GOOD], 'followed, and the main left as it is');
  assert.equal((await q('SELECT source_id FROM lib_series WHERE id = $1', [SER]))[0].source_id, MAIN, 'never made the main source');
  // To the front of the finishing sweep (lib/finishDownloads.ts backFirst).
  assert.equal((await q('SELECT source_checked_at FROM lib_series WHERE id = $1', [SER]))[0].source_checked_at, null);
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1`, [SER]))[0]?.detail;
  assert.equal(audit?.reason, 'scout');
  assert.equal(audit?.auto, true);
  // What the others said is kept (lib/scoutMemory.ts).
  const v = await verdicts();
  assert.equal(v[GOOD], 'ok');
  // Reintroduce by dropping the image-server rule (lib/sourceScout.ts `taken`): TWIN, which cools with MAIN, is searched.
  assert.equal(searched.get(TWIN) ?? 0, 0, 'a source on the main\'s image server is never asked');
});

test('a source that said no is not asked again', { skip }, async () => {
  const { unregisterAdapter, registerAdapter } = await import('../src/lib/sources');
  unregisterAdapter(GOOD);
  try {
    const first = await sc.runScout(SER);
    assert.equal(first.verdict, 'exhausted', JSON.stringify(first));
    const v = await verdicts();
    assert.equal(v[NOPE], 'no_hit');
    assert.equal(v[WRONG], 'title_differs');
    assert.ok(first.nextAt && first.nextAt.getTime() - Date.now() > 50 * 60_000, 'looked at again when the first answer runs out, not at once');
    searched.clear();
    const second = await sc.runScout(SER);
    // Reintroduce by asking anyway (lib/sourceScout.ts, the `holds` skip): NOPE and WRONG are searched again.
    assert.equal(searched.get(NOPE) ?? 0, 0);
    assert.equal(searched.get(WRONG) ?? 0, 0);
    assert.equal(second.searches, 0);
  } finally {
    registerAdapter(adapter(GOOD, { hit: TITLE }) as any);
  }
});

test('a series its own sources can serve is not scouted', { skip }, async () => {
  await q('DELETE FROM source_health WHERE source_id = $1', [MAIN]);
  const out = await sc.runScout(SER);
  // Reintroduce by scouting every behind series (dropping the `need` check): GOOD is searched and followed.
  assert.equal(out.verdict, 'not_needed');
  assert.equal(out.searches, 0);
  assert.deepEqual(await follows(), []);
});

test('chapters at their retry cap make a series worth scouting, and get their tries back', { skip }, async () => {
  await q('DELETE FROM source_health WHERE source_id = $1', [MAIN]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts) VALUES ($1, 11, $2, 'error', 3), ($1, 12, $2, 'error', 3)
           ON CONFLICT (series_id, number) DO UPDATE SET attempts = 3, status = 'error'`, [SER, MAIN]);
  try {
    const out = await sc.runScout(SER);
    assert.equal(out.verdict, 'followed', JSON.stringify(out));
    assert.equal(out.followed?.brings, 2, 'it lists the two capped chapters');
    // Reintroduce by dropping afterFollow's reset (lib/sourceScout.ts): the attempts stay at 3, and the sweep never asks.
    const left = await q('SELECT number::int AS n, attempts FROM chapter_failures WHERE series_id = $1 ORDER BY number', [SER]);
    assert.deepEqual(left.map((r: any) => Number(r.attempts)), [0, 0]);
  } finally {
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [SER]);
  }
});

test('a broken follower does not hold the series at its limit, and is kept', { skip }, async () => {
  const { registerAdapter, unregisterAdapter } = await import('../src/lib/sources');
  for (const b of BROKE) registerAdapter(adapter(b) as any);
  try {
    for (const b of BROKE) {
      await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [SER, b, `${b}-series`]);
      await breakIt(b);
    }
    const { MAX_FOLLOWERS } = await import('../src/lib/autoFollow');
    assert.equal(MAX_FOLLOWERS, 3, 'PREMISE: three by default (lib/followLimit.ts)');
    const out = await sc.runScout(SER);
    // Reintroduce by counting every follower (runScout's check, or followJudged's `notCounted`): `cap`.
    assert.equal(out.verdict, 'followed', JSON.stringify(out));
    assert.deepEqual(await follows(), [...BROKE, GOOD].sort(), 'nothing deleted');
    // Three working followers fill it, cooling or not.
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [BROKE]);
    await q('DELETE FROM series_sources WHERE series_id = $1 AND source_id = $2', [SER, GOOD]);
    for (const b of BROKE) await cool(b);
    const capped = await sc.runScout(SER);
    assert.equal(capped.verdict, 'cap');
    assert.equal(capped.searches, 0);
  } finally {
    await q('DELETE FROM series_sources WHERE series_id = $1', [SER]);
    for (const b of BROKE) unregisterAdapter(b);
  }
});

test('a cooling candidate waits for the next look, with nothing remembered about it', { skip }, async () => {
  await cool(GOOD);
  const out = await sc.runScout(SER);
  assert.equal(out.verdict, 'deferred', JSON.stringify(out));
  assert.ok(out.nextAt && out.nextAt.getTime() - Date.now() <= 15 * 60_000 + 5_000, 'looked at again within a quarter of an hour');
  assert.equal(searched.get(GOOD) ?? 0, 0);
  assert.equal((await verdicts())[GOOD], undefined);
});

test('a source an admin unfollowed is not followed again', { skip }, async () => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  await q(`DELETE FROM users WHERE username = 'sct-admin'`);
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms) VALUES ('sct-admin','sct-admin','x','admin','password','{}'::jsonb) RETURNING id`))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  try {
    const first = await sc.runScout(SER);
    assert.equal(first.followed?.source, GOOD, 'PREMISE: followed');
    const res = await app.inject({
      method: 'DELETE', url: `/api/admin/series/${SER}/sources/${GOOD}`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(await follows(), []);
    searched.clear();
    const again = await sc.runScout(SER);
    // Reintroduce by dropping markRemoved from the unfollow route (routes/admin.ts): GOOD is followed again.
    assert.notEqual(again.followed?.source, GOOD, JSON.stringify(again));
    assert.equal(searched.get(GOOD) ?? 0, 0, 'not even searched');
    assert.equal((await verdicts())[GOOD], 'removed');
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username = 'sct-admin'`);
  }
});

test('the hour\'s searches hold across looks, and a look stopped by them goes on later', { skip }, async () => {
  sc._setScoutLimits({ perHour: 1 });
  const { unregisterAdapter, registerAdapter } = await import('../src/lib/sources');
  unregisterAdapter(GOOD);
  try {
    const out = await sc.runScout(SER);
    // Reintroduce by not counting the hour (lib/sourceScout.ts scoutSearchesLeft): WRONG is searched too, and the look
    // ends `exhausted`.
    assert.equal(out.searches, 1);
    assert.equal(out.verdict, 'left');
    assert.ok(out.nextAt && Math.abs(out.nextAt.getTime() - Date.now() - 3600_000) < 60_000, 'an hour on, the first time');
    assert.equal(sc.scoutSearchesLeft(), 0);
    assert.equal(await sc.scoutTick(), null, 'no look at all with the hour spent');
  } finally {
    registerAdapter(adapter(GOOD, { hit: TITLE }) as any);
  }
});

test('one look at a time, and none with the switch off', { skip }, async () => {
  await q(`INSERT INTO series_scout (series_id, reason, priority) VALUES ($1, 'stuck', 2) ON CONFLICT (series_id) DO UPDATE SET next_at = now()`, [SER]);
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const first = sc.scoutTick();
  while (!searched.size) await new Promise((r) => setTimeout(r, 10));
  // Reintroduce by dropping the `scouting` flag: the second look runs too, and searches.
  assert.equal(await sc.scoutTick(), null, 'a second look while one runs does nothing');
  open();
  const out = await first;
  assert.equal(out?.verdict, 'followed');
  assert.equal(out?.seriesId, SER);
  const row = (await q('SELECT verdict, priority, next_at > now() + interval \'5 hours\' AS later FROM series_scout WHERE series_id = $1', [SER]))[0];
  assert.equal(row.verdict, 'followed');
  assert.equal(row.priority, 0, 'the request is answered');
  assert.equal(row.later, true, 'and looked at again no sooner than six hours on');
  // The switch: "Use other sources on their own" (auto_follow_on_failure).
  await q('DELETE FROM series_sources WHERE series_id = $1', [SER]);
  await q(`UPDATE series_scout SET next_at = now(), priority = 2 WHERE series_id = $1`, [SER]);
  await q('UPDATE server_settings SET auto_follow_on_failure = false WHERE id = 1');
  searched.clear();
  assert.equal(await sc.scoutTick(), null);
  assert.equal(searched.size, 0);
});

test('with nothing put forward, a behind series none of whose sources can be asked is picked', { skip }, async () => {
  await q('DELETE FROM series_scout WHERE series_id = $1', [SER]);
  const out = await sc.scoutTick();
  assert.equal(out?.seriesId, SER, JSON.stringify(out));
  assert.equal(out?.verdict, 'followed');
  // A series it just looked at waits for its backoff: the next idle pick passes over it.
  await q('DELETE FROM series_sources WHERE series_id = $1', [SER]);
  assert.equal(await sc.scoutTick(), null);
});

test('a series every source of which is cooling is put forward for the scout', { skip }, async () => {
  await q('DELETE FROM series_scout WHERE series_id = $1', [SER]);
  const { updateSeries } = await import('../src/lib/updater');
  const r = await updateSeries(SER, 0);
  assert.equal(r.outcome, 'blocked', 'PREMISE: its only source is cooling');
  // Reintroduce by dropping the request in visitSeries (lib/updater.ts): no row.
  const row = (await q('SELECT reason, priority FROM series_scout WHERE series_id = $1', [SER]))[0];
  assert.equal(row?.reason, 'stuck');
  assert.equal(row?.priority, 2);
  // A caught-up series is not put forward: the trigger asks for behind ones only.
  await q('DELETE FROM series_scout WHERE series_id = $1', [SER]);
  await q('UPDATE lib_series SET source_missing = 0, finish_missing = 0, finish_after = NULL WHERE id = $1', [SER]);
  await updateSeries(SER, 0);
  assert.equal((await q('SELECT 1 FROM series_scout WHERE series_id = $1', [SER])).length, 0);
});

test('the hunt skips a source that already said no, and a series the scout just looked at', { skip }, async () => {
  const { huntSource, HUNT_MAX_PER_SWEEP } = await import('../src/lib/sourceHunt');
  const { recordVerdict } = await import('../src/lib/scoutMemory');
  await q('DELETE FROM source_health WHERE source_id = $1', [MAIN]);
  await q('UPDATE lib_series SET source_hunt_at = NULL WHERE id = $1', [SER]);
  await recordVerdict(SER, NOPE, 'no_hit', { ourCount: 12 });
  const allowed = () => true;
  const r = await huntSource(SER, 11, { allowed, budget: { left: HUNT_MAX_PER_SWEEP } });
  // Reintroduce by searching them anyway (lib/sourceHunt.ts `saidNo`): NOPE is searched.
  assert.equal(searched.get(NOPE) ?? 0, 0);
  assert.ok(r.followed, JSON.stringify(r));
  // The scout looked within the hour: the hunt does not search at all.
  await q('DELETE FROM series_sources WHERE series_id = $1', [SER]);
  await q('UPDATE lib_series SET source_hunt_at = NULL WHERE id = $1', [SER]);
  await q(`INSERT INTO series_scout (series_id, reason, last_at) VALUES ($1, 'stuck', now()) ON CONFLICT (series_id) DO UPDATE SET last_at = now()`, [SER]);
  searched.clear();
  const again = await huntSource(SER, 11, { allowed, budget: { left: HUNT_MAX_PER_SWEEP } });
  // Reintroduce by dropping HUNT_AFTER_SCOUT_MS (lib/sourceHunt.ts): it searches.
  assert.equal(again.why, 'cooldown');
  assert.equal(searched.size, 0);
});
