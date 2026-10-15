// Back and Forward put a page back where it was left (lib/scrollMemory.ts, 2026-10-15). The page fade now keeps the page
// being left on screen while it fades out, and the browser's own restoring scrolled THAT page -- which jumped, and was too
// short: a Library left 2000 px down came back 145 px down. A fake window drives every case here; run.mjs walks the real
// one. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createScrollMemory, RECORD_MS, SETTLE_MS } from '../lib/scrollMemory';

/** A window with a page of `height` px in a 900 px viewport; frames run when `frame()` is called. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const frames: (() => void)[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  let y = 0;
  const w = {
    location: { pathname: '/library/', search: '' },
    history: { scrollRestoration: 'auto' },
    /** Every read of scrollY: in a browser each one makes it finish its style and layout on the spot. */
    reads: 0,
    get scrollY() { w.reads++; return y; },
    height: 5000,
    now: 0,
    performance: { now: () => w.now },
    scrollTo(_x: number, to: number) { const max = Math.max(0, w.height - 900); const at = Math.min(Math.max(0, to), max); if (at !== y) { y = at; w.fire('scroll'); } },
    addEventListener(t: string, f: () => void) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener(t: string, f: () => void) { listeners.get(t)?.delete(f); },
    requestAnimationFrame(f: () => void) { frames.push(f); return frames.length; },
    setTimeout(fn: () => void, ms: number) { const id = nextTimer++; timers.set(id, { at: w.now + ms, fn }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    fire(t: string) { for (const f of [...(listeners.get(t) ?? [])]) f(); },
    frame() { w.now += 16; const run = frames.splice(0); for (const f of run) f(); w.runTimers(); return run.length; },
    /** Let time pass with nothing scrolling: timers that come due run. */
    wait(ms: number) { w.now += ms; w.runTimers(); },
    runTimers() { for (const [id, t] of [...timers]) if (t.at <= w.now) { timers.delete(id); t.fn(); } },
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
  w.wait(RECORD_MS);
  assert.equal(m.where('/library/'), 2000);
  w.go('/series/', '?id=s1'); m.putBack(); w.height = 1045; w.scrollTo(0, 0);   // a click: the series arrives at its top
  w.scrollTo(0, 145);                        // ...and is read a little
  w.go('/library/'); w.fire('popstate');     // Back
  assert.equal(m.where('/series/?id=s1'), 145, 'the page left by Back is filed at once, scrolling paused or not');
  w.scrollTo(0, 0);                          // whatever moves while the series fades out belongs to no page...
  assert.equal(m.where('/library/'), 2000, '...least of all the Library');
  w.height = 5000;                           // the Library has mounted
  m.putBack();
  assert.equal(w.scrollY, 2000);
  assert.equal(w.frame(), 0, 'it is in place, so it stops trying');
  w.scrollTo(0, 2400); w.wait(RECORD_MS);
  assert.equal(m.where('/library/'), 2400, 'and recording resumes');
});

test('a page still growing into its old height is followed until it gets there', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 3000); w.wait(RECORD_MS);
  w.go('/series/', '?id=s1'); m.putBack(); w.height = 1200; w.scrollTo(0, 0);
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
  w.scrollTo(0, 3000); w.wait(RECORD_MS);
  w.go('/series/', '?id=s1'); m.putBack(); w.height = 1200; w.scrollTo(0, 0);
  w.go('/library/'); w.fire('popstate'); w.height = 1500; m.putBack();
  for (let t = 0; t < SETTLE_MS; t += 16) w.frame();
  assert.equal(w.frame(), 0, `still trying after ${SETTLE_MS} ms`);

  const v = fakeWindow(); const n = createScrollMemory(v); n.install();
  v.scrollTo(0, 3000); v.wait(RECORD_MS);
  v.go('/series/', '?id=s1'); n.putBack(); v.height = 1200; v.scrollTo(0, 0);
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
  w.scrollTo(0, 700); w.wait(RECORD_MS);
  assert.equal(m.where('/updates/'), 700, 'the memory stopped recording: a stale return was never cleared');
});

test('a click still opens the next page at its top', () => {
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.scrollTo(0, 2000); w.wait(RECORD_MS);
  w.go('/series/', '?id=s1');                // no popstate: a link
  m.putBack();                               // the series arrives...
  w.scrollTo(0, 0);                          // ...and Next scrolls it to its top
  assert.equal(w.scrollY, 0);
  // and one series to another is its own address
  w.scrollTo(0, 300); w.wait(RECORD_MS);
  w.go('/series/', '?id=s2'); m.putBack(); w.scrollTo(0, 0);
  w.go('/series/', '?id=s1'); w.fire('popstate'); m.putBack();
  assert.equal(w.scrollY, 300);
  assert.equal(m.where('/library/'), 2000, 'the Library kept its own place through all of it');
});

test('scrolling never reads the position: it is filed once the scrolling pauses', () => {
  // v0.67.2 read scrollY on every scroll event, which made the browser finish its style and layout once a frame while a
  // wheel scrolled fast -- the costliest script of a fast scroll on the Library.
  const w = fakeWindow(); const m = createScrollMemory(w); m.install();
  w.reads = 0;
  for (let y = 40; y <= 2400; y += 40) { w.scrollTo(0, y); w.now += 16; w.runTimers(); }   // sixty frames of a wheel
  assert.equal(w.reads, 0, `${w.reads} reads of scrollY while the page was moving`);
  assert.equal(m.where('/library/'), undefined, 'nothing filed mid-scroll');
  w.wait(RECORD_MS);
  assert.equal(w.reads, 1, 'one read, once it paused');
  assert.equal(m.where('/library/'), 2400);
  // A late filing goes to the page that was on screen, not to the address the next click already moved to.
  w.scrollTo(0, 1800); w.go('/series/', '?id=s1'); w.wait(RECORD_MS);
  assert.equal(m.where('/library/'), 1800);
  assert.equal(m.where('/series/?id=s1'), undefined);
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
