// `sourceCover(source, u)` -- in that order, at every call site.
//
// FindMissingDialog called it `sourceCover(c.coverUrl, c.source)`. Both parameters are strings, both are
// optional-ish, and TypeScript is perfectly happy: the swap is invisible at the type level and invisible on
// screen, because the tile just fails to load like any cover behind a flaky CDN. What it actually produced
// was a request for the SOURCE ID as an image URL --
//
//   /img/sources/cover?source=https%3A%2F%2Fcdn...%2Fcover.jpg&u=mangakakalot
//
// -- which the server answered with a 500 and a level-50 TypeError per candidate row, three at a time.
//
// Read from source rather than rendered: the dialog only shows candidates when a real source answers a
// scan, so a rendered assertion about it would depend on a third party being up. The server now serves a
// placeholder for an unfetchable value (bff/test/coverUrlGuard.int.test.ts), which stops the 500 -- it does
// not put the cover back. Only the argument order does that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The first two arguments of every `sourceCover(...)` call, as written. */
function calls(src: string): { first: string; second: string }[] {
  const out: { first: string; second: string }[] = [];
  for (const m of src.matchAll(/\bsourceCover\(([^)]*)\)/g)) {
    const [first = '', second = ''] = m[1].split(',').map((a) => a.trim());
    out.push({ first, second });
  }
  return out;
}

test('no sourceCover() call passes a cover URL where the source id belongs', () => {
  const bad: string[] = [];
  for (const file of walk(ROOT)) {
    if (/[\\/]test[\\/]/.test(file)) continue; // this file names the mistake on purpose
    for (const { first, second } of calls(readFileSync(file, 'utf8'))) {
      const rel = file.slice(ROOT.length + 1);
      // The first argument is the source id. Anything called a cover/art/url is the second one.
      if (/cover|art\b|\burl\b/i.test(first)) bad.push(`${rel}: sourceCover(${first}, ${second}) -- 1st arg is the SOURCE`);
      // And the mirror of it: the second argument is a URL, never a source id.
      if (/^(?:\w+\.)?source$/i.test(second)) bad.push(`${rel}: sourceCover(${first}, ${second}) -- 2nd arg is the URL`);
    }
  }
  assert.deepEqual(bad, [], `sourceCover() arguments are swapped:\n  ${bad.join('\n  ')}`);
});

test('sourceCover still takes (source, u) -- the order the check above assumes', () => {
  const src = readFileSync(join(ROOT, 'components/cards.tsx'), 'utf8');
  const sig = /export const sourceCover = \(\s*source: string \| undefined,\s*u\?: string \| null/.exec(src);
  assert.ok(sig, 'sourceCover no longer declares (source, u) -- update sourceCoverArgs.test.ts with it');
});
