// Every colour the app asks for has to exist.
//
// `text-fog-200` and `text-fog-600` were used 65 times across app/ and components/ and were never defined in
// the theme. Tailwind does not warn about that: it simply emits no rule, so all 65 elements inherited their
// parent colour -- which on this app is `fog-50`, near-white. Two thirds of the app's *secondary* text was
// rendering at exactly the same brightness as its primary text, and the result reads as flat rather than as
// broken, so nobody files it as a bug.
//
// This catches the whole class of it: a shade referenced anywhere that the theme does not define.
//
// Under Tailwind v4 the theme is the `@theme` block in app/globals.css, not a config file; this test
// moved with it rather than being deleted, because the bug it guards is not a v3 bug -- v4 emits
// nothing for an undefined shade in exactly the same silent way.
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

/**
 * The body of the `@theme { ... }` block, found by COUNTING BRACES rather than with a regex.
 *
 * ⚠️ Tailwind v4 allows `@keyframes` inside `@theme`, and this project has three of them, so the obvious
 * non-greedy `@theme\s*\{([\s\S]*?)\}` reads only as far as the FIRST nested `}`. Today that regex would
 * still pass -- every colour token happens to sit above the keyframes -- which is the dangerous part: it is
 * correct by accident of ordering, not by construction. Reintroduce it AND move one `@keyframes` block
 * above the colours and the whole palette silently disappears ("the ink scale is missing"), which reads as
 * a broken test rather than as a reordered stylesheet. Counting braces does not care where they sit.
 */
function themeBlock(css: string): string {
  const start = css.indexOf('@theme');
  assert.notEqual(start, -1, 'app/globals.css has no @theme block');
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail('the @theme block in app/globals.css is never closed');
}

/** The shades the theme actually defines, read from the stylesheet rather than restated here. */
function scales(): Record<string, Set<string>> {
  const theme = themeBlock(readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8'));
  const out: Record<string, Set<string>> = {};
  for (const family of ['ink', 'fog']) {
    const shades = [...theme.matchAll(new RegExp(`--color-${family}-(\\d+)\\s*:`, 'g'))].map((m) => m[1]);
    assert.ok(shades.length, `the ${family} scale is missing from the @theme block in app/globals.css`);
    out[family] = new Set(shades);
  }
  return out;
}

test('no component asks for a colour shade the theme does not define', () => {
  const defined = scales();
  // Any utility that takes a colour: text-, bg-, border-, from-, via-, to-, ring-, fill-, stroke-, divide-,
  // decoration-, outline-, shadow-, accent-, caret-, placeholder-. Optional opacity suffix (`/70`).
  const use = /\b(?:text|bg|border|from|via|to|ring|fill|stroke|divide|decoration|outline|caret|placeholder)-(ink|fog)-(\d+)/g;
  const bad = new Map<string, string[]>();

  for (const file of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')), walk(join(ROOT, 'lib')))) {
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
    'These shades are referenced but not defined in the @theme block of app/globals.css, so Tailwind\n' +
      'emits nothing for them\n' +
      'and the element silently inherits its parent colour. Add the shade to the theme or use one that exists.',
  );
});

/* ============================== Background tones (Look settings) ============================== */
// OLED black is the app's look and the default; Graphite and Midnight are `html[data-tone]` blocks that re-define the
// whole ink scale (lib/tone.ts says why). Every tone is checked the same way: it defines every shade the theme does,
// lib/tone.ts restates it faithfully, its surfaces keep their order, and the text on them stays readable.

const CSS = () => readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8');
const TONE_SRC = () => readFileSync(join(ROOT, 'lib', 'tone.ts'), 'utf8');

/** The shades a block defines, as `{ '950': '#000000', … }`. */
function inks(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-ink-(\d+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

/** The body of `html[data-tone='<key>'] { … }`, or null. */
function toneBlock(css: string, key: string): string | null {
  const m = css.match(new RegExp(`html\\[data-tone='${key}'\\]\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

/** Every tone's scale, OLED's being the @theme block's own. */
function toneScales(): Record<string, Record<string, string>> {
  const css = CSS();
  const out: Record<string, Record<string, string>> = { oled: inks(themeBlock(css)) };
  for (const m of TONE_SRC().matchAll(/\{ key: '([a-z]+)', label:/g)) {
    if (m[1] === 'oled') continue;
    const block = toneBlock(css, m[1]);
    assert.ok(block, `lib/tone.ts offers "${m[1]}" and app/globals.css has no html[data-tone='${m[1]}'] block`);
    out[m[1]] = inks(block!);
  }
  return out;
}

/** WCAG 2 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('OLED black is the default and exactly what it was', () => {
  // The owner's rule: the look is not negotiable. A tone is something a reader picks; nothing about the default moves.
  // Reintroduce a "softer" default by editing the @theme scale and this fails on the first shade.
  const css = CSS();
  assert.deepEqual(inks(themeBlock(css)), {
    '950': '#000000', '900': '#060608', '850': '#0b0b0f', '800': '#111116', '700': '#1a1a22', '600': '#26262f', '500': '#3a3a45',
  });
  assert.equal(toneBlock(css, 'oled'), null, 'OLED needs no block: it is the theme');
  assert.match(TONE_SRC(), /export const DEFAULT_TONE: Tone = 'oled';/);
  assert.match(TONE_SRC(), /export const TONES = \[\n {2}\{ key: 'oled',/, 'OLED is not the first choice');
  // What the tones restate in their own ink, OLED keeps as it was written: the canvas, the scrollbars, the glass and
  // the sidebar's scrim. A tone overrides them under html[data-tone] only.
  assert.match(css, /html \{\s*-webkit-text-size-adjust: 100%;\s*background: #000;\s*\}/);
  assert.match(css, /\* \{ scrollbar-width: thin; scrollbar-color: #26262f transparent; \}/);
  assert.match(css, /\.glass \{\s*background: rgba\(10, 10, 15, 0\.55\);/);
  assert.match(css, /\.glass-strong \{\s*background: rgba\(6, 6, 9, 0\.78\);/);
  assert.match(css, /\.rail-scrim \{\s*background-image: linear-gradient\(to right, rgb\(0 0 0 \/ 0\.82\), rgb\(0 0 0 \/ 0\.55\) 55%, rgb\(0 0 0 \/ 0\)\);/);
  // The browser bar without a tone is OLED's black: the colour the <head> script makes its meta in (tone.test.ts).
  assert.match(TONE_SRC(), /else p=\$\{JSON\.stringify\(themeColorOf\(DEFAULT_TONE\)\)\};/);
});

test('every tone defines the whole ink scale, and only the ink scale', () => {
  // A tone missing a shade renders that shade in OLED's black on a grey page -- a card that is a hole. Reintroduce by
  // deleting one line from a block: this names it.
  const css = CSS();
  const want = Object.keys(inks(themeBlock(css))).sort();
  for (const [key, scale] of Object.entries(toneScales())) {
    assert.deepEqual(Object.keys(scale).sort(), want, `${key} does not define every ink shade`);
    if (key === 'oled') continue;
    const props = [...toneBlock(css, key)!.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.every((p) => p.startsWith('--color-ink-')), `${key} sets more than the ink scale: ${props.join(', ')}`);
  }
  // The tones come before Reduce effects, whose solid glass must still win over a tone's tinted one.
  const reduce = css.indexOf('html.reduce-effects .glass');
  for (const sel of ["html[data-tone='graphite']", "html[data-tone='midnight']", 'html[data-tone] .glass {']) {
    const at = css.indexOf(sel);
    assert.ok(at > 0 && at < reduce, `${sel} is missing or comes after the Reduce effects block`);
  }
});

test('lib/tone.ts says each tone\'s colours as app/globals.css defines them', () => {
  // `page` is the theme-color meta, `surface` and `line` the swatches. Change a tone in the CSS alone and the browser
  // bar, or the swatch a reader picks it by, shows a colour the page does not have.
  const scales = toneScales();
  const rows = [...TONE_SRC().matchAll(/\{ key: '([a-z]+)', label: TONE_LABELS\[\d\], page: '(#[0-9a-f]{6})', surface: '(#[0-9a-f]{6})', line: '(#[0-9a-f]{6})' \}/g)];
  assert.deepEqual(rows.map((r) => r[1]), ['oled', 'graphite', 'midnight']);
  for (const [, key, page, surface, line] of rows) {
    assert.deepEqual({ page, surface, line }, { page: scales[key]['950'], surface: scales[key]['800'], line: scales[key]['600'] }, key);
  }
});

test('every tone keeps its surfaces in order and its text readable', () => {
  // The scale runs from the page (950) up to the hover border (500): each step lighter than the one before, or a card
  // sinks into the page. Text is checked where it sits -- the page and the three surfaces cards and sheets use.
  const css = CSS();
  const fog = Object.fromEntries([...themeBlock(css).matchAll(/--color-fog-(\d+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const accent = css.match(/--accent: (\d+) (\d+) (\d+);/)!.slice(1).map((n) => Number(n).toString(16).padStart(2, '0'));
  const violet = `#${accent.join('')}`;
  const steps = ['950', '900', '850', '800', '700', '600', '500'];
  for (const [key, scale] of Object.entries(toneScales())) {
    for (let i = 1; i < steps.length; i++) {
      assert.ok(luminance(scale[steps[i]]) > luminance(scale[steps[i - 1]]), `${key}: ink-${steps[i]} is not lighter than ink-${steps[i - 1]}`);
    }
    for (const bg of ['950', '900', '850', '800']) {
      // Body text and the secondary greys: WCAG AA for small text.
      for (const shade of ['50', '100', '200', '300', '400']) {
        const r = contrast(fog[shade], scale[bg]);
        assert.ok(r >= 4.5, `${key}: fog-${shade} on ink-${bg} is ${r.toFixed(2)}:1, under 4.5`);
      }
      // The faint grey of help lines and counts, and the default accent's links and marks: 3:1, the floor for UI.
      for (const [name, fg] of [['fog-500', fog['500']], ['the default accent', violet]] as const) {
        const r = contrast(fg, scale[bg]);
        assert.ok(r >= 3, `${key}: ${name} on ink-${bg} is ${r.toFixed(2)}:1, under 3`);
      }
    }
  }
});
