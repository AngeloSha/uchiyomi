// The 18+ reveal's notice: a pill pinned on every page while it is on, the one-tap way out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the pill renders only while 18+ is revealed, and its button hides it and refreshes every query', () => {
  const c = code(read('components/AdultToggle.tsx'));
  const bar = c.slice(c.indexOf('export function AdultBar('));
  assert.ok(bar.length > 0, 'no AdultBar');
  assert.match(bar, /const on = useAdultShown\(\);\s*if \(!on\) return null;/, 'the pill shows while 18+ is off');
  assert.match(bar, /setAdultShown\(false\); qc\.invalidateQueries\(\);/, 'Hide 18+ does not switch it off and refetch');
  assert.match(bar, /role="status"/, 'the notice is not announced');
  assert.match(bar, /tr\('18\+ titles are showing\.'\)/);
  assert.match(bar, /tr\('Hide 18\+'\)/);
});

test('the button that reveals is the way in only: it is gone while the reveal is on', () => {
  const c = code(read('components/AdultToggle.tsx'));
  const toggle = c.slice(c.indexOf('export function AdultToggle('), c.indexOf('export function AdultBar('));
  assert.match(toggle, /if \(on \|\| \(!alsoWhen && !\(libs \?\? \[\]\)\.some\(\(l\) => l\.adult\)\)\) return null;/);
  assert.match(toggle, /setAdultShown\(true\)/);
  assert.doesNotMatch(toggle, /setAdultShown\(!on\)/, 'the toggle can still switch the reveal off');
});

test('the AppShell mounts the pill once, for a signed-in page, and not in the reader', () => {
  const shell = code(read('components/AppShell.tsx'));
  assert.equal(shell.split('<AdultBar />').length - 1, 1, 'the pill is not mounted exactly once');
  assert.match(shell, /status === 'authed' && <AdultBar \/>/);
  // The reader returns before the shell's chrome is drawn.
  assert.ok(shell.indexOf("if (immersive) return <>{children}</>;") < shell.indexOf('<AdultBar />'), 'the pill is drawn in the reader');
  for (const f of ['app/page.tsx', 'app/library/page.tsx', 'app/discover/page.tsx']) {
    assert.ok(!code(read(f)).includes('<AdultBar'), `${f} draws its own pill`);
  }
});
