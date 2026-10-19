// The v0.39.0 settings consoles: the profile's four tabs (You · Settings · Connections · Account) and the admin
// Settings tab, both composed from `components/settings.tsx`.
//
// Read from source, like library.test.ts: whether a text field saves on blur rather than on every keystroke,
// whether the grid ever caps the page, whether /admin keeps its tab in the URL, whether the sources are one tab
// (v0.54.0; Providers once embedded the whole Extensions card) -- each a thing that was wrong or inconsistent before
// its release, and each invisible to a type check. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
// Pure, so they are called rather than pinned (the address tests below).
import { readPage, withPage } from '../lib/settingsIndex';
import { ADMIN_SETTINGS } from '../lib/settingsIndex.admin';
import { PROFILE_SETTINGS } from '../lib/settingsIndex.profile';

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
  // A share of a row (`max-w-[45%]`, a summary row's value) is no page cap: it shrinks with the row.
  assert.doesNotMatch(src, /max-w-(?:xs|sm|lg|xl|\dxl|screen|\[(?!\d+%\]))/, 'a cap wider than max-w-prose/max-w-md somewhere in settings.tsx');
  // v0.88.0: the console holds every page of Profile and Admin, and answers width with columns too (layout.mjs measures
  // it). Reintroduce by `max-w-5xl` on the pane: "the console caps the page" fails.
  assert.doesNotMatch(code(read('components/ConsoleLayout.tsx')), /max-w-(?:xs|sm|md|lg|xl|\dxl|screen|\[)/, 'the console caps the page');
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
  assert.match(src, /const setReader = \(p: Partial<ReaderPrefs>\) => \{ const n = \{ \.\.\.prefs, \.\.\.p \}; setPrefs\(n\); savePrefs\(n\); \};/, 'a reader default is not written local-first through savePrefs');
  assert.match(src, /const \[prefs, setPrefs\] = useState\(loadPrefs\);/, 'the defaults do not start from the local store');
  // The server copy is adopted once it answers, and never after the section is gone.
  assert.match(src, /syncPrefsFromServer\(\)\.then\(\(p\) => \{ if \(live\) setPrefs\(p\); \}\);/, 'the server copy is not adopted, or is adopted after unmount');
  // The goal is the stats query's number, so a change must refetch the stats or the hero pill lies. Since v0.86.0 the
  // goal lives in the hero alone (the owner's yes to cut A): its dialog saves it there.
  const page = code(read('app/profile/page.tsx'));
  assert.match(page, /json: \{ weeklyGoal: n \}/, 'the weekly goal does not PUT {weeklyGoal}');
  assert.match(page, /qc\.invalidateQueries\(\{ queryKey: \['stats'\] \}\)/, 'saving the goal does not refetch the stats');
  assert.doesNotMatch(src, /weeklyGoal/, 'the weekly goal is back in Settings, a third place to set it');
  // Smart downloads keep the body the server already takes.
  assert.match(src, /json: \{ smartOffline: next \}/, 'Keep favorites offline no longer PUTs {smartOffline}');
});

test('the language menu stays locked while a once-only secret is on screen', () => {
  // I18nProvider remounts its whole subtree on a language change (`<div key={lang}>`), and three values are
  // shown exactly once and never again: the OPDS password, a fresh API token, the 2FA recovery codes. They
  // live on OTHER tabs now, so the Language row cannot see them in React state; it asks lib/shownOnce.ts at
  // render time instead, which any tab switch re-runs. Reintroduce by dropping `disabled={locked}` from the
  // menu (chips until v0.86.0): "the menu is not locked" fails; or by holding `locked` in a `useState` read once: "the lock is
  // not read at render time" fails, because a token minted after the Settings tab first rendered would not
  // lock it.
  const src = code(read('components/ProfileSettings.tsx'));
  assert.match(src, /const locked = !!readShownOnce\('opds\.link'\) \|\| !!readShownOnce\('apiToken\.fresh'\) \|\| !!readShownOnce\('totp\.recovery'\);/, 'the lock is not read at render time, or misses one of the three secrets');
  assert.match(src, /<SelectRow<Locale> label=\{tr\('Language'\)\} value=\{lang\} disabled=\{locked\}/, 'the menu is not locked');
  assert.match(src, /onChange=\{\(code\) => setLang\(code\)\}/, 'the menu does not set the language');
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
    // v0.43.0 (#70): Admin → Settings → Notifications is a console section of its own file, with 74 strings.
    'components/AdminNotifications.tsx',
    // v0.49.0 (#117): Admin → Settings → Downloads, the slow archive's knobs.
    'components/ArchiveSettings.tsx',
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
  // The page is drawn only while it is the one on screen (components/ConsoleLayout.tsx), so the flag needs no tab check.
  assert.match(code(read('app/profile/page.tsx')), /<ProfileConnections focusTracking=\{focusTracking\} \/>/, 'the page does not hand Connections its focus');
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

test('/admin and /profile take their page from ?tab= on every render, and write it without Next\'s history state', () => {
  // v0.88.0: one list each (components/ConsoleLayout.tsx). The page is the address's on every render -- Back, a refresh,
  // a language change (which remounts everything, lib/I18nProvider.tsx) and a saved link all land on it -- read through
  // the registry's readPage, which knows the tab names from before too. A wide console REPLACES the address on a click
  // (clicking down a rail is not a trail anyone wants to walk back through); a narrow one PUSHES the page, so a phone's
  // own Back returns to the list. ⚠️ Never with `window.history.state` as the first argument: it carries Next's marker,
  // and Next then leaves its router -- and useSearchParams, which the page is read from -- where it was. Reintroduce by
  // `pushState(window.history.state, …)`: "the console hands Next its own history state" fails; by reading the page in a
  // lazy `useState`: "the page is read once" fails.
  for (const f of ['app/admin/page.tsx', 'app/profile/page.tsx']) {
    assert.match(code(read(f)), /<Suspense fallback=\{<div className="min-h-screen-d" \/>\}>/, `${f} has no Suspense boundary for useSearchParams`);
  }
  const layout = code(read('components/ConsoleLayout.tsx'));
  assert.match(layout, /const fromUrl = readPage\(index, params\.get\('tab'\), params\.get\('cat'\), ids\);/, 'the page is not read from the address');
  assert.doesNotMatch(layout, /useState[^;\n]*readPage\(index, params/, 'the page is read once');
  assert.match(layout, /window\.history\.replaceState\(null, '', withPage\(window\.location\.href, id\)\);/, 'a wide console does not replace the address');
  assert.match(layout, /window\.history\.pushState\(\{ consolePage: id \}, '', withPage\(window\.location\.href, id\)\);/, 'a narrow console does not push the page');
  assert.doesNotMatch(layout, /(?:pushState|replaceState)\(window\.history\.state/, 'the console hands Next its own history state');
  assert.doesNotMatch(layout, /router\.(?:push|replace)\(/, 'a page change is a route navigation');
  // The pure half, called rather than pinned: every other parameter kept (the import page's card=tracking), v0.86.0's
  // `cat` dropped with the old tab, and no page for the list.
  assert.equal(withPage('http://x/profile/?tab=Connections&card=tracking', 'connections'), '/profile/?card=tracking&tab=connections', 'withPage loses card=');
  assert.equal(withPage('http://x/admin/?tab=Settings&cat=downloads', 'downloads'), '/admin/?tab=downloads', 'withPage keeps the old cat=');
  assert.equal(withPage('http://x/admin/?tab=health#repairs', null), '/admin/#repairs', 'the list keeps a page in the address');
});

test('the profile is one list -- You, Insights and its Settings group -- with no leftover cards', () => {
  // v0.88.0: You · Insights, then Settings: General · Appearance · Reading · This device · Connections · Account (the
  // owner: Connections "is not under anything"). The page keeps the person's card, the You page and its board; every
  // setting lives in its page's component. Reintroduce by moving Connections out of the group: "the profile's list
  // changed" fails; by importing `SecurityPanel` on the page: "a retired card is back on the page" fails.
  assert.deepEqual(PROFILE_SETTINGS.categories.map((c) => `${c.group ?? ''}/${c.id}`),
    ['/you', '/insights', 'Settings/general', 'Settings/appearance', 'Settings/reading', 'Settings/device', 'Settings/connections', 'Settings/account'],
    'the profile\'s list changed');
  const src = code(read('app/profile/page.tsx'));
  assert.doesNotMatch(src, /AdminCard|SignOutCard|SettingsCard|SecurityPanel/, 'a retired card is back on the page');
  // The two files behind the Manage layer are gone, not merely unimported: a file nobody imports still compiles, still
  // ships in the repo and still tempts the next builder to "reuse" its three identical chips. Reintroduce by restoring
  // the file: "SettingsCard.tsx is back" fails.
  assert.equal(existsSync(join(ROOT, 'components/SettingsCard.tsx')), false, 'SettingsCard.tsx is back');
  assert.equal(existsSync(join(ROOT, 'components/SecurityPanel.tsx')), false, 'SecurityPanel.tsx is back');
  // The settings pages are ProfileSettings', Connections and Account their own components; only You is a board of cards.
  assert.match(src, /const settings = useProfileSettingsViews\(\);/, 'the settings pages are not ProfileSettings\'');
  assert.match(src, /<ProfileConnections focusTracking=\{focusTracking\} \/>/, 'Connections is not ProfileConnections');
  assert.match(src, /<ProfileAccount \/>/, 'Account is not ProfileAccount');
  assert.equal((src.match(/className="board"/g) || []).length, 1, 'the .board wrapper is not the You page alone');
  // The list is labelled for the whole page, not with the first page's name ("You › You" to a screen reader).
  assert.match(src, /<ConsoleLayout index=\{PROFILE_SETTINGS\} label=\{tr\('Profile'\)\}/, 'the list is not labelled Profile');
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

test('the sources are ONE page, mounting one panel, where Providers and Extensions were two', () => {
  // v0.53.0 rendered `<Extensions span="full" />` on its own tab with a door to it in Providers; the owner: "why do we
  // have 2 when they are basically the same". Since v0.54.0 Sources is one page, mounting components/SourcesPanel.tsx
  // once; the catalogue is part of it (Add sources), mounted there once. Reintroduce a Providers or Extensions page:
  // "the Library group has more than its three pages" fails; mount the old panel: the count fails.
  assert.deepEqual(ADMIN_SETTINGS.categories.filter((c) => c.group === 'Library').map((c) => c.id), ['library', 'sources', 'art'],
    'the Library group has more than its three pages');
  const src = code(read('app/admin/page.tsx'));
  assert.doesNotMatch(src, /function (Providers|ExtensionsLink|Extensions)\(/, 'the old Providers, its door or the Extensions card is back in the admin page');
  assert.match(src, /summary: tr\('Sites and extensions'\), pane: <SourcesPanel \/> \}/, 'the Sources page does not mount the panel');
  assert.equal((src.match(/<SourcesPanel\b/g) ?? []).length, 1, 'the Sources panel is mounted from more than one place');
  assert.doesNotMatch(src, /<ExtensionsPanel\b|ExtensionsPanel'/, 'the old Extensions panel is mounted again');
  const sources = code(read('components/SourcesPanel.tsx'));
  assert.equal((sources.match(/<BrowseView\b/g) ?? []).length, 1, 'the catalogue is mounted from more than one place');
  // v0.88.0: the Overview's tiles to Tasks, Sessions, Sources and Activity were a second menu inside the first; the list
  // is the way to each. Reintroduce a tile: "the Overview leads to pages again" fails.
  assert.doesNotMatch(src, /function TabTile\(|onTab\(/, 'the Overview leads to pages again');
});

test('the old tab names land on their pages: Providers and Extensions on Sources, Tasks on Maintenance, Settings on its first page', () => {
  // Bookmarks, the docs, Health's links and the add dialog's "Turn on more MangaDex languages" said `?tab=Providers` or
  // `?tab=Extensions` until v0.54.0; until v0.88.0 Admin had a Tasks tab and both consoles a Settings tab, its page in
  // `?cat=`. Reintroduce readPage without the registry's tabAliases: an old address lands on the first page, and these
  // fail.
  const ids = ADMIN_SETTINGS.categories.map((c) => c.id);
  const at = (tab: string | null, cat: string | null = null) => readPage(ADMIN_SETTINGS, tab, cat, ids);
  assert.equal(at('Providers'), 'sources', '?tab=Providers lands somewhere else');
  assert.equal(at('Extensions'), 'sources', '?tab=Extensions lands somewhere else');
  assert.equal(at('Tasks'), 'maintenance', '?tab=Tasks lands somewhere else');
  assert.equal(at('Settings'), 'server', '?tab=Settings does not open the first settings page');
  assert.equal(at('Settings', 'downloads'), 'downloads', '?tab=Settings&cat=downloads loses its page');
  assert.equal(at('Settings', 'members'), 'members', 'a cat= naming another page is not read');
  assert.equal(at('Health'), 'health', 'the old capitalised names are not read');
  assert.equal(at('sources'), 'sources');
  // Not a way in for anything else: an unknown name, one of Object's own, or a page this console does not draw.
  assert.equal(at('Bogus'), null);
  assert.equal(at('constructor'), null, 'a name Object has lands on its function');
  assert.equal(at('toString'), null);
  assert.equal(at(null), null);
  assert.equal(readPage(ADMIN_SETTINGS, 'Members', null, ids.filter((id) => id !== 'members')), null, 'a page Desktop does not draw opens');
  // The profile's Settings tab opens General, and its old cat= the page it named.
  const pids = PROFILE_SETTINGS.categories.map((c) => c.id);
  assert.equal(readPage(PROFILE_SETTINGS, 'Settings', null, pids), 'general');
  assert.equal(readPage(PROFILE_SETTINGS, 'Settings', 'reading', pids), 'reading');
  assert.equal(readPage(PROFILE_SETTINGS, 'Connections', null, pids), 'connections');
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
  // Server is the first of the settings pages (the old `?tab=Settings` opens it, readPage), and run.mjs reads the
  // payload from the first 4000 characters of its body text. Reintroduce by moving Downloads first in the registry:
  // "Server is not the first settings page" fails.
  assert.equal(ADMIN_SETTINGS.categories.find((c) => c.settings)?.id, 'server', 'Server is not the first settings page');
  assert.match(src, /server: \{[^\n]*\n\s*pane: ready\(data && <ServerSection data=\{data\} save=\{save\} \/>, 'server'\) \}/, 'Server does not draw ServerSection');
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
  assert.match(opds, /<button ref=\{actionRef\} type="button" onClick=\{gen\} disabled=\{busy\} className="btn-key">/, 'the OPDS action is not the ref-carrying key (an accent button wrapped the German title to three lines at 390)');
  assert.match(opds, /<button ref=\{doneRef\} type="button" onClick=\{done\} className="btn-key">\{tr\('Done'\)\}<\/button>/, 'the OPDS Done is not the ref-carrying key');
  // Tokens: Create → Done, Done → New token, Revoke → New token; the form's Cancel forgets the scopes.
  const tokens = src.slice(src.indexOf('function TokensSection('));
  assert.match(tokens, /after\(doneRef\); setFresh\(r\.token\);/, 'Create does not send focus to Done');
  assert.match(tokens, /const done = \(\) => \{ after\(actionRef\); setFresh\(null\); \};/, 'token Done does not send focus back to New token');
  assert.match(tokens, /await api\(`\/api\/tokens\/\$\{id\}`, \{ method: 'DELETE' \}\); after\(actionRef\);/, 'token Revoke does not send focus to New token');
  assert.match(tokens, /<button ref=\{actionRef\} type="button" onClick=\{\(\) => \(open \? cancel\(\) : setOpen\(true\)\)\}/, 'New token does not carry the action ref');
  assert.match(tokens, /<button ref=\{doneRef\} type="button" onClick=\{done\} className="btn-key mt-2">\{tr\('Done'\)\}<\/button>/, 'the token Done is not the ref-carrying key');
  // R2: a scope ticked for an abandoned token carried over to the next one. The mint's own reset line is
  // pinned by forgetSeries.test.ts and stays as it is; Cancel resets the same three.
  assert.match(tokens, /const cancel = \(\) => \{ setOpen\(false\); setName\(''\); setWrite\(false\); setAdmin\(false\); setAdult\(false\); \};/, 'Cancel keeps the scopes ticked for the next token');
  // R1 contrast: the one security fact on the tracker form was fog-600 (2.6:1 on the card).
  assert.match(src, /text-fog-500">\s*\{tr\('The token carries access to your \{name\} account and cannot be scoped\./, 'the token-scope sentence is below AA again');
  assert.doesNotMatch(src, /text-fog-600">\s*\{tr\('The token carries access/, 'the token-scope sentence is fog-600');
});

test('a dialog gives focus back to what opened it, and a phone\'s page gives it back to its row', () => {
  // Escape or Cancel on the "Delete read chapters" confirm left focus on <body>. The Modal reads `document.activeElement`
  // before it takes focus and re-focuses it in the cleanup. v0.88.0: on a phone a row opens its page with the focus on
  // the page's title, and Back -- the page's key or the phone's own -- puts it on the row again, scrolled into view
  // (components/ConsoleLayout.tsx). Reintroduce by dropping `opener?.focus()` from the Modal's cleanup: "the Modal does
  // not return focus" fails; by dropping the row's focus from the return: "Back drops the focus" fails.
  const modal = code(read('components/ConfirmDialog.tsx'));
  const effect = modal.slice(modal.indexOf('useEffect(() => {'), modal.indexOf('}, []);'));
  assert.match(effect, /const opener = document\.activeElement as HTMLElement \| null;/, 'the Modal does not remember what opened it');
  assert.match(effect, /return \(\) => \{ document\.removeEventListener\('keydown', onKey\); opener\?\.focus\(\); \};/, 'the Modal does not return focus');
  // `opener` is read BEFORE the first field takes focus, or it would remember the dialog's own ✕.
  assert.ok(effect.indexOf('const opener') < effect.indexOf('first?.focus()'), 'the opener is read after the dialog took focus');
  const layout = code(read('components/ConsoleLayout.tsx'));
  // Once the screen has changed (the address first, the page after it): into a page its title takes the focus; Back --
  // the key or the phone's own -- returns it to the row the page was opened from, in view. A focus moved in `open`
  // itself landed on the page before, already hidden (con-flow found it).
  const moves = layout.slice(layout.indexOf('const was = useRef(page);'), layout.indexOf('const go = (e: SettingsEntry) => {'));
  assert.match(moves, /if \(wide \|\| from === page\) return;/, 'the focus moves on a computer, or on no change');
  assert.match(moves, /if \(page\) \{\s*heading\.current\?\.focus\(\{ preventScroll: true \}\);/, 'a phone\'s page does not take the focus');
  assert.match(moves, /row\?\.scrollIntoView\(\{ block: 'center' \}\);\s*row\?\.focus\(\{ preventScroll: true \}\);/, 'Back drops the focus, or leaves its row off screen');
  assert.match(moves, /\}, \[page\]\);/, 'the focus does not follow the page');
  assert.doesNotMatch(layout.slice(layout.indexOf('const open = (id: string) => {'), layout.indexOf('const back = () => {')), /focus\(/, 'the focus moves before the page is drawn');
  assert.match(layout, /<h2 ref=\{heading\} id=\{`console-\$\{shownPage\.id\}-title`\} tabIndex=\{-1\}/, 'the page\'s title cannot take the focus');
});

test('the list marks the page on screen, its rows are rows and not pills, and every chevron mirrors', () => {
  // v0.88.0: the list beside the page says which one is on screen, to a screen reader as well as by its colour; on a
  // phone, where the list is a screen of its own, no row is current. Admin, Support and Sign out are rows at the foot,
  // in a card of their own. And the You page's "See all" kept a right-pointing chevron in Arabic while every LinkRow
  // mirrored its own. Reintroduce by dropping `aria-current`: "the page on screen is not announced" fails; by dropping
  // `rtl:-scale-x-100` from See all: "the See all chevron does not mirror" fails.
  const layout = code(read('components/ConsoleLayout.tsx'));
  // Both kinds of entry -- the profile's picture tiles and the rows -- say it.
  assert.equal((layout.match(/aria-current=\{on && wide \? 'page' : undefined\}/g) ?? []).length, 2, 'the page on screen is not announced, as a tile or as a row');
  assert.doesNotMatch(layout, /rounded-full/, 'the list\'s rows are pills');
  for (const m of layout.matchAll(/<IcChevron(?:Right|Left)[^>]*>/g)) assert.match(m[0], /rtl:-scale-x-100/, `a chevron does not mirror: ${m[0]}`);
  const profile = code(read('app/profile/page.tsx'));
  const foot = profile.slice(profile.indexOf('function FootRows('), profile.indexOf('function GoalModal('));
  assert.equal((foot.match(/<ConsoleFootRow\b/g) ?? []).length, 3, 'Admin, Support and Sign out are not the list\'s foot rows');
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
  // The SaveState is the row's own unless a SaveScope says it in one place for the surface (v0.53.0, Edit details).
  const control = /<div className="([^"]*)">\s*\{children\}\s*\{!scoped && <SaveState status=\{status \?\? IDLE\} \/>\}/.exec(row);
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
  // Sentence case since v0.86.0: no CSS capitals in the settings (they read as shouting in German and do nothing in Arabic).
  assert.match(chips, /text-\[11px\] font-semibold text-fog-500">\{tr\('Known groups'\)\}/, 'the Known groups heading is not 11 px fog-500');
  assert.doesNotMatch(src, /\buppercase\b/, 'a CSS-capitals eyebrow is back in Admin → Settings');
  assert.equal((src.match(/text-fog-600/g) ?? []).length, 1, 'fog-600 is used for more than the one decorative count');
});

test('Admin → Settings → Downloads → Slow archive is one row with its editor, and saves each knob the way the server takes it', () => {
  // #117. v0.86.0: one row in the Downloads category says whether it runs and opens the knobs. Its switch reads "on" for
  // a running archive, and the column is `archive_paused`; the window's two ends go together because the server refuses
  // one alone. Reintroduce `save({ archivePaused: next })`: "the switch pauses the archive when it is turned on" fails;
  // save one end alone: "one end of the window".
  const admin = code(read('components/AdminSettings.tsx'));
  const downloads = admin.slice(admin.indexOf('function SchedulesSection('), admin.indexOf('function MaintenanceSection('));
  assert.match(downloads, /<SlowArchiveRow data=\{data\} save=\{save\} \/>/, 'the slow archive is not a row of Downloads');
  const src = code(read('components/ArchiveSettings.tsx'));
  assert.match(src, /<SummaryRow id="slow-archive" ref=\{editor\.row\} label=\{tr\('Slow archive'\)\} onClick=\{editor\.show\}/, 'the row is not the slow archive\'s summary');
  assert.match(src, /<EditorSheet title=\{tr\('Slow archive'\)\} open=\{editor\.open\} onClose=\{editor\.close\}>/, 'the knobs are not in the row\'s editor');
  assert.match(src, /on=\{data\.archive_paused !== true\} onChange=\{\(next\) => save\(\{ archivePaused: !next \}\)\}/, 'the switch pauses the archive when it is turned on');
  assert.match(src, /min=\{ARCHIVE_PACE\.perHourRange\[0\]\} max=\{ARCHIVE_PACE\.perHourRange\[1\]\}/, 'the pace row is not held to the server\'s range');
  assert.match(src, /help=\{archivePaceHelp\(perHour\)\} onSave=\{\(n\) => save\(\{ archivePerHour: n \}\)\}/, 'the pace row does not say what it comes to');
  assert.match(src, /save\(\{ archiveWindowFrom: n, archiveWindowTo: to \}\)/, 'one end of the window is saved alone');
  assert.match(src, /save\(\{ archiveWindowFrom: from, archiveWindowTo: n \}\)/, 'one end of the window is saved alone');
  assert.match(src, /\{ archiveWindowFrom: null, archiveWindowTo: null \}/, 'the window is not cleared at both ends');
  assert.match(src, /onSave=\{\(n\) => save\(\{ archiveMinFreeGb: n \}\)\}/);
  // Its strings are in all eight languages (the console test above lists this file too).
  assert.ok(trKeys(['components/ArchiveSettings.tsx']).size >= 15, 'the scan found too few strings in the section');
  for (const f of localeFiles()) assert.deepEqual(missingIn(f, trKeys(['components/ArchiveSettings.tsx'])), [], `${f} lacks a slow archive string`);
});

test('every page the registries name has a view, and every view a page', () => {
  // v0.88.0: each console draws the registry's pages (lib/settingsIndex*.ts) from the views its page and its settings
  // component give it (components/ConsoleLayout.tsx). A view the registry does not name is never drawn, and a page with
  // no view is skipped: both would be something nobody can reach. Reintroduce by dropping `maintenance:` from the admin
  // settings' views: "a page has no view" fails.
  const keysOf = (file: string, from: string): string[] => {
    const src = code(read(file));
    const a = src.indexOf(from);
    assert.notEqual(a, -1, `${file}: ${from} is gone`);
    const body = src.slice(a, src.indexOf('\n  };', a));
    return [...body.matchAll(/^\s{4}(\w+): \{/gm)].map((m) => m[1]);
  };
  const admin = [...keysOf('app/admin/page.tsx', 'const views: Record<string, PageView> = {'),
    ...keysOf('components/AdminSettings.tsx', 'const views: Record<string, PageView> = {')];
  const profile = [...keysOf('app/profile/page.tsx', 'const views: Record<string, PageView> = {'),
    ...keysOf('components/ProfileSettings.tsx', 'const views: Record<string, PageView> = {')];
  for (const [index, drawn] of [[ADMIN_SETTINGS, admin], [PROFILE_SETTINGS, profile]] as const) {
    const named = index.categories.map((c) => c.id);
    for (const c of named) assert.ok(drawn.includes(c), `a page has no view: ${index.page} ${c}`);
    for (const v of drawn) assert.ok(named.includes(v), `a view no page names: ${index.page} ${v}`);
    assert.equal(new Set(drawn).size, drawn.length, `a page has two views: ${index.page}`);
  }
  assert.match(code(read('app/admin/page.tsx')), /\.\.\.settings\.views,/, 'the admin console leaves out its settings pages');
  assert.match(code(read('app/profile/page.tsx')), /\.\.\.settings\.views,/, 'the profile leaves out its settings pages');
});

test('the consoles open under their cinematic heroes: in full above the first page, a band above the rest, a phone\'s page under its own band', () => {
  // v0.88.0. A first cut of the one list put each hero in a small card in the list; the owner: "it was cinematic and
  // nicer before with a hero section". The hero is the console's, above the list and the page (components/ConsoleLayout.tsx):
  // in full above Overview and You and above a phone's list, a band above every other page on a computer, and not above
  // a page a phone opened -- that page opens under a band of the same art with its own title and Back key. The profile's
  // You and Insights lead its list as pictures. Reintroduce the hero above a phone's page (drop `narrowList` from its
  // wrapper): "the hero is drawn above a phone's page" fails; a full hero everywhere: "every page gets the full hero"
  // fails; a picture page among the rows too: "a tile is a row as well" fails; the band without the goal's pill:
  // "the band has no weekly goal" fails.
  const layout = code(read('components/ConsoleLayout.tsx'));
  assert.match(layout, /\{hero && <div className=\{narrowList\} data-console-hero=\{heroMode\}><HeroFrame reduced=\{reduced\}>\{hero\(heroMode\)\}<\/HeroFrame><\/div>\}/, 'the hero is drawn above a phone\'s page');
  // From full to band and back, its height is eased, never jumped: the list under it would leap from under the pointer.
  const frame = layout.slice(layout.indexOf('function HeroFrame('), layout.indexOf('function ConsoleSearch('));
  assert.match(frame, /transition: reduced \|\| height === null \? undefined : 'height 0\.45s /, 'the hero jumps between full and band');
  assert.match(frame, /className="overflow-y-clip"/, 'the frame clips the hero\'s bleed, or nothing');
  // Beside the page the list scrolls on its own only once it has stuck: with the hero in view a wheel over it scrolls the
  // page. Reintroduce `overflow-y-auto` for good: "the list takes the wheel while the hero is in view" fails.
  assert.match(layout, /\$\{stuck \? '@min-\[52\.5rem\]\/console:overflow-y-auto' : '@min-\[52\.5rem\]\/console:overflow-y-hidden'\}/, 'the list takes the wheel while the hero is in view');
  assert.match(layout, /data-lenis-prevent=\{stuck \? '' : undefined\}/, 'the list keeps Lenis off the page while the hero is in view');
  assert.doesNotMatch(layout, /overscroll-contain/, 'the stuck list never hands the wheel back to the page at its ends');
  assert.match(layout, /const heroMode = wide && shownPage\.id !== home \? 'band' : 'full';/, 'every page gets the full hero');
  assert.match(layout, /const tiles = pages\.filter\(\(c\) => views\[c\.id\]\?\.tile\);/, 'the pictures are not the pages that pass one');
  assert.match(layout, /for \(const c of pages\.filter\(\(p\) => !views\[p\.id\]\?\.tile\)\)/, 'a tile is a row as well');
  // A phone's page: the art layer (hidden beside the list), the Back key, one title.
  const header = layout.slice(layout.indexOf('<header data-console-header'), layout.indexOf('</header>'));
  assert.match(header, /<div aria-hidden className="absolute inset-0 -z-10 @min-\[52\.5rem\]\/console:hidden" data-console-header-art>\s*\{art\}/, 'a phone\'s page has no art over its title');
  assert.match(header, /data-console-back>/, 'a phone\'s page has no Back key');
  assert.equal((header.match(/<h2 /g) ?? []).length, 1, 'a page has two titles');
  // The two heroes, and the art each hands the phone's pages.
  const profile = code(read('app/profile/page.tsx'));
  assert.match(profile, /hero=\{\(mode\) => \(\s*<ProfileHero mode=\{mode\}/, 'the profile has no hero');
  assert.match(profile, /art=\{anchorId \? <Backdrop seriesId=\{anchorId\} hero className="absolute inset-0" \/> : null\}/, 'the profile\'s pages open under no art');
  const hero = profile.slice(profile.indexOf('function ProfileHero('), profile.indexOf('function CoverFan('));
  assert.equal((hero.match(/\{pills\}/g) ?? []).length, 2, 'the band has no weekly goal');
  assert.equal((hero.match(/id="weekly-goal"/g) ?? []).length, 2, 'the weekly goal\'s pill lost its id (search lands on it)');
  assert.match(profile, /tile: <CoverFan ids=\{shelf\.ids\} fallback=\{anchorId\} \/>/, 'You is not a picture of your covers');
  assert.match(profile, /tile: <ActivityBars days=\{stats\?\.byDay \?\? \[\]\} \/>/, 'Insights is not a picture of your weeks');
  const admin = code(read('app/admin/page.tsx'));
  assert.match(admin, /hero=\{\(mode\) => <AdminHero mode=\{mode\} onBack=\{\(\) => \(window\.history\.length > 1 \? router\.back\(\) : router\.push\('\/profile\/'\)\)\} \/>\}/, 'the admin console has no hero, or its Back leads nowhere when opened directly');
  assert.match(admin, /const compact = mode === 'band';/, 'the admin band is not the compact hero');
});
