// What is on screen above the page (v0.49.0): lib/layers.ts, the stack the notices place themselves by so
// they never cover a dialog's title. The store is run as plain functions; the registrations are read from
// source, because what matters is that every dialog primitive in the app is on the stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { layersNow, registerLayer } from '../lib/layers';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: several comments quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('registering and releasing layers moves the stack, and releasing twice is harmless', () => {
  // Reintroduce by releasing without recomputing the snapshot (`entries.delete(id);` alone): "releasing a
  // dialog left it on the stack" fails -- a notice would dock in the nav band for a dialog long closed.
  const start = layersNow();
  assert.deepEqual({ ...start }, { dialog: 0, nav: 0, toolbar: 0, navBandFree: true, toolbarHeight: 0 });
  const nav = registerLayer('nav');
  const modal = registerLayer('dialog', { navBandFree: true });
  assert.equal(layersNow().dialog, 1);
  assert.equal(layersNow().nav, 1);
  assert.equal(layersNow().navBandFree, true);
  const sheet = registerLayer('dialog');
  assert.equal(layersNow().dialog, 2);
  assert.equal(layersNow().navBandFree, false, 'a reader sheet that runs to the bottom edge left the nav band "free"');
  sheet.release();
  assert.equal(layersNow().dialog, 1, 'releasing a dialog left it on the stack');
  sheet.release();
  assert.equal(layersNow().dialog, 1, 'a second release unregistered another dialog');
  assert.equal(layersNow().navBandFree, true);
  modal.release();
  nav.release();
  assert.deepEqual({ ...layersNow() }, { ...start });
});

test('a toolbar is measured: the tallest one wins, and a resize moves it', () => {
  const a = registerLayer('toolbar', { height: 62 });
  assert.equal(layersNow().toolbarHeight, 62);
  a.update({ height: 104 }); // the series bar wrapped to a third row
  assert.equal(layersNow().toolbarHeight, 104);
  const b = registerLayer('toolbar', { height: 80 });
  assert.equal(layersNow().toolbarHeight, 104);
  a.release();
  assert.equal(layersNow().toolbarHeight, 80);
  a.update({ height: 500 });
  assert.equal(layersNow().toolbarHeight, 80, 'a released toolbar came back on update');
  b.release();
  assert.equal(layersNow().toolbarHeight, 0);
});

test('the snapshot is the same object until something it says changes', () => {
  // useSyncExternalStore compares snapshots by identity. Reintroduce `snapshot = Object.freeze(next)` without
  // the `same` check: "an update that changed nothing replaced the snapshot" fails -- and in the browser
  // every no-op resize re-renders the notices.
  const t = registerLayer('toolbar', { height: 50 });
  const snap = layersNow();
  assert.equal(layersNow(), snap);
  t.update({ height: 50 });
  assert.equal(layersNow(), snap, 'an update that changed nothing replaced the snapshot');
  assert.ok(Object.isFrozen(snap), 'the snapshot can be written to');
  t.update({ height: 51 });
  assert.notEqual(layersNow(), snap);
  t.release();
});

test('every dialog in the app is on the stack, and so are the nav and both select bars', () => {
  // A dialog missing here is one a notice will be placed over. Reintroduce by deleting `useLayer('dialog'`
  // from Modal: "components/ConfirmDialog.tsx declares a dialog but never registers it" fails.
  const files = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')));
  // The JSX attribute, not a selector string that looks for one (the palette's type-to-search check does).
  const declares = (src: string) => (src.match(/\saria-modal="true"/g) || []).length;
  const dialogs = files.filter((f) => declares(code(readFileSync(f, 'utf8'))) > 0);
  assert.ok(dialogs.length >= 5, `only ${dialogs.length} dialog files found -- the scan is broken`);
  for (const f of dialogs) {
    const rel = f.slice(ROOT.length + 1);
    const src = code(readFileSync(f, 'utf8'));
    const declared = declares(src);
    const registered = (src.match(/useLayer\('dialog'/g) || []).length;
    assert.ok(registered >= declared, `${rel} declares a dialog but never registers it, so notices land on its buttons`);
    assert.match(src, /import \{ useLayer \} from '@\/lib\/layers';/, `${rel} does not import useLayer`);
  }
  // The dialogs that keep the phone's nav band free say so; the one that does not, doesn't.
  assert.match(code(read('components/ConfirmDialog.tsx')), /useLayer\('dialog', true, \{ navBandFree: true \}\);/);
  assert.match(code(read('components/ConsoleNav.tsx')), /useLayer\('dialog', true, \{ navBandFree: true \}\);/);
  assert.match(code(read('components/ui.tsx')), /useLayer\('dialog', true, \{ navBandFree: !!overBottomNav \}\);/, 'a reader sheet claims the nav band is free');
  // The palette stays mounted while closed; registering it unconditionally would hold notices off a band
  // nothing is using.
  assert.match(code(read('components/CommandPalette.tsx')), /useLayer\('dialog', open\);/, 'the closed command palette counts as an open dialog');
  assert.match(code(read('components/BottomNav.tsx')), /useLayer\('nav'\);/, 'the bottom nav is not on the stack');
  for (const [f, cond] of [['app/library/page.tsx', 'selecting && picked.size > 0'], ['app/series/page.tsx', 'selecting && pickedCount > 0']] as const) {
    const src = code(read(f));
    assert.ok(src.includes(`useLayer('toolbar', ${cond}, { ref: toolbarRef });`), `${f}: the select bar is not on the stack while it shows`);
    assert.match(src, /<div ref=\{toolbarRef\} className="fixed inset-x-0 bottom-\[calc\(5\.75rem/, `${f}: the measured element is not the select bar`);
  }
});
