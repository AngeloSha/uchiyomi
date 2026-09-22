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

// ── v0.41.0: the split (huntCandidates + followHunted) the nightly repair builds on ──────────────────
//
// Three sources that carry the title and judge `ok`, switched on per test (`hitOn`): registered after the
// probes, so with the tests above they sit past HUNT_MAX_SOURCES and change nothing there; the tests below
// hand `allowed` a rule that admits only them, so the candidate order is exactly hit-a, hit-b, hit-c.
const HITS = ['hunt-hit-a', 'hunt-hit-b', 'hunt-hit-c'];
let hitOn = false;
/** listChapters calls per hit source: one per candidate judged, so "nothing past the accepted one is asked" is countable. */
const judged = new Map<string, number>();
let huntCandidates: any, followHunted: any;
const hitSource = (id: string) => ({
  id, name: id,
  async search() {
    searches.set(id, (searches.get(id) ?? 0) + 1);
    return hitOn ? [{ sourceId: `${id}-series`, source: id, title: TITLE }] : [];
  },
  async getSeries(sid: string) { return { sourceId: sid, source: id, title: TITLE }; },
  async listChapters() { judged.set(id, (judged.get(id) ?? 0) + 1); return chapters(id); },
  async getPageUrls() { return []; },
});
const onlyHits = (id: string) => HITS.includes(id);
const searched = () => [...searches.values()].reduce((a, b) => a + b, 0);
const latestAudit = async (id: string) =>
  (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1 ORDER BY at DESC LIMIT 1`, [id]))[0]?.detail;

before(async () => {
  if (!DSN) return;
  const sources = await import('../src/lib/sources');
  for (const id of HITS) sources.registerAdapter(hitSource(id) as any);
  ({ huntCandidates, followHunted } = await import('../src/lib/sourceHunt'));
});

test('wants stops at the first accepted judgement and keeps the first ok one as the fallback', { skip }, async () => {
  // Reintroduce by judging every hit before choosing (dropping the early return in the judge loop): hit-c is
  // looked up too. Reintroduce the fallback by keeping the LAST ok judgement (`fallback = j`): it names hit-b.
  await seed(MAIN);
  hitOn = true; judged.clear();
  try {
    const budget = { left: 5 };
    let prefsSeen: unknown = null;
    const r = await huntCandidates(MAIN, {
      allowed: onlyHits, budget,
      wants: (j: any, prefs: unknown) => { prefsSeen = prefs; return j.source === HITS[1]; },
    });
    assert.equal(r.why, 'followed');
    assert.equal(r.chosen?.source, HITS[1], 'the first judgement wants() accepted');
    assert.equal(r.chosen?.chapters?.length, 11, 'the chosen judgement carries the chapter list the follow will read');
    assert.equal(r.fallback?.source, HITS[0], 'the first ok judgement wants() refused is the fallback');
    assert.equal(r.title, TITLE);
    assert.ok(prefsSeen && typeof prefsSeen === 'object', 'wants() is handed the release preferences the judgement was made under');
    assert.equal(judged.get(HITS[0]), 1);
    assert.equal(judged.get(HITS[1]), 1);
    assert.equal(judged.get(HITS[2]) ?? 0, 0, 'nothing past the accepted judgement is looked up');
    assert.equal(budget.left, 4, 'one search, one charge');
    assert.equal((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [MAIN]))[0].n, 0,
      'huntCandidates follows nothing: that is followHunted');

    // Nothing wanted: no choice, the first ok judgement still offered as the fallback, and every hit judged.
    await q('UPDATE lib_series SET source_hunt_at = NULL WHERE id = $1', [MAIN]);
    judged.clear();
    const none = await huntCandidates(MAIN, { allowed: onlyHits, budget, wants: () => false });
    assert.equal(none.chosen, null);
    assert.equal(none.why, 'no_candidate');
    assert.equal(none.fallback?.source, HITS[0]);
    assert.deepEqual([...judged.keys()], HITS, 'with nothing accepted, every candidate was judged in order');
  } finally { hitOn = false; }
});

test('force searches inside the 24 h stamp, re-stamps, charges the budget, and still obeys the switch', { skip }, async () => {
  // Reintroduce by dropping `!opts.force &&` from the stamp check: the forced hunt answers `cooldown` and
  // searches nothing. Reintroduce the stamp by skipping the UPDATE when forced: source_hunt_at does not move.
  await seed(MAIN);
  await q(`UPDATE lib_series SET source_hunt_at = now() - interval '1 hour' WHERE id = $1`, [MAIN]);
  const stampOf = async () => new Date((await q('SELECT source_hunt_at AS t FROM lib_series WHERE id = $1', [MAIN]))[0].t).getTime();
  const before = await stampOf();
  const budget = { left: 5 };
  const cold = await huntSource(MAIN, 11, { allowed: onlyHits, budget });
  assert.equal(cold.why, 'cooldown', 'inside the stamp, an ordinary hunt does nothing');
  assert.equal(searched(), 0);
  assert.equal(budget.left, 5);

  const forced = await huntSource(MAIN, 11, { allowed: onlyHits, budget, force: true });
  assert.equal(forced.why, 'no_candidate', 'forced, the search ran (the hits are switched off, so it found nothing)');
  assert.equal(searched(), HITS.length, 'every admitted candidate was searched');
  assert.equal(budget.left, 4, 'a forced hunt is still charged to the budget');
  assert.ok((await stampOf()) > before, 'and still stamps: a forced hunt is today\'s hunt');

  await q('UPDATE server_settings SET auto_follow_on_failure = false WHERE id = 1');
  searches.clear();
  assert.equal((await huntSource(MAIN, 11, { allowed: onlyHits, budget, force: true })).why, 'off', 'force overrides the stamp, never the switch');
  assert.equal(searched(), 0);
  assert.equal(budget.left, 4);
});

test('reason reaches the audit row, and followHunted carries the caller\'s detail or throws its why', { skip }, async () => {
  // Reintroduce by hard-coding `reason: 'failed_chapter'` in followHunted's audit detail: the short-chapter
  // row reads failed_chapter. Reintroduce the throw by returning on `cap`: the last block gets no error.
  await seed(MAIN);
  await seed(C1);
  await seed(C2);
  hitOn = true;
  try {
    const r = await huntSource(MAIN, 11, { allowed: onlyHits, budget: { left: 5 }, reason: 'short_chapter' });
    assert.equal(r.why, 'followed');
    assert.equal(r.followed?.source, HITS[0]);
    assert.equal(r.chapter?.number, 11);
    assert.equal(r.chapter?.source, HITS[0], 'the copy is tagged with the source it came from');
    const a = await latestAudit(MAIN);
    assert.equal(a?.reason, 'short_chapter');
    assert.equal(a?.number, 11);
    assert.equal(a?.auto, true);
    assert.equal(a?.source, HITS[0]);

    // The gap step's path: choose by the caller's rule, then follow with the caller's detail.
    const found = await huntCandidates(C1, { allowed: onlyHits, budget: { left: 5 }, reason: 'gap', wants: (j: any) => j.source === HITS[1] });
    assert.equal(found.chosen?.source, HITS[1]);
    const f = await followHunted(C1, found.title, found.chosen, 'gap', { numbers: [5, 6, 7] });
    assert.deepEqual(f, { source: HITS[1], sourceSeriesId: `${HITS[1]}-series` });
    const row = (await q('SELECT source_id, added_by, coverage FROM series_sources WHERE series_id = $1', [C1]))[0];
    assert.equal(row?.source_id, HITS[1]);
    assert.equal(row?.added_by, null, 'a server-initiated follow is marked automatic');
    const g = await latestAudit(C1);
    assert.equal(g?.reason, 'gap');
    assert.deepEqual(g?.numbers, [5, 6, 7]);
    assert.equal(g?.auto, true);
    assert.equal(g?.title, TITLE);

    // Nothing written under the lock is a throw with the HuntResult verdict on it, not a silent success.
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'p1'), ($1, $3, 'p2')`, [C2, PROBES[0], PROBES[1]]);
    await assert.rejects(
      () => followHunted(C2, TITLE, { ...found.chosen, source: HITS[2], sourceSeriesId: `${HITS[2]}-series` }, 'gap'),
      (e: any) => e?.why === 'cap',
    );
    assert.equal(await latestAudit(C2), undefined, 'a follow that was not written is not audited');
    await assert.rejects(
      () => followHunted('s_hunt_nobody', TITLE, found.chosen, 'failed_chapter'),
      (e: any) => e?.why === 'no_candidate',
    );
  } finally { hitOn = false; }
});
