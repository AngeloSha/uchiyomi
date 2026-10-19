// The profile photo opens quick settings (components/ProfileMenu.tsx) instead of navigating.
// Source-grep style, like the other component tests: the pieces that must not drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { arrival } from '../lib/destinations';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the avatar is a labelled popup button, and the header uses it', () => {
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.match(menu, /aria-label=\{tr\('You'\)\}/);
  assert.match(menu, /aria-haspopup="dialog"/);
  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(code(read('components/TopNav.tsx')), /<ProfileMenu active=/);
});

test('the popup closes on Escape, an outside press and tabbing out, hands focus back, scrolls with Lenis opted out', () => {
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.match(menu, /e\.key === 'Escape'/);
  assert.match(menu, /'pointerdown'/);
  assert.match(menu, /onBlur=/);
  assert.match(menu, /btn\.current\?\.focus/);
  assert.match(menu, /data-lenis-prevent/);
  assert.doesNotMatch(menu, /\b(?:left|right)-\d|\bm[lr]-\d|\bp[lr]-\d|text-(?:left|right)/, 'physical-direction classes break rtl');
});

test('it offers only switches Settings already has, from the same hooks', () => {
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.match(menu, /useIncognito\(\)/);
  assert.match(menu, /INCOGNITO_TEXT\[0\]/);
  assert.match(menu, /useReduceEffects\(\)/);
  assert.match(code(read('components/ProfileSettings.tsx')), /useReduceEffects\(\)/);
  assert.equal((menu.match(/<SwitchRow /g) ?? []).length, 2, 'Incognito and Reduce effects, plus the conditional Show 18+ row');
  // 18+ renders nothing for an account with no 18+ library or filter, as AdultToggle does.
  assert.match(menu, /showAdult && \(/);
  assert.match(menu, /\.some\(\(l\) => l\.adult\)/);
  assert.match(menu, /href="\/profile\/"/, 'the Profile route stays reachable');
  assert.match(menu, /\{tr\('Sign out'\)\}/);
  assert.match(menu, /!isDesktop\(\) && <button/, 'no Sign out on the desktop app');
});

test('the phone opens the same body in a sheet from Home\'s avatar', () => {
  const home = code(read('app/page.tsx'));
  assert.match(home, /<QuickSettingsSheet onClose=/);
  assert.match(home, /onClick=\{\(\) => setQuickOpen\(true\)\}/);
  assert.doesNotMatch(home, /<Link href="\/profile"[^>]*>\s*<Avatar/);
});

test('Profile and Profile settings arrive as the palette\'s destinations do', () => {
  // v0.88.0: the profile on screen opens its own pages in place (lib/consoleOnScreen.ts); from another page it is a push,
  // and the profile reads its page from the address as it mounts. Reintroduce `<Link href=…>` for either: the links lose
  // `go(…)` and this fails; drop `openInConsole` first: "the profile on screen is navigated away from" fails.
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.match(menu, /<a href="\/profile\/" onClick=\{go\('\/profile\/'\)\}/);
  assert.match(menu, /<a href="\/profile\/\?tab=general" onClick=\{go\('\/profile\/\?tab=general'\)\}/);
  assert.match(menu, /onClose\(\);\s*if \(openInConsole\(href\)\) return;\s*const how = arrival\(href, window\.location, \(\) => false\);\s*if \(how === 'push'\) router\.push\(href\);\s*else if \(how === 'load'\) window\.location\.assign\(href\);/,
    'the profile on screen is navigated away from');
  assert.match(menu, /if \(e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/, 'a new-tab click stays the browser\'s');
  // What arrival says when the profile is not on screen to open it in place: a push from another page, nothing where it
  // already is, and a whole load for another of its pages (the console may not be drawn yet to open it).
  const at = (pathname: string, search = '') => ({ pathname, search });
  assert.equal(arrival('/profile/?tab=general', at('/library/'), () => false), 'push');
  assert.equal(arrival('/profile/?tab=general', at('/profile/'), () => false), 'load', 'from You to General');
  assert.equal(arrival('/profile/', at('/profile/', '?tab=general'), () => false), 'load', 'from General to You');
  assert.equal(arrival('/profile/', at('/profile'), () => false), 'none', 'already there');
  assert.equal(arrival('/profile/?tab=You', at('/profile/'), () => false), 'none', 'You by its old capitalised name is another page');
});

test('a refused save says so in the panel, as in Settings', () => {
  // The PR hid every row's save state (`[&_[role=status]]:hidden`), so a switch the server refused flipped back with no
  // word. Reintroduce the class: this fails.
  const menu = code(read('components/ProfileMenu.tsx'));
  assert.doesNotMatch(menu, /role=status\]\]:hidden/);
});

