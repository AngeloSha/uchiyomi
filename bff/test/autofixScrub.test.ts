// Fix everything's lines that name a series, as an admin who hides 18+ reads them (v0.55.1, lib/autofix.ts scrubbed).
//
// v0.55.0 left every line that names a series by title out for any admin without the 18+ reveal, adult or not: the
// lines carried no id to hold a title to. Since v0.55.1 each of them carries `seriesIds`, the series it names, and only
// a line naming a series the admin's reach hides is left out (the routes ask visibility.ts nameableIds, which
// repairRoutes.int.test.ts holds against a database). Pure: these hand the scrub its set of nameable ids.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scrubAutofixRun, scrubAutofixRecord, autofixSeriesIds } = require('../src/lib/autofix') as typeof import('../src/lib/autofix');

const line = (code: string, params: Record<string, unknown>) => ({ code, params }) as any;
const shown = line('autofix.item.renumbered', { title: 'Plain', seriesIds: ['s-plain'] });
const adult = line('autofix.item.linked', { a: 'Adult', b: 'Plain', seriesIds: ['s-adult', 's-plain'] });
const legacy = line('autofix.item.merged', { from: 'Old', into: 'Plain' });
const untitled = line('autofix.item.tested', { name: 'Webtoons', ok: true });
const empty = line('autofix.item.deleted', { title: 'Nobody', n: 2, seriesIds: [] });

const run = (current?: Record<string, unknown>) => ({
  id: 'r1', status: 'running', startedAt: '2026-10-03T00:00:00.000Z', by: 'admin', phase: 'duplicates', phaseIndex: 4,
  ...(current ? { current } : {}),
  log: [shown, adult, legacy, untitled, empty],
  summary: { green: false, again: false, clears: [], needsYou: [], done: [{ kind: 'linked', n: 1, said: line('autofix.done.linked', { n: 1 }), items: [shown, adult] }] },
}) as any;
const NAMED = new Set(['s-plain']);

test('an admin who hides 18+ reads every line naming a series their reach shows, and none naming one it hides', () => {
  // Reintroduce v0.55.0's rule (every titled line left out): "a line naming a series that is not 18+ is kept" fails.
  const r = scrubAutofixRun(run(), true, NAMED)!;
  assert.ok(r.log!.includes(shown), 'a line naming a series that is not 18+ is kept');
  assert.ok(!r.log!.includes(adult), 'a line naming an 18+ series is left out, whatever else it names');
  assert.ok(!r.log!.includes(legacy), 'a line from v0.55.0, with no ids to hold its title to, keeps the old rule');
  assert.ok(!r.log!.includes(empty), 'a line naming no series it can be held to is left out');
  assert.ok(r.log!.includes(untitled), 'a line that names no series is never touched');
  assert.deepEqual(r.summary!.done[0].items, [shown], "the done lines' items, the same way");
  assert.equal(r.summary!.done[0].said.code, 'autofix.done.linked');
});

test('the "Now:" title is held to the series it names, and with none it goes', () => {
  // Reintroduce by keeping v0.55.0's rule for the title (always dropped): "Now: a series that is not 18+ is named" fails.
  const at = (current: Record<string, unknown>) => scrubAutofixRun(run(current), true, NAMED)!.current;
  assert.equal(at({ title: 'Plain', seriesIds: ['s-plain'], done: 1, of: 3 })!.title, 'Plain', 'Now: a series that is not 18+ is named');
  assert.equal(at({ title: 'Adult', seriesIds: ['s-adult'], done: 1, of: 3 })!.title, undefined, 'Now: an 18+ series is not named');
  assert.equal(at({ title: 'Plain + Adult', seriesIds: ['s-plain', 's-adult'] })!.title, undefined, 'Now: a duplicate pair with an 18+ copy');
  assert.equal(at({ title: 'Plain' })!.title, undefined, 'Now: a title with no ids is not named');
  assert.equal(at({ title: 'Plain', seriesIds: [] })!.title, undefined, 'Now: a title the repair gave no series for is not named');
  assert.deepEqual({ ...at({ title: 'Adult', seriesIds: ['s-adult'], done: 1, of: 3 }) }, { title: undefined, seriesIds: ['s-adult'], done: 1, of: 3 },
    'how far it is keeps');
});

test('with the reveal on, or for a kept record, the rule is the same one', () => {
  const r = run({ title: 'Adult', seriesIds: ['s-adult'] });
  assert.equal(scrubAutofixRun(r, false, new Set()), r, 'an admin with the 18+ reveal on reads the run as it is');
  assert.equal(scrubAutofixRun(null, true, NAMED), null);
  // The repair history's record: `{phaseIndex, summary, log}`, no current.
  const rec = { phaseIndex: 9, log: [shown, adult, legacy], summary: run().summary };
  const kept = scrubAutofixRecord(rec, true, NAMED);
  assert.deepEqual(kept.log, [shown]);
  assert.deepEqual(kept.summary.done[0].items, [shown]);
  assert.equal(scrubAutofixRecord(rec, false, new Set()), rec);
  assert.equal(scrubAutofixRecord(null, true, NAMED), null);
});

test('the ids a run names, for the one query the routes make', () => {
  const ids = autofixSeriesIds(run({ title: 'Now', seriesIds: ['s-now'] }));
  assert.deepEqual([...new Set(ids)].sort(), ['s-adult', 's-now', 's-plain']);
  // Only titled lines are asked about: a param of another line is not a series.
  assert.deepEqual(autofixSeriesIds({ log: [line('autofix.item.tested', { name: 'x', seriesIds: ['nope'] })] }), []);
  assert.deepEqual(autofixSeriesIds(null), []);
  assert.deepEqual(autofixSeriesIds('not a run'), []);
});
