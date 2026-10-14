// Every data-* hook the browser walks and the screenshot rig look for still exists in the app (UI refresh, Phase 0).
//
// The walks (test/e2e/*.mjs) and the rig (scripts/shots/*.mjs) find their way round the app by `data-*` hooks --
// about three hundred of them. Almost all of them guard what they find with `if (el)`, so a hook that a redesign
// drops does not fail anything: the walk skips its check, the rig skips its picture, and both stay green. A
// redesign moves a lot of markup, so this holds the whole set at once: a hook named there has to be written
// somewhere in app/, components/ or lib/.
//
// Read as text on purpose: a hook is a literal in both places, and a browser run could only prove the hooks it
// happened to reach. Reintroduce by renaming `data-health-check` in app/admin/page.tsx: this names it and the nine
// walks that look for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const WEB = join(__dirname, '..');
const REPO = join(WEB, '..');

/** Every file under `dir` whose name ends with one of `ends`. */
function files(dir: string, ends: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { if (name !== 'node_modules') out.push(...files(abs, ends)); }
    else if (ends.some((e) => name.endsWith(e))) out.push(abs);
  }
  return out;
}

/**
 * The `data-*` names in a text. One that ends in `-` is a prefix the code completes from a template
 * (`data-fix-${kind}`), and is kept with its dash so it can only ever match as a prefix.
 */
const hooksIn = (src: string): string[] => [...src.matchAll(/data-[a-z][a-z0-9-]*/g)].map((m) => m[0]);

/** What the app writes: whole names, and the prefixes its templates complete. */
function written(): { names: Set<string>; prefixes: string[] } {
  const app = ['app', 'components', 'lib']
    .flatMap((d) => files(join(WEB, d), ['.ts', '.tsx', '.css']))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const all = hooksIn(app);
  return { names: new Set(all.filter((h) => !h.endsWith('-'))), prefixes: all.filter((h) => h.endsWith('-')) };
}

/**
 * Whether the app writes a hook a walk names. A walk's prefix (`data-fix-`) needs some written name that starts
 * with it; a walk's whole name needs that exact name, or an app template prefix that completes to it.
 */
function isWritten(h: string, w: { names: Set<string>; prefixes: string[] }): boolean {
  if (h.endsWith('-')) return [...w.names].some((n) => n.startsWith(h)) || w.prefixes.some((p) => p.startsWith(h));
  return w.names.has(h) || w.prefixes.some((p) => h.startsWith(p));
}

/**
 * Hooks the walks name that the app is not meant to write, each with the reason. Keep it short: an entry here is
 * a hook nobody checks.
 */
const NOT_THE_APPS: Record<string, string> = {
  'data-e2e-rail': 'run.mjs marks the rail it found itself (el.dataset.e2eRail)',
  'data-shot-from': 'capture.mjs marks the start of a band it crops',
  'data-shot-to': 'capture.mjs marks the end of a band it crops',
  'data-dir': 'desktop.mjs passes --data-dir to Electron; not a DOM hook',
  'data-ext-update-bar': 'engineWalk.mjs checks the old update bar is gone (count 0)',
  'data-ext-off-bar': 'engineWalk.mjs checks the old turned-off bar is gone (count 0)',
  'data-ext-filter': 'engineWalk.mjs checks Browse has no filter chips (count 0)',
};

test('every data-* hook the walks and the screenshot rig use is still written by the app', () => {
  const users = new Map<string, Set<string>>();
  const scripts = [...files(join(WEB, 'test', 'e2e'), ['.mjs']), ...files(join(REPO, 'scripts', 'shots'), ['.mjs'])];
  assert.ok(scripts.length >= 20, `found only ${scripts.length} walk and rig scripts -- the paths moved`);
  for (const f of scripts) {
    for (const h of hooksIn(readFileSync(f, 'utf8'))) {
      if (!users.has(h)) users.set(h, new Set());
      users.get(h)!.add(basename(f));
    }
  }
  assert.ok(users.size >= 250, `found only ${users.size} hooks in the walks -- the scan no longer matches them`);

  const w = written();
  const gone = [...users]
    .filter(([h]) => !NOT_THE_APPS[h] && !isWritten(h, w))
    .map(([h, by]) => `${h} (used by ${[...by].sort().join(', ')})`);
  assert.deepEqual(gone, [], 'hooks the walks look for that nothing in the app writes any more -- move each one to the element that replaced its old one');
});

test('the allowlist holds no hook the app writes after all', () => {
  // An entry the app does write is a hook that is no longer exempt: drop it so the first test covers it again.
  const w = written();
  assert.deepEqual(Object.keys(NOT_THE_APPS).filter((h) => isWritten(h, w)), []);
});
