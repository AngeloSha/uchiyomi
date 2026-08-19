// Chapter release dates drive the Updates feed ordering and the "Updated X ago" line on a series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../src/lib/sources/dates';

const hoursAgo = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000;

test('parses absolute dates in the formats sources actually emit', () => {
  assert.equal(parseWhen('July 1, 2026')?.slice(0, 10), '2026-07-01');
  assert.equal(parseWhen('Jul 01,2026 12:00')?.slice(0, 10), '2026-07-01', 'manganato omits the space after the comma');
  assert.equal(parseWhen('2026-07-01')?.slice(0, 10), '2026-07-01');
});

test('parses relative dates', () => {
  assert.ok(Math.abs(hoursAgo(parseWhen('2 days ago')!) - 48) < 1);
  assert.ok(Math.abs(hoursAgo(parseWhen('3 hours ago')!) - 3) < 0.1);
  assert.ok(Math.abs(hoursAgo(parseWhen('1 week ago')!) - 168) < 1);
  assert.ok(Math.abs(hoursAgo(parseWhen('yesterday')!) - 24) < 0.1);
  assert.ok(hoursAgo(parseWhen('today')!) < 0.1);
});

test('rejects junk rather than inventing a date', () => {
  for (const junk of ['', '   ', 'Chapter 12', 'read now', 'x'.repeat(80)]) {
    assert.equal(parseWhen(junk), undefined, `should reject ${JSON.stringify(junk)}`);
  }
  assert.equal(parseWhen(undefined), undefined);
  assert.equal(parseWhen(null), undefined);
});

test('rejects dates outside a sane window', () => {
  assert.equal(parseWhen('January 1, 1970'), undefined, 'epoch-ish dates are parse artefacts');
  assert.equal(parseWhen('January 1, 2200'), undefined, 'far-future dates are not real releases');
});
