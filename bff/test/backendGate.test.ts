// Which backend is running is decided in ONE place: lib/backend.ts, where only LIBRARY_BACKEND=komga selects
// Komga and anything else -- including unset -- is the owned library.
//
// Two checks in server.ts spelt it `process.env.LIBRARY_BACKEND === 'owned'` instead. The compose files set the
// variable, so nothing looked wrong on the maintainer's server; the all-in-one image and the Unraid template do
// not, and on every one of those installs the scheduled new-chapter check and the nightly repair never started.
// Followed series were only ever checked when someone pressed Run now (#109).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test("nothing in src/ asks whether LIBRARY_BACKEND is 'owned': unset is owned", () => {
  // Reintroduce by putting `process.env.LIBRARY_BACKEND === 'owned'` back on the sweep in server.ts.
  const offenders: string[] = [];
  for (const f of tsFiles(SRC)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      // Code only: a comment that warns against the spelling is the point, not an offence.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(raw)) return;
      const l = raw.replace(/\/\/.*$/, '');
      if (/LIBRARY_BACKEND\s*(?:===|==|!==|!=)\s*['"`]owned['"`]/.test(l) || /['"`]owned['"`]\s*(?:===|==|!==|!=)\s*(?:process\.)?env\.LIBRARY_BACKEND/.test(l)) {
        offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${raw.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use OWNED from lib/backend.ts instead:\n${offenders.join('\n')}`);
});

test('the scheduled check and the nightly repair start on an install that never set LIBRARY_BACKEND', () => {
  // The gate itself: both blocks in server.ts are `if (OWNED)`, and OWNED is true with the variable unset.
  const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const sweep = server.indexOf('runSweep({ maxNew: 5 }');
  const repair = server.indexOf('runRepair(app.log)');
  assert.ok(sweep > 0 && repair > 0, 'the sweep or repair tick moved; update this test');
  // The gate is the `if (` that opens the block holding the call's own `tick`.
  const openerOf = (at: number) => {
    const head = server.slice(0, at);
    const i = head.lastIndexOf('const tick = async');
    const gate = head.slice(0, i).lastIndexOf('if (');
    return head.slice(gate, head.indexOf(')', gate) + 1);
  };
  assert.equal(openerOf(sweep), 'if (OWNED)', `the sweep is gated by ${openerOf(sweep)}`);
  assert.equal(openerOf(repair), 'if (OWNED)', `the repair is gated by ${openerOf(repair)}`);
  const backend = readFileSync(join(SRC, 'lib', 'backend.ts'), 'utf8');
  assert.match(backend, /export const OWNED = process\.env\.LIBRARY_BACKEND !== 'komga';/);
});
