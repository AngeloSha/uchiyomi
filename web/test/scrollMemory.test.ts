// Back and Forward put a page back where it was left (lib/scrollMemory.ts, 2026-10-15). The page fade now keeps the page
// being left on screen while it fades out, and the browser's own restoring scrolled THAT page -- which jumped, and was too
// short: a Library left 2000 px down came back 145 px down. A fake window drives every case here; run.mjs walks the real
// one. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createScrollMemory, SETTLE_MS } from '../lib/scrollMemory';

/** A window with a page of `height` px in a 900 px viewport; frames run when `frame()` is called. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const frames: (() => void)[] = [];
  const w = {
    location: { pathname: '/library/', search: '' },
    history: { scrollRestoration: 'auto' },
    scrollY: 0,
    height: 5000,
    now: 0,
    performance: { now: () => w.now },
    scrollTo(_x: number, y: number) { const max = Math.max(0, w.height - 900); const to = Math.min(Math.max(0, y), max); if (to !== w.scrollY) { w.scrollY = to; w.fire('scroll'); } },
    addEventListener(t: string, f: () => void) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener(t: string, f: () => void) { listeners.get(t)?.delete(f); },
    requestAnimationFrame(f: () => void) { frames.push(f); return frames.length; },
    fire(t: string) { for (const f of [...(listeners.get(t) ?? [])]) f(); },
    frame() { w.now += 16; const run = frames.splice(0); for (const f of run) f(); return run.length; },
    go(path: string, search = '') { w.location.pathname = path; w.location.search = search; },
  };
  return w;
}

test('it takes the restoring over from the browser', () => {
  const w = fakeWindow();
  createScrollMemory(w).install();
  assert.equal(w.history.scrollRestoration, 'manual',
    'left to the browser, Back scrolls the page still fading out: it jumps, and a short one lands the return near the top');
});

test('Back returns a page to where it was left, once it has arrived', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 2000);                       // the Library, read down to 2000
  assert.equal(m.where('/library/'), 2000);
  w.go('/series/', '?id=s1'); w.height = 1045; w.scrollTo(0, 0);   // a click: the series opens at its top
  w.scrollTo(0, 145);                        // ...and is read a little
  w.go('/library/'); w.fire('popstate');     // Back
  w.scrollTo(0, 0);                          // whatever moves while the series fades out belongs to no page...
  assert.equal(m.where('/library/'), 2000, '...least of all the Library');
  w.height = 5000;                           // the Library has mounted
  m.putBack();
  assert.equal(w.scrollY, 2000);
  assert.equal(w.frame(), 0, 'it is in place, so it stops trying');
  w.scrollTo(0, 2400);
  assert.equal(m.where('/library/'), 2400, 'and recording resumes');
});

test('a page still growing into its old height is followed until it gets there', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 3000);
  w.go('/series/', '?id=s1'); w.height = 1200; w.scrollTo(0, 0);
  w.go('/library/'); w.fire('popstate');
  w.height = 1500;                           // mounted with its first rows only
  m.putBack();
  assert.equal(w.scrollY, 600, 'as far as the page goes, for now');
  w.height = 4200; w.frame();                // more rows
  assert.equal(w.scrollY, 3000);
  assert.equal(w.frame(), 0);
});

test('it gives up after a while, and never fights someone scrolling', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 3000);
  w.go('/series/', '?id=s1'); w.height = 1200; w.scrollTo(0, 0);
  w.go('/library/'); w.fire('popstate'); w.height = 1500; m.putBack();
  for (let t = 0; t < SETTLE_MS; t += 16) w.frame();
  assert.equal(w.frame(), 0, `still trying after ${SETTLE_MS} ms`);

  const v = fakeWindow(); const n = createScrollMemory(v); n.install();
  v.scrollTo(0, 3000);
  v.go('/series/', '?id=s1'); v.height = 1200; v.scrollTo(0, 0);
  v.go('/library/'); v.fire('popstate'); v.height = 1500; n.putBack();
  v.fire('wheel');                           // they scroll themselves
  v.height = 4200; v.frame();
  assert.equal(v.scrollY, 600, 'the page was pulled away from someone scrolling it');
});

test('a return overtaken by another navigation is dropped, not kept forever', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.go('/series/', '?id=s1'); w.fire('popstate');   // Back to a series...
  w.go('/updates/');                                // ...and away again before it arrived
  m.putBack();
  w.scrollTo(0, 700);
  assert.equal(m.where('/updates/'), 700, 'the memory stopped recording: a stale return was never cleared');
});

test('a click still opens the next page at its top', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 2000);
  w.go('/series/', '?id=s1');                // no popstate: a link
  w.scrollTo(0, 0);                          // Next scrolls the new page to its top
  m.putBack();
  assert.equal(w.scrollY, 0);
  // and one series to another is its own address
  w.scrollTo(0, 300); w.go('/series/', '?id=s2'); w.scrollTo(0, 0);
  w.go('/series/', '?id=s1'); w.fire('popstate'); m.putBack();
  assert.equal(w.scrollY, 300);
});

test('every page puts itself back as it arrives, and the shell installs it first', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const pt = read('components/PageTransition.tsx');
  assert.match(pt, /useLayoutEffect\(\(\) => \{ if \(current\) scrollMemory\(\)\.putBack\(\); \}, \[current, url\]\);/,
    'the arriving page no longer puts itself back: Back lands wherever the browser left the fading page');
  assert.match(pt, /const url = `\$\{live\.pathname\}\?\$\{live\.search\?\.toString\(\) \?\? ''\}`;/,
    'search params are part of an arrival (one series to another)');
  const shell = read('components/AppShell.tsx');
  const at = shell.indexOf('useEffect(() => { scrollMemory(); }, []);');
  assert.ok(at > 0 && at < shell.indexOf("if (status === 'loading') return"), 'AppShell no longer installs it above its early returns');
});
