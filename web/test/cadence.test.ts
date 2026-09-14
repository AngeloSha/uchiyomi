// The cadence line under a group's name, tested away from React.
//
// The server decides whether a group ships daily or has gone quiet; this checks that every verdict it can
// send turns into the right sentence, and in particular that "quiet" is never softened into the rhythm the
// group used to keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cadenceLine, cadenceText } from '../lib/cadence';
import type { Cadence } from '../lib/types';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const c = (over: Partial<Cadence> = {}): Cadence => ({ kind: 'weekly', intervalDays: 7, daysSince: 3, quiet: false, ...over });

test('each kind has its own label', () => {
  assert.equal(cadenceLine(c({ kind: 'daily', daysSince: 3 }), iso(3), NOW)[0].key, 'ships daily');
  assert.equal(cadenceLine(c({ kind: 'weekly' }), iso(3), NOW)[0].key, 'ships weekly');
  assert.equal(cadenceLine(c({ kind: 'monthly', intervalDays: 30 }), iso(3), NOW)[0].key, 'ships monthly');
  assert.equal(cadenceLine(c({ kind: 'irregular', intervalDays: null }), iso(3), NOW)[0].key, 'releases irregularly');
});

test('quiet wins over the kind', () => {
  // Reintroduce by dropping the `c.quiet` branch from cadenceLine: the line reads "ships weekly · last
  // release 60d ago" for a group that stopped two months ago, which is the sentence that makes a reader
  // wait for a chapter that is not coming.
  const parts = cadenceLine(c({ kind: 'weekly', daysSince: 60, quiet: true }), iso(60), NOW);
  assert.deepEqual(parts, [{ key: 'quiet — no release in {n} days', args: { n: 60 } }], 'quiet wins over the kind');
  // Without the server's day count the age of the last release stands in.
  assert.deepEqual(cadenceLine(c({ kind: 'unknown', daysSince: null, quiet: true }), iso(50), NOW)[0].args, { n: 50 });
});

test('today under a day, the relative time after it', () => {
  // Reintroduce by comparing `since < 0` instead of `< 1`: a release six hours ago reads "last release 6h
  // ago" where the card promises "today".
  const today = cadenceLine(c({ kind: 'daily', daysSince: 0.25 }), iso(0.25), NOW);
  assert.deepEqual(today.map((p) => p.key), ['ships daily', 'last release today']);
  const ago = cadenceLine(c({ kind: 'weekly', daysSince: 3 }), iso(3), NOW);
  assert.equal(ago[1].key, 'last release {ago}');
  assert.equal(ago[1].args.ago, '3d ago');
});

test('an unknown rhythm with a date is only the last-release part', () => {
  const parts = cadenceLine(c({ kind: 'unknown', intervalDays: null, daysSince: 5 }), iso(5), NOW);
  assert.deepEqual(parts.map((p) => p.key), ['last release {ago}']);
});

test('nothing known says nothing', () => {
  assert.deepEqual(cadenceLine(c({ kind: 'unknown', intervalDays: null, daysSince: null }), null, NOW), []);
  assert.equal(cadenceText(c({ kind: 'unknown', intervalDays: null, daysSince: null }), null, NOW), '');
});

test('cadenceText joins the parts with a middle dot', () => {
  // English is the source language, so with no dictionary loaded the keys render as themselves.
  assert.equal(cadenceText(c({ kind: 'weekly', daysSince: 3 }), iso(3), NOW), 'ships weekly · last release 3d ago');
  assert.equal(cadenceText(c({ kind: 'weekly', daysSince: 60, quiet: true }), iso(60), NOW), 'quiet — no release in 60 days');
});
