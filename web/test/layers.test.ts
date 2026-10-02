// What is on screen above the page (v0.49.0): lib/layers.ts, the stack the notices place themselves by so
// they never cover a dialog's title. The store is run as plain functions; the registrations are read from
// source, because what matters is that every dialog primitive in the app is on the stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { attachLayer, layersNow, reachOf, registerLayer } from '../lib/layers';

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
  assert.deepEqual({ ...start }, { dialog: 0, nav: 0, navHeight: 0, toolbar: 0, navBandFree: true, toolbarHeight: 0, sheetReach: 0 });
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

test('a measured toolbar: attachLayer reads the element now, follows every resize, and lets go', () => {
  // The critic's fix for the constant 11.25rem offset: the select bar wraps to three rows at 390 px. Nothing
  // in the browser runs here, so the element and the observer are fakes the test drives. Reintroduce by
  // dropping the observer (`if (RO) { … }`): "a resize did not move the toolbar height" fails; by never
  // measuring (`if (el)` → `if (false)`): "the toolbar was never measured" fails.
  let height = 62.4;
  const el = { getBoundingClientRect: () => ({ height }) };
  const observers: { cb: () => void; watched: unknown[]; off: boolean }[] = [];
  class FakeRO {
    o: { cb: () => void; watched: unknown[]; off: boolean };
    constructor(cb: () => void) { this.o = { cb, watched: [], off: false }; observers.push(this.o); }
    observe(e: unknown) { this.o.watched.push(e); }
    disconnect() { this.o.off = true; }
  }
  const undo = attachLayer('toolbar', {}, el, FakeRO);
  assert.equal(layersNow().toolbar, 1);
  assert.equal(layersNow().toolbarHeight, 62, 'the toolbar was never measured');
  assert.equal(observers.length, 1, 'no ResizeObserver watches the toolbar');
  assert.deepEqual(observers[0].watched, [el], 'the observer watches something other than the toolbar');
  height = 104; // the series bar wrapped to a third row
  observers[0].cb();
  assert.equal(layersNow().toolbarHeight, 104, 'a resize did not move the toolbar height');
  undo();
  assert.equal(observers[0].off, true, 'the observer outlives the toolbar');
  assert.equal(layersNow().toolbar, 0);
  assert.equal(layersNow().toolbarHeight, 0);
  // A dialog has no element to measure, and its nav-band flag goes through.
  const d = attachLayer('dialog', { navBandFree: true });
  assert.equal(layersNow().dialog, 1);
  assert.equal(layersNow().navBandFree, true);
  d();
  // useLayer is that function on the element it was given, with the browser's observer. Reintroduce
  // `const el = null` (or pass `undefined` for the observer): "useLayer does not measure its ref" fails.
  const src = code(read('lib/layers.ts'));
  const hook = src.slice(src.indexOf('export function useLayer('), src.indexOf('export function useLayers('));
  assert.match(hook, /return attachLayer\(kind, \{ navBandFree \}, ref\?\.current, typeof ResizeObserver !== 'undefined' \? ResizeObserver : undefined\);/,
    'useLayer does not measure its ref');
});

test('a reader sheet is measured by how far up it reaches, from its layout box', () => {
  // The notices rise above a sheet that runs to the bottom edge (lib/notices.ts 'above-sheet'). The reader's
  // settings sheet springs up from `y: 100%`, so its painted box is below the screen when it is first
  // measured, and a transform never resizes it, so the observer would not correct it. Reintroduce
  // `height: Math.round(el.getBoundingClientRect().height)` for dialogs too: "the Sheet's bottom margin is
  // not counted" fails; read the painted top instead: "a sheet mid-spring measured as its painted box" fails.
  assert.equal(reachOf({ getBoundingClientRect: () => ({ height: 600 }), offsetTop: 844 - 600, offsetParent: { clientHeight: 844 } }), 600);
  // A Sheet from sm up sits 1.5 rem off the bottom edge: its reach counts the margin under it.
  assert.equal(reachOf({ getBoundingClientRect: () => ({ height: 500 }), offsetTop: 900 - 500 - 24, offsetParent: { clientHeight: 900 } }), 524,
    'the Sheet\'s bottom margin is not counted');
  // Mid-spring the painted box is anywhere; the layout box is where the sheet is going.
  const springing = { getBoundingClientRect: () => ({ height: 700, top: 844 }), offsetTop: 144, offsetParent: { clientHeight: 844 } };
  assert.equal(reachOf(springing), 700, 'a sheet mid-spring measured as its painted box');
  // No layout parent (a fake, or a detached node): its height.
  assert.equal(reachOf({ getBoundingClientRect: () => ({ height: 321.4 }) }), 321);

  const undo = attachLayer('dialog', {}, { getBoundingClientRect: () => ({ height: 0 }), offsetTop: 211, offsetParent: { clientHeight: 844 } });
  assert.equal(layersNow().sheetReach, 633, 'a measured dialog does not report its reach');
  assert.equal(layersNow().navBandFree, false);
  assert.equal(layersNow().toolbarHeight, 0, 'a sheet counted as a select bar');
  const plain = attachLayer('dialog', { navBandFree: true });
  assert.equal(layersNow().sheetReach, 633, 'an unmeasured dialog changed the reach');
  undo();
  assert.equal(layersNow().sheetReach, 0, 'a closed sheet still holds the notices up');
  plain();
  // And a toolbar is still measured by its height; so is the nav bar, which is neither.
  const bar = attachLayer('toolbar', {}, { getBoundingClientRect: () => ({ height: 62 }), offsetTop: 700, offsetParent: { clientHeight: 844 } });
  assert.equal(layersNow().toolbarHeight, 62);
  assert.equal(layersNow().sheetReach, 0, 'a select bar counted as a sheet');
  const nav = attachLayer('nav', {}, { getBoundingClientRect: () => ({ height: 71.2 }), offsetTop: 752, offsetParent: { clientHeight: 844 } });
  assert.equal(layersNow().navHeight, 71, 'the nav bar is not measured by its height');
  assert.equal(layersNow().toolbarHeight, 62, 'the nav bar counted as a select bar');
  assert.equal(layersNow().sheetReach, 0, 'the nav bar counted as a sheet');
  nav();
  assert.equal(layersNow().navHeight, 0);
  bar();
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
    assert.match(src, /import \{[^}]*\buseLayer\b[^}]*\} from '@\/lib\/layers';/, `${rel} does not import useLayer`);
  }
  // A dialog also hides behind a hand-rolled overlay: a `fixed inset-0` root with no aria-modal (Edit series,
  // Add to collection, Edit chapter, the art picker, New collection, the reader's settings all were). Each
  // such root is one more dialog the file must register. Only the roots below are not dialogs. Reintroduce by
  // deleting `useLayer('dialog');` from ChapterEditModal: "app/series/page.tsx has 3 full-screen overlays
  // but registers 2 dialogs" fails.
  const NOT_DIALOGS: Record<string, string> = {
    'components/ContextMenu.tsx': 'the invisible click-catcher behind a context menu, which closes on any click',
    'app/reader/page.tsx': 'the reader itself, a page that fills the screen, and its loading fallback',
  };
  const overlays = (src: string) => [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((m) => (m[1] ?? m[2]).split(/\s+/))
    .filter((c) => c.includes('fixed') && c.includes('inset-0')).length;
  let roots = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    const src = code(readFileSync(f, 'utf8'));
    const n = overlays(src);
    if (!n) continue;
    roots += n;
    if (NOT_DIALOGS[rel]) continue;
    const registered = (src.match(/useLayer\('dialog'/g) || []).length;
    assert.ok(registered >= n, `${rel} has ${n} full-screen overlays but registers ${registered} dialogs, so notices land on their buttons`);
    assert.match(src, /import \{[^}]*\buseLayer\b[^}]*\} from '@\/lib\/layers';/, `${rel} does not import useLayer`);
  }
  assert.ok(roots >= 12, `only ${roots} full-screen overlays found -- the scan is broken`);
  for (const rel of Object.keys(NOT_DIALOGS)) assert.ok(overlays(code(read(rel))) > 0, `${rel} no longer has an overlay; drop it from NOT_DIALOGS`);

  // The dialogs that keep the phone's nav band free say so; the one that does not, doesn't.
  assert.match(code(read('components/ConfirmDialog.tsx')), /useLayer\('dialog', true, \{ navBandFree: true \}\);/);
  assert.match(code(read('components/ConsoleNav.tsx')), /useLayer\('dialog', true, \{ navBandFree: true \}\);/);
  assert.match(code(read('components/ui.tsx')), /useLayer\('dialog', true, \{ navBandFree: !!overBottomNav, ref: overBottomNav \? undefined : panelRef \}\);/, 'a reader sheet claims the nav band is free');
  // The palette stays mounted while closed; registering it unconditionally would hold notices off a band
  // nothing is using.
  assert.match(code(read('components/CommandPalette.tsx')), /useLayer\('dialog', open\);/, 'the closed command palette counts as an open dialog');
  assert.match(code(read('components/BottomNav.tsx')), /useLayer\('nav', true, \{ ref: barRef \}\);/, 'the bottom nav is not on the stack');
  // The series page's bar is up from the moment Select is (v0.52.0): it says what it acts on before anything is ticked.
  for (const [f, cond] of [['app/library/page.tsx', 'selecting && picked.size > 0'], ['app/series/page.tsx', 'selecting']] as const) {
    const src = code(read(f));
    assert.ok(src.includes(`useLayer('toolbar', ${cond}, { ref: toolbarRef });`), `${f}: the select bar is not on the stack while it shows`);
    assert.match(src, /<div ref=\{toolbarRef\} className="fixed inset-x-0 bottom-\[calc\(5\.75rem/, `${f}: the measured element is not the select bar`);
  }
  // The import page's sticky "Import selected" footer rests on the phone's nav like a select bar, so it is one
  // to the notices: without it an error from that very flow sat on the button for six seconds. Reintroduce by
  // dropping its useLayer line: "the import page's sticky footer is not on the stack" fails.
  const imp = code(read('app/admin/import/page.tsx'));
  assert.ok(imp.includes("useLayer('toolbar', true, { ref: footerRef });"), "the import page's sticky footer is not on the stack");
  assert.match(imp, /<div ref=\{footerRef\} className="sticky bottom-\[calc\(5\.5rem\+env\(safe-area-inset-bottom\)\)\] [^"]*lg:bottom-0 lg:pb-4"/,
    "the measured element is not the import page's footer, or on a laptop its 1rem off the edge is not measured with it");
  // Every sticky footer in the app is one of these: a new one must say so here.
  const stickies = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))
    .filter((f) => /className="[^"]*\bsticky bottom-/.test(code(readFileSync(f, 'utf8')))).map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(stickies, ['app/admin/import/page.tsx'], 'a sticky footer the notices do not know about');
});
