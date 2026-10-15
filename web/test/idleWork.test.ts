// "The app feels a bit clanky" (2026-10-15): what it did while nobody touched it. Profiled at 4x CPU, the idle Library
// spent a quarter of its main thread restyling and re-layering the page for 158 loading shimmers, every one of them off
// the screen, and a phone ran smooth scrolling's frame loop on every page for a wheel it never has. Neither fix changes a
// pixel (the owner's rule, uchiyomi-look-is-not-negotiable); this file pins both, and the rule the first depends on.
// Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(relative(ROOT, p)));
    else if (name.endsWith('.tsx')) out.push(relative(ROOT, p));
  }
  return out;
}

test('a placeholder off the screen is skipped, and its shimmer with it', () => {
  const css = read('app/globals.css');
  const rule = css.match(/\n\s*\.skeleton \{[^}]*\}/)?.[0] ?? '';
  assert.ok(rule, 'the .skeleton rule moved: find it and keep content-visibility on it');
  assert.match(rule, /content-visibility: auto;/,
    'the .skeleton rule lost `content-visibility: auto`: the idle Library runs 158 shimmers nobody can see again, and '
    + 're-layers the page for every frame of them');
  // The shimmer is the look, and it stays as it was: on ::after, the same animation, Reduce effects still turning it off.
  assert.match(css, /\.skeleton::after \{[^}]*animate-shimmer/);
  assert.match(css, /html\.reduce-effects \.skeleton::after \{ animation: none; display: none; \}/);
});

test('every placeholder takes its size from its classes, never from what it holds', () => {
  // `content-visibility: auto` sizes an element it skips as if it were empty. A placeholder whose height came from a child
  // would be nothing below the fold and jump back to its height when scrolled to -- the one way the rule above could
  // show on screen. Today every one is a fixed height, an aspect ratio, a size, or the whole of its parent.
  const found: string[] = [];
  for (const file of [...sources('app'), ...sources('components')]) {
    read(file).split('\n').forEach((line, i) => {
      if (!/className=\{?[`"'][^`"']*\bskeleton\b/.test(line)) return;
      found.push(`${file}:${i + 1}`);
      const classes = line.slice(line.search(/\bskeleton\b/));
      assert.match(classes, /(^|[\s'`{])(?:[a-z0-9]+:)*(?:h-|aspect-|size-|inset-0\b)/,
        `${file}:${i + 1} is a placeholder with no height of its own (h-*, aspect-*, size-*, or inset-0): with `
        + 'content-visibility it collapses while off the screen -- give it one');
    });
  }
  assert.ok(found.length >= 20, `only ${found.length} placeholders found: the scan above stopped seeing them`);
  assert.ok(found.some((f) => f.startsWith('components/ui.tsx')), 'the cover placeholder in Img is not in the scan');
});

test('smooth scrolling runs its frame loop only where a wheel can turn', () => {
  const src = read('app/providers.tsx');
  // A desktop is exactly as before: the same Lenis, and its loop from the start.
  assert.match(src, /new Lenis\(\{ duration: 1\.05, smoothWheel: true \}\)/);
  assert.match(src, /const fine = window\.matchMedia\('\(any-pointer: fine\)'\);\n\s*if \(fine\.matches\) start\(\);/,
    'a mouse or trackpad must start the loop at once, or the first wheel turn of every page loses a frame');
  // A phone waits for a wheel, and one that gets a mouse or trackpad later starts then.
  assert.match(src, /window\.addEventListener\('wheel', start, \{ passive: true \}\);/);
  assert.match(src, /fine\.addEventListener\('change', start\);/);
  assert.doesNotMatch(src, /let raf = requestAnimationFrame\(/,
    'the frame loop starts unconditionally again: every phone wakes the main thread every frame of every page for it');
  // Both go when the effect does (Reduce effects switched on destroys this Lenis).
  assert.match(src, /window\.removeEventListener\('wheel', start\);/);
  assert.match(src, /fine\.removeEventListener\('change', start\);/);
});
