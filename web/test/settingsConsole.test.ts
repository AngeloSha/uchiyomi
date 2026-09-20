// The v0.39.0 settings consoles: the profile's four tabs (You · Settings · Connections · Account) and the admin
// Settings tab, both composed from `components/settings.tsx`.
//
// Read from source, like library.test.ts: whether a text field saves on blur rather than on every keystroke,
// whether the grid ever caps the page, whether /admin keeps its tab in the URL, whether Providers still embeds
// the whole Extensions card -- each a thing that was wrong or inconsistent before this release, and each
// invisible to a type check. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
// Pure, so it is called rather than pinned (builder A's tab-address test below).
import { withTab } from '../lib/tabParam';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments below quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/** Every English string a file asks `tr()` for, plus labels declared through `keys(...)` (lib/i18n.ts). */
const trKeys = (files: string[]): Set<string> => {
  const keys = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
    for (const decl of src.matchAll(/\bkeys\(([^)]*)\)/g)) {
      for (const m of decl[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    }
  }
  return keys;
};
const localeFiles = (): string[] => readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
const missingIn = (file: string, keys: Iterable<string>): string[] => {
  const d = JSON.parse(read(`public/locales/${file}`));
  return [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
};
// Keep the helpers referenced even before every builder's test lands, so an unused-import lint cannot bite.
void existsSync; void code; void trKeys; void localeFiles; void missingIn;

// ---- builder tests are appended below this line (Edit tool only; one block per builder) ----

// ---- B: the primitives in components/settings.tsx ----

/** The source between two `export function` markers, so a guard reads ONE component and not its neighbours. */
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.notEqual(a, -1, `${from} is gone from components/settings.tsx`);
  assert.notEqual(b, -1, `${to} is gone from components/settings.tsx`);
  return src.slice(a, b);
};

test('the settings primitives are accessible', () => {
  // The pill group is a real radio group (one tab stop, arrows inside it, "2 of 3, checked" announced), the
  // sliding pill takes its layoutId from useId() so two groups on one card cannot swap pills, the tick honours
  // reduced motion, the live region exists before it changes, and the disclosure names what it controls.
  // And nothing directional is physical: the profile ships in Arabic, where an `ml-auto` control block sits
  // on the wrong side of its label. Reintroduce by swapping `ms-auto` for `ml-auto` in Row.
  const src = read('components/settings.tsx');
  const body = code(src);
  assert.match(body, /role="radiogroup"/, 'Segmented is no longer a radio group');
  assert.match(body, /role="radio"/, 'the pills are no longer radios');
  assert.match(body, /aria-checked=\{selected\}/, 'the pills do not announce which is checked');
  assert.match(body, /const id = useId\(\);[\s\S]*layoutId=\{id\}/, 'the pill layoutId is not the per-instance useId()');
  assert.match(body, /useReducedMotion\(\)/, 'nothing consults reduced motion');
  assert.match(body, /role="status" aria-live="polite"/, 'the SaveState live region is gone');
  assert.match(body, /aria-expanded=\{isOpen\} aria-controls=\{cid\}/, 'the disclosure button no longer names its content');
  // ⚠️ `-(?:\d|auto|px|\[)` and not `-\d` alone: `ml-auto` -- the one physical class a control block is
  // most likely to grow -- has no digit in it and sailed past the narrower pattern.
  const PHYSICAL = /(?<![\w-])-?(?:m|p)[lr]-(?:\d|auto|px|\[)|\btext-(?:left|right)\b|(?<![\w-])-?(?:left|right)-(?:\d|auto|px|full|\[)/;
  assert.doesNotMatch(body, PHYSICAL,
    'a physical margin/padding/side class in the settings primitives -- these mirror wrong under dir="rtl"');
  assert.ok(PHYSICAL.test('ml-auto') && PHYSICAL.test('pr-2') && PHYSICAL.test('-mr-1') && PHYSICAL.test('left-0') && !PHYSICAL.test('ms-auto px-3 inset-x-2'),
    'the physical-class pattern itself stopped matching what it should');
  assert.match(body, /\bms-auto\b/, 'the Row control block is no longer pushed to the end with ms-auto');
});

test('text and number rows save once, on blur or Enter, and only when changed', () => {
  // A server name saved per keystroke is sixty PATCHes and a "Saved" that flickers the whole time you type;
  // and Enter followed by Tab must not save the same value twice. Both rows commit from blur and from the
  // Enter key only, compare against the last value they sent (`last`), and never call onSave from onChange.
  // Reintroduce by calling `onSave` inside the input's `onChange`.
  const src = code(read('components/settings.tsx'));
  for (const [name, next] of [['TextRow', 'NumberRow'], ['NumberRow', 'RangeRow']] as const) {
    const part = slice(src, `export function ${name}(`, `export function ${next}(`);
    assert.doesNotMatch(part, /onChange=\{[^}]*onSave/, `${name} saves from onChange`);
    assert.match(part, /onBlur=\{\(\) => \{ setFocused\(false\); commit\(\); \}\}/, `${name} does not commit on blur`);
    assert.match(part, /e\.key === 'Enter'[\s\S]*commit\(\)/, `${name} does not commit on Enter`);
    assert.match(part, /if \(n(?:ext)? === last\.current\) return;/, `${name} lost its "only when changed" guard`);
    assert.match(part, /onChange=\{\(e\) => setDraft\(e\.target\.value\)\}/, `${name}'s onChange does more than hold the draft`);
  }
  assert.doesNotMatch(src, /onChange=\{[^}]*onSave/, 'a row in settings.tsx saves from onChange');
});

test('the saved tick is the one feedback idiom', () => {
  // Toasts stay for actions with side effects; a setting that says "Saved" twice -- once in the row and once
  // at the top of the screen -- is the noise the primitives exist to remove. So this file never imports the
  // toast, and SaveState has a branch for every kind rather than falling silent on one of them.
  // Reintroduce by importing useToast and toasting 'Saved' from useAutosave.
  const src = code(read('components/settings.tsx'));
  assert.doesNotMatch(src, /useToast|from '\.\/Toast'|toast\(/, 'settings.tsx toasts');
  const state = slice(src, 'export function SaveState(', 'export function useAutosave(');
  for (const kind of ['saving', 'saved', 'error']) {
    assert.match(state, new RegExp(`status\\.kind === '${kind}'`), `SaveState has no branch for '${kind}'`);
  }
  assert.match(state, /tr\('Saving…'\)/, 'the saving label is not translated');
  assert.match(state, /'✓ ' \+ tr\('Saved'\)/, 'the tick is not "✓ Saved"');
  assert.match(state, /\{status\.message\}/, 'the error branch does not show the message');
});

test('the settings grid never caps the page', () => {
  // The owner's "768 px ribbon": a settings grid inside a capped container on a 2560 px display. The grid
  // answers width with more columns and NEVER with a max-width; layout.mjs measures the same thing in a
  // browser. Reintroduce by appending `max-w-3xl` to SETTINGS_GRID.
  const src = code(read('components/settings.tsx'));
  const m = /export const SETTINGS_GRID = '([^']*)';/.exec(src);
  assert.ok(m, 'SETTINGS_GRID is not exported as a string constant');
  assert.match(m[1], /\bxl:grid-cols-2\b/, 'the grid no longer goes to two columns at xl');
  assert.doesNotMatch(m[1], /max-w/, 'SETTINGS_GRID caps the page');
  assert.doesNotMatch(src, /max-w-(?:xs|sm|lg|xl|\dxl|screen|\[)/, 'a cap wider than max-w-prose/max-w-md somewhere in settings.tsx');
});

// ---- builder C: ProfileSettings (Appearance · Reading · Downloads · This device) and ProfileAccount ----

test('reader defaults on the profile write through the reader\'s own store', () => {
  // `lib/readerPrefs.ts` is the ONE writer of `yomi_reader_prefs` and of the `PUT /api/settings {reader,
  // readerSeries}` behind it: local-first, debounced 1.5 s, and it also carries the per-series memory. A
  // second writer on the profile -- its own localStorage line, or its own `json: { reader: ... }` -- would
  // race the reader's debounce and, worse, PUT a `reader` object with no `readerSeries` beside it, which
  // the server merges shallowly: every per-series memory on every device wiped by a Mode tap on the
  // profile. Reintroduce by replacing `savePrefs(n)` with `api('/api/settings', { method: 'PUT', json: {
  // reader: n } })`: "the profile writes the reader store itself" fails.
  const src = code(read('components/ProfileSettings.tsx'));
  assert.match(src, /import \{ ReaderPrefs, loadPrefs, savePrefs, syncPrefsFromServer \} from '@\/lib\/readerPrefs';/, 'the profile does not use the reader store');
  assert.doesNotMatch(src, /yomi_reader_prefs|json: \{ reader/, 'the profile writes the reader store itself');
  // Local-first, exactly as the reader's sheet: state first, then the store (which debounces the server).
  assert.match(src, /const set = \(p: Partial<ReaderPrefs>\) => \{ const n = \{ \.\.\.prefs, \.\.\.p \}; setPrefs\(n\); savePrefs\(n\); \};/, 'a reader default is not written local-first through savePrefs');
  assert.match(src, /const \[prefs, setPrefs\] = useState\(loadPrefs\);/, 'the defaults do not start from the local store');
  // The server copy is adopted once it answers, and never after the section is gone.
  assert.match(src, /syncPrefsFromServer\(\)\.then\(\(p\) => \{ if \(live\) setPrefs\(p\); \}\);/, 'the server copy is not adopted, or is adopted after unmount');
  // The goal is the stats query's number, so a change must refetch the stats or the hero pill lies.
  assert.match(src, /json: \{ weeklyGoal: n \}/, 'the weekly goal does not PUT {weeklyGoal}');
  assert.match(src, /qc\.invalidateQueries\(\{ queryKey: \['stats'\] \}\)/, 'saving the goal does not refetch the stats');
  // Smart downloads keep the body the server already takes.
  assert.match(src, /json: \{ smartOffline: next \}/, 'Keep favorites offline no longer PUTs {smartOffline}');
});

test('the language chips stay locked while a once-only secret is on screen', () => {
  // I18nProvider remounts its whole subtree on a language change (`<div key={lang}>`), and three values are
  // shown exactly once and never again: the OPDS password, a fresh API token, the 2FA recovery codes. They
  // live on OTHER tabs now, so the Language row cannot see them in React state; it asks lib/shownOnce.ts at
  // render time instead, which any tab switch re-runs. Reintroduce by dropping `disabled={locked}` from the
  // chips: "the chips are not locked" fails; or by holding `locked` in a `useState` read once: "the lock is
  // not read at render time" fails, because a token minted after the Settings tab first rendered would not
  // lock it.
  const src = code(read('components/ProfileSettings.tsx'));
  assert.match(src, /const locked = !!readShownOnce\('opds\.link'\) \|\| !!readShownOnce\('apiToken\.fresh'\) \|\| !!readShownOnce\('totp\.recovery'\);/, 'the lock is not read at render time, or misses one of the three secrets');
  assert.match(src, /onClick=\{\(\) => setLang\(l\.code\)\} disabled=\{locked\}/, 'the chips are not locked');
  assert.match(src, /\{locked && \(\s*<p className="mt-2 max-w-prose text-\[11px\] text-amber-300">/, 'the lock has no sentence explaining itself');
  assert.doesNotMatch(src, /useState\([^)]*readShownOnce/, 'the lock is held in state rather than read on every render');
});

test('sign out is still a button on the profile', () => {
  // The e2e signs out THROUGH THE UI -- `[...document.querySelectorAll('button')].find(/sign out/i)` -- because
  // it is the app's own `logout()` that clears the saved identity, and that is the half being tested. A
  // `<Link href="/auth/logout">` would drop the server cookie and pass locally while asserting nothing.
  // Reintroduce by rendering the control as a Link: "Sign out is not a button" fails.
  const src = code(read('components/ProfileAccount.tsx'));
  assert.match(src, /<button type="button" onClick=\{logout\}[^>]*>\s*\{tr\('Sign out'\)\}\s*<\/button>/, 'Sign out is not a button');
  assert.match(src, /label=\{tr\('Sign out of this device'\)\} help=\{tr\('Other devices stay signed in\.'\)\}/, 'the row does not say what stays signed in');
  assert.doesNotMatch(src, /<Link[^>]*>\s*\{tr\('Sign out'\)\}/, 'Sign out is a Link');
});

test('the account tab keeps its secrets inline and its one explicit Save on the password', () => {
  // The recovery codes are shown once, survive a language-change remount only through `shownOnce`, and a
  // collapsed box would hide them for good; the old page had exactly that bug behind a "Manage" chip. The
  // password is the one thing on this tab that must never save as you type, so it keeps a button -- and it
  // must be the ONLY `btn-accent` outside the 2FA boxes. Reintroduce by wrapping the recovery box in
  // `<Disclosure>`: "a secret sits behind a collapse" fails; or by calling `changePw` from an `onChange`:
  // "the password saves as you type" fails.
  const src = code(read('components/ProfileAccount.tsx'));
  assert.match(src, /useState<string\[\] \| null>\(\(\) => readShownOnce<string\[\]>\('totp\.recovery'\)\)/, 'the recovery codes do not survive a remount');
  assert.doesNotMatch(src, /<Disclosure|SettingsCard|defaultOpen/, 'a secret sits behind a collapse');
  assert.match(src, /<form onSubmit=\{changePw\}/, 'the password form has no explicit submit');
  assert.doesNotMatch(src, /onChange=\{[^}]*changePw/, 'the password saves as you type');
  assert.match(src, /import \{ SETTINGS_GRID, Section, Row, useAutosave \} from '@\/components\/settings';/, 'the account tab does not use the settings primitives');
  assert.match(src, /queryKey: \['sessions'\], queryFn: \(\) => api<\{ content: Session\[\] \}>\('\/auth\/sessions'\)/, 'the sessions query moved without its key');
});

// ---- D: components/ProfileConnections.tsx + the locale sweep over every new console file ----

test('every string the new consoles render is in all eight locale files', () => {
  // Five new components and the rebuilt page: none of them edits a locale file, and the parity test
  // (library.test.ts) only compares the eight files with each other, so a string that reaches none of them
  // falls back to English in every language without anything failing. This reads the code instead.
  // Reintroduce by deleting any one of these keys from public/locales/ar.json.
  const files = [
    'components/settings.tsx', 'components/ProfileYou.tsx', 'components/ProfileSettings.tsx',
    'components/ProfileConnections.tsx', 'components/ProfileAccount.tsx', 'components/AdminSettings.tsx',
    'app/profile/page.tsx',
  ];
  for (const f of files) assert.ok(existsSync(join(ROOT, f)), `${f} does not exist -- a console this test covers is not built yet`);
  const keys = trKeys(files);
  // Anti-vacuity: the six files carry well over two hundred strings between them; a scan finding fewer than
  // 150 has lost its regex, not its strings.
  assert.ok(keys.size >= 150, `only ${keys.size} strings found across the new consoles -- the scan itself is broken`);
  const locales = localeFiles();
  assert.equal(locales.length, 8, `expected eight locale files, found ${locales.join(', ')}`);
  for (const f of locales) {
    const missing = missingIn(f, keys);
    assert.deepEqual(missing, [], `${missing.length} of the consoles' strings are missing from ${f}: ${missing.slice(0, 12).join(' | ')}${missing.length > 12 ? ' | …' : ''}`);
  }
});

test('the tracking card keeps its anchor for the import page\'s deep link', () => {
  // The import page's "connect one under Profile" line lands on `/profile/?tab=Connections&card=tracking`,
  // and the page scrolls `#progress-tracking` into view once the trackers are known. Rename the id or drop
  // the scroll and that link opens the tab with the card ~430 px below the fold at phone width, which is the
  // exact bug the query was added for. The row text stays `Sync your reading to {name}` because
  // scripts/shots/capture.mjs finds this card by it, and the title stays `API tokens` for the same rig.
  // Reintroduce by renaming the id to "tracking".
  const src = code(read('components/ProfileConnections.tsx'));
  assert.match(src, /<Section ref=\{ref\} id="progress-tracking" className="scroll-mt-4 lg:scroll-mt-20" title=\{tr\('Progress tracking'\)\}/, 'the tracking section lost its id, its scroll margin or its title');
  const card = src.slice(src.indexOf('function TrackerSection('), src.indexOf('function TrackerRow('));
  assert.ok(card.length > 0, 'TrackerSection / TrackerRow are not where this test looks');
  assert.match(card, /ref\.current\.scrollIntoView\(\{ block: 'start', behavior: still \? 'auto' : 'smooth' \}\)/, 'the section never scrolls itself into view, or ignores reduced motion');
  assert.match(card, /if \(!all\.length\) return null;/, 'an empty provider list no longer hides the section');
  assert.match(src, /tr\('Sync your reading to \{name\}', \{ name: label \}\)/, 'the not-connected row no longer reads "Sync your reading to {name}"');
  assert.match(src, /title=\{tr\('API tokens'\)\}/, 'the tokens section is no longer titled "API tokens"');
  assert.match(code(read('app/profile/page.tsx')), /<ProfileConnections focusTracking=\{focusTracking && tab === 'Connections'\} \/>/, 'the page does not hand the Connections tab its focus');
});

test('the once-only secrets on the Connections tab are never behind a fold, and the token form is inline', () => {
  // The OPDS password and a fresh API token are sent by the server exactly once. They are read back from
  // lib/shownOnce.ts at mount (a language change remounts the whole tab) and rendered whenever held -- never
  // inside a Disclosure, a collapsed card or a Modal, any of which would hide or destroy the one copy. The
  // create form is inline for a second reason: the admin-scope ConfirmDialog is already a z-50 Modal, and two
  // stacked modals would share one Escape key. Reintroduce by importing Disclosure and wrapping the reveal
  // box in it, or by rendering the form inside <Modal>.
  const src = code(read('components/ProfileConnections.tsx'));
  assert.match(src, /const \[link, setLinkState\] = useState<OpdsLink \| null>\(\(\) => readShownOnce<OpdsLink>\('opds\.link'\)\);/, 'the OPDS link is not read back from shownOnce at mount');
  assert.match(src, /writeShownOnce\('opds\.link', v\)/, 'the OPDS link is not written to shownOnce');
  assert.match(src, /useState<string \| null>\(\(\) => readShownOnce<string>\('apiToken\.fresh'\)\)/, 'a fresh token is not read back from shownOnce at mount');
  assert.match(src, /writeShownOnce\('apiToken\.fresh', v\)/, 'a fresh token is not written to shownOnce');
  assert.doesNotMatch(src, /\bDisclosure\b|\bSettingsCard\b|<Modal\b/, 'a fold or a modal is back on the Connections tab');
  assert.match(src, /aria-expanded=\{open\} aria-controls=\{formId\}/, 'the New token button does not announce the inline form it opens');
  assert.match(src, /\{link && \(/, 'the OPDS reveal box is not rendered whenever a link is held');
  assert.match(src, /\{fresh && \(/, 'the fresh-token box is not rendered whenever a token is held');
});

// ---- builder A: the tab address, the profile's four tabs, the import page's pointer ----

test('/admin and /profile read and write ?tab=, without a history entry or a snap-back', () => {
  // Until v0.39.0 the admin tab was `useState<Tab>('Overview')`: a refresh, the back button and every deep
  // link landed on Overview, and a language change -- which remounts the whole subtree, lib/I18nProvider.tsx
  // -- snapped the profile back to You from the very tab holding the language picker. Both pages now take
  // the tab from `useTabParam`, which reads the query ONCE in a lazy `useState` and writes it back with
  // `history.replaceState`: never `pushState` (Back would walk through the tabs instead of leaving the page),
  // never `router.replace` (a route navigation re-runs the Suspense fallback for a cosmetic change), never
  // an effect re-reading the params (it would fire against its own write and snap the tab back). The pure
  // `withTab` keeps every other parameter -- the import page arrives with `card=tracking` beside the tab --
  // and drops `tab` when it names the first tab, so `/admin/` and `/admin/?tab=Overview` stay one address.
  // Reintroduce by `useState<Tab>('Overview')` on the admin page: "the admin tab is not read from the
  // query" fails; by `pushState` in the hook: "the hook pushes a history entry" fails; by appending
  // `tab=Overview` for the fallback: "the first tab is written into the URL" fails.
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /<Suspense fallback=\{<div className="min-h-screen-d" \/>\}>/, 'the admin page has no Suspense boundary for useSearchParams');
  assert.match(admin, /const \[tab, setTab\] = useTabParam<Tab>\(TABS, 'Overview'\);/, 'the admin tab is not read from the query');
  const profile = code(read('app/profile/page.tsx'));
  assert.match(profile, /const \[tab, setTab\] = useTabParam<Tab>\(PROFILE_TABS, 'You'\);/, 'the profile tab is not read from the query');
  const hook = code(read('lib/useTabParam.ts'));
  assert.match(hook, /history\.replaceState\(/, 'the hook does not write the tab back to the URL');
  assert.doesNotMatch(hook, /pushState|useEffect\(|router\.replace/, 'the hook pushes a history entry, re-reads the query in an effect, or navigates');
  // The pure half, called rather than pinned.
  assert.ok(withTab('http://x/admin/?tab=Overview&foo=1', 'Settings', 'Overview').endsWith('?foo=1&tab=Settings'), 'withTab drops the other params or does not replace the tab');
  assert.doesNotMatch(withTab('http://x/admin/?tab=Settings', 'Overview', 'Overview'), /tab=/, 'the first tab is written into the URL');
  assert.equal(withTab('http://x/profile/?tab=Connections&card=tracking', 'Settings', 'You'), '/profile/?card=tracking&tab=Settings', 'withTab loses card=');
  assert.equal(withTab('http://x/profile/', 'Connections', 'You'), '/profile/?tab=Connections', 'withTab does not add the tab to a bare address');
});

test('the profile has four tabs and no leftover cards', () => {
  // You · Settings · Connections · Account. The old second tab, Reading, was device settings plus one chart
  // plus one integration; the old Account tab held eight cards including the admin door and a sign-out card
  // that repeated the rail. Everything that is a setting now lives in its tab's component; the page keeps
  // the hero, the rail and the You board. Reintroduce by adding 'Reading' to `keys(...)`: "the profile
  // still has a Reading tab" fails; by importing `SecurityPanel` on the page: "a retired card is back on
  // the page" fails.
  const src = code(read('app/profile/page.tsx'));
  assert.match(src, /keys\('You', 'Settings', 'Connections', 'Account'\)/, 'the profile tabs are not You · Settings · Connections · Account');
  assert.doesNotMatch(src, /keys\([^)]*'Reading'/, 'the profile still has a Reading tab');
  assert.doesNotMatch(src, /AdminCard|SignOutCard|SettingsCard|SecurityPanel/, 'a retired card is back on the page');
  // The two files behind the Manage layer are gone, not merely unimported: a file nobody imports still
  // compiles, still ships in the repo and still tempts the next builder to "reuse" its three identical
  // chips. Reintroduce by restoring the file: "SettingsCard.tsx is back" fails.
  assert.equal(existsSync(join(ROOT, 'components/SettingsCard.tsx')), false, 'SettingsCard.tsx is back');
  assert.equal(existsSync(join(ROOT, 'components/SecurityPanel.tsx')), false, 'SecurityPanel.tsx is back');
  // The three settings tabs render their own grid; only You is a board of cards.
  assert.match(src, /<ProfileSettings weeklyGoal=\{stats\?\.weeklyGoal \?\? 0\} \/>/, 'the Settings tab is not ProfileSettings');
  assert.match(src, /<ProfileConnections focusTracking=\{focusTracking && tab === 'Connections'\} \/>/, 'the Connections tab is not ProfileConnections');
  assert.match(src, /<ProfileAccount \/>/, 'the Account tab is not ProfileAccount');
  assert.equal((src.match(/className="board"/g) || []).length, 1, 'the .board wrapper is not the You tab alone');
  // The nav is labelled for the whole page, not with the first tab's name ("You › You" to a screen reader).
  assert.match(src, /ariaLabel=\{tr\('Profile'\)\}/, 'the console nav is still labelled with the first tab\'s name');
  // The You cards moved out verbatim and are imported, not redefined.
  assert.match(src, /import \{ BadgesCard, ListsCard, StudioCard, type Stats \} from '@\/components\/ProfileYou';/, 'the You cards are not imported from ProfileYou');
  assert.doesNotMatch(src, /function (?:BadgesCard|ListsCard|StudioCard)\(/, 'a You card is defined on the page again');
});

test('the import page sends people to the tracking card under Connections', () => {
  // The intake's not-connected line points at the profile with both halves of the query: the tab that
  // holds Progress tracking (Connections since v0.39.0) and the card to scroll to. Reintroduce by
  // `?tab=Reading`: "the import page points at a tab that no longer exists" fails.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /href="\/profile\/\?tab=Connections&card=tracking"/, 'the import page points at a tab that no longer exists');
  assert.doesNotMatch(src, /tab=Reading/, 'the import page still links to the Reading tab');
  assert.match(src, /Connect it under Profile → Connections → Progress tracking to bring your list over\./, 'the sentence names the wrong path');
});

// ---- builder E: the admin shell and Admin → Settings ----

test('Providers no longer embeds the Extensions card', () => {
  // `<Extensions span="full" />` rendered on the Extensions tab AND inside Providers, so the catalogue's
  // search field, its language list and its 1,400 rows appeared twice in the console and "Search
  // extensions" sat on a tab about sources. Providers keeps a door to the tab -- one status line and a
  // chevron -- and the panel switch is the only place the card mounts. Reintroduce by putting
  // `<Extensions span="full" />` back under the smoke-test block in Providers.
  const src = code(read('app/admin/page.tsx'));
  const providers = src.slice(src.indexOf('function Providers('), src.indexOf('function ExtensionsLink('));
  assert.ok(providers.length > 0, 'no Providers function, or ExtensionsLink no longer follows it');
  assert.doesNotMatch(providers, /<Extensions /, 'Providers renders the whole Extensions card again');
  assert.match(providers, /<ExtensionsLink onTab=\{onTab\} \/>/, 'Providers has no door to the Extensions tab');
  const link = src.slice(src.indexOf('function ExtensionsLink('), src.indexOf('// ---- Art Review'));
  assert.match(link, /onTab\('Extensions'\)/, 'the door does not switch to the Extensions tab');
  assert.match(link, /queryKey: \['ext-status'\][^\n]*\/api\/admin\/extensions\/status/, 'the door reads a different status than the Extensions tab does');
  assert.match(link, /rtl:-scale-x-100/, 'the chevron does not mirror under RTL');
  // The tab itself still mounts the card, once.
  const panel = src.slice(src.indexOf('const panel = ('), src.indexOf('<ConsoleNav'));
  assert.match(panel, /tab === 'Extensions' && <div className="board"><Extensions span="full" \/><\/div>/, 'the Extensions tab no longer mounts the card');
  assert.equal((src.match(/<Extensions /g) ?? []).length, 1, 'the Extensions card is mounted from more than one place');
});

test('read-chapter cleanup still asks first and carries the day count', () => {
  // The only switch on the tab that deletes files: ON opens the danger dialog rather than saving, OFF saves
  // at once. The dialog quotes the number in the box, and the click that opens it is the click that blurs
  // the box, so the refetch has not landed when the answer comes -- the confirm carries the days whenever
  // the server has not caught up, or the first run would use the OLD stored value under a box showing the
  // new one. Reintroduce by saving `{ cleanupRead: true }` alone in onConfirm.
  const src = code(read('components/AdminSettings.tsx'));
  const section = src.slice(src.indexOf('function HousekeepingSection('), src.indexOf('const NO_PREFS'));
  assert.ok(section.length > 0, 'no HousekeepingSection');
  assert.match(section, /if \(next\) setConfirm\(true\); else save\(\{ cleanupRead: false/, 'the switch no longer asks before turning on, or no longer saves at once when turning off');
  assert.match(section, /onConfirm=\{[^\n]*cleanupRead: true, \.\.\.\(cur !== stored \? \{ cleanupReadDays: cur \} : \{\}\)/, 'the confirm does not carry the day count with the switch');
  assert.match(section, /<ConfirmDialog[\s\S]{0,1500}?\n\s*danger\n/, 'the dialog is not the rose one');
  // The days save on their own, through the number row, and the due figure is withheld until the server
  // has counted at the number on screen.
  assert.match(section, /<NumberRow label=\{tr\('Wait \(days\)'\)\} min=\{0\} max=\{3650\}/, 'Wait (days) is not a NumberRow 0-3650');
  assert.match(section, /cur === stored && typeof data\.cleanup_read_due === 'number' \? data\.cleanup_read_due : null/, 'the due figure is shown against a day count the server has not counted at');
});

test('scanlators keep one Save', () => {
  // The lists are edited in several steps and must land as one write, so this is the ONE explicit Save on
  // the tab -- and it is quiet until something changed. Reintroduce by adding a second `btn-accent` to the
  // section, or by dropping `disabled={!dirty}`.
  const src = code(read('components/AdminSettings.tsx'));
  const section = src.slice(src.indexOf('function ScanlatorsSection('));
  assert.ok(section.length > 0, 'no ScanlatorsSection');
  assert.equal((section.match(/btn-accent/g) ?? []).length, 1, 'the scanlators section has more than one accent button');
  assert.match(section, /disabled=\{!dirty\}/, 'the Save is not dirty-tracked');
  assert.match(section, /\{tr\('Save scanlator defaults'\)\}/, 'the Save is not the scanlator one');
  // And it is the only explicit Save on the whole tab: every other row saves itself.
  assert.equal((src.match(/btn-accent/g) ?? []).length, 1, 'Admin → Settings has more than one accent Save button');
  assert.doesNotMatch(src, /tr\('Save name'\)|tr\('Save interval'\)|tr\('Save'\)/, 'a per-field Save button is back');
});

test('the install-count disclosure opens with the switch and is open while counting', () => {
  // What is sent must be visible at the moment of consent: the disclosure holding the literal payload is
  // open whenever the server is counting, and switching the count ON opens it (the `key` remounts it when
  // the switch lands, so `defaultOpen` is re-read). Its two labels are the exact ones run.mjs clicks and
  // the docs quote. Reintroduce by `defaultOpen={false}`: an admin who is being counted opens the tab to a
  // closed drawer.
  const src = code(read('components/AdminSettings.tsx'));
  const section = src.slice(src.indexOf('function ServerSection('), src.indexOf('function SchedulesSection('));
  assert.ok(section.length > 0, 'no ServerSection');
  assert.match(section, /<Disclosure key=\{on \? 'counting' : 'not-counting'\} defaultOpen=\{on\}/, 'the disclosure is not open while counting, or does not reopen when the switch lands');
  assert.match(section, /label=\{on \? tr\('What is sent, once a day'\) : tr\('What would be sent, once a day'\)\}/, 'the disclosure labels changed');
  // The payload and the three promises are inside it, unchanged.
  const drawer = section.slice(section.indexOf("<Disclosure key={on ? 'counting'"), section.indexOf('</Disclosure>', section.indexOf("<Disclosure key={on ? 'counting'")));
  assert.match(drawer, /<code>\{`POST \$\{preview\.url\}\\n\$\{JSON\.stringify\(preview\.payload, null, 2\)\}`\}<\/code>/, 'the payload is described rather than shown');
  assert.equal((drawer.match(/<li>\{tr\('/g) ?? []).length, 3, 'the three promises are not all inside the disclosure');
  // Server is the first section in the DOM: run.mjs reads the first 4000 characters of body text for it.
  const grid = src.slice(src.indexOf('<div className={SETTINGS_GRID}>', src.indexOf('return (\n    <div className={SETTINGS_GRID}>')));
  assert.match(grid, /<ServerSection [^\n]*\/>\s*<SchedulesSection [^\n]*\/>\s*<HousekeepingSection [^\n]*\/>\s*<ScanlatorsSection /, 'the sections are not in the order Server, Updates & schedules, Library housekeeping, Scanlators');
});

// ---- fixer X2 (review R1/R2): keyboard focus on Connections, the dialogs, the phone pills, 2FA state ----

test('focus never drops to <body> on the Connections tab', () => {
  // Every action there unmounts the button that was pressed -- Create/Generate swap the form or the header
  // action for a reveal box, Done removes the box, Revoke removes the row -- and a focused element that
  // leaves the DOM drops focus to <body>, from where the next Tab starts ~50 stops before the token just
  // minted (R1, measured: activeElement BODY after all six). Each handler names the next target before its
  // state change and one effect, run after every commit, focuses it once it is in the DOM and enabled; a
  // press names a target, a mount never does, so returning to the tab with a token on screen steals nothing.
  // Reintroduce by dropping `after(doneRef);` from `create`: "Create does not send focus to Done" fails; by
  // seeding the effect from `fresh` instead of a press (`useEffect(() => doneRef.current?.focus(), [fresh])`):
  // "focus is moved on a mount" fails; by clearing the request before `focus()` lands: "a disabled action
  // loses the request" fails.
  const src = code(read('components/ProfileConnections.tsx'));
  const hook = src.slice(src.indexOf('function useFocusAfter('), src.indexOf('/* ============================== Progress tracking'));
  assert.ok(hook.length > 0, 'useFocusAfter is not where this test looks');
  assert.match(hook, /useEffect\(\(\) => \{\s*const el = pending\.current\?\.current;\s*if \(!el\) return;\s*el\.focus\(\);\s*if \(document\.activeElement === el\) pending\.current = null;\s*\}\);/, 'a disabled action loses the request, or the effect does not run after every commit');
  assert.doesNotMatch(src, /useEffect\(\(\) => [^\n]*(doneRef|actionRef)\.current\?\.focus\(\)[^\n]*\[(fresh|link)\]/, 'focus is moved on a mount');
  // OPDS: Generate → Done, Done → Generate, Revoke → Generate (after the request, so the button is enabled).
  const opds = src.slice(src.indexOf('function OpdsSection('), src.indexOf('/* ============================== API tokens'));
  assert.match(opds, /const r = await api<OpdsLink>\('\/api\/opds\/token', \{ method: 'POST' \}\); after\(doneRef\); setLink\(r\);/, 'Generate does not send focus to Done');
  assert.match(opds, /const done = \(\) => \{ after\(actionRef\); setLink\(null\); \};/, 'OPDS Done does not send focus back to the header action');
  assert.match(opds, /await api\('\/api\/opds\/token', \{ method: 'DELETE' \}\); setLink\(null\); await load\(\); after\(actionRef\);/, 'OPDS Revoke does not send focus to the header action');
  assert.match(opds, /<button ref=\{actionRef\} type="button" onClick=\{gen\} disabled=\{busy\} className="chip text-xs disabled:opacity-50">/, 'the OPDS action is not the ref-carrying chip (an accent button wrapped the German title to three lines at 390)');
  assert.match(opds, /<button ref=\{doneRef\} type="button" onClick=\{done\} className="chip text-xs">\{tr\('Done'\)\}<\/button>/, 'the OPDS Done is not the ref-carrying chip');
  // Tokens: Create → Done, Done → New token, Revoke → New token; the form's Cancel forgets the scopes.
  const tokens = src.slice(src.indexOf('function TokensSection('));
  assert.match(tokens, /after\(doneRef\); setFresh\(r\.token\);/, 'Create does not send focus to Done');
  assert.match(tokens, /const done = \(\) => \{ after\(actionRef\); setFresh\(null\); \};/, 'token Done does not send focus back to New token');
  assert.match(tokens, /await api\(`\/api\/tokens\/\$\{id\}`, \{ method: 'DELETE' \}\); after\(actionRef\);/, 'token Revoke does not send focus to New token');
  assert.match(tokens, /<button ref=\{actionRef\} type="button" onClick=\{\(\) => \(open \? cancel\(\) : setOpen\(true\)\)\}/, 'New token does not carry the action ref');
  assert.match(tokens, /<button ref=\{doneRef\} type="button" onClick=\{done\} className="chip mt-2 text-xs">\{tr\('Done'\)\}<\/button>/, 'the token Done is not the ref-carrying chip');
  // R2: a scope ticked for an abandoned token carried over to the next one. The mint's own reset line is
  // pinned by forgetSeries.test.ts and stays as it is; Cancel resets the same three.
  assert.match(tokens, /const cancel = \(\) => \{ setOpen\(false\); setName\(''\); setWrite\(false\); setAdmin\(false\); setAdult\(false\); \};/, 'Cancel keeps the scopes ticked for the next token');
  // R1 contrast: the one security fact on the tracker form was fog-600 (2.6:1 on the card).
  assert.match(src, /text-fog-500">\s*\{tr\('The token carries access to your \{name\} account and cannot be scoped\./, 'the token-scope sentence is below AA again');
  assert.doesNotMatch(src, /text-fog-600">\s*\{tr\('The token carries access/, 'the token-scope sentence is fog-600');
});

test('a dialog and the phone group sheet give focus back to what opened them', () => {
  // Escape or Cancel on the "Delete read chapters" confirm left focus on <body>; Enter on the admin group
  // button opened a sheet that neither took focus nor answered Escape. Both read `document.activeElement`
  // before they take focus and re-focus it in the cleanup; the sheet lands on the current tab's chip.
  // Reintroduce by dropping `opener?.focus()` from the Modal's cleanup: "the Modal does not return focus"
  // fails; by removing the sheet's keydown listener: "the sheet ignores Escape" fails.
  const modal = code(read('components/ConfirmDialog.tsx'));
  const effect = modal.slice(modal.indexOf('useEffect(() => {'), modal.indexOf('}, []);'));
  assert.match(effect, /const opener = document\.activeElement as HTMLElement \| null;/, 'the Modal does not remember what opened it');
  assert.match(effect, /return \(\) => \{ document\.removeEventListener\('keydown', onKey\); opener\?\.focus\(\); \};/, 'the Modal does not return focus');
  // `opener` is read BEFORE the first field takes focus, or it would remember the dialog's own ✕.
  assert.ok(effect.indexOf('const opener') < effect.indexOf('first?.focus()'), 'the opener is read after the dialog took focus');
  const nav = code(read('components/ConsoleNav.tsx'));
  const sheet = nav.slice(nav.indexOf('function GroupSheet<'));
  assert.ok(sheet.length > 0, 'no GroupSheet');
  assert.match(sheet, /const onKey = \(e: KeyboardEvent\) => \{ if \(e\.key === 'Escape'\) closeRef\.current\(\); \};\s*document\.addEventListener\('keydown', onKey\);/, 'the sheet ignores Escape');
  assert.match(sheet, /querySelector<HTMLElement>\('button\.chip-active'\) \?\? ref\.current\?\.querySelector<HTMLElement>\('button\.chip'\);\s*first\?\.focus\(\);/, 'the sheet does not move focus onto a chip');
  assert.match(sheet, /return \(\) => \{ document\.removeEventListener\('keydown', onKey\); opener\?\.focus\(\); \};/, 'the sheet does not return focus to the group button');
  assert.match(sheet, /<div ref=\{ref\} className="glass[^"]*"\s*role="dialog" aria-modal="true"/, 'the ref is not on the dialog panel');
});

test('the phone pill row marks the current tab, and the rail chevrons mirror under RTL', () => {
  // On a phone the pill row is the only tab navigation; the fill alone says nothing to a screen reader
  // (the desktop rail already set aria-current). And the Admin/Support rows on the desktop rail, plus the
  // You tab's "See all", kept a right-pointing chevron in Arabic while every LinkRow mirrored its own.
  // Reintroduce by dropping `aria-current` from the pill: "the active pill is not announced" fails; by
  // dropping `rtl:-scale-x-100` from `chev`: "the rail chevron does not mirror" fails.
  const nav = code(read('components/ConsoleNav.tsx'));
  const pills = nav.slice(nav.indexOf('{group.tabs.map((t) => ('), nav.indexOf('{footer && flat &&'));
  assert.ok(pills.length > 0, 'the phone pill row is not where this test looks');
  assert.match(pills, /<button key=\{t\} onClick=\{\(\) => onTab\(t\)\}\s*aria-current=\{tab === t \? 'page' : undefined\}/, 'the active pill is not announced');
  const profile = code(read('app/profile/page.tsx'));
  assert.match(profile, /const chev = 'ms-auto hidden shrink-0 opacity-60 lg:block rtl:-scale-x-100';/, 'the rail chevron does not mirror');
  const you = code(read('components/ProfileYou.tsx'));
  assert.match(you, /\{tr\('See all'\)\}<IcChevronRight width=\{14\} height=\{14\} aria-hidden className="rtl:-scale-x-100" \/>/, 'the See all chevron does not mirror');
});

test('whether 2FA is on is read from the auth context, and the header button announces its box', () => {
  // A local copy seeded from `user.totpEnabled` at mount was re-seeded from the stale context on every
  // remount (Settings and back, a language change): after enabling, the section offered Set up 2FA again
  // beside the recovery codes it had just shown, and POST /auth/totp/setup rotates a live secret (R2).
  // Enable and disable now write the truth back through `setTotpEnabled` (lib/auth.tsx) and the section
  // derives from the context. The one DOM button in three states says expanded/collapsed on all three
  // and names the box (R1): a static `false` that vanished once pressed read "collapsed" forever.
  // Reintroduce by `const [totpOn, setTotpOn] = useState(!!user?.totpEnabled)`: "2FA is copied into local
  // state" fails; by dropping `setTotpEnabled(true)` from enableTotp: "enabling does not tell the auth
  // context" fails; by `aria-expanded={false}` on Set up 2FA: "a header button lies about its box" fails.
  const src = code(read('components/ProfileAccount.tsx'));
  const section = src.slice(src.indexOf('function TwoFactorSection('), src.indexOf('/* ============================== Active sessions'));
  assert.ok(section.length > 0, 'no TwoFactorSection');
  assert.match(section, /const \{ user, setTotpEnabled \} = useAuth\(\);/, 'the section does not take setTotpEnabled from useAuth');
  assert.doesNotMatch(section, /useState\([^)]*totpEnabled/, '2FA is copied into local state');
  assert.match(section, /const totpOn = !!user\?\.totpEnabled;/, '2FA is not derived from the context');
  assert.match(section, /setSetup\(null\); setCode\(''\); setTotpEnabled\(true\);/, 'enabling does not tell the auth context');
  assert.match(section, /setDisabling\(false\); setTotpEnabled\(false\); setRecovery\(null\);/, 'disabling does not tell the auth context');
  assert.equal((section.match(/aria-expanded=\{open\} aria-controls=\{boxId\}/g) ?? []).length, 3, 'a header button lies about its box');
  assert.doesNotMatch(section, /aria-expanded=\{false\}/, 'a static aria-expanded is back');
  assert.equal((section.match(/<form id=\{boxId\}/g) ?? []).length, 2, 'the setup and disable forms do not carry the announced id');
  // The context side: declared on AuthCtx and handed out by the provider, so a remount reads the truth.
  const auth = code(read('lib/auth.tsx'));
  assert.match(auth, /setTotpEnabled: \(v: boolean\) => void;/, 'AuthCtx does not declare setTotpEnabled');
  assert.match(auth, /<Ctx\.Provider value=\{\{[^}]*\bsetTotpEnabled\b/, 'the provider does not hand out setTotpEnabled');
});

// ---- fixer X1 (review R1/R2): the primitives at 390 px, untouched rows, the profile's Settings tab, Admin → Settings ----

test('a row never grows wider than its card at 390 px', () => {
  // R1's blocker: pills + the 56 px status span + their gap came to more than the 324 px row in six of eight
  // languages, and three things let that leave the card -- the control block was `shrink-0` and could not
  // wrap, the pill group was an `inline-flex` that could not wrap, and the `<section>` (a grid item, whose
  // minimum width is its content's) widened its column to fit. In ja and fr the page scrolled sideways while
  // idle; in de the "✓ Gespeichert" ran through the card's edge for the 1.5 s it showed. Now the status drops
  // under the pills (end-aligned), the pills wrap inside their border, and the card holds its width.
  // Reintroduce by putting `shrink-0` back on the control block: "the control block cannot wrap" fails; by
  // dropping `min-w-0` from the section: "the section lets its content widen the grid column" fails.
  const src = code(read('components/settings.tsx'));
  const row = slice(src, 'export function Row(', 'export function SwitchRow(');
  const control = /<div className="([^"]*)">\s*\{children\}\s*<SaveState status=\{status \?\? IDLE\} \/>/.exec(row);
  assert.ok(control, 'the inline Row has no control block holding children + SaveState');
  assert.doesNotMatch(control[1], /\bshrink-0\b/, 'the control block cannot wrap');
  for (const cls of ['ms-auto', 'max-w-full', 'flex-wrap', 'justify-end']) assert.match(control[1], new RegExp(`\\b${cls}\\b`), `the control block lost ${cls}`);
  assert.match(row, /className="min-w-0 flex-1 basis-32"/, 'the label block is not basis-32 (basis-48 wrapped Mode and Theme under a one-word label at 1280)');
  const seg = slice(src, 'export function Segmented<', 'export function TextRow(');
  const root = /<div role="radiogroup" aria-label=\{label\}\s*className=\{`([^`]*)`\}/.exec(seg);
  assert.ok(root, 'the Segmented root is not where this test looks');
  assert.match(root[1], /\bmax-w-full\b/, 'the pill group can be wider than its row');
  assert.match(root[1], /\bflex-wrap\b/, 'the pill group cannot wrap');
  const section = slice(src, 'export function Section(', 'export function Row(');
  assert.match(section, /<section [^>]*className=\{`card grad-border min-w-0 p-4/, 'the section lets its content widen the grid column');
  // The status span keeps its cap, or a long error sentence would become the widest line in the block.
  const state = slice(src, 'export function SaveState(', 'export function useAutosave(');
  assert.match(state, /min-w-14 max-w-56 truncate text-end/, 'SaveState lost its width cap');
});

test('an untouched number row never saves, and an emptied required text row goes back to the saved value', () => {
  // R1: with weeklyGoal 0 (no goal) the Custom box (min 1) showed 0, and a plain focus + Tab clamped it to 1
  // and PUT {weeklyGoal: 1} -- the clamp ran first and the CLAMPED value was compared with the last one. The
  // "did anything get typed" check now sits before the clamp. R2: an emptied Server name was sent and refused
  // with a bare 400 the row could only call "Could not save"; `required` reverts it like NumberRow's empty.
  // Reintroduce by moving `if (parsed === last.current)` below the `const n = Math.min(` line: "NumberRow
  // clamps before it asks whether anything was typed" fails; by dropping `required` from the Server name
  // row: "the Server name can be saved empty" fails.
  const src = code(read('components/settings.tsx'));
  const num = slice(src, 'export function NumberRow(', 'export function RangeRow(');
  const same = num.indexOf('if (parsed === last.current) { setDraft(String(last.current)); return; }');
  const clamp = num.indexOf('const n = Math.min(max, Math.max(min, Math.floor(parsed)));');
  assert.ok(same !== -1, 'NumberRow has no "nothing typed" check');
  assert.ok(clamp !== -1, 'NumberRow no longer clamps');
  assert.ok(same < clamp, 'NumberRow clamps before it asks whether anything was typed');
  const text = slice(src, 'export function TextRow(', 'export function NumberRow(');
  assert.match(text, /if \(required && !next\) \{ setDraft\(last\.current\); return; \}/, 'TextRow has no required → revert rule');
  assert.match(text, /required=\{required\}/, 'the input does not carry required');
  assert.match(code(read('components/AdminSettings.tsx')), /<TextRow label=\{tr\('Server name'\)\}[^\n]*\brequired\b/, 'the Server name can be saved empty');
});

test('the disclosure trigger is a real tap target', () => {
  // A bare `text-xs` button with no vertical padding was a 16 px target on a phone (every other control on
  // the tab is ≥ 24). `py-1.5` makes it 28 px; `mt-0.5` and `-mb-1.5` put the text back where `mt-2` had it.
  // Reintroduce by dropping `py-1.5`.
  const src = code(read('components/settings.tsx'));
  const disc = src.slice(src.indexOf('export function Disclosure('));
  assert.match(disc, /<button type="button" aria-expanded=\{isOpen\} aria-controls=\{cid\} onClick=\{toggle\}\s*className="[^"]*\bpy-1\.5\b/, 'the disclosure button has no vertical padding');
  assert.match(disc, /className="mt-0\.5 -mb-1\.5 flex items-center gap-1 py-1\.5 text-xs/, 'the disclosure button is not padded with its rhythm kept');
});

test('the avatar dots keep the focus ring, and a refused avatar or accent is put back', () => {
  // R1: an inline `outline: none` on the seven unchosen dots killed the browser's focus ring on the first
  // eight tab stops of the Settings tab. The chosen dot is marked with a ring class instead and `outline` is
  // left alone. R2: Accent and Avatar were optimistic but not reverted, so a refused colour stayed pressed
  // and applied (--accent changed) beside "Could not save" until a reload; the switches on the same tab
  // already reverted. Reintroduce by `style={{ background: c, outline: 'none' }}`: "a dot sets outline
  // inline" fails; by dropping `if (!ok) setAvatar(av);`: "a refused avatar stays" fails.
  const src = code(read('components/ProfileSettings.tsx'));
  assert.doesNotMatch(src, /outline:/, 'a dot sets outline inline');
  assert.match(src, /aria-pressed=\{av\.color === c\}\s*className=\{`h-7 w-7 rounded-full \$\{av\.color === c \? 'ring-2 ring-white ring-offset-2 ring-offset-ink-850' : ''\}`\}/, 'the chosen dot is not marked with a ring');
  assert.match(src, /const ok = await avatarSave\.run\(\(\) => api\('\/api\/settings', \{ method: 'PUT', json: \{ avatar: merged \} \}\)\);\s*if \(!ok\) setAvatar\(av\);/, 'a refused avatar stays');
  assert.match(src, /const prev = accent;[\s\S]{0,400}?\.then\(\(ok\) => \{ if \(!ok\) \{ setAccent\(prev\); setSettings\(\{ accent: prev \}\); \} \}\);/, 'a refused accent stays applied');
});

test('the push switch keeps focus and its refusal reaches the row', () => {
  // R1: the New-chapter alerts switch was `disabled` while busy, and Chrome blurs a focused control that
  // becomes disabled, so every toggle dropped focus to <body>; and its denied-permission sentence was thrown
  // as a plain Error, which `msgOf` (it reads `e.body`) cannot see, so the row said "Could not save". Flips
  // are queued behind a ref instead of disabling, and the throw is an ApiError carrying `{ message }`.
  // Reintroduce by `disabled={!supported || busy}`: "the switch is disabled while busy" fails; by
  // `throw new Error(tr('The browser did not grant it.'))`: "the refusal is not in the shape msgOf reads" fails.
  const src = code(read('components/ProfileSettings.tsx'));
  const device = src.slice(src.indexOf('function DeviceSection('));
  assert.ok(device.length > 0, 'no DeviceSection');
  assert.match(device, /label=\{tr\('New-chapter alerts'\)\}[\s\S]{0,300}?disabled=\{!supported\} onChange=\{toggle\}/, 'the switch is disabled while busy');
  assert.doesNotMatch(device, /useState\(false\);\s*[^\n]*busy|\bsetBusy\b/, 'a busy flag is back');
  assert.match(device, /throw new ApiError\(0, JSON\.stringify\(\{ message: tr\('The browser did not grant it\.'\) \}\)\)/, 'the refusal is not in the shape msgOf reads');
  assert.doesNotMatch(device, /throw new Error\(/, 'a plain Error is thrown at the row');
  assert.match(device, /const queue = useRef<Promise<unknown>>\(Promise\.resolve\(\)\);/, 'flips are not serialised through a ref');
  assert.match(device, /queue\.current = job\.catch\(\(\) => \{\}\);/, 'a failed flip would block every later one');
  assert.match(src, /import \{ api, ApiError \} from '@\/lib\/api';/, 'ApiError is not imported');
});

test('Admin → Settings notes are readable and its group inputs are named', () => {
  // R1: the two housekeeping notes were `text-fog-600`, 2.6:1 on the card (AA is 4.5:1); the "Add a group…"
  // inputs had only a placeholder for a name (the heading above is a <p>), so the two read as identical; the
  // Known groups eyebrow was 10 px. fog-600 stays for the decorative count on a suggestion chip only.
  // Reintroduce by `text-fog-600` on a housekeeping note: "a housekeeping note is below AA" fails; by
  // dropping `aria-label={label}` from the input: "the group input has no accessible name" fails.
  const src = code(read('components/AdminSettings.tsx'));
  const house = src.slice(src.indexOf('function HousekeepingSection('), src.indexOf('const NO_PREFS'));
  assert.ok(house.length > 0, 'no HousekeepingSection');
  assert.doesNotMatch(house, /text-fog-600/, 'a housekeeping note is below AA');
  assert.match(house, /text-\[11px\] leading-relaxed text-fog-400">\s*\{cur === 0/, 'the line that says what the number means is not fog-400');
  assert.match(house, /<p className="mt-1 max-w-prose text-\[11px\] leading-relaxed text-fog-500">\s*\{tr\('Only chapters Uchiyomi downloaded itself/, 'the line that says what is spared is not fog-500');
  const chips = src.slice(src.indexOf('function GroupChips('), src.indexOf('function ScanlatorsSection('));
  assert.ok(chips.length > 0, 'no GroupChips');
  assert.match(chips, /<input\s*value=\{draft\}\s*aria-label=\{label\}/, 'the group input has no accessible name');
  assert.doesNotMatch(src, /text-\[10px\]/, 'text under 11 px is back on Admin → Settings');
  assert.match(chips, /text-\[11px\] font-semibold uppercase tracking-wider text-fog-500">\{tr\('Known groups'\)\}/, 'the Known groups eyebrow is not 11 px fog-500');
  assert.equal((src.match(/text-fog-600/g) ?? []).length, 1, 'fog-600 is used for more than the one decorative count');
});
