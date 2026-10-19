// The badges as the server knows them (v0.89.0, #267 part 3; lib/badges.ts) against the badges the browser draws
// (web/lib/badges.ts): the same badges, in the same order, with the same goals, each unlocking the frame cast in its own
// metal. The server is what says who may wear a frame, so a goal changed on one side only would let a frame be worn
// before its badge shows, or refuse one beside an earned badge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const WEB = readFileSync(join(__dirname, '..', '..', 'web', 'lib', 'badges.ts'), 'utf8');

test('the server\'s badges are the web\'s: names, kinds, goals and order, and each one\'s frame is its metal', async () => {
  const { BADGE_RULES, FRAMES } = await import('../src/lib/badges');
  // `{ label: LABELS[i], kind: '…', goal: n, metal: '…', glyph: '…' }`, with LABELS read for the names.
  const labels = [...WEB.match(/const LABELS = keys\(([^)]*)\)/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const web = [...WEB.matchAll(/\{ label: LABELS\[(\d)\], kind: '(\w+)', goal: (\d+), metal: '(\w+)'/g)]
    .map((m) => ({ name: labels[Number(m[1])], kind: m[2], goal: Number(m[3]), frame: m[4] }));
  assert.equal(web.length, 6, 'PREMISE: the web\'s six badges were read');
  // Reintroduce by changing a goal on one side (Bookworm at 40 here): this names the difference.
  assert.deepEqual(BADGE_RULES.map((b) => ({ ...b })), web);
  assert.deepEqual([...FRAMES], web.map((b) => b.frame), 'one frame a badge, in the badges\' order');
});

test('the streaks a frame is measured on are the profile\'s: the longest run, today or yesterday holding the current one', async () => {
  const { computeStreaks } = await import('../src/lib/badges');
  assert.deepEqual(computeStreaks([]), { current: 0, longest: 0 });
  assert.equal(computeStreaks(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05']).longest, 3);
  assert.equal(computeStreaks(['2026-01-03', '2026-01-01', '2026-01-02']).longest, 3, 'in any order');
  const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  assert.equal(computeStreaks([day(1), day(2)]).current, 2, 'yesterday still holds the run');
  assert.equal(computeStreaks([day(2), day(3)]).current, 0);
});
