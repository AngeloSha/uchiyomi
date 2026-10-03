// What the repository itself carries, held to the shape a fresh clone needs.
//
// v0.55.0 shipped a tracked `web/node_modules`: a symlink to one machine's dependency folder, committed because
// `.gitignore` said `web/node_modules/`, and a trailing slash only ever matches a directory, never a link. The
// images did not notice (.dockerignore drops node_modules), CI did not notice (`npm ci` replaces it), but every
// contributor with a real `web/node_modules` folder could no longer `git pull`: git refuses to put a link where a
// directory is. So the index is checked here: no node_modules path, and no symlink at all, since every link this
// repository has ever carried was a local path that means nothing on anyone else's disk.
//
// It needs a git checkout. In a copy without one (an image build, a tarball) there is nothing to check, and it skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');

function trackedEntries(): Array<{ mode: string; path: string }> | null {
  try {
    const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // `<mode> <object> <stage>\t<path>`, NUL-separated.
    return out.split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { mode: line.slice(0, tab).split(' ')[0], path: line.slice(tab + 1) };
    });
  } catch {
    return null;
  }
}

test('the repository tracks no node_modules and no symlink', (t) => {
  const entries = trackedEntries();
  if (!entries) return t.skip('not a git checkout');
  assert.ok(entries.length > 100, `git listed only ${entries.length} files; the check is not looking at the repository`);
  const modules = entries.filter((e) => e.path.split('/').includes('node_modules')).map((e) => e.path);
  assert.deepEqual(modules, [], 'node_modules is tracked: run `git rm --cached` on it');
  const links = entries.filter((e) => e.mode === '120000').map((e) => e.path);
  assert.deepEqual(links, [], 'a symlink is tracked; a link to a local path breaks every other checkout');
});
