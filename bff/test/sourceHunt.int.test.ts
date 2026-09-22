// The bounded, once-a-day source hunt against a real scratch database.
//
// This pins the two safety boundaries most likely to regress while the happy path keeps working: an adult
// provider is never searched for a clean series, and the search slots are shared across simultaneous hunts
// rather than multiplied per series. It also proves that judgeCandidate returns the chapter list the hunt
// consumes, avoiding a third provider lookup.
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

const OWN = 'hunt-own', CLEAN = 'hunt-clean', ADULT = 'hunt-adult';
const PROBES = ['hunt-probe-1', 'hunt-probe-2', 'hunt-probe-3', 'hunt-probe-4'];
const TITLE = 'Hunted Tale';
const MAIN = 's_hunt_main', C1 = 's_hunt_concurrent_1', C2 = 's_hunt_concurrent_2';
const ALL_SERIES = [MAIN, C1, C2];
const searches = new Map<string, number>();
let active = 0, peak = 0, delaySearch = false;
let q: any, huntSource: any, seriesIsAdult: any, sweepAllowedFor: any, judgeCandidate: any;

const chapters = (source: string) => Array.from({ length: 11 }, (_, i) => ({ sourceId: `${source}-c${i + 1}`, number: i + 1 }));
const source = (id: string, opts: { adult?: boolean; hit?: boolean } = {}) => ({
  id, name: id, ...(opts.adult ? { isNsfw: true } : {}),
  async search() {
    searches.set(id, (searches.get(id) ?? 0) + 1);
    active++; peak = Math.max(peak, active);
    try {
      if (delaySearch) await new Promise((r) => setTimeout(r, 25));
      return opts.hit ? [{ sourceId: `${id}-series`, source: id, title: TITLE }] : [];
    } finally { active--; }
  },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: TITLE }; },
  async listChapters() { return chapters(id); },
  async getPageUrls() { return []; },
});

async function seed(id: string, ageRating: number | null = null): Promise<void> {
  await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, age_rating)
           VALUES ($1,'T!hunt',$2,$3,0,$4,$5,$6)`, [id, TITLE, id, OWN, `${OWN}-${id}`, ageRating]);
  for (let n = 1; n <= 10; n++) {
    const chosen = { sourceId: `${OWN}-c${n}`, source: OWN, number: n };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen)
             VALUES ($1,$2,$3,$4::jsonb)`, [id, n, OWN, JSON.stringify(chosen)]);
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = await import('../src/lib/db'));
  const sources = await import('../src/lib/sources');
  await migrate();
  sources.registerAdapter(source(OWN) as any);
  sources.registerAdapter(source(CLEAN) as any);
  sources.registerAdapter(source(ADULT, { adult: true, hit: true }) as any);
  for (const id of PROBES) sources.registerAdapter(source(id) as any);
  ({ huntSource, seriesIsAdult, sweepAllowedFor } = await import('../src/lib/sourceHunt'));
  ({ judgeCandidate } = await import('../src/lib/autoFollow'));
});

beforeEach(async () => {
  if (!DSN) return;
  searches.clear(); active = 0; peak = 0; delaySearch = false;
  await q('UPDATE server_settings SET auto_follow_on_failure = true WHERE id = 1');
  await q('DELETE FROM audit_log WHERE event = $1 AND detail->>\'id\' = ANY($2::text[])', ['series.follow_source', ALL_SERIES]).catch(() => {});
  for (const id of ALL_SERIES) await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[OWN, CLEAN, ADULT, ...PROBES]]).catch(() => {});
});

after(async () => {
  if (!DSN) return;
  await q('UPDATE server_settings SET auto_follow_on_failure = true WHERE id = 1').catch(() => {});
  for (const id of ALL_SERIES) await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[OWN, CLEAN, ADULT, ...PROBES]]).catch(() => {});
});

test('the adult rule filters before search, then an adult series may find and follow that source', { skip }, async () => {
  await seed(MAIN);
  const cleanRule = sweepAllowedFor(await seriesIsAdult(MAIN));
  assert.equal(cleanRule(ADULT), false);
  const firstBudget = { left: 5 };
  const none = await huntSource(MAIN, 11, { allowed: cleanRule, budget: firstBudget });
  assert.equal(none.why, 'no_candidate');
  assert.equal(searches.get(ADULT) ?? 0, 0, 'the adult provider was filtered before any request');

  await q('UPDATE lib_series SET age_rating = 18, source_hunt_at = NULL WHERE id = $1', [MAIN]);
  searches.clear();
  const adultRule = sweepAllowedFor(await seriesIsAdult(MAIN));
  assert.equal(adultRule(ADULT), true);
  const found = await huntSource(MAIN, 11, { allowed: adultRule, budget: { left: 5 } });
  assert.equal(found.why, 'followed');
  assert.equal(found.chapter?.source, ADULT);
  assert.equal(found.chapter?.number, 11);
  const row = (await q('SELECT source_id, added_by FROM series_sources WHERE series_id = $1', [MAIN]))[0];
  assert.equal(row?.source_id, ADULT);
  assert.equal(row?.added_by, null, 'a server-initiated follow is marked automatic');
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1 ORDER BY at DESC LIMIT 1`, [MAIN]))[0];
  assert.equal(audit?.detail?.reason, 'failed_chapter');
  assert.ok((await q('SELECT source_hunt_at FROM lib_series WHERE id = $1', [MAIN]))[0]?.source_hunt_at, 'the once-a-day stamp was written');

  const before = searches.get(ADULT) ?? 0;
  assert.equal((await huntSource(MAIN, 11, { allowed: adultRule, budget: { left: 5 } })).why, 'cooldown');
  assert.equal(searches.get(ADULT) ?? 0, before, 'a second failure inside 24h does no search');
});

test('judgeCandidate carries the fetched chapters into its verdict', { skip }, async () => {
  const j = await judgeCandidate(
    { title: TITLE, altTitles: [], numbers: Array.from({ length: 10 }, (_, i) => i + 1) },
    { source: ADULT, sourceId: `${ADULT}-series` },
  );
  assert.equal(j.why, 'ok');
  assert.equal(j.chapters?.length, 11);
  assert.equal(j.chapters?.[10]?.number, 11);
});

test('the admin switch stops a hunt before budget, stamp, or network', { skip }, async () => {
  await seed(MAIN, 18);
  await q('UPDATE server_settings SET auto_follow_on_failure = false WHERE id = 1');
  const budget = { left: 5 };
  const out = await huntSource(MAIN, 11, { allowed: () => true, budget });
  assert.equal(out.why, 'off');
  assert.equal(budget.left, 5);
  assert.equal([...searches.values()].reduce((a, b) => a + b, 0), 0);
  assert.equal((await q('SELECT source_hunt_at FROM lib_series WHERE id = $1', [MAIN]))[0]?.source_hunt_at, null);
});

test('simultaneous series share one search pool', { skip }, async () => {
  // Reintroduce by allocating inFlight/waiting inside huntSource: both calls get two slots and peak becomes 4.
  await seed(C1);
  await seed(C2);
  delaySearch = true;
  const allowed = (id: string) => id !== ADULT;
  const [a, b] = await Promise.all([
    huntSource(C1, 11, { allowed, budget: { left: 1 } }),
    huntSource(C2, 11, { allowed, budget: { left: 1 } }),
  ]);
  assert.equal(a.why, 'no_candidate');
  assert.equal(b.why, 'no_candidate');
  assert.ok(peak <= 2, `SCAN_CONCURRENCY=2 but ${peak} hunt searches overlapped`);
  assert.ok([...searches.values()].reduce((x, y) => x + y, 0) >= 4, 'both hunts actually searched several candidates');
});
