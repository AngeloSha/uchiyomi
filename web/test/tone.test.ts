// The background tone, applied (Look settings, UI refresh phase 3): lib/tone.ts against a stand-in document and storage,
// the <head> script that applies the device's copy before the first paint, and where the account's tone is applied --
// the same places as the accent and Reduce effects. The colours themselves are checked in tokens.test.ts.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { applyTone, readToneMirror, restoreTone, themeColorOf, toneOf, TONE_BOOT, TONES } from '../lib/tone';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// A document with an <html>, a <head> that metas can be added to, and a storage. The static page carries no theme-color
// meta: TONE_BOOT makes it (app/layout.tsx says why).
interface Meta { name: string; content: string; setAttribute(k: string, v: string): void }
const attrs = new Map<string, string>();
let metas: Meta[] = [];
const meta = (): Meta => ({ name: '', content: '', setAttribute(k, v) { if (k === 'name') this.name = v; if (k === 'content') this.content = v; } });
const bars = () => metas.filter((m) => m.name === 'theme-color').map((m) => m.content);
const store = new Map<string, string>();
let storageThrows = false;
const g = globalThis as Record<string, unknown>;
g.document = {
  documentElement: {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  },
  head: { appendChild: (m: Meta) => { metas.push(m); return m; } },
  createElement: (tag: string) => { assert.equal(tag, 'meta'); return meta(); },
  querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? metas.filter((m) => m.name === 'theme-color') : []),
};
g.localStorage = {
  getItem: (k: string) => { if (storageThrows) throw new Error('blocked'); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (storageThrows) throw new Error('blocked'); store.set(k, v); },
  removeItem: (k: string) => { if (storageThrows) throw new Error('blocked'); store.delete(k); },
};

beforeEach(() => { attrs.clear(); store.clear(); storageThrows = false; metas = []; });

test('a tone the app does not know is OLED', () => {
  for (const v of [undefined, null, '', 'OLED', 'dark', 1, {}, 'graphite ']) assert.equal(toneOf(v), 'oled', String(v));
  assert.equal(toneOf('graphite'), 'graphite');
  assert.equal(toneOf('midnight'), 'midnight');
  assert.equal(themeColorOf('oled'), '#000000');
});

test('applying a tone sets <html data-tone>, the browser bar and the mirror; OLED clears all three', () => {
  new Function(TONE_BOOT)(); // the page's one meta, black
  applyTone('midnight');
  assert.equal(attrs.get('data-tone'), 'midnight');
  assert.deepEqual(bars(), [themeColorOf('midnight')], 'the bar is not the tone\'s, or a second meta was made');
  assert.equal(readToneMirror(), 'midnight');
  // Back to OLED: no attribute at all -- OLED is the CSS with no tone block -- black bars, and no mirror.
  // Reintroduce `setAttribute('data-tone', 'oled')`: html[data-tone] rules would then restyle OLED's glass and scrim.
  applyTone('oled');
  assert.equal(attrs.has('data-tone'), false);
  assert.deepEqual(bars(), ['#000000']);
  assert.equal(store.size, 0);
  applyTone('graphite');
  applyTone(null); // sign-out
  assert.equal(attrs.has('data-tone'), false, 'the sign-in screen is not OLED');
  assert.equal(store.size, 0, 'the next person\'s offline launch inherits this one\'s tone');
  // With no meta at all (the boot script never ran), the bar is still coloured: one is made, once.
  metas = [];
  applyTone('graphite');
  applyTone('graphite');
  assert.deepEqual(bars(), [themeColorOf('graphite')]);
});

test('the device\'s copy comes back on restore, and blocked storage is OLED, not an error', () => {
  store.set('uchiyomi.tone', 'graphite');
  restoreTone();
  assert.equal(attrs.get('data-tone'), 'graphite');
  store.set('uchiyomi.tone', 'neon');
  restoreTone();
  assert.equal(attrs.has('data-tone'), false);
  storageThrows = true;
  assert.equal(readToneMirror(), 'oled');
  assert.doesNotThrow(() => applyTone('midnight'));
  assert.equal(attrs.get('data-tone'), 'midnight', 'refused storage still colours the page');
});

test('the <head> script applies only a tone that is not OLED, makes the one browser-bar meta, and never throws', () => {
  const boot = new Function(TONE_BOOT);
  for (const [saved, want] of [['graphite', 'graphite'], ['midnight', 'midnight'], ['oled', undefined], ['x', undefined],
    ['constructor', undefined], ['__proto__', undefined], [undefined, undefined]] as const) {
    attrs.clear(); store.clear(); metas = [];
    if (saved) store.set('uchiyomi.tone', saved);
    boot();
    assert.equal(attrs.get('data-tone'), want, String(saved));
    assert.deepEqual(bars(), [want ? themeColorOf(want) : '#000000'], `the bar for ${saved}`);
  }
  // Storage refused: no tone, and the bar is still made, black.
  metas = [];
  storageThrows = true;
  assert.doesNotThrow(() => boot());
  assert.deepEqual(bars(), ['#000000']);
  // Every tone but OLED is in it, so a tone added to TONES is restored before the first paint too.
  for (const t of TONES) assert.equal(TONE_BOOT.includes(`"${t.key}"`), t.key !== 'oled', t.key);
  // In the root layout's <head>, and so differing from what React renders for <html>: on purpose, and said so.
  const layout = code(read('app/layout.tsx'));
  assert.match(layout, /<html lang="en" className=\{`[^`]*`\} suppressHydrationWarning>\s*<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: TONE_BOOT \}\} \/>\s*<\/head>/);
  // ⚠️ No theme-color of React's or Next's: Next re-renders `viewport.themeColor` on every client-side navigation (the bar
  // went back to black at the first click under a tone), and React matches a <meta> it rendered by its content, so once
  // this script had coloured it React added a second. Both caught by e2e/run.mjs "look settings"; reintroduce either and
  // this fails before the browser walk has to.
  assert.doesNotMatch(layout, /themeColor:/);
  assert.doesNotMatch(layout, /<meta name="theme-color"/);
});

test('the account\'s tone is applied where the accent and Reduce effects are', () => {
  const auth = code(read('lib/auth.tsx'));
  // Before `authed`, like Reduce effects: the shell's first frame is in the reader's tone.
  assert.match(auth, /applyReduceEffects\(u\.settings\?\.reduceEffects === true\);\s*applyTone\(u\.settings\?\.tone\);\s*setStatus\('authed'\);/);
  assert.match(auth, /restoreReduceEffects\(\);\s*restoreTone\(\);\s*setStatus\('offline'\);/);
  assert.match(auth, /applyReduceEffects\(false\);\s*applyTone\(null\);\s*setUser\(null\);/, 'sign-out keeps the tone for the sign-in screen');
  assert.match(auth, /if \('tone' in partial\) applyTone\(partial\.tone\);/, 'picking a tone waits for a reload');
  assert.match(code(read('app/providers.tsx')), /useLayoutEffect\(restoreReduceEffects, \[\]\);\s*useLayoutEffect\(restoreTone, \[\]\);/);
});

test('Profile → Settings → Appearance offers every tone, saves it to the account, and takes it back if refused', () => {
  // v0.86.0: picture cards (components/settings.tsx ChoiceRow), each tone drawn by components/settingsArt.tsx ToneArt, and
  // every card keeps the `data-tone-choice` the walks pick it by. Reintroduce by dropping `optionProps`: "a card lost its
  // data-tone-choice" fails.
  const src = code(read('components/ProfileSettings.tsx'));
  const row = src.slice(src.indexOf("<ChoiceRow<Tone> id=\"background\" label={tr('Background')}"), src.indexOf('<Row id="accent"'));
  assert.ok(row.length > 100, 'no Background row before the accent');
  assert.match(row, /options=\{TONES\.map\(\(t\) => \(\{ value: t\.key, label: tr\(t\.label\), art: <ToneArt tone=\{t\.key\} \/> \}\)\)\}/, 'not every tone is offered');
  assert.match(row, /value=\{tone\} onChange=\{pickTone\} optionProps=\{\(v\) => \(\{ 'data-tone-choice': v \}\)\}/, 'a card lost its data-tone-choice');
  // Each card is drawn in its own tone's colours, not the page's: the three side by side whatever is on.
  const art = code(read('components/settingsArt.tsx'));
  const tone = art.slice(art.indexOf('export function ToneArt('));
  assert.match(tone, /style=\{\{ background: t\.page, boxShadow: `inset 0 0 0 1px \$\{t\.line\}` \}\}/);
  assert.match(tone, /style=\{\{ background: t\.surface, boxShadow: `inset 0 0 0 1px \$\{t\.line\}` \}\}/);
  assert.doesNotMatch(row + tone, /rounded-full/, 'a tone is a squared swatch, not a capsule');
  // Applied at once, saved, and taken back if the server refuses -- the row's tick says so (ChoiceRow's autosave).
  assert.match(src, /setSettings\(\{ tone: next \}\);\s*try \{ await api\('\/api\/settings', \{ method: 'PUT', json: \{ tone: next \} \}\); \}\s*catch \(e\) \{ setSettings\(\{ tone: prev \}\); throw e; \}/);
});
