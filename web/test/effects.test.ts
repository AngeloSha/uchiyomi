// #71, "laggy on a modest PC": the Reduce effects switch, and the look it must never cost anyone else.
//
// The owner's rule for this issue was explicit: the app does not get plainer because one machine is slow.
// So the fix is a switch, and the finish -- the drifting mesh, the grain's overlay blend, the vignette over
// the content -- stays exactly as v0.42.0 drew it for everyone who does not flip it. Half of this file pins
// that look so that nobody "optimises" it away later; the other half proves the switch really turns the
// costly things off, applies before the first paint, follows the account, and leaves prefers-reduced-motion
// doing precisely what it did before. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyReduceEffects, effectsReduced, readReduceEffectsMirror, restoreReduceEffects,
} from '../lib/effects';

/**
 * The optimiser the build itself runs (lightningcss, via `@tailwindcss/node`), for the two minifier guards.
 *
 * ⚠️ Loaded lazily, and that is the point: `@tailwindcss/node` is not in package.json -- it is here only
 * because npm hoists it out of `@tailwindcss/postcss`. A version that bundles or renames it, or an installer
 * that does not hoist, would turn a static import into a module-load failure and take this whole file with
 * it, silently retiring the load-bearing guard on the one default-look change in this release. Lazily, it
 * says what went missing instead. (Safe to import dynamically because `optimize` is a plain function: no
 * `instanceof` crosses this boundary, which is what makes a second module instance dangerous elsewhere.)
 */
async function minify(css: string): Promise<string> {
  let optimize: (c: string, o: { minify: boolean }) => { code: string };
  try {
    ({ optimize } = await import('@tailwindcss/node'));
  } catch (e) {
    assert.fail('@tailwindcss/node is gone, so the build\'s own minifier cannot be run here and the '
      + 'backdrop-filter guards are not running -- add it to devDependencies at the version '
      + `package-lock.json already pins (${(e as Error).message})`);
  }
  return optimize(css, { minify: true }).code;
}

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: several comments here quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/* ------------------------------------------------------------------ a small CSS reader */

interface Rule { sel: string; body: string; ctx: string[] }
/** Every rule in the sheet with the at-rules it sits inside (`@layer …`, `@media …`), comments removed. */
function cssRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walk = (s: string, ctx: string[]) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      let pre = s.slice(i, open);
      pre = pre.slice(pre.lastIndexOf(';') + 1).trim(); // drop `@import …;` and `@source …;` statements
      let depth = 1;
      let j = open + 1;
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      const body = s.slice(open + 1, j - 1);
      if (/^@(media|layer|supports|theme)\b/.test(pre)) walk(body, [...ctx, pre.replace(/\s+/g, ' ')]);
      else out.push({ sel: pre.replace(/\s+/g, ' '), body, ctx });
      i = j;
    }
  };
  walk(src, []);
  return out;
}
/** A rule body as `prop: value` lines, whitespace collapsed. */
const decls = (body: string): string[] => body.split(';').map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean)
  .map((d) => { const k = d.indexOf(':'); return `${d.slice(0, k).trim()}: ${d.slice(k + 1).trim()}`; });
const flat = (body: string) => body.replace(/\s+/g, ' ').trim();
const CSS = () => cssRules(read('app/globals.css'));

/* ================================================================ the default look, pinned */

// Exactly the v0.42.0 declarations. A change here is a change to how the app looks for everyone, and #71's
// answer to a slow machine is the switch, not this.
const GRAIN_URL = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;
const PINNED: Record<string, string[]> = {
  '.fx-grain': [
    'position: fixed', 'inset: 0', 'z-index: 2', 'pointer-events: none',
    'opacity: 0.05', 'mix-blend-mode: overlay',
    `background-image: ${GRAIN_URL}`,
    'background-size: 180px 180px',
  ],
  '.fx-vignette': [
    'position: fixed', 'inset: 0', 'z-index: 2', 'pointer-events: none',
    'background: radial-gradient(125% 100% at 50% 0%, transparent 52%, rgba(0,0,0,0.5) 100%)',
  ],
  '.fx-mesh': [
    'position: fixed', 'inset: -25%', 'z-index: 0', 'pointer-events: none',
    'filter: blur(90px) saturate(1.25)', 'opacity: 0.55',
    'background: radial-gradient(38% 40% at 18% 28%, rgb(var(--accent) / 0.20), transparent 70%), radial-gradient(40% 48% at 82% 18%, rgba(34, 211, 238, 0.10), transparent 70%), radial-gradient(52% 52% at 62% 92%, rgb(var(--accent) / 0.14), transparent 70%)',
    'animation: mesh-drift 26s ease-in-out infinite alternate',
  ],
};
const MESH_DRIFT = '0% { transform: translate3d(0, 0, 0) scale(1); } 100% { transform: translate3d(2%, -3%, 0) scale(1.14); }';

test('the cinematic layers keep their v0.42.0 look by default', () => {
  // Reintroduce by the "cheap default" #71 was first going to ship -- `mix-blend-mode: normal` on the grain,
  // `filter: none` on the mesh, `z-index: 0` on the vignette: "the default .fx-grain changed" (or the mesh,
  // or the vignette) fails.
  const rules = CSS();
  for (const [sel, want] of Object.entries(PINNED)) {
    const found = rules.filter((r) => r.sel === sel && r.ctx.length === 0);
    assert.equal(found.length, 1, `expected exactly one unconditional ${sel} rule, found ${found.length}`);
    assert.deepEqual(decls(found[0].body), want, `the default ${sel} changed`);
  }
  const drift = rules.filter((r) => r.sel === '@keyframes mesh-drift');
  assert.equal(drift.length, 1, 'the mesh drift keyframes are gone');
  assert.equal(flat(drift[0].body), MESH_DRIFT, 'the mesh drifts differently');
});

test('nothing outside the pinned rules restyles a cinematic layer, except the switch and reduced motion', () => {
  // A second rule is the quiet way to change the look without touching the pinned three: a more specific
  // `html .fx-grain { mix-blend-mode: normal }` wins and the pin above still passes (a second plain
  // `.fx-grain` rule is caught there, by its count). The only rules allowed to name an fx layer are the
  // pinned three, the Reduce effects block, and the prefers-reduced-motion line that has stopped the drift
  // since before #71. Reintroduce by appending `html .fx-grain { opacity: .03; }` to globals.css: "a rule
  // outside the pinned three restyles .fx-grain" fails.
  for (const r of CSS()) {
    if (!/\.fx-(grain|mesh|vignette)\b/.test(r.sel)) continue;
    if (r.ctx.length === 0 && r.sel in PINNED) continue;
    if (r.ctx.length === 0 && r.sel.split(',').every((s) => s.trim().startsWith('html.reduce-effects '))) continue;
    if (r.ctx.join('|') === '@media (prefers-reduced-motion: reduce)' && r.sel === '.fx-mesh' && flat(r.body) === 'animation: none;') continue;
    assert.fail(`a rule outside the pinned three restyles ${r.sel.match(/\.fx-\w+/)![0]}: ${r.ctx.join(' ')} ${r.sel} { ${flat(r.body)} }`);
  }
});

test('prefers-reduced-motion does exactly what it did before the switch existed', () => {
  // The system setting and the switch are different requests: someone who asked their OS for less motion did
  // not ask for the grain or the glass to go. So the media block stays the two rules it was -- no drift, near
  // zero durations -- and gains nothing. Reintroduce by folding the switch into it (hiding the fx layers
  // under the media query): "the reduced-motion block changed" fails.
  const inPrm = CSS().filter((r) => r.ctx.join('|') === '@media (prefers-reduced-motion: reduce)');
  assert.deepEqual(inPrm.map((r) => `${r.sel} { ${flat(r.body)} }`), [
    '.fx-mesh { animation: none; }',
    '*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }',
  ], 'the reduced-motion block changed');
});

test('the app shell still mounts all three layers, and only the switch removes them', () => {
  // Reintroduce by returning null from CinematicFX on a slow-machine guess, or dropping one layer:
  // "CinematicFX no longer renders the three layers" / "CinematicFX has a second way to render nothing" fails.
  const fx = code(read('components/CinematicFX.tsx'));
  assert.match(fx, /<>\s*<div className="fx-mesh" \/>\s*<div className="fx-grain" \/>\s*<div className="fx-vignette" \/>\s*<\/>/,
    'CinematicFX no longer renders the three layers, in order');
  assert.match(fx, /const reduced = useReduceEffects\(\);\s*if \(reduced\) return null;/, 'CinematicFX does not step aside for the switch');
  assert.equal((fx.match(/return null/g) || []).length, 1, 'CinematicFX has a second way to render nothing');
  assert.match(code(read('components/AppShell.tsx')), /<CinematicFX \/>/, 'the app shell no longer mounts CinematicFX');
});

/* ================================================================ what the switch turns off */

test('the Reduce effects rules are unlayered and turn off the fx layers, every backdrop blur and the shimmer', () => {
  // ⚠️ Unlayered is the load-bearing part. Tailwind v4 emits the 56 `backdrop-blur-*` utilities inside
  // @layer utilities, and an unlayered rule beats every layered one -- inside a layer, those utilities win
  // again and the switch says "on" with every blur still running. Reintroduce by wrapping the block in
  // `@layer components { … }`: "a Reduce effects rule sits inside @layer" fails; by deleting the
  // backdrop-filter line: "the switch leaves backdrop-filter on" fails.
  const rules = CSS();
  const all = rules.filter((r) => /html\.reduce-effects/.test(r.sel));
  assert.ok(all.length >= 4, `only ${all.length} Reduce effects rules found -- the block is gone or the reader is broken`);
  for (const r of all) assert.deepEqual(r.ctx, [], `a Reduce effects rule sits inside ${r.ctx.join(' ')}: ${r.sel}`);
  const sels = (r: Rule) => r.sel.split(',').map((s) => s.trim());
  const hides = all.find((r) => ['.fx-mesh', '.fx-grain', '.fx-vignette'].every((c) => sels(r).includes(`html.reduce-effects ${c}`)));
  assert.ok(hides, 'the switch does not hide all three fx layers');
  assert.ok(decls(hides!.body).includes('display: none'), 'the switch does not hide all three fx layers');
  const blur = all.find((r) => ['*', '*::before', '*::after'].every((c) => sels(r).includes(`html.reduce-effects ${c}`)));
  assert.ok(blur, 'the switch leaves backdrop-filter on');
  for (const d of ['backdrop-filter: none', '-webkit-backdrop-filter: none']) {
    assert.ok(decls(blur!.body).includes(d), `the switch leaves backdrop-filter on (missing "${d}")`);
  }
  // Glass without its blur is see-through over whatever scrolls under it, so it must go solid, not stay
  // at 55 % over a bright cover.
  const glass = all.find((r) => ['.glass', '.glass-strong'].every((c) => sels(r).includes(`html.reduce-effects ${c}`)));
  assert.ok(glass, 'the glass panels are not made solid under the switch');
  assert.match(decls(glass!.body).join(';'), /^background: (var\(--color-ink-\d+\)|#[0-9a-f]{6})$/i, 'the glass panels are not made solid under the switch');
  const shimmer = all.find((r) => sels(r).includes('html.reduce-effects .skeleton::after'));
  assert.ok(shimmer && decls(shimmer.body).includes('animation: none'), 'the skeleton still shimmers under the switch');
  // The masked accent rim was the one cost left in Firefox once everything else was off (32 -> 59.5 fps on
  // the library). Reintroduce by deleting its line: "the switch leaves the masked rims on" fails.
  const rim = all.find((r) => sels(r).includes('html.reduce-effects .grad-border::before'));
  assert.ok(rim && decls(rim.body).includes('display: none'), 'the switch leaves the masked rims on');
});

test('the switch still turns backdrop-filter off after the build minifies it', async () => {
  // ⚠️ Passing the source check above is not enough. Tailwind's minifier (lightningcss, through
  // @tailwindcss/node's `optimize` -- the step @tailwindcss/postcss runs on every build) reads a
  // `-webkit-backdrop-filter` that FOLLOWS `backdrop-filter` as overriding it, and keeps only the prefixed
  // one; Chrome 152 and Firefox 155 both ignore the prefixed property. The first version of this block was
  // written unprefixed-first, looked right in the source, and shipped a switch that left every blur on
  // outside Safari. So the block is run through the same optimiser here. Reintroduce by swapping the two
  // declarations back (`backdrop-filter: none; -webkit-backdrop-filter: none;`): "the minified CSS keeps
  // only the prefixed backdrop-filter" fails.
  const block = CSS().filter((r) => /html\.reduce-effects/.test(r.sel)).map((r) => `${r.sel} {${r.body}}`).join('\n');
  const out = await minify(block);
  const star = out.match(/html\.reduce-effects \*[^{]*\{([^}]*)\}/);
  assert.ok(star, `the minified block has no html.reduce-effects * rule: ${out.slice(0, 300)}`);
  assert.match(star![1], /(^|;)backdrop-filter:none(;|$)/, `the minified CSS keeps only the prefixed backdrop-filter: ${star![0]}`);
});

test('the glass panels really blur in Chrome and Firefox after the build minifies them', async () => {
  // The same minifier trap, on the default look this time: until v0.43.0 `.glass` and `.glass-strong` were
  // written unprefixed-first, the build kept only `-webkit-backdrop-filter`, and every browser but Safari drew
  // the phone nav, dialogs, the command palette and the sign-in card as plain see-through panels. The owner
  // asked for the blur the design always meant. Reintroduce by swapping either pair back
  // (`backdrop-filter: blur(20px) …;` above `-webkit-backdrop-filter: …;`): "the minified .glass keeps only
  // the prefixed backdrop-filter" fails.
  for (const [cls, px] of [['.glass', 20], ['.glass-strong', 24]] as const) {
    const rule = CSS().find((r) => r.sel === cls && r.ctx.length === 0);
    assert.ok(rule, `no unlayered ${cls} rule`);
    const out = await minify(`${cls} {${rule!.body}}`);
    assert.match(out, new RegExp(`(^|[;{])backdrop-filter:blur\\(${px}px\\)`),
      `the minified ${cls} keeps only the prefixed backdrop-filter: ${out}`);
  }
});

test('every consumer honours the switch', () => {
  // Each is the other half of one CSS rule, or a thing CSS cannot reach. Reintroduce by removing the check
  // from any one of them -- Lenis, for example (`if (reduceEffects || effectsReduced()) return;`): "Lenis
  // still starts under Reduce effects" fails.
  const providers = code(read('app/providers.tsx'));
  assert.match(providers, /if \(reduceEffects \|\| effectsReduced\(\)\) return;\s*if \(window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) return;\s*const lenis = new Lenis/,
    'Lenis still starts under Reduce effects (or lost its reduced-motion check)');
  assert.match(providers, /\}, \[reduceEffects\]\);/, 'Lenis does not stop and start when the switch is flipped');
  assert.match(providers, /useLayoutEffect\(restoreReduceEffects, \[\]\);/, 'the device copy is not restored before the first paint');
  assert.match(code(read('components/cards.tsx')), /if \(!enabled\(\) \|\| effectsReduced\(\)\) return;/, 'cards still tilt under Reduce effects');
  const ui = code(read('components/ui.tsx'));
  assert.match(ui, /const reduced = useReduceEffects\(\);/, 'Img does not read the switch');
  assert.match(ui, /\$\{reduced\s*\? \(loaded \? 'opacity-100' : 'opacity-0'\)\s*: `transition-all duration-700 ease-out \$\{loaded \? 'scale-100 opacity-100 blur-none' : 'scale-105 opacity-0 blur-md'\}`\}/,
    'covers still sharpen in under Reduce effects (or lost the sharpen-in by default)');
  for (const f of ['components/PageTransition.tsx', 'components/ConsoleNav.tsx']) {
    const src = code(read(f));
    assert.match(src, /initial=\{reduced \? false : \{ opacity: 0, y: \d+ \}\}/, `${f} still animates in under Reduce effects`);
    assert.match(src, /transition=\{reduced \? \{ duration: 0 \} : \{ duration: 0\.2\d/, `${f} still animates in under Reduce effects`);
  }
});

/* ================================================================ the setting itself */

test('the Appearance section has the Reduce effects switch, and it saves to the account', () => {
  // Reintroduce by saving only locally (dropping the PUT): "the switch does not save reduceEffects to the
  // account" fails -- and the setting would stop following the person to their other devices.
  const src = code(read('components/ProfileSettings.tsx'));
  const start = src.indexOf('function AppearanceSection()');
  const end = src.indexOf('function ReadingSection(');
  assert.ok(start > 0 && end > start, 'AppearanceSection or ReadingSection moved');
  const slice = src.slice(start, end);
  assert.match(slice, /<SwitchRow label=\{tr\('Reduce effects'\)\}\s*help=\{tr\('Turns off the animated background, blur, smooth scrolling and transitions\. Try it if scrolling feels slow\.'\)\}\s*on=\{reduceEffects\} onChange=\{saveReduceEffects\} \/>/,
    'the Reduce effects row is not in Appearance');
  assert.match(slice, /const reduceEffects = user\?\.settings\?\.reduceEffects === true;/, 'the row does not read the account setting');
  assert.match(slice, /setSettings\(\{ reduceEffects: next \}\);/, 'the switch is not applied the moment it is flipped');
  assert.match(slice, /json: \{ reduceEffects: next \}/, 'the switch does not save reduceEffects to the account');
  assert.match(slice, /catch \(e\) \{ setSettings\(\{ reduceEffects: prev \}\); throw e; \}/, 'a refused save leaves the switch applied');
});

test('the class is applied before the app shell renders, and follows the account both ways', () => {
  // CinematicFX mounts in the same commit as `status: 'authed'`. If the class arrived in an effect after it,
  // the three layers would paint a frame on every reload with the switch on. Reintroduce by moving the
  // `applyReduceEffects` line below `setStatus('authed')`: "the switch is applied after the authed render"
  // fails; by writing `if (u.settings?.reduceEffects) applyReduceEffects(true)`: "the account cannot turn
  // it off" fails, and on a shared tablet the next person inherits the last one's choice.
  const src = code(read('lib/auth.tsx'));
  const body = (name: string) => {
    const s = src.indexOf(`const ${name} = `);
    assert.ok(s > 0, `${name} is gone`);
    return src.slice(s, src.indexOf('\n  };', s));
  };
  const authed = body('adoptAuthed');
  const a = authed.indexOf('applyReduceEffects(u.settings?.reduceEffects === true);');
  assert.ok(a > 0, 'the account cannot turn it off (adoptAuthed does not apply the setting both ways)');
  assert.ok(a < authed.indexOf("setStatus('authed')"), 'the switch is applied after the authed render');
  const offline = body('adoptOffline');
  const o = offline.indexOf('restoreReduceEffects();');
  assert.ok(o > 0 && o < offline.indexOf("setStatus('offline')"), 'an offline launch applies the switch after rendering, or not at all');
  const signOut = body('clearLocalSession');
  const c = signOut.indexOf('applyReduceEffects(false);');
  assert.ok(c > 0 && c < signOut.indexOf("setStatus('anon')"), 'signing out leaves this account\'s choice on the sign-in screen');
  assert.match(body('setSettings'), /if \('reduceEffects' in partial\) applyReduceEffects\(partial\.reduceEffects === true\);/,
    'flipping the switch does not apply it at once');
});

/* ================================================================ lib/effects.ts, run */

const classes = new Set<string>();
let store: Record<string, string> = {};
let storageThrows = false;
let prefersReduced = false;
const refuse = () => { if (storageThrows) throw new Error('SecurityError: storage is disabled'); };
(globalThis as any).document = {
  documentElement: {
    classList: {
      toggle: (c: string, on?: boolean) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
  },
};
(globalThis as any).localStorage = {
  getItem: (k: string) => { refuse(); return k in store ? store[k] : null; },
  setItem: (k: string, v: string) => { refuse(); store[k] = String(v); },
  removeItem: (k: string) => { refuse(); delete store[k]; },
};
const mm = (q: string) => ({ matches: /prefers-reduced-motion/.test(q) ? prefersReduced : false, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
(globalThis as any).matchMedia = mm;
(globalThis as any).window = { matchMedia: mm };
const reset = () => { classes.clear(); store = {}; storageThrows = false; prefersReduced = false; applyReduceEffects(false); };

test('turning the switch on sets the class and the device copy, and off clears both', () => {
  // Reintroduce by only ever adding the class (`classList.add`): "turning it off leaves the class" fails.
  reset();
  applyReduceEffects(true);
  assert.ok(classes.has('reduce-effects'), 'turning it on does not set html.reduce-effects');
  assert.equal(store['uchiyomi.reduceEffects'], '1', 'turning it on does not write the device copy');
  assert.equal(effectsReduced(), true);
  applyReduceEffects(false);
  assert.ok(!classes.has('reduce-effects'), 'turning it off leaves the class');
  assert.ok(!('uchiyomi.reduceEffects' in store), 'turning it off leaves the device copy');
  assert.equal(effectsReduced(), false);
});

test('an offline launch restores the device copy', () => {
  // Reintroduce by making restoreReduceEffects a no-op: "the device copy is not restored" fails.
  reset();
  store['uchiyomi.reduceEffects'] = '1';
  restoreReduceEffects();
  assert.ok(classes.has('reduce-effects') && effectsReduced(), 'the device copy is not restored');
  store = {};
  restoreReduceEffects();
  assert.ok(!classes.has('reduce-effects') && !effectsReduced(), 'an empty device copy leaves the switch on');
});

test('storage that refuses does not break the switch', () => {
  // A private window, or a browser with site data blocked, throws on every localStorage call. The switch
  // must still work for the session; only the offline launch forgets it. Reintroduce by removing the
  // try/catch around the storage write: the call throws and "a refusing storage breaks the switch" fails.
  reset();
  storageThrows = true;
  assert.doesNotThrow(() => applyReduceEffects(true), 'a refusing storage breaks the switch');
  assert.ok(classes.has('reduce-effects'), 'a refusing storage breaks the switch');
  assert.equal(readReduceEffectsMirror(), false);
  storageThrows = false;
});

test('prefers-reduced-motion does not turn Reduce effects on', () => {
  // The owner's rule: the system setting keeps its old behaviour and gains no new visual change. Reintroduce
  // by OR-ing `matchMedia('(prefers-reduced-motion: reduce)').matches` into the snapshot: "reduced motion
  // turned the switch on" fails.
  reset();
  prefersReduced = true;
  restoreReduceEffects();
  assert.equal(effectsReduced(), false, 'reduced motion turned the switch on');
  assert.ok(!classes.has('reduce-effects'), 'reduced motion turned the switch on');
  const lib = code(read('lib/effects.ts'));
  assert.doesNotMatch(lib, /matchMedia|prefers-reduced-motion/, 'reduced motion turned the switch on (lib/effects.ts reads the media query)');
  assert.match(lib, /useSyncExternalStore\(subscribe, effectsReduced, \(\) => false\)/, 'useReduceEffects reads something other than the setting');
  prefersReduced = false;
});

test('the perf rig sets the switch off for its baseline instead of inheriting it', () => {
  // The rig's first phase is labelled "switch off", but the switch follows the ACCOUNT: until the rig sets it,
  // an account left with Reduce effects on -- a crashed run, an earlier script, a real reader who uses it --
  // makes that phase measure the ON state and print ~60 fps on every row, which reads as "nothing is wrong"
  // about a page with no fx layers, no Lenis and no blur on it. It happened on this rig's first outside run.
  // Reintroduce by deleting the `requireReduceEffects(page, false)` line above `runAll('switch off')` in
  // either file: "the baseline phase inherits whatever the account holds" fails.
  for (const f of ['test/perf/scroll.mjs', 'test/perf/interact.mjs']) {
    const src = code(read(f));
    const baseline = src.indexOf("runAll('switch off')");
    assert.ok(baseline > 0, `${f} no longer has a "switch off" phase`);
    const setsOff = /\b(requireReduceEffects|setReduceEffects)\(page, false\)/.exec(src.slice(0, baseline));
    assert.ok(setsOff, `the baseline phase inherits whatever the account holds (${f})`);
    // And the state each number was taken in is printed beside it, so a row measured in the wrong state is
    // visible in the log rather than being read as a number.
    assert.match(src, /fmtState\(/, `${f} prints no page state beside its rows`);
  }
});
