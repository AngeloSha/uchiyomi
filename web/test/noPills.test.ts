// "No more pills" (v0.49.0): the owner asked for the capsule shapes to go from actions, statuses and
// notices -- and for the filter and sort chips to stay exactly as they are.
//
// A capsule is anything `rounded-full` that is not a circle, or a shared class that is one (`.chip`,
// `.btn-accent`, `.btn-ghost` in app/globals.css). A circle names equal sides (`h-1.5 w-1.5`, `h-8 w-8`,
// `size-2`) and has no inline padding or minimum width: a dot or a round icon button stays allowed. A
// `min-w-[16px] rounded-full` count is a capsule the moment it says "9+".
//
// SURFACES is the list of redesigned files, SLICES the redesigned parts of files that also hold chips which
// stay (a filter row). Each later v0.49.0 step adds the surfaces it redesigns (the notices, the Downloads
// view, Health's rows, …) here in the same commit.
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
  // Step 5, the Downloads view that replaced the pill: the ring's mapper, the view, the series band.
  'components/DownloadsRing.tsx',
  'components/ServerDownloadsView.tsx',
  'components/SeriesServerDownloads.tsx',
  // Step 6, the notices that replaced the capsule toasts.
  'components/Toast.tsx',
  'lib/notices.ts',
  // Step 8, Health: its keys, legends and status lines, and the live strip and history.
  'components/HealthActions.tsx',
  'components/RepairLive.tsx',
];

/**
 * `[file, name, from, to]`: the code between the two markers. A marker that moved fails by name rather than
 * letting the scan read an empty string and pass.
 *
 * The admin console's status badges (step 3) and its action keys: the owner ruled that only filter and sort
 * chips keep the chip shape, so the Providers panel's Test / Clear block / Enable / Update address / Check
 * all / Reload and the Extensions tab's Refresh, Add, languages, Update all, Update, Add and Remove are
 * `.btn-key`s. The Extensions tab's 18+ and Added toggles are filters and stay chips, so its slices stop
 * short of them. Health()'s own capsules belong to the Health step, which adds its slice when it redesigns
 * them.
 */
const SLICES: [string, string, string, string][] = [
  ['app/admin/page.tsx', 'Overview: Needs attention', 'function NeedsAttention(', 'function TabTile('],
  ['app/admin/page.tsx', 'Providers: source cards and their keys', 'function controlsOf(', '<div className="board">'],
  ['app/admin/page.tsx', 'Providers: Check all and Reload', "{tr('{n} sources in {m} providers'", '{sweep && ('],
  // Anchored on the header's own code: the first "{tr('Extensions')}</p>" is the not-configured card's.
  ['app/admin/page.tsx', 'Extensions: engine status and Refresh', 'const list = cat?.content || [];', '{!status.reachable ? ('],
  ['app/admin/page.tsx', 'Extensions: repositories, languages and Update all', '<button onClick={() => setShowRepos(!reposOpen)}', '<input value={q2}'],
  ['app/admin/page.tsx', 'Extensions: catalogue rows', '{list.map((e) => (', '{!list.length && !isFetching && ('],
  // Step 5: the Library's Series | Downloads switch (its count is a squared tag), and the header's two counts
  // side by side on a desktop -- the downloads ring's and the Updates bell's, a capsule at "9+" until v0.49.0.
  ['app/library/page.tsx', 'Library: the Series | Downloads switch', 'function ViewSwitch(', 'function MoveToLibrary('],
  ['components/TopNav.tsx', 'TopNav: the downloads ring and the Updates count', '<DownloadsNavIcon />', '<button onClick={refresh}'],
  // Step 8: Health's body -- the verdict marks that replaced the HEALTH_LABEL capsules, Re-check as a key, Open
  // as a text link -- and the Tasks rows' Run now.
  ['app/admin/page.tsx', 'Health: the cards, their marks and rows', 'function Health()', 'function DesktopUpdateNote('],
  ['app/admin/page.tsx', 'Tasks: Run now', 'function Tasks()', 'function DesktopBackups()'],
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

/** A class list's utilities without their variants (`lg:px-2` → `px-2`). */
const utilities = (classes: string) => classes.split(/\s+/).filter(Boolean).map((c) => c.slice(c.lastIndexOf(':') + 1));
const isCapsule = (classes: string) => {
  const u = utilities(classes);
  if (!u.includes('rounded-full')) return false;
  if (u.some((c) => /^(px|ps|pe|min-w)-/.test(c))) return true;
  if (u.some((c) => /^size-/.test(c))) return false;
  const h = u.filter((c) => /^h-/.test(c)).map((c) => c.slice(2));
  const w = u.filter((c) => /^w-/.test(c)).map((c) => c.slice(2));
  // A circle names its sides, and names them equal.
  return !h.some((x) => w.includes(x));
};

test('the capsule detector: padding, a minimum width or unequal sides make rounded-full a capsule', () => {
  // The first detector wanted `px-` beside `rounded-full`, so the round count the owner ruled out (a
  // `min-w-[16px] rounded-full text-center` tag that grows into a pill at "9+") passed. Reintroduce that
  // rule: "a min-width count is a capsule" fails.
  assert.ok(isCapsule('absolute rounded-full px-1 text-[9px]'));
  assert.ok(isCapsule('min-w-[16px] rounded-full bg-accent text-center text-[10px]'), 'a min-width count is a capsule');
  assert.ok(isCapsule('rounded-full ps-2 pe-3'), 'logical padding is padding');
  assert.ok(isCapsule('h-5 w-9 rounded-full'), 'a 20 x 36 lozenge is a capsule');
  assert.ok(isCapsule('lg:rounded-full lg:px-3'), 'a variant hides the capsule');
  assert.ok(isCapsule('rounded-full bg-ink-700 py-1 text-[11px]'), 'a fully rounded label with no sides named grows with its text');
  assert.ok(!isCapsule('h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400'), 'a dot is a capsule');
  assert.ok(!isCapsule('-my-1.5 grid h-8 w-8 place-items-center rounded-full'), 'a round icon button is a capsule');
  assert.ok(!isCapsule('size-2 rounded-full bg-accent'));
  assert.ok(!isCapsule('rounded-lg px-3'), 'a rounded rectangle is a capsule');
});

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

test('the admin console\'s status badges are marks and its actions keys: the slices hold what they claim to', () => {
  // A slice that silently lost its content (a marker matched something earlier) would scan nothing and pass.
  // Reintroduce by renaming `statusMark` back to `statusChip`: "Providers: source cards and their keys: … is
  // not where this test looks" fails -- the scan above goes first and says so too. Anchor the engine slice on
  // "{tr('Extensions')}</p>" again: it starts at the not-configured card and "the engine slice holds the
  // not-configured card" fails.
  const admin = code(read('app/admin/page.tsx'));
  const [attention, providers, toolbar, engine, repos, rows, health, tasks] = SLICES.filter(([f]) => f === 'app/admin/page.tsx').map(([, name, from, to]) => slice(admin, from, to, name));
  // Health (step 8): a mark per card, Re-check a key, and nothing called HEALTH_LABEL left to be a capsule.
  assert.match(health, /<StatusMark \{\.\.\.mark\} size="xs" \/>/, 'the Health slice has no mark');
  assert.match(health, /className="btn-key"/, 'Re-check is not a key');
  assert.doesNotMatch(health, /HEALTH_LABEL|HEALTH_TONE/, 'the Health capsules are back');
  assert.match(tasks, /className="btn-key /, 'Run now is not a key');
  assert.match(attention, /<StatusMark tone=\{m\.tone\} title=\{m\.label\} \/>/, 'the Needs attention slice has no mark');
  assert.match(providers, /<StatusMark \{\.\.\.sourceMark\(st\)\} \/>/, 'the Providers slice has no mark');
  assert.match(providers, /function packageCard\(/, 'the Providers slice ends before the package card');
  const keys = (src: string) => (src.match(/className=\{?[`"]btn-key\b/g) || []).length;
  assert.equal(keys(providers), 4, 'Test, Clear block, Enable/Disable and Update address are not all keys');
  assert.equal(keys(toolbar), 2, 'Check all and Reload are not both keys');
  assert.match(engine, /<StatusMark \{\.\.\.engineMark\(/, 'the Extensions slice has no mark');
  assert.match(engine, /onClick=\{refreshRepos\}[^>]*className="btn-key"/, 'Refresh is not a key');
  assert.doesNotMatch(engine, /No extension engine is set up|refreshAll = \(\) =>/, 'the engine slice holds the not-configured card');
  assert.ok(engine.split('\n').length < 20, `the engine slice is ${engine.split('\n').length} lines: a marker moved`);
  assert.equal(keys(repos), 4, 'the repository Add, Choose languages, a language\'s Hide/Show and Update all are not all keys');
  assert.doesNotMatch(repos, /value=\{q2\}|setShowAdult/, 'the repositories slice runs into the filter chips');
  assert.equal(keys(rows), 2, 'a catalogue row\'s Update and Add/Remove are not keys');
});

test('the downloads counts are squared tags: the switch\'s, the ring\'s and the Updates bell\'s beside it', () => {
  // The Updates count beside the new desktop ring was a round tag that became a capsule at "9+": three count
  // shapes side by side. Reintroduce `rounded-full` on it: the capsule scan above fails ("TopNav … capsule")
  // and so does this.
  const top = slice(code(read('components/TopNav.tsx')), '<DownloadsNavIcon />', '<button onClick={refresh}', 'TopNav');
  const count = /<span data-updates-count className="([^"]*)"/.exec(top);
  assert.ok(count, 'the Updates count is not where this test looks');
  assert.match(count![1], /rounded-\[4px\]/, 'the Updates count is not squared');
  assert.doesNotMatch(count![1], /rounded-full/, 'the Updates count is a capsule');
  const sw = slice(code(read('app/library/page.tsx')), 'function ViewSwitch(', 'function MoveToLibrary(', 'ViewSwitch');
  assert.match(sw, /role="tablist"/, 'the switch slice does not hold the switch');
  assert.match(sw, /rounded-\[4px\][^"]*tabular-nums/, 'the switch\'s count is not a squared tag');
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
