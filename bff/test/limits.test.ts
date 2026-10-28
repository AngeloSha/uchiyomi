// GET /api/admin/limits: the env-only knobs, numbers only, never a secret.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

test('limitsReport lists the six knobs with their effective values', async () => {
  const { limitsReport } = await import('../src/lib/limits');
  const e = { SUWAYOMI_PAGE_CONCURRENCY: 4, SOURCE_LATEST_TIMEOUT_MS: 8000, SOURCE_TEST_TIMEOUT_MS: 45000, BACKUP_KEEP: 14, CACHE_MAX_BYTES: 1024 };
  const r = limitsReport(e, undefined, 3);
  assert.deepEqual(r.limits.map((l) => l.key), ['SUWAYOMI_PAGE_CONCURRENCY', 'SOURCE_LATEST_TIMEOUT_MS', 'SOURCE_TEST_TIMEOUT_MS', 'SCAN_CONCURRENCY', 'BACKUP_KEEP', 'CACHE_MAX_BYTES']);
  assert.equal(r.limits.find((l) => l.key === 'SCAN_CONCURRENCY')!.value, 3, 'unset falls back to the solver slot count');
  assert.equal(limitsReport(e, '7', 3).limits.find((l) => l.key === 'SCAN_CONCURRENCY')!.value, 7);
  assert.equal(limitsReport(e, '0', 3).limits.find((l) => l.key === 'SCAN_CONCURRENCY')!.value, 1, 'floored at one slot, as routes/sources.ts does');
  for (const l of r.limits) assert.equal(typeof l.value, 'number');
});

test('the report carries no secret, whatever the environment holds', async () => {
  process.env.JWT_SECRET = 'super-secret-value-do-not-leak';
  const { currentLimits } = await import('../src/lib/limits');
  const text = JSON.stringify(currentLimits());
  assert.ok(!text.includes('super-secret'));
  assert.ok(!/SECRET|PASSWORD|PRIVATE|TOKEN|DATABASE_URL/.test(text));
});

test('the route is an admin route and the report is built from named fields only', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'limits.ts'), 'utf8');
  assert.ok(!/\.\.\.\s*env\b|Object\.(entries|keys|assign)\(\s*env/.test(src), 'never spread the env object');
  const admin = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf8');
  assert.match(admin, /app\.get\('\/api\/admin\/limits'/);
});
