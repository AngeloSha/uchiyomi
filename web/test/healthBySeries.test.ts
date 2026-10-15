// Health's by-series view: the checks' findings grouped under the series they are about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { groupBySeries } from '../lib/healthBySeries';
import type { HealthCheck, HealthItem } from '../lib/types';

const item = (o: Partial<HealthItem> & { title: string }): HealthItem => ({ detail: '', ...o });
const check = (id: string, items: HealthItem[]): HealthCheck => ({ id, title: id, status: 'warn', summary: '', items } as HealthCheck);

test('findings about one series are grouped under it, the series with most problems first', () => {
  const rows = groupBySeries([
    check('chapter-gaps', [item({ title: 'Bee', seriesId: 'b' }), item({ title: 'Aye', seriesId: 'a' })]),
    check('outliers', [item({ title: 'Bee', seriesId: 'b' })]),
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.problems.map((p) => p.check.id)]), [['b', ['chapter-gaps', 'outliers']], ['a', ['chapter-gaps']]]);
  assert.deepEqual([...rows[0].checks].sort(), ['chapter-gaps', 'outliers']);
});

test('equal counts fall back to the title; a finding keeps the key its check card gives it', () => {
  const rows = groupBySeries([check('chapter-gaps', [item({ title: 'Zed', seriesId: 'z' }), item({ title: 'Ann', seriesId: 'a', key: 'series:a' })])]);
  assert.deepEqual(rows.map((r) => r.title), ['Ann', 'Zed']);
  assert.equal(rows[0].problems[0].key, 'series:a');
  assert.equal(rows[1].problems[0].key, 'series:z');
});

test('what is about no one series, a greyed row and the duplicates card are not problems of a series', () => {
  const rows = groupBySeries([
    check('sources', [item({ title: 'A source', sourceId: 'x' })]),
    check('chapter-gaps', [item({ title: 'Fine', seriesId: 'f', info: true })]),
    check('duplicates', [item({ title: 'Pair', seriesId: 'p', seriesIds: ['p', 'q'] })]),
  ]);
  assert.deepEqual(rows, []);
});

test('the Health tab offers the view as a toggle, shows the last Fix everything run, and leaves it for a card key', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(src, /data-health-view/);
  assert.match(src, /bySeries \? <HealthBySeries checks=\{checks\} \/> : checks\.map/);
  assert.match(src, /<LastFixLine \/>/);
  assert.match(src, /setBySeries\(false\);[^\n]*\n\s*setOpen\(id\)/, 'Fix everything\'s "Show the card" has no card to show in the by-series view');
});
