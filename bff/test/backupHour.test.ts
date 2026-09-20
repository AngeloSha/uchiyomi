// The backup hour is a setting now, and changing it moves the NEXT run.
//
// The scheduler in server.ts arms one timer per run and read `backup_hour` only when that timer fired. So a
// change made at 10:00 from 3 to 22 still fired at 03:00 the next morning and only the night after landed at
// 22:00 -- while the Tasks tab, which reads the column, said "daily at 22:00" for a night that ran at three.
// Nothing failed and nobody could tell. These guards pin the three pieces that make the change land at once:
// the settings route accepts the hour, writing it re-arms the timer, and there is exactly one scheduler that
// clears before it sets. The round-trip through the database is backupHour.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
/** Source with comments stripped: the comments above the code quote the very lines these forbid. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the settings route accepts backupHour as a whole hour of the day, and returns it', () => {
  // Reintroduce by widening the range to .max(24): the scheduler's own guard then silently falls back to
  // 03:00 for a value the API accepted, which is the "accepted and ignored" shape extensionMonitor's test
  // calls the worst of both.
  const admin = code(read('routes/admin.ts'));
  assert.match(admin, /backupHour: z\.number\(\)\.int\(\)\.min\(0\)\.max\(23\)\.optional\(\)/, 'backupHour is not validated as an integer hour 0-23');
  // The GET has to answer it back, or the panel cannot show what it just saved.
  assert.match(admin, /SETTINGS_COLS = [\s\S]{0,400}?backup_hour'/, 'backup_hour is not in the columns GET /api/admin/settings returns');
});

test('writing the hour re-arms the pending timer', () => {
  // ⚠️ THE LOAD-BEARING LINE. Reintroduce by deleting the `runtime.rearmBackup?.()` call after the UPDATE:
  // the PATCH is accepted, GET agrees, the Tasks tab shows the new hour, and tonight's backup runs at the old
  // one anyway.
  const admin = code(read('routes/admin.ts'));
  const write = /backup_hour = \$1[\s\S]{0,200}?runtime\.rearmBackup\?\.\(\)/;
  assert.match(admin, write, 'the settings route writes backup_hour without re-arming the scheduler');
});

test('server.ts has one backup scheduler, which clears before it sets', () => {
  const server = code(read('server.ts'));
  assert.match(server, /runtime\.rearmBackup = /, 'the scheduler never installs the re-arm hook');
  const armStart = server.indexOf('const arm = async ()');
  assert.ok(armStart > 0, 'there is no `arm` function in the backup block');
  const arm = server.slice(armStart, server.indexOf('};', armStart));
  // Exactly one place sets the timer, and it is inside arm, after a clearTimeout. Reintroduce by putting
  // `setTimeout(backupTick, …)` back into backupTick's finally: a re-arm during a running backup then leaves
  // two live timers, and the server backs up twice a night.
  assert.equal((server.match(/setTimeout\(backupTick/g) ?? []).length, 1, 'setTimeout(backupTick is called from more than one place');
  assert.match(arm, /clearTimeout\(timer\)[\s\S]{0,200}?timer = setTimeout\(backupTick/, 'arm sets the timer without clearing the pending one first');
  // And the tick hands back to arm rather than scheduling itself.
  const tick = server.slice(server.indexOf('const backupTick = async ()'), armStart);
  assert.match(tick, /finally \{[\s\S]{0,200}?void arm\(\)/, 'backupTick does not re-arm through arm()');
  assert.doesNotMatch(tick, /setTimeout\(/, 'backupTick schedules itself, bypassing arm()');
});

test('the hook is declared on the runtime and defaults to null', () => {
  // Reintroduce by giving it a no-op default: the route's `?.()` would call it happily and nothing would
  // ever re-arm, with no type error to say so.
  const rt = code(read('lib/runtime.ts'));
  assert.match(rt, /rearmBackup: \(\(\) => void\) \| null;/, 'runtime.rearmBackup is not typed as nullable');
  assert.match(rt, /rearmBackup: null,/, 'runtime.rearmBackup does not start as null');
});

test('the arm called last owns the timer, not the arm whose SELECT resolves last', () => {
  // Two PATCHes of the hour milliseconds apart (5, then 18) issue two SELECTs on separate pool connections.
  // Clear-then-set alone lets whichever SELECT resolves LAST own the timer, so if the first one is slow the
  // night's backup runs at 05:00 while the Tasks tab (which reads the column) says 18:00. The fix is a
  // generation number taken BEFORE the await and checked AFTER it: an arm that is no longer the newest
  // stands down before it touches the timer. Reintroduce by dropping the `if (g !== gen) return;` line --
  // clear-then-set still holds, the earlier tests still pass, and the superseded hour wins the race.
  const server = code(read('server.ts'));
  const armStart = server.indexOf('const arm = async ()');
  assert.ok(armStart > 0, 'there is no `arm` function in the backup block');
  const arm = server.slice(armStart, server.indexOf('};', armStart));
  const at = (re: RegExp, what: string) => {
    const m = arm.search(re);
    assert.ok(m >= 0, what);
    return m;
  };
  const took = at(/const g = \+\+gen;/, 'arm does not take a generation number');
  const awaited = at(/await nextBackupDelay\(\)/, 'arm does not await the delay');
  const stood = at(/if \(g !== gen\) return;/, 'a superseded arm does not stand down (no `g !== gen` return)');
  const cleared = at(/clearTimeout\(timer\)/, 'arm never clears the pending timer');
  // Order is the whole guard: number before the await (or two arms share one), check after the await (or it
  // checks nothing), and the check before the clear (or the loser has already killed the winner's timer).
  assert.ok(took < awaited, 'the generation number is taken after the await, so overlapping arms share it');
  assert.ok(awaited < stood, 'the generation check runs before the await, where nothing can have changed yet');
  assert.ok(stood < cleared, 'a superseded arm clears the winner\'s timer before it stands down');
  // The counter lives beside the timer, in the same block, and nothing else bumps it.
  const block = server.slice(server.indexOf('let timer: NodeJS.Timeout | null = null;'), server.indexOf('runtime.rearmBackup = '));
  assert.match(block, /let gen = 0;/, 'the generation counter is not declared in the backup block');
  assert.equal((block.match(/\+\+gen/g) ?? []).length, 1, 'something other than arm() bumps the generation counter');
});
