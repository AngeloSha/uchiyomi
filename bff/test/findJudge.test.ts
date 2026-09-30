// Find other sources' judgement, with fake adapters and no database. The search judges through autoFollow's
// judgeCandidate -- the one judge every automatic follow uses -- with one opt-in (`descriptionNames`), and
// lib/findSources.ts only decides which verdicts are worth showing (toCandidate) and which a bulk follow may take
// (mayFollow). Health and preferences are handed in, so nothing reads Postgres. From @TIGamingTV's PR #119.
//
// The hazard is the one lib/autoFollow.ts exists for: a candidate that is a sequel or a spin-off lists every
// number the parent does, and following it files the wrong book's chapters under this series.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
/* eslint-disable @typescript-eslint/no-var-requires */
const { toCandidate, mayFollow, hitsToJudge, sourcesToAsk, FIND_MAX_SOURCES } = require('../src/lib/findSources') as typeof import('../src/lib/findSources');
const { judgeCandidate } = require('../src/lib/autoFollow') as typeof import('../src/lib/autoFollow');
const { registerAdapter, listSources } = require('../src/lib/sources') as typeof import('../src/lib/sources');
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
  registerAdapter(fake('lj-short', 'The Master', 'Alternative Titles: Gosu', range(1, 50)) as any);
});

const ours = { names: ['Solo Leveling'], numbers: range(1, 200) };
/** judgeCandidate as the search calls it, then the search's own reading of the verdict. */
async function judge(source: string, descriptionNames = true, facts = ours) {
  const j = await judgeCandidate(
    { title: facts.names[0], altTitles: facts.names.slice(1), numbers: facts.numbers },
    { source, sourceId: 'x' },
    { prefs: PREFS, health: new Map(), lookupMs: 2000, descriptionNames },
  );
  return { j, row: toCandidate(j, facts, PREFS) };
}

test('a source that lists our title among its other names is found, and says which name matched', async () => {
  const { j, row } = await judge('lj-alt');
  assert.equal(j.why, 'ok');
  assert.equal(j.matchedVia, 'Solo Leveling');
  assert.equal(row?.verdict, 'ok');
  assert.equal(row?.theirTitle, 'Only I Level Up');
  assert.equal(row?.ourName, 'Solo Leveling');
  assert.equal(row?.theirName, 'Solo Leveling');
  assert.equal(row?.coverageFwd, 1);
  assert.equal(row?.coverageBack, 1);
});

test('without the opt-in, the description is not read and the same source does not match', async () => {
  // Reintroduce by parsing descriptions unconditionally in judgeCandidate: every other caller -- the add's
  // auto-follow, the hunt -- would start matching by description names too.
  assert.equal((await judge('lj-alt', false)).j.why, 'title_differs');
  assert.equal((await judge('lj-same', false)).row?.verdict, 'ok', 'the main title still matches without it');
});

test('one of OUR other names matching their title is found too', async () => {
  const { row } = await judge('lj-volumes', false, { names: ['Solo Leveling', 'Only I Level Up'], numbers: range(1, 14) });
  assert.equal(row?.verdict, 'ok');
  assert.equal(row?.ourName, 'Only I Level Up');
});

test('a sequel is never offered: a name that only CONTAINS ours, numbered differently, is not a review row', async () => {
  // "Solo Leveling: Ragnarok" 1..60 contains "Solo Leveling": judgeCandidate measures it both ways and
  // refuses it; the review must not show it as "follow anyway" either. Reintroduce by keeping every
  // numbering_differs in toCandidate: this reads a row.
  const { j, row } = await judge('lj-sequel');
  assert.equal(j.why, 'numbering_differs');
  assert.equal(row, null);
});

test('a work whose description names ours but whose numbering runs far past it is amber, and never run', async () => {
  // An exact other-name match on a 400-chapter listing against our 200: we list half of theirs. A match
  // through a description name is always measured BOTH ways. Reintroduce by letting it take the one-way
  // shortcut in judgeCandidate: this reads ok.
  const { row } = await judge('lj-sequel-named');
  assert.equal(row?.verdict, 'numbering_differs');
  assert.equal(row?.coverageFwd, 1);
  assert.equal(row?.coverageBack, 0.5);
  assert.equal(mayFollow(row!), false, 'a run would follow it');
});

test('a name match numbered differently is amber; a source that is down, a stranger, or not loaded is no row', async () => {
  assert.equal((await judge('lj-volumes')).row?.verdict, 'numbering_differs', '14 volumes against 200 chapters');
  assert.equal((await judge('lj-down')).j.why, 'unreachable');
  assert.equal((await judge('lj-down')).row, null);
  assert.equal((await judge('lj-stranger')).row, null);
  assert.equal((await judge('lj-not-registered')).j.why, 'unavailable');
});

test('a description name shorter than MIN_ALT_KEY never matches', async () => {
  // "Gosu" is a word, not an identity. Reintroduce by dropping the key-length guard in judgeCandidate.
  const { j } = await judge('lj-short', true, { names: ['Gosu'], numbers: range(1, 50) });
  assert.equal(j.why, 'title_differs');
});

test('only ok is followed in bulk; there is no override', () => {
  // Review of #119: one confirmation used to cover every selected warning in every series. Reintroduce by
  // letting mayFollow take numbering_differs: a bulk follow takes the wrong book.
  assert.equal(mayFollow({ verdict: 'ok' }), true);
  assert.equal(mayFollow({ verdict: 'numbering_differs' }), false);
  assert.equal(mayFollow({ verdict: 'too_few' }), false);
  assert.equal(mayFollow({ verdict: 'title_differs' }), false);
});

test('sources are asked in scan order, without the ones already read from or resting, and only so many', () => {
  const now = Date.now();
  const health = new Map<string, any>([
    ['lj-down', { source_id: 'lj-down', disabled: true, blocked_until: null }],
    ['lj-stranger', { source_id: 'lj-stranger', disabled: false, blocked_until: new Date(now + 60_000).toISOString() }],
  ]);
  const order = sourcesToAsk({ primary: 'lj-same', followers: ['lj-alt'] }, health, () => true, listSources(), now);
  assert.ok(!order.includes('lj-same'), 'the primary is asked');
  assert.ok(!order.includes('lj-alt'), 'a source already followed is asked');
  assert.ok(!order.includes('lj-down'), 'a disabled source is asked');
  assert.ok(!order.includes('lj-stranger'), 'a source in a cooldown is asked');
  assert.ok(order.length <= FIND_MAX_SOURCES);
  // The hunt's adult rule: a source the series may not reach is never asked.
  assert.ok(!sourcesToAsk({ primary: null, followers: [] }, new Map(), (id) => id !== 'lj-sequel', listSources(), now).includes('lj-sequel'));
});

test('per source, every exact-name hit is judged first, then the source\'s own top hit, two at most', () => {
  const hit = (sourceId: string, title: string) => ({ sourceId, source: 's', title });
  const list = [hit('1', 'Something Else'), hit('2', 'Only I Level Up'), hit('3', 'solo leveling'), hit('4', 'Solo Leveling (Novel)')];
  assert.deepEqual(hitsToJudge(list, ['Solo Leveling', 'Only I Level Up']).map((h) => h.sourceId), ['2', '3']);
  assert.deepEqual(hitsToJudge(list, ['Tower of God']).map((h) => h.sourceId), ['1'], 'no exact hit: only the top one');
  assert.deepEqual(hitsToJudge([hit('', 'Solo Leveling')], ['Solo Leveling']), [], 'a hit with no id cannot be judged');
});
