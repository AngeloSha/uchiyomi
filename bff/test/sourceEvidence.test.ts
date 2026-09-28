// The per-stage evidence rules behind Health's Source health (#115), pure.
//
// The #115 shape, in one sentence: a search failure was erased by a download. `status` was one column any path
// could reset, so "Manga Ball (EN)" failed its Test while Health said "All good". These pin the three rules that
// replace it: only a success at the SAME stage closes a failure; one failure in ordinary use is noise and three in
// a row are a finding, while a failed Test or daily check counts at once; and evidence nobody has refreshed for a
// week is stale. The SQL writers in sourceHealth.ts apply the same merge; sourceCheck.int.test.ts drives them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openFailures, currentFailures, liveStagesPatch, stageLines, TRAFFIC_CONFIRM, LIVE_STALE_MS, type Stages,
} from '../src/lib/sourceEvidence';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, DAY = 24 * 60 * MIN;
const ERR = 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception';

test('a download success does not clear a search failure', () => {
  // Reintroduce by comparing failAt against the newest okAt of ANY stage (or row.last_ok_at, which reportOk
  // stamps): the download's okAt is newer, and the search failure is gone.
  const stages: Stages = {
    search: { failAt: ago(30 * MIN), failBy: 'test', error: ERR, kind: 'error' },
    pages: { okAt: ago(5 * MIN), okBy: 'traffic', streak: 0 },
    images: { okAt: ago(5 * MIN), okBy: 'traffic', streak: 0 },
  };
  const open = openFailures(stages, NOW);
  assert.deepEqual(open.map((f) => f.stage), ['search'], 'still open: nothing has searched successfully since');
  assert.equal(open[0].confirmed, true);
  assert.equal(open[0].error, ERR);
  // A later search success, and only that, closes it.
  stages.search = { ...stages.search, okAt: ago(1 * MIN), okBy: 'traffic', streak: 0 };
  assert.deepEqual(openFailures(stages, NOW), [], 'a search success after the failure closes it');
});

test('one traffic failure is noise; three in a row are a finding; a live failure is confirmed at once; a week-old one is stale', () => {
  // Reintroduce by setting TRAFFIC_CONFIRM = 1: the streak-1 case below is confirmed. By dropping the LIVE_STALE_MS
  // test: the eight-day case stays current.
  const one: Stages = { chapters: { failAt: ago(MIN), failBy: 'traffic', streak: 1, kind: 'error', error: 'x' } };
  assert.equal(openFailures(one, NOW)[0].confirmed, false, 'one failed listing in normal use is not a finding');
  assert.deepEqual(currentFailures(one, NOW), []);
  const three: Stages = { chapters: { failAt: ago(MIN), failBy: 'traffic', streak: 3, kind: 'error', error: 'x' } };
  assert.equal(openFailures(three, NOW)[0].confirmed, true, 'three in a row at one stage are');
  const live: Stages = { pages: { failAt: ago(MIN), failBy: 'sweep', streak: 1, kind: 'empty' } };
  assert.equal(openFailures(live, NOW)[0].confirmed, true, 'the daily check failing it is confirmed at once');
  assert.equal(openFailures(live, NOW)[0].kind, 'empty');
  const old: Stages = { search: { failAt: ago(8 * DAY), failBy: 'test', kind: 'error', error: ERR } };
  const [f] = openFailures(old, NOW);
  assert.equal(f.stale, true, 'eight days without a re-test is stale');
  assert.equal(f.confirmed, true, 'still a real failure, just an old one');
  assert.deepEqual(currentFailures(old, NOW), [], 'and not a current one');
  // The numbers themselves, last, so a reintroduction fails on the behaviour above rather than here.
  assert.equal(TRAFFIC_CONFIRM, 3);
  assert.equal(LIVE_STALE_MS, 7 * DAY);
});

test('since is when the open failure began; a row written without it falls back to its failAt', () => {
  const s: Stages = { search: { failAt: ago(MIN), since: ago(3 * DAY), failBy: 'test', kind: 'error' } };
  assert.equal(openFailures(s, NOW)[0].since, ago(3 * DAY));
  assert.equal(openFailures({ search: { failAt: ago(MIN), failBy: 'test' } }, NOW)[0].since, ago(MIN));
});

test('a live run writes what it reached, never images, never our own deadline', () => {
  // Reintroduce by writing a failure for kind 'timeout': the inconclusive patch below gains a search failure,
  // and a test that merely ran out of time turns Health amber.
  const at = ago(0);
  assert.deepEqual(liveStagesPatch({ passed: ['search', 'chapters'], failure: { stage: 'pages', kind: 'error', error: 'boom' } }, 'test', at), {
    search: { okAt: at, okBy: 'test', streak: 0 },
    chapters: { okAt: at, okBy: 'test', streak: 0 },
    pages: { failAt: at, failBy: 'test', error: 'boom', kind: 'error' },
  });
  assert.deepEqual(liveStagesPatch({ passed: [], failure: { stage: 'search', kind: 'timeout' } }, 'sweep', at), {},
    'a run our deadline ended writes no stage at all');
  assert.deepEqual(liveStagesPatch({ passed: ['search', 'chapters', 'pages', 'images'] }, 'sweep', at).images, undefined,
    'the smoke test fetches no bytes, so it can never speak for images');
});

test('one line per stage, whichever way it last went', () => {
  const lines = stageLines({
    search: { failAt: ago(MIN), failBy: 'test', error: ERR, kind: 'error', okAt: ago(DAY) },
    images: { okAt: ago(DAY), okBy: 'traffic' },
  });
  assert.deepEqual(lines.map((l) => [l.stage, l.state]), [['search', 'fail'], ['chapters', 'unknown'], ['pages', 'unknown'], ['images', 'ok']]);
  assert.equal(lines[0].error, ERR);
  assert.equal(lines[3].by, 'traffic');
});

test('junk in the column reads as no evidence, never a crash', () => {
  assert.deepEqual(openFailures(null, NOW), []);
  assert.deepEqual(openFailures('nope' as any, NOW), []);
  assert.deepEqual(openFailures({ search: { failAt: 'not a date' } } as any, NOW), []);
});

test('a site that says it is offline keeps that kind through the evidence (v0.49.1)', () => {
  // Health words the stage by its kind; folded into 'error' it would read as an unknown fault. Reintroduce by dropping
  // 'site_offline' from openFailures' kind list: the kind reads 'error'.
  const s: Stages = { chapters: { failAt: ago(MIN), failBy: 'sweep', streak: 1, kind: 'site_offline', error: 'site_offline: the site says it is offline ("x")' } };
  assert.equal(openFailures(s, NOW)[0].kind, 'site_offline');
  assert.deepEqual(liveStagesPatch({ passed: [], failure: { stage: 'search', kind: 'site_offline', error: 'e' } }, 'test', ago(0)),
    { search: { failAt: ago(0), failBy: 'test', error: 'e', kind: 'site_offline' } });
});
