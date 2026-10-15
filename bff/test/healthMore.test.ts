// The free-space rule of Health's "Disk space and folders" card, pure.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('spaceStatus: a big array with 4 % free is fine, a small disk is not', async () => {
  const { spaceStatus } = await import('../src/lib/healthMore');
  const GB = 1024 ** 3;
  assert.equal(spaceStatus(0, 0), 'ok', 'a disk that reports no size says nothing');
  assert.equal(spaceStatus(4000 * GB, 80000 * GB), 'ok', '5 % of 80 TB is 4 TB, so 4 TB free is not a worry');
  assert.equal(spaceStatus(120 * GB, 3000 * GB), 'warn', 'under 5 % and under 200 GB');
  assert.equal(spaceStatus(60 * GB, 4000 * GB), 'problem', 'under 2 % is a problem however big the disk');
  assert.equal(spaceStatus(4 * GB, 100 * GB), 'problem', 'under 5 GB is a problem');
  assert.equal(spaceStatus(50 * GB, 100 * GB), 'ok');
});
