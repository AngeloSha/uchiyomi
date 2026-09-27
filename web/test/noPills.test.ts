// "No more pills" (v0.49.0): the owner asked for the capsule shapes to go from actions, statuses and
// notices -- and for the filter and sort chips to stay exactly as they are.
//
// A capsule is a fully rounded box with horizontal padding: `rounded-full` and `px-…` on one element, or a
// shared class that is one (`.chip`, `.btn-accent`, `.btn-ghost` in app/globals.css). A dot (`h-1.5 w-1.5
// rounded-full`, no padding) is a circle, not a capsule, and stays allowed.
//
// SURFACES is the list of redesigned files, SLICES the redesigned parts of files that also hold chips which
// stay (a filter row, an action the owner has not ruled on). Each later v0.49.0 step adds the surfaces it
// redesigns (the notices, the Downloads view, Health's rows, …) here in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: comments here describe the capsules they replaced. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const SURFACES = [
  'components/ProgressRing.tsx',
  'components/StatusMark.tsx',
  'components/ActionList.tsx',
  'lib/ring.ts',
  'lib/status.ts',
];

/**
 * `[file, name, from, to]`: the code between the two markers. A marker that moved fails by name rather than
 * letting the scan read an empty string and pass.
 *
 * The admin console's status badges (step 3). Health()'s own capsules belong to the Health step, which adds
 * its slice when it redesigns them; the Providers panel's Test / Check all keys and the Extensions header's
 * Refresh are actions the owner has not ruled on, so the slices end before them.
 */
const SLICES: [string, string, string, string][] = [
  ['app/admin/page.tsx', 'Overview: Needs attention', 'function NeedsAttention(', 'function TabTile('],
  ['app/admin/page.tsx', 'Providers: source status', 'const statusMark = ', '<div className="board">'],
  ['app/admin/page.tsx', 'Extensions: engine status', "{tr('Extensions')}</p>", '{status.reachable && ('],
];

const slice = (src: string, from: string, to: string, name: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${name}: ${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

/** Every string that could be a class list, from every redesigned surface, with where it came from. */
function surfaceStrings(): { where: string; s: string }[] {
  const parts = [
    ...SURFACES.map((f) => ({ where: f, src: code(read(f)) })),
    ...SLICES.map(([f, name, from, to]) => ({ where: `${f} (${name})`, src: slice(code(read(f)), from, to, name) })),
  ];
  const out: { where: string; s: string }[] = [];
  // Quoted strings and template literals.
  for (const { where, src } of parts) for (const m of src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push({ where, s: m[1] ?? m[2] ?? m[3] });
  return out;
}

/** The component classes in globals.css, by name, with their @apply bodies whitespace-collapsed. */
function componentClasses(): Map<string, string> {
  const css = read('app/globals.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const m of css.matchAll(/\n\s*\.([\w-]+)\s*\{([^{}]*)\}/g)) out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  return out;
}

const isCapsule = (classes: string) => /(^|\s|:)rounded-full(\s|$)/.test(classes) && /(^|\s|:)px-/.test(classes);

test('no capsule in the redesigned surfaces: no rounded-full with padding, no pill-shaped shared class', () => {
  // Reintroduce the round count on the Library tab (`rounded-full px-1` on RingIcon's count tag), or a
  // `chip` on an action key: "components/ProgressRing.tsx: capsule" fails.
  const pills = [...componentClasses()].filter(([, body]) => isCapsule(body)).map(([name]) => name);
  assert.deepEqual(pills.sort(), ['btn-accent', 'btn-ghost', 'chip'], 'the pill-shaped shared classes changed -- update this list deliberately');
  for (const { where, s } of surfaceStrings()) {
    if (isCapsule(s)) assert.fail(`${where}: capsule -- "${s.trim()}"`);
    for (const p of pills) {
      if (new RegExp(`(^|[\\s{}'"\`])${p}(?=$|[\\s'"\`])`).test(s)) assert.fail(`${where}: uses the pill-shaped .${p} -- "${s.trim().slice(0, 120)}"`);
    }
  }
});

test('the admin console\'s status badges are marks: the slices hold what they claim to', () => {
  // A slice that silently lost its content (a marker matched something earlier) would scan nothing and pass.
  // Reintroduce by renaming `statusMark` back to `statusChip`: "Providers: source status: … is not where
  // this test looks" fails -- the scan above goes first and says so too.
  const admin = code(read('app/admin/page.tsx'));
  const [attention, providers, engine] = SLICES.map(([, name, from, to]) => slice(admin, from, to, name));
  assert.match(attention, /<StatusMark tone=\{m\.tone\} title=\{m\.label\} \/>/, 'the Needs attention slice has no mark');
  assert.match(providers, /<StatusMark \{\.\.\.sourceMark\(st\)\} \/>/, 'the Providers slice has no mark');
  assert.match(providers, /function packageCard\(/, 'the Providers slice ends before the package card');
  assert.match(engine, /<StatusMark \{\.\.\.engineMark\(/, 'the Extensions slice has no mark');
});

test('the filter and sort chips stay exactly as they are', () => {
  // The owner's rule: only actions, statuses and notices lose the capsule. Reintroduce a restyle of `.chip`
  // (`rounded-lg` for `rounded-full`): "the filter/sort chips changed" fails.
  const cls = componentClasses();
  assert.equal(cls.get('chip'), '@apply inline-flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800/60 px-3 py-1.5 text-sm text-fog-300 transition;',
    'the filter/sort chips changed');
  assert.equal(cls.get('chip-active'), '@apply border-transparent bg-accent-soft text-accent;', 'the active filter/sort chip changed');
});

test('the action keys that replace the pills are rectangles', () => {
  // Reintroduce `rounded-full` for `rounded-lg` on `.btn-key`: "the action key lost its 8 px corners" fails.
  const cls = componentClasses();
  const key = cls.get('btn-key');
  assert.ok(key, 'there is no .btn-key');
  assert.match(key!, /\brounded-lg\b/, 'the action key lost its 8 px corners');
  assert.ok(!isCapsule(key!), 'the action key is a capsule');
  for (const v of ['btn-key-primary', 'btn-key-danger']) {
    assert.ok(cls.has(v), `there is no .${v}`);
    assert.doesNotMatch(cls.get(v)!, /rounded-full/, `.${v} makes the key a capsule`);
  }
});
