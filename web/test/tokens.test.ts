// Every colour the app asks for has to exist.
//
// `text-fog-200` and `text-fog-600` were used 65 times across app/ and components/ and were never defined in
// the theme. Tailwind does not warn about that: it simply emits no rule, so all 65 elements inherited their
// parent colour -- which on this app is `fog-50`, near-white. Two thirds of the app's *secondary* text was
// rendering at exactly the same brightness as its primary text, and the result reads as flat rather than as
// broken, so nobody files it as a bug.
//
// This catches the whole class of it: a shade referenced anywhere that the config does not define.
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

/** The shades the theme actually defines, read from the config rather than restated here. */
function scales(): Record<string, Set<string>> {
  const cfg = readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf8');
  const out: Record<string, Set<string>> = {};
  for (const family of ['ink', 'fog']) {
    const m = cfg.match(new RegExp(`${family}:\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(m, `the ${family} scale is missing from tailwind.config.ts`);
    out[family] = new Set([...m![1].matchAll(/(\d+)\s*:/g)].map((x) => x[1]));
  }
  return out;
}

test('no component asks for a colour shade the theme does not define', () => {
  const defined = scales();
  // Any utility that takes a colour: text-, bg-, border-, from-, via-, to-, ring-, fill-, stroke-, divide-,
  // decoration-, outline-, shadow-, accent-, caret-, placeholder-. Optional opacity suffix (`/70`).
  const use = /\b(?:text|bg|border|from|via|to|ring|fill|stroke|divide|decoration|outline|caret|placeholder)-(ink|fog)-(\d+)/g;
  const bad = new Map<string, string[]>();

  for (const file of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))) {
    const body = readFileSync(file, 'utf8');
    for (const m of body.matchAll(use)) {
      const [, family, shade] = m;
      if (defined[family].has(shade)) continue;
      const key = `${family}-${shade}`;
      const rel = file.slice(ROOT.length + 1);
      if (!bad.has(key)) bad.set(key, []);
      if (!bad.get(key)!.includes(rel)) bad.get(key)!.push(rel);
    }
  }

  assert.deepEqual(
    [...bad.entries()].map(([k, files]) => `${k} (${files.length} file(s), e.g. ${files[0]})`),
    [],
    'These shades are referenced but not defined in tailwind.config.ts, so Tailwind emits nothing for them\n' +
      'and the element silently inherits its parent colour. Add the shade to the theme or use one that exists.',
  );
});
