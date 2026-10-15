// The You page's insights (lib/youInsights.ts): the hour/weekday bucketing in the reader's zone, and the rules the query keeps.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
let bucketTimes: typeof import('../src/lib/insightsBuckets').bucketTimes;
before(async () => { ({ bucketTimes } = await import('../src/lib/insightsBuckets')); });

test('hours and weekdays are the reader\'s own zone, Sunday first', () => {
  const t = Date.UTC(2026, 9, 11, 23, 30); // Sunday 23:30 UTC
  const utc = bucketTimes([t], 'UTC');
  assert.equal(utc.byHour[23], 1);
  assert.equal(utc.byWeekday[0], 1);
  const tokyo = bucketTimes([t], 'Asia/Tokyo'); // Monday 08:30
  assert.equal(tokyo.byHour[8], 1);
  assert.equal(tokyo.byWeekday[1], 1);
  const bad = bucketTimes([t], 'not/a-zone'); // falls back to UTC
  assert.equal(bad.byHour[23], 1);
});

test('empty input gives empty histograms', () => {
  const r = bucketTimes([], 'UTC');
  assert.equal(r.byHour.length, 24);
  assert.equal(r.byWeekday.length, 7);
  assert.equal(r.byHour.reduce((a, b) => a + b, 0), 0);
});

test('the query lists series through browsable() and counts only recorded (non-incognito) events', () => {
  const src = readFileSync(join(__dirname, '../src/lib/youInsights.ts'), 'utf8');
  assert.match(src, /browsable\('s', ctx, p\)/);
  assert.match(src, /FROM reading_events WHERE user_id/);
  assert.match(src, /max\(created_at\) AS last_at/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /updated_at/, 'last-read time must come from events, not progress (which incognito still writes)');
  const route = readFileSync(join(__dirname, '../src/routes/personal.ts'), 'utf8');
  assert.match(route, /\/api\/stats\/insights/);
});
