// The UI refresh's contracts: the desktop sidebar and the geometry around it, art under the chrome, and the rails.
//
// Most of this is layout, which a browser measures (e2e/layout.mjs: every page's usable width minus the rail, the hero
// edge to edge, the sidebar's labels whole in four languages, Arabic on the right, the bar see-through over art). What
// is held here is what a browser run can pass by luck: a page that never had art, a phone that never mounts the rail,
// a hook read on one render and not the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { sidebarItems, ringMark } from '../components/Sidebar';
import { enterArt, overArtNow } from '../lib/overArt';
import type { NavRing } from '../lib/serverDownloads';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments here quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

test('the geometry: the rail is in the shell and every bleed from lg up, and nowhere below it', () => {
  // Reintroduce `.shell { padding-inline: 2rem }` without the rail: every page's first column slides under the sidebar --
  // "the shell does not clear the rail" fails (and layout.mjs's usable width with it).
  const css = read('app/globals.css');
  assert.match(css, /--rail-w: 0px;\s*--topbar-h: 0px;/, 'the rail and the bar have a width below lg');
  assert.match(css, /@media \(min-width: 1024px\) \{ :root \{ --gutter: 2rem; --rail-w: 4\.5rem; --topbar-h: 65px; \} \}/, 'the rail is not 72 px from lg');
  assert.match(css, /\.shell \{ padding-inline: 2rem; padding-inline-start: calc\(2rem \+ var\(--rail-w\)\); \}/, 'the shell does not clear the rail');
  for (const cls of ['bleed', 'bleed-lg']) {
    const body = new RegExp(`\\.${cls} \\{\\s*margin-inline-start: calc\\(-2rem - var\\(--rail-w\\)\\); margin-inline-end: -2rem;\\s*width: calc\\(100% \\+ 4rem \\+ var\\(--rail-w\\)\\);`);
    assert.match(css, body, `.${cls} does not reach under the rail to the window's edge`);
  }
  assert.match(css, /\.bleed-pad \{ padding-inline-start: calc\(2rem \+ var\(--rail-w\)\); padding-inline-end: 2rem; \}/, 'text in a bleed is not put back on the content edge');
  assert.match(css, /\.under-topbar \{ margin-top: calc\(-1 \* var\(--topbar-h\)\); \}/, 'art does not start under the top bar');
  assert.match(css, /\[dir='rtl'\] \.rail-scrim \{\s*background-image: linear-gradient\(to left,/, 'the rail\'s scrim darkens the wrong side in Arabic');
  // The last pill-shaped action classes are squared (noPills.test.ts holds the list).
  assert.match(css, /\.btn-accent \{\s*@apply inline-flex items-center justify-center gap-2 rounded-xl /, 'the accent key is a capsule again');
});

test('text laid in a bleed sits on the content edge, and the fixed bars start past the rail', () => {
  // Reintroduce `lg:px-8` on the Discover hero's text (inside a .bleed that now reaches under the rail): the title starts
  // under the sidebar -- "a bleed's text is padded from the window's edge" fails.
  for (const f of [...files('app'), ...files('components')]) {
    for (const m of code(read(f)).matchAll(/className=\{?[`"]([^`"]*)[`"]/g)) {
      if (/(^|\s)bleed(-lg)?(\s|$)/.test(m[1])) assert.doesNotMatch(m[1], /\blg:px-(8|14)\b/, `${f}: a bleed's text is padded from the window's edge`);
    }
  }
  assert.match(read('components/DiscoverHero.tsx'), /className="bleed-pad relative z-10 flex h-full flex-col justify-end/, 'the Discover hero\'s text');
  assert.match(read('app/admin/page.tsx'), /className=\{`bleed-pad relative /, 'the admin hero\'s text');
  assert.match(read('app/profile/page.tsx'), /className="bleed-pad pb-4 lg:pb-6"/, 'the profile hero\'s text');
  for (const f of ['app/library/page.tsx', 'app/series/page.tsx']) {
    assert.match(read(f), /className="fixed inset-x-0 bottom-\[calc\(5\.75rem\+env\(safe-area-inset-bottom\)\)\] z-40 [^"]*lg:start-\[var\(--rail-w\)\]/, `${f}: the select bar runs under the sidebar`);
  }
  assert.match(read('components/ConsoleNav.tsx'), /sticky top-\[calc\(var\(--topbar-h\)\+1\.5rem\)\]/, 'the admin and profile rail slides under the top bar');
});

test('the sidebar: who sees which item', () => {
  // Reintroduce Discover for everyone: an account that may not add series is offered a page that refuses it.
  const names = (o: Parameters<typeof sidebarItems>[0]) => {
    const r = sidebarItems(o);
    return [...r.main, ...r.more, ...(r.admin ? [r.admin] : [])].map((i) => i.href);
  };
  assert.deepEqual(names({ downloader: true, admin: true, desktop: false }), ['/', '/library', '/collections', '/discover', '/history', '/moments', '/downloads', '/admin']);
  assert.ok(!names({ downloader: false, admin: false, desktop: false }).includes('/discover'), 'Discover for an account that may not add series');
  assert.ok(!names({ downloader: true, admin: false, desktop: false }).includes('/admin'), 'Admin for a member');
  assert.ok(!names({ downloader: true, admin: true, desktop: true }).includes('/downloads'), 'Offline in Uchiyomi Desktop, where the chapters are on the disk');
  // The mark walk49 reads off the Library item.
  const ring = (o: Partial<NavRing>): NavRing => ({ show: false, progress: 'idle', count: 0, attention: false, slow: false, label: '', ...o });
  assert.equal(ringMark(ring({})), 'idle');
  assert.equal(ringMark(ring({ show: true })), 'active');
  assert.equal(ringMark(ring({ show: true, slow: true })), 'slow');
});

test('the sidebar is built the way the walks and the layers need it', () => {
  const src = code(read('components/Sidebar.tsx'));
  // e2e/i18n.mjs waits for the Library's <aside>; walk49 finds the phone's bar as `nav.fixed.bottom-0`.
  assert.doesNotMatch(src, /<aside\b/, 'the sidebar is an <aside>: i18n.mjs would take it for the Library\'s');
  assert.doesNotMatch(src, /\bbottom-0\b/, 'the sidebar says bottom-0: walk49 would take it for the phone\'s bar');
  // Logical sides only: in Arabic it is on the right. Reintroduce `left-0`: this fails (and layout.mjs's Arabic check).
  assert.doesNotMatch(src, /(?<![\w-])-?(left|right)-[\d[]|\b(ml|mr|pl|pr)-\d/, 'a physical side in the sidebar');
  assert.match(src, /fixed inset-y-0 start-0 z-40 w-\[var\(--rail-w\)\]/, 'the rail is not the start edge, 72 px');
  // The labels stay in the document while it is closed: the accessible names, and the words i18n.mjs reads.
  assert.match(src, /transition-opacity \$\{open \? 'opacity-100' : 'opacity-0'\}/, 'the labels are removed rather than faded');
  assert.doesNotMatch(src, /open \? '[^']*' : '[^']*\bhidden\b/, 'the labels are display:none while closed');
  // Never the `nav` layer, which is the phone's measured bar; and out of the way while a dialog is open.
  assert.doesNotMatch(src, /useLayer\(/, 'the sidebar registers a layer: the notices would dock above a bar that is not there');
  assert.match(src, /const covered = layers\.dialog > 0;/);
  assert.match(src, /inert=\{covered \|\| undefined\}/, 'the sidebar stays clickable over an open dialog');
  // Opened by keyboard focus only: a click focuses the link it followed.
  assert.match(src, /matches\?\.\(':focus-visible'\)/, 'a mouse click holds the panel open on the next page');
});

test('the shell: the sidebar from lg up only, the Health banner above the bar, and the hooks before any return', () => {
  // Reintroduce `<Sidebar />` without the wide gate: a phone gets a second navigation over its bottom bar.
  const shell = code(read('components/AppShell.tsx'));
  const at = (s: string) => shell.indexOf(s);
  assert.ok(at('const wide = useWideViewport();') > 0 && at('const wide = useWideViewport();') < at("if (status === 'loading') return"), 'the viewport hook runs after an early return');
  assert.ok(at('<HealthBanner />') < at('<TopNav ') && at('<TopNav ') < at('{wide && <Sidebar />}') && at('{wide && <Sidebar />}') < at('<main '),
    'not banner, bar, sidebar, page -- in that order');
});

test('art under the chrome: one page says so, two say so, and the bar is clear only at the top', () => {
  // Reintroduce a flag for the counter: a page change mounts the next page's art before the last one's leaves, and the
  // last one's leaving would clear the bar over the next page's art.
  assert.equal(overArtNow(), false);
  const a = enterArt();
  const b = enterArt();
  a();
  assert.equal(overArtNow(), true, 'one page left and took the other\'s art with it');
  a();
  assert.equal(overArtNow(), true, 'leaving twice counted twice');
  b();
  assert.equal(overArtNow(), false);
  assert.match(code(read('components/TopNav.tsx')), /const clear = overArt && !scrolled;/, 'the bar is clear over art after the page scrolls');
  for (const f of ['app/page.tsx', 'app/series/page.tsx']) assert.match(code(read(f)), /useArtUnderChrome\(\);/, `${f} does not say its art is under the bar`);
});

test('every card rail scrolls with arrows, and a card is as wide as its skeleton', () => {
  // Reintroduce the old Rail anywhere: a mouse cannot move it (rails.test.ts says why).
  for (const f of [...files('app'), ...files('components')]) assert.doesNotMatch(code(read(f)), /<Rail\b/, `${f} uses the old Rail`);
  assert.doesNotMatch(read('components/ui.tsx'), /export function Rail\(/, 'the old Rail is back');
  // Every use of the card rails' class is a named ScrollRail: reintroduce a `<div className={CARD_RAIL}>` for one of Home's
  // rails and the counts part.
  for (const [f, least] of [['app/page.tsx', 11], ['app/series/page.tsx', 1], ['components/RelatedRail.tsx', 2], ['app/reader/page.tsx', 1]] as const) {
    const src = code(read(f));
    const uses = (src.match(/className=\{CARD_RAIL\}/g) ?? []).length;
    // A label may hold braces of its own ("Because you read {title}"): lazily, to the class on the same line.
    const rails = (src.match(/<ScrollRail label=\{.+?\} className=\{CARD_RAIL\}>/g) ?? []).length;
    assert.equal(rails, uses, `${f}: a card rail that is not a named ScrollRail`);
    assert.ok(rails >= least, `${f}: ${rails} card rails, expected at least ${least}`);
  }
  assert.match(read('components/ScrollRail.tsx'), /export const CARD_RAIL = 'flex gap-3 px-4 pb-3 pt-2 scroll-px-4 \[scroll-snap-type:x_mandatory\]';/);
  assert.match(code(read('components/cards.tsx')), /export function SeriesCard\(\{ series, w = CARD_W,/, 'a rail card is a fixed width again');
  assert.match(code(read('components/ui.tsx')), /aspect-\[2\/3\] \$\{CARD_W\}/, 'the skeleton is not the card\'s width');
});

test('the new motion is the default look, and steps aside for Reduce effects and for reduced motion', () => {
  // Each reads BOTH switches on every render, as Toast.tsx does (effects.test.ts). Reintroduce
  // `const reduced = useReduceEffects() || useReducedMotion();` in one: its assertion fails.
  const both = /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const reduced = plain \|\| !!still;/;
  for (const f of ['components/Sidebar.tsx', 'components/MosaicArt.tsx', 'components/HeroCarousel.tsx', 'app/series/page.tsx']) {
    const src = code(read(f));
    assert.match(src, both, `${f} reads the motion settings conditionally, or only one of them`);
    assert.doesNotMatch(src, /useReduceEffects\(\)\s*(\|\||&&|\?)|useReducedMotion\(\)\s*(\|\||&&|\?)/, `${f} reads the motion settings conditionally`);
  }
  assert.match(code(read('components/MosaicArt.tsx')), /initial=\{reduced \? false : \{ opacity: 0, y: 14 \}\}/, 'the tiles still settle in under Reduce effects');
  assert.match(code(read('app/series/page.tsx')), /style=\{\{ opacity: reduced \? 1 : artDim \}\}/, 'the banner still dims under Reduce effects');
  assert.match(code(read('components/HeroCarousel.tsx')), /style=\{reduced \|\| stopped \? undefined : \{ animation: `hero-progress/, 'the slide bar still fills under Reduce effects');
  assert.match(read('app/globals.css'), /@keyframes hero-progress \{/, 'the slide bar\'s keyframes are not emitted');
});
