// Connect sources' judgement (lib/linkBatch.ts judgeLink, mayFollow, hitsToJudge), with fake adapters and
// no database: the release preferences are handed in, and the switch that decides whether descriptions are
// read is an argument. The batch lifecycle itself needs Postgres and is not exercised here.
//
// The hazard is the one lib/autoFollow.ts exists for: a candidate that is a sequel or a spin-off lists every
// number the parent does, and following it files the wrong book's chapters under this series.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
/* eslint-disable @typescript-eslint/no-var-requires */
const { judgeLink, mayFollow, hitsToJudge } = require('../src/lib/linkBatch') as typeof import('../src/lib/linkBatch');
const { registerAdapter } = require('../src/lib/sources') as typeof import('../src/lib/sources');
/* eslint-enable @typescript-eslint/no-var-requires */

const PREFS = { priority: [], blocked: [], patienceMs: 0 };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** A source carrying one work under `title`, with `description`, listing `numbers`. */
function fake(id: string, title: string, description: string, numbers: number[], opts: { throws?: boolean } = {}) {
  return {
    id, name: id,
    search: async () => [],
    getSeries: async (sid: string) => { if (opts.throws) throw new Error('down'); return { sourceId: sid, source: id, title, summary: description }; },
    listChapters: async () => { if (opts.throws) throw new Error('down'); return numbers.map((n) => ({ sourceId: `${id}-${n}`, number: n })); },
    getPageUrls: async () => [],
  };
}

before(() => {
  registerAdapter(fake('lj-alt', 'Only I Level Up', 'A hunter.\n\nAlternative Titles: Solo Leveling; Na Honjaman Level Up', range(1, 200)) as any);
  registerAdapter(fake('lj-same', 'Solo Leveling', 'A hunter.', range(1, 200)) as any);
  registerAdapter(fake('lj-sequel', 'Solo Leveling: Ragnarok', 'The sequel.\n\nAlternative Titles: Na Honjaman Level Up Ragnarok', range(1, 60)) as any);
  registerAdapter(fake('lj-sequel-named', 'Ragnarok', 'Alt names: Solo Leveling', range(1, 400)) as any);
  registerAdapter(fake('lj-volumes', 'Only I Level Up', 'Alternative Titles: Solo Leveling', range(1, 14)) as any);
  registerAdapter(fake('lj-down', 'Solo Leveling', '', [], { throws: true }) as any);
  registerAdapter(fake('lj-stranger', 'Tower of God', 'Alternative Titles: Sinui Tap', range(1, 200)) as any);
});

const ours = { names: ['Solo Leveling'], numbers: range(1, 200) };
const judge = (source: string, readDescriptions = true, facts = ours) =>
  judgeLink(facts, { source, sourceSeriesId: 'x' }, { prefs: PREFS, readDescriptions, lookupMs: 2000 });

test('a source that lists our title among its other names is found, and says which name matched', async () => {
  const j = await judge('lj-alt');
  assert.equal(j.verdict, 'ok');
  assert.equal(j.theirTitle, 'Only I Level Up');
  assert.equal(j.ourName, 'Solo Leveling');
  assert.equal(j.theirName, 'Solo Leveling');
  assert.equal(j.coverageFwd, 1);
  assert.equal(j.coverageBack, 1);
});

test('with the switch off, the description is not read and the same source does not match', async () => {
  // Reintroduce by parsing descriptions unconditionally: this reads ok.
  assert.equal((await judge('lj-alt', false)).verdict, 'title_differs');
  // The main title still matches without it.
  assert.equal((await judge('lj-same', false)).verdict, 'ok');
});

test('one of OUR other names matching their title is found too', async () => {
  const j = await judge('lj-volumes', false, { names: ['Solo Leveling', 'Only I Level Up'], numbers: range(1, 14) });
  assert.equal(j.verdict, 'ok');
  assert.equal(j.ourName, 'Only I Level Up');
});

test('a sequel is refused: its names contain ours but never equal them', async () => {
  // "Solo Leveling: Ragnarok" contains "Solo Leveling"; its other name is not ours either.
  assert.equal((await judge('lj-sequel')).verdict, 'title_differs');
});

test('a work whose description names ours but whose numbering runs far past it is only a warning', async () => {
  // An exact other-name match on a 400-chapter listing against our 200: we list half of theirs. The
  // numbering is measured BOTH ways for an other-name match, so it is not ok -- the admin may still override.
  // Reintroduce by allowing the one-way shortcut for other-name matches: this reads ok.
  const j = await judge('lj-sequel-named');
  assert.equal(j.verdict, 'numbering_differs');
  assert.equal(j.coverageFwd, 1);
  assert.equal(j.coverageBack, 0.5);
});

test('a name match numbered differently is a warning, a source that is down is unreachable', async () => {
  assert.equal((await judge('lj-volumes')).verdict, 'numbering_differs', '14 volumes against 200 chapters');
  assert.equal((await judge('lj-down')).verdict, 'unreachable');
  assert.equal((await judge('lj-stranger')).verdict, 'title_differs');
  assert.equal((await judge('lj-not-registered')).verdict, 'unreachable');
});

test('too few numbers on our side cannot be measured, and says so', async () => {
  assert.equal((await judge('lj-same', true, { names: ['Solo Leveling'], numbers: [1, 2] })).verdict, 'too_few');
});

test('only ok is followed without the override; a name mismatch only when picked by hand AND overridden', () => {
  // Reintroduce by returning true for numbering_differs without the override: the run follows a warning
  // nobody confirmed.
  assert.equal(mayFollow({ verdict: 'ok', manual: false }, false), true);
  assert.equal(mayFollow({ verdict: 'numbering_differs', manual: false }, false), false);
  assert.equal(mayFollow({ verdict: 'numbering_differs', manual: false }, true), true);
  assert.equal(mayFollow({ verdict: 'too_few', manual: false }, true), true);
  assert.equal(mayFollow({ verdict: 'title_differs', manual: false }, true), false);
  assert.equal(mayFollow({ verdict: 'title_differs', manual: true }, false), false);
  assert.equal(mayFollow({ verdict: 'title_differs', manual: true }, true), true);
});

test('per source, every exact-name hit is judged first, then the source\'s own top hit, two at most', () => {
  const hit = (sourceId: string, title: string) => ({ sourceId, source: 's', title });
  const list = [hit('1', 'Something Else'), hit('2', 'Only I Level Up'), hit('3', 'solo leveling'), hit('4', 'Solo Leveling (Novel)')];
  assert.deepEqual(hitsToJudge(list, ['Solo Leveling', 'Only I Level Up']).map((h) => h.sourceId), ['2', '3']);
  assert.deepEqual(hitsToJudge(list, ['Tower of God']).map((h) => h.sourceId), ['1'], 'no exact hit: only the top one');
  assert.deepEqual(hitsToJudge([hit('', 'Solo Leveling')], ['Solo Leveling']), [], 'a hit with no id cannot be judged');
});
