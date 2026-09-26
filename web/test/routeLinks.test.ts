// A link to a series or a chapter uses the page's query shape, never a path segment.
//
// The web app is a static export: /series/ is ONE page that reads `?id=`, and /series/<id> is a path nobody
// generated. The server answers an unknown path with the app shell, which lands on Home. So the Health tab's
// **Open** -- `/series/${seriesId}` -- took the admin to the home screen instead of the series it named, and
// nothing about it looked wrong in the code: every other link in the app is written `/series/?id=`.
//
// Every file under app/ and components/ is read, so the next such link fails here instead of on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'out' || n === '.next' ? [] : sources(p);
    return /\.(tsx?|jsx?)$/.test(n) ? [p] : [];
  });
}

test('series and reader links use the query shape the static export serves', () => {
  // Reintroduce by putting back the Health tab's `href={`/series/${it.seriesId}`}`: it is named here.
  const pathShaped = /[`'"]\/(series|reader)\/(\$\{|['"]\s*\+)/;
  const offenders: string[] = [];
  for (const f of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components')), ...sources(join(ROOT, 'lib'))]) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (pathShaped.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `write /series/?id=… (and /reader/?…) instead:\n${offenders.join('\n')}`);
});

test('the Health tab builds its Open links in one place', () => {
  // Where each finding's Open goes is lib/healthLinks.ts, tested in healthLinks.test.ts.
  const admin = readFileSync(join(ROOT, 'app', 'admin', 'page.tsx'), 'utf8');
  assert.match(admin, /healthLinks\(c\.id, it\)\.map/);
});
