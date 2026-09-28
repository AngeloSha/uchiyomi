// The notices (v0.49.0): components/Toast.tsx, the capsules at the top of the screen redrawn as cards at the
// bottom edge that never cover a dialog's title. The rules are run as plain functions (lib/notices.ts); the
// component and its callers are read from source, because what matters there is where the viewport is
// rendered, that it never anchors to the top, and that every busy message says so itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  MAX_NOTICES, NOTICE_ERROR_MIN_MS, NOTICE_MAX_MS, NOTICE_MIN_MS, WIDE_BESIDE_DIALOG, WIDE_COLUMN, announceText,
  createCountdown, dropNotice, noticeDuration, noticeOffset, noticePlace, noticeTone, offlineOutcome, pushNotice, visibleNotices,
  wideWidth, type Notice, type NoticePlace,
} from '../lib/notices';
import type { Layers } from '../lib/layers';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: several comments quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The index of the last character of the string, template or regex literal starting at `i`, or -1 when `i`
 * starts none. A `/` is a regex when what comes before it cannot end an expression -- `.replace(/'[^']*'/, …)`
 * in the admin page's restore error would otherwise read as strings and run the call to the end of the file.
 */
function literalEnd(src: string, i: number): number {
  const ch = src[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
    return j;
  }
  if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && /[(,=:[!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 8), i))) {
    let j = i + 1;
    let klass = false;
    while (j < src.length && src[j] !== '\n' && (klass || src[j] !== '/')) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[') klass = true;
      else if (src[j] === ']') klass = false;
      j++;
    }
    return j;
  }
  return -1;
}
/** Where the call whose `(` is at `open` ends (just past its `)`), past strings, templates, regexes and nested brackets. */
function callEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const lit = literalEnd(src, i);
    if (lit >= 0) { i = lit; continue; }
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}
/** A call's argument list, split at its top-level commas. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const lit = literalEnd(inner, i);
    if (lit >= 0) { i = lit; continue; }
    const ch = inner[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(inner.slice(from, i)); from = i + 1; }
  }
  out.push(inner.slice(from));
  return out;
}

const L = (over: Partial<Layers> = {}): Layers => ({ dialog: 0, nav: 0, navHeight: 0, toolbar: 0, navBandFree: true, toolbarHeight: 0, sheetReach: 0, ...over });
let nextId = 0;
const add = (list: Notice[], msg: string, type: Notice['type'] = 'info', extra: Partial<Notice> = {}) =>
  pushNotice(list, { id: ++nextId, msg, type, busy: false, duration: noticeDuration(msg, type), ...extra });

/* ================================================================ how long */

test('a notice stays long enough to read: longer for more words, at least 6 s for an error, never over 10 s', () => {
  // The capsule lasted 3.2 s whatever it said, and a two-sentence refusal was gone before it was read.
  // Reintroduce `return 3200` in noticeDuration: "a short notice is gone before it can be read" fails.
  const short = noticeDuration('Saved', 'success');
  assert.ok(short >= NOTICE_MIN_MS && short >= 4000, `a short notice is gone before it can be read (${short} ms)`);
  const sentence = 'The library repair is running — try again in a few minutes';
  assert.ok(noticeDuration(sentence, 'info') > short, 'a longer message does not stay longer than a short one');
  assert.ok(noticeDuration('x'.repeat(400), 'info') <= NOTICE_MAX_MS, 'a very long message stays for good');
  assert.equal(noticeDuration('x'.repeat(400), 'info'), 10_000);
  assert.ok(noticeDuration('Failed', 'error') >= NOTICE_ERROR_MIN_MS, 'an error leaves before it can be acted on');
  assert.ok(noticeDuration('Failed', 'error') > noticeDuration('Failed', 'info'), 'an error stays no longer than the same words as news');
  // Characters, not UTF-16 units: an emoji is one character to a reader.
  assert.equal(noticeDuration('✓ 😀 done', 'info'), noticeDuration('✓ x done', 'info'));
});

/* ================================================================ merging and the cap */

test('the same words twice are one card counting, a key takes the place of its notice, and three is the most', () => {
  // Reintroduce the old append (`return [...list, { ...next, count: 1, bump: 0 }].slice(-MAX_NOTICES)` as
  // the whole function): "a repeat stacked a second card" fails -- five taps on a key that refuses were five
  // identical capsules.
  let list: Notice[] = [];
  list = add(list, 'Could not save', 'error');
  const first = list[0];
  list = add(list, 'Could not save', 'error');
  assert.equal(list.length, 1, 'a repeat stacked a second card');
  assert.equal(list[0].count, 2, 'the repeat is not counted (×2)');
  assert.equal(list[0].id, first.id, 'the merged card is a new card (it would animate in again)');
  assert.equal(list[0].bump, first.bump + 1, 'a repeat does not restart the card\'s clock');
  // The same words in another tone are another message.
  list = add(list, 'Could not save', 'info');
  assert.equal(list.length, 2, 'an error and a piece of news with the same words merged');
  // A repeat of an older card moves it to the newest place: over a dialog only the newest shows.
  list = add(list, 'Could not save', 'error');
  assert.equal(list.at(-1)!.type, 'error', 'the repeated card stayed behind a newer one');
  assert.equal(list.at(-1)!.count, 3);

  // A key takes the place of the notice with that key: "Checking…" becomes "Library refreshed".
  let keyed: Notice[] = [];
  keyed = add(keyed, 'Checking for new chapters…', 'info', { busy: true, key: 'refresh' });
  const busyOne = keyed[0];
  keyed = add(keyed, 'Something else');
  keyed = add(keyed, 'Library refreshed', 'success', { key: 'refresh' });
  assert.equal(keyed.length, 2, 'the keyed result added a card beside the busy one instead of taking its place');
  const done = keyed.find((n) => n.key === 'refresh')!;
  assert.equal(done.id, busyOne.id, 'the replacement is a new card rather than the old one updated');
  assert.equal(done.msg, 'Library refreshed');
  assert.equal(done.type, 'success');
  assert.equal(done.busy, false, 'the finished notice still turns');
  assert.equal(done.count, 1);
  assert.equal(done.bump, busyOne.bump + 1, 'the replacement kept the busy notice\'s spent clock');
  assert.equal(keyed.at(-1)!.key, 'refresh', 'the replacement is not the newest');
  // A keyed notice does not swallow an unkeyed one with the same words, nor the reverse.
  keyed = add(keyed, 'Library refreshed', 'success');
  assert.equal(keyed.length, 3);

  // The cap.
  let many: Notice[] = [];
  for (const m of ['one', 'two', 'three', 'four', 'five']) many = add(many, m);
  assert.equal(many.length, MAX_NOTICES, `${many.length} notices kept -- they climb a phone screen toward the titles`);
  assert.deepEqual(many.map((n) => n.msg), ['three', 'four', 'five'], 'the cap dropped the newest instead of the oldest');
  assert.deepEqual(dropNotice(many, many[1].id).map((n) => n.msg), ['three', 'five']);
});

test('three show at once, and one over a dialog or a reader sheet', () => {
  // Reintroduce `slice(-MAX_NOTICES)` for every place: "three notices over a dialog" fails -- they climb out
  // of the nav band into the dialog's buttons.
  let list: Notice[] = [];
  for (const m of ['a', 'b', 'c']) list = add(list, m);
  const places: NoticePlace[] = ['above-nav', 'above-toolbar', 'bottom'];
  for (const p of places) assert.deepEqual(visibleNotices(list, p).map((n) => n.msg), ['a', 'b', 'c'], `${p}: not the three, oldest first`);
  assert.deepEqual(visibleNotices(list, 'nav-band').map((n) => n.msg), ['c'], 'three notices over a dialog');
  assert.deepEqual(visibleNotices(list, 'above-sheet').map((n) => n.msg), ['c'], 'three notices over a reader sheet');
  assert.deepEqual(visibleNotices([], 'nav-band'), []);
});

/* ================================================================ where */

test('where a notice goes: above the nav, above a select bar, in the nav band under a dialog, above a reader sheet', () => {
  // Reintroduce the top anchor by ignoring dialogs (`if (l.dialog > 0) { … }` removed): "a notice over a
  // dialog is placed as if nothing were open" fails.
  assert.equal(noticePlace(L({ nav: 1 })), 'above-nav');
  assert.equal(noticePlace(L({ nav: 1, toolbar: 1, toolbarHeight: 104 })), 'above-toolbar', 'a select bar is ignored');
  assert.equal(noticePlace(L({ nav: 1, dialog: 1 })), 'nav-band', 'a notice over a dialog is placed as if nothing were open');
  // A dialog over a select bar: the dialog's backdrop covers the bar, and the band is still the nav's.
  assert.equal(noticePlace(L({ nav: 1, dialog: 1, toolbar: 1, toolbarHeight: 104 })), 'nav-band');
  // Whether the dialog leaves the band free does not matter while there is a nav: every dialog is inside
  // <main>, under the nav, so docking there hides only what the nav hides.
  assert.equal(noticePlace(L({ nav: 1, dialog: 1, navBandFree: false })), 'nav-band');
  // The reader: no nav. A sheet running to the bottom edge is measured, and the notice rises above it.
  // Reintroduce the old `nav ? 'nav-band' : 'bottom'`: "a notice sits on a reader sheet's last rows" fails.
  assert.equal(noticePlace(L({ dialog: 1, navBandFree: false, sheetReach: 633 })), 'above-sheet', 'a notice sits on a reader sheet\'s last rows');
  assert.equal(noticePlace(L({ dialog: 1, navBandFree: true })), 'bottom', 'a dialog that leaves the bottom band free still pushes the notice off it');
  assert.equal(noticePlace(L()), 'bottom');
});

test('the offsets: measured, from the bottom edge, and from lg up the corner', () => {
  // The critic's ruling: a constant 11.25 rem over the select bar is wrong for both bars (the series bar is
  // three rows at 390 px). Reintroduce a constant (`calc(11.25rem + env(safe-area-inset-bottom))`): "the
  // select bar's measured height is not in the offset" fails.
  const tb = noticeOffset('above-toolbar', L({ toolbarHeight: 104 }));
  assert.match(tb.phone, /\b104px\b/, 'the select bar\'s measured height is not in the offset');
  assert.match(tb.phone, /5\.75rem \+ env\(safe-area-inset-bottom\)/, 'the offset over the select bar forgets the nav under it');
  assert.match(tb.wide, /\b104px\b/, 'from lg up (where the bar is at the very bottom) the notice sits on it');
  // Above the nav, 0.5 rem clear of where the select bars rest on it (5.75 rem).
  assert.match(noticeOffset('above-nav', L()).phone, /^calc\(6\.25rem \+ env\(safe-area-inset-bottom\)\)$/, 'the notice sits on the nav');
  // In the nav band: exactly where the nav's bar is, and the dialog is above it.
  assert.equal(noticeOffset('nav-band', L()).phone, 'max(1.3rem, calc(env(safe-area-inset-bottom) + 0.9rem))');
  const sheet = noticeOffset('above-sheet', L({ sheetReach: 633 }));
  assert.ok(sheet.phone.includes('calc(633px + 0.75rem)'), 'the notice is not above the reader sheet');
  assert.equal(sheet.wide, sheet.phone, 'from lg up the reader\'s full-width settings sheet is covered');
  // Capped below the top: the settings sheet reaches 85 % of the screen, and on a landscape phone (390 px tall,
  // still below lg) a card above it started above the window. Reintroduce the bare `calc(reach + 0.75rem)`:
  // "a notice above a tall sheet on a landscape phone leaves the screen" fails.
  assert.match(sheet.phone, /^min\(calc\(633px \+ 0\.75rem\), calc\(100dvh - 4\.5rem - env\(safe-area-inset-top\)\)\)$/, 'a notice above a tall sheet on a landscape phone leaves the screen');
  // What that means at 844 x 390: the sheet reaches 331.5 px, the cap is 390 - 72 = 318 px, and a two-line card
  // (about 60 px) then starts 12 px below the top instead of 4 px above it.
  const rem = 16;
  const bottom = Math.min(0.85 * 390 + 0.75 * rem, 390 - 4.5 * rem);
  assert.ok(390 - bottom - 60 >= 0, `a two-line card starts ${390 - bottom - 60}px from the top of a landscape phone`);
  for (const p of ['above-nav', 'nav-band', 'bottom'] as const) assert.equal(noticeOffset(p, L()).wide, '1.5rem', `${p}: not the lg corner`);
});

test('docked in the nav band, a notice covers the nav bar exactly: its bottom, its height, its width', () => {
  // Docked at the edge with its own height, a one-line card left the top half of the nav's icons showing
  // above it. It now takes the bar's place. The bar's bottom is the nav's `.safe-bottom` padding plus its
  // inner pb-2, its width max-w-2xl less px-4, its height measured. Reintroduce `min-h-0` on the docked
  // card (or drop the measurement from BottomNav): "the docked notice is not as tall as the nav bar" fails;
  // restyle the nav's padding without this offset: the pins below fail first.
  const nav = code(read('components/BottomNav.tsx'));
  assert.match(nav, /<nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 lg:hidden">\s*<div className="mx-auto max-w-2xl px-4 pb-2">\s*<div ref=\{barRef\} className="glass grad-border [^"]*rounded-3xl/,
    'the nav bar moved or changed shape -- redo the nav-band offset, width and corners in lib/notices.ts and Toast.tsx');
  assert.match(nav, /useLayer\('nav', true, \{ ref: barRef \}\);/, 'the nav bar is not measured');
  const css = read('app/globals.css');
  assert.match(css, /\.safe-bottom \{ padding-bottom: max\(0\.8rem, calc\(env\(safe-area-inset-bottom\) \+ 0\.4rem\)\); \}/, '.safe-bottom changed -- redo the nav-band offset');
  // 0.8 + 0.5 and 0.4 + 0.5: the nav's padding plus its pb-2.
  assert.equal(noticeOffset('nav-band', L()).phone, 'max(1.3rem, calc(env(safe-area-inset-bottom) + 0.9rem))');
  const src = code(read('components/Toast.tsx'));
  assert.match(src, /'--notice-min-h': band \? `\$\{layers\.navHeight\}px` : '0px'/, 'the docked notice is not as tall as the nav bar');
  assert.match(src, /place === 'nav-band' \? 'min-h-\[var\(--notice-min-h\)\] max-w-\[40rem\] rounded-3xl lg:min-h-0 lg:rounded-xl' : 'max-w-md rounded-xl'/,
    'the docked notice is not the nav bar\'s width and shape');
  assert.match(src, /\$\{band \? 'px-4' : 'px-3'\}/, 'the docked notice is not inset like the nav bar');
});

/** Tailwind's max-w-* steps, in rem. */
const MAX_W: Record<string, number> = { xs: 20, sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42, '3xl': 48, '4xl': 56, '5xl': 64 };
/**
 * The widest centred panel in the app, read from the source: every `aria-modal="true"` element's own max-w-*
 * (the panel is the element, or for Modal and Sheet their panel a few lines on). Panels that are not centred
 * are named with why, so the column's arithmetic below is held to what the dialogs really are.
 */
const NOT_CENTRED: Record<string, string> = {
  'components/PreviewReader.tsx': 'fills the screen, over the notices (z-[70])',
  'components/ReaderSettings.tsx': 'a full-width bottom sheet: the notices rise above it (above-sheet)',
  'components/CommandPalette.tsx': 'anchored at the top, over the notices (z-[70])',
};
function widestCentredPanel(): { rem: number; where: string } {
  let widest = { rem: 0, where: '' };
  for (const f of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))) {
    const rel = f.slice(ROOT.length + 1);
    if (NOT_CENTRED[rel]) continue;
    const src = code(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\saria-modal="true"/g)) {
      // The tag's own class list and the next few lines, where Modal's and Sheet's panels are.
      const near = src.slice(Math.max(0, m.index! - 400), m.index! + 1200);
      for (const w of near.matchAll(/(?<![\w-])(?:sm:|md:|lg:)?max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl)\b/g)) {
        if (MAX_W[w[1]] > widest.rem) widest = { rem: MAX_W[w[1]], where: `${rel}: max-w-${w[1]}` };
      }
    }
  }
  return widest;
}

test('from lg up the column beside a centred dialog never reaches it', () => {
  // The widest centred panel is read from the source (widestCentredPanel): a Sheet's max-w-xl, 36 rem; Modal is
  // 28 or 32. The column sits 1.5 rem (`lg:end-6`) from the end edge. Reintroduce the design's
  // `calc(50vw-19rem)`: at 1024 px its start edge is 0.5 rem into the dialog, and "the notice column overlaps
  // a 36 rem dialog at 1024 px" fails. Put the admin's art picker back at max-w-2xl (42 rem): its corner sat
  // under the column, and "the notice column overlaps a 42 rem dialog" fails the same way.
  assert.equal(wideWidth('nav-band', 1), WIDE_BESIDE_DIALOG);
  assert.equal(wideWidth('bottom', 1), WIDE_BESIDE_DIALOG, 'a dialog with no nav left the column full width');
  assert.equal(wideWidth('above-nav', 0), WIDE_COLUMN);
  assert.equal(wideWidth('above-sheet', 1), WIDE_COLUMN, 'the column above a reader sheet narrowed for nothing');
  const m = /^lg:w-\[min\((\d+(?:\.\d+)?)rem,calc\(50vw-(\d+(?:\.\d+)?)rem\)\)\]$/.exec(WIDE_BESIDE_DIALOG);
  assert.ok(m, `the dialog-aware width is not min(Xrem,calc(50vw-Yrem)): ${WIDE_BESIDE_DIALOG}`);
  const [cap, less] = [Number(m![1]), Number(m![2])];
  const toast = code(read('components/Toast.tsx'));
  assert.match(toast, /\blg:end-6\b/, 'the column is no longer 1.5 rem from the end edge -- redo this arithmetic');
  const rem = 16;
  const panel = widestCentredPanel();
  assert.ok(panel.rem >= 36, `the widest centred panel read is ${panel.rem} rem (${panel.where}) -- the scan is broken: a Sheet alone is 36`);
  for (const vw of [1024, 1100, 1280, 1440, 1920]) {
    const width = Math.min(cap * rem, vw / 2 - less * rem);
    const start = vw - 1.5 * rem - width;
    const dialogEnd = vw / 2 + (panel.rem / 2) * rem;
    assert.ok(start >= dialogEnd + 0.5 * rem - 0.01, `the notice column overlaps a ${panel.rem} rem dialog at ${vw} px (${start} < ${dialogEnd}; ${panel.where})`);
    assert.ok(width >= 11 * rem, `the column is ${width}px at ${vw} px -- too narrow to read`);
  }
  for (const rel of Object.keys(NOT_CENTRED)) assert.match(code(read(rel)), /\saria-modal="true"/, `${rel} is no longer a dialog: drop it from NOT_CENTRED`);
});

test('the tones: an error is a problem, a success the accent\'s done, anything else neutral', () => {
  assert.equal(noticeTone('error'), 'problem');
  assert.equal(noticeTone('success'), 'accent');
  assert.equal(noticeTone('info'), 'info');
});

/* ================================================================ the clock and the voice */

test('a notice\'s clock stops while held and carries on from where it stopped; a merge starts it again', () => {
  // Reintroduce a pause that forgets what was spent (`left = ms` in pause): "a hover gave the notice its
  // whole time back" fails; a pause that does not stop the timer: "the notice left while it was held" fails.
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let tid = 0;
  const setT = (fn: () => void, ms: number) => { timers.set(++tid, { at: now + ms, fn }); return tid; };
  const clearT = (id: number) => { timers.delete(id); };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  let ended = 0;
  const c = createCountdown(5000, () => ended++, setT, clearT, () => now);
  c.run();
  c.run();
  assert.equal(timers.size, 1, 'running twice started two timers');
  advance(2000);
  c.pause();
  assert.equal(timers.size, 0, 'the notice left while it was held (its timer still runs)');
  assert.equal(c.left(), 3000, 'a hover gave the notice its whole time back');
  advance(60_000);
  assert.equal(ended, 0, 'the notice left while it was held');
  c.run();
  assert.equal(c.left(), 3000, 'a hover gave the notice its whole time back');
  advance(2999);
  assert.equal(ended, 0, 'the notice left before its time was up');
  advance(1);
  assert.equal(ended, 1, 'the notice did not leave when its time was up');
  c.run();
  advance(10_000);
  assert.equal(ended, 1, 'an ended clock ran again');
  // A merge: from the full length again.
  const d = createCountdown(4000, () => ended++, setT, clearT, () => now);
  d.run();
  advance(3500);
  d.reset(4000);
  d.run();
  advance(3500);
  assert.equal(ended, 1, 'a repeat did not restart the clock');
  advance(500);
  assert.equal(ended, 2);
});

test('the same sentence twice is announced twice', () => {
  // Reintroduce `return msg`: "a repeat is silent" fails -- a live region speaks when its text changes.
  const a = announceText('', 'Could not save');
  const b = announceText(a, 'Could not save');
  assert.notEqual(a, b, 'a repeat is silent');
  assert.equal(b.replace(/​/g, ''), 'Could not save');
  assert.notEqual(announceText(b, 'Could not save'), b, 'a third repeat is silent');
  assert.equal(announceText('Saved', 'Could not save'), 'Could not save');
});

/* ================================================================ the component, from source */

test('the viewport is anchored to the bottom, placed by the layers, and never at the top', () => {
  // v0.48.3's lesson and the owner's rule: never over a dialog's title. Reintroduce the old
  // `safe-top pointer-events-none fixed inset-x-0 top-0`: "a notice is anchored to the top" fails.
  const src = code(read('components/Toast.tsx'));
  const at = src.indexOf('<section data-notices');
  assert.ok(at > 0, 'no <section data-notices>');
  const tag = src.slice(at, src.indexOf('>', src.indexOf('className=', at)) + 1);
  const cls = /className=\{`([^`]*)`\}/.exec(tag)?.[1] ?? '';
  assert.ok(cls.length > 0, 'the viewport has no className');
  const utils = cls.split(/\s+/).map((c) => c.slice(c.lastIndexOf(':') + 1));
  assert.ok(!utils.some((c) => /^(top-|inset-0$|inset-y-|safe-top$)/.test(c)), `a notice is anchored to the top: ${cls}`);
  assert.match(cls, /\bfixed\b/);
  assert.match(cls, /\bbottom-\[var\(--notice-bottom\)\]/, 'the phone offset is not the measured one');
  assert.match(cls, /\blg:bottom-\[var\(--notice-bottom-lg\)\]/, 'the lg offset is not the measured one');
  assert.match(cls, /\$\{wideWidth\(place, layers\.dialog\)\}/, 'the lg column does not narrow beside a dialog');
  assert.match(src, /const place = noticePlace\(layers\);/, 'the place ignores the layers');
  assert.match(src, /const layers = useLayers\(\);/);
  assert.match(src, /const offset = noticeOffset\(place, layers\);/);
  assert.match(src, /'--notice-bottom': offset\.phone, '--notice-bottom-lg': offset\.wide/, 'the offsets never reach the CSS');
  assert.match(src, /const shown = visibleNotices\(items, place\);/, 'every notice shows over a dialog');
  // No capsule, and nothing else round with sides either: the owner asked for the pill to go.
  assert.doesNotMatch(src, /rounded-full/, 'Toast.tsx has something rounded-full');
  // The old 3.2 s timer.
  assert.doesNotMatch(src, /3200/, 'the fixed 3.2 s lifetime is back');
});

test('the viewport is over the bottom nav: rendered beside the app, not inside <main>', () => {
  // Every dialog is inside AppShell's <main> (z-[1]), under the bottom nav (z-40, root level). A notice
  // docked in the nav band must be over the nav. Reintroduce by rendering the viewport inside <main>, or on
  // z-[30]: "the notices are under the bottom nav" fails.
  const zOf = (src: string, marker: RegExp) => {
    const at = src.search(marker);
    assert.ok(at >= 0, `${marker} not found`);
    const cls = src.indexOf('className=', at);
    const z = /^className=\{?[`"][^`"]*?\bz-(?:\[(\d+)\]|(\d+)(?![\w.]))/.exec(src.slice(cls, cls + 400));
    assert.ok(z, `no z-index in the className after ${marker}`);
    return Number(z[1] ?? z[2]);
  };
  const toast = code(read('components/Toast.tsx'));
  const nav = code(read('components/BottomNav.tsx'));
  const palette = code(read('components/CommandPalette.tsx'));
  const notices = zOf(toast, /<section data-notices/);
  assert.ok(notices > zOf(nav, /<nav /), `the notices are under the bottom nav (z ${notices})`);
  // The palette is anchored at the top and is the one layer over the notices.
  assert.ok(notices < zOf(palette, /\{open && \(\s*<motion\.div /), 'the notices are over the command palette');
  const provider = toast.slice(toast.indexOf('export function ToastProvider('));
  assert.match(provider, /\{children\}\s*<NoticeViewport /, 'the viewport is not rendered beside the app');
  const providers = code(read('app/providers.tsx'));
  assert.match(providers, /<ToastProvider>\s*<AuthProvider>\{children\}<\/AuthProvider>\s*<\/ToastProvider>/, 'ToastProvider no longer wraps the app shell');
  assert.doesNotMatch(code(read('components/AppShell.tsx')), /NoticeViewport|data-notices/, 'the notices moved inside the app shell');
});

test('two live regions always mounted, a Dismiss with a name, and the motion switches honoured', () => {
  // Reintroduce `{said.polite && <div role="status" …>}`: "the live region mounts with its first message"
  // fails -- most screen readers do not announce a region that appears together with its text.
  const src = code(read('components/Toast.tsx'));
  const view = src.slice(src.indexOf('function NoticeViewport('), src.indexOf('function usePageHidden('));
  for (const [role, live] of [['status', 'polite'], ['alert', 'assertive']]) {
    const re = new RegExp(`<div className="sr-only" role="${role}" aria-live="${live}" aria-atomic="true">\\{said\\.${live}\\}</div>`);
    assert.match(view, re, `the ${live} live region is missing`);
    const at = view.search(re);
    const before = view.slice(Math.max(0, at - 40), at);
    assert.doesNotMatch(before, /&&\s*\(?\s*$|\?\s*\(?\s*$/, `the ${live} live region mounts with its first message`);
  }
  assert.ok(view.indexOf('role="status"') < view.indexOf('<section data-notices'), 'the live regions are inside the notices (they would unmount with them)');
  assert.match(src, /aria-label=\{tr\('Dismiss'\)\}/, 'the ✕ has no name');
  // Errors interrupt, the rest wait.
  assert.match(src, /type === 'error' \? \{ \.\.\.s, assertive: announceText\(s\.assertive, msg\) \} : \{ \.\.\.s, polite: announceText\(s\.polite, msg\) \}/,
    'an error is not announced assertively, or a notice not at all');
  // Both motion hooks, unconditionally (the effects test also holds the slide).
  assert.match(view, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const reduced = plain \|\| !!still;/,
    'the motion switches are read conditionally, or not both');
  const card = src.slice(src.indexOf('function NoticeCard('));
  assert.match(card, /\{!reduced && \(\s*<span aria-hidden key=\{n\.bump\}/, 'the hairline drains under Reduce effects or reduced motion');
  assert.match(card, /drag=\{still \? false : 'y'\}/, 'the card can be dragged under reduced motion');
  assert.match(card, /<StatusGlyph tone=\{n\.busy \? 'accent' : tone\} size=\{16\} working=\{n\.busy\} \/>/, 'a busy notice has no ring, or every notice has one');
  // The clock is JavaScript, stopped while held.
  assert.match(card, /const paused = hover \|\| focus \|\| press \|\| hidden;/, 'a held notice keeps counting down');
  assert.match(card, /useNoticeClock\(n\.duration, n\.bump, paused, \(\) => onDismiss\(n\.id\)\);/);
  assert.doesNotMatch(src, /onAnimationEnd/, 'the notice ends on the hairline\'s animationend (0.001 ms under reduced motion)');
});

test('the four held-by-hand behaviours of a card: a merge restarts its clock, a tap never holds it, a hidden tab stops it, two lines over a dialog', () => {
  // None of these can be run without a DOM, and the walk uses short messages and a mouse, so each is pinned in
  // the source. Reintroduce, one at a time:
  // - `if (seen.current !== bump) { seen.current = bump; }` (no reset): "a merged card leaves on its old
  //   schedule" -- the ×2 card goes while its hairline has just restarted;
  // - `onPointerEnter={() => setHover(true)}`: "one tap holds a notice for good" -- a touch fires the enter
  //   and never the leave;
  // - the visibilitychange listener dropped: "a notice counts down in a background tab";
  // - `line-clamp-2` dropped: "a long notice over a dialog grows up into it".
  const src = code(read('components/Toast.tsx'));
  const clock = src.slice(src.indexOf('function useNoticeClock('), src.indexOf('function NoticeCard('));
  assert.match(clock, /if \(seen\.current !== bump\) \{ seen\.current = bump; c\.reset\(ms\); \}/, 'a merged card leaves on its old schedule');
  assert.match(clock, /if \(paused\) c\.pause\(\); else c\.run\(\);/, 'the clock ignores a hold');
  const card = src.slice(src.indexOf('function NoticeCard('));
  assert.match(card, /onPointerEnter=\{\(e\) => \{ if \(e\.pointerType === 'mouse'\) setHover\(true\); \}\}/, 'one tap holds a notice for good');
  assert.match(card, /onPointerLeave=\{\(e\) => \{ if \(e\.pointerType === 'mouse'\) setHover\(false\); else setPress\(false\); \}\}/, 'one tap holds a notice for good');
  const hidden = src.slice(src.indexOf('function usePageHidden('), src.indexOf('function useNoticeClock('));
  assert.match(hidden, /document\.addEventListener\('visibilitychange', read\);/, 'a notice counts down in a background tab');
  assert.match(hidden, /return \(\) => document\.removeEventListener\('visibilitychange', read\);/, 'the background-tab listener outlives its card');
  assert.match(hidden, /setHidden\(document\.visibilityState === 'hidden'\)/, 'a notice counts down in a background tab');
  assert.match(card, /const tight = oneAtATime\(place\);/);
  assert.match(card, /\$\{tight \? 'line-clamp-2 lg:line-clamp-none' : ''\}/, 'a long notice over a dialog grows up into it');
});

test('one card per flow: a keyed error is never replaced by a success from the same run', () => {
  // Save offline pushed its error inside the loop and "Saved 3 chapters offline" after it under the same key,
  // which took the error's place in the same tick: the reader never learned the device had filled up. The
  // outcome is one card now (offlineOutcome). Reintroduce the success whenever something was saved: "a run that
  // stopped part-way ends as a success" fails; reintroduce the old loop in series/page.tsx: "series/page.tsx: a
  // success with key 'save-offline' follows its error" fails.
  const stopped = offlineOutcome(3, 10, true)!;
  assert.equal(stopped.type, 'error', 'a run that stopped part-way ends as a success');
  assert.equal(stopped.msg, 'Saved 3 of 10 offline — stopped, device storage may be full', 'the stop does not say what was saved');
  assert.deepEqual(offlineOutcome(0, 10, true), { msg: 'Stopped — device storage may be full', type: 'error' });
  assert.deepEqual(offlineOutcome(1, 1, false), { msg: 'Saved 1 chapter offline', type: 'success' }, 'one chapter reads "1 chapters"');
  assert.deepEqual(offlineOutcome(4, 4, false), { msg: 'Saved 4 chapters offline', type: 'success' });
  assert.equal(offlineOutcome(0, 0, false), null);
  // And for every flow in the app: within one function, a toast keyed K with 'error' is not followed by a
  // 'success' keyed K unless a `return` comes first (the flow ended with its error). A catch that follows a
  // try's success is the other order, and fine.
  const files = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')));
  let keyed = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    const src = code(readFileSync(f, 'utf8'));
    const calls = [...src.matchAll(/\btoast\(/g)].map((m) => {
      const at = m.index!;
      const end = callEnd(src, at + 'toast'.length);
      const text = src.slice(at, end);
      const key = /key: (['`][^'`]*['`])/.exec(text)?.[1];
      const type = /,\s*'(info|success|error)'\s*(?:,|\))/.exec(text)?.[1] ?? (/\?\s*'error'\s*:\s*'success'/.test(text) ? 'either' : 'info');
      return { at, end, key, type };
    }).filter((c) => c.key);
    keyed += calls.length;
    for (const e of calls.filter((c) => c.type === 'error' || c.type === 'either')) {
      const later = calls.find((c) => c.at > e.end && c.key === e.key && (c.type === 'success' || c.type === 'either'));
      if (!later) continue;
      const between = src.slice(e.end, later.at);
      // The flow ended with its error (a return), or the success is on another branch or in another function.
      if (/\breturn\b|\belse\b|=>|\bfunction\b/.test(between)) continue;
      assert.fail(`${rel}: a success with key ${e.key} follows its error in the same run -- it would take the error's place unread`);
    }
  }
  assert.ok(keyed >= 10, `only ${keyed} keyed notices found -- the scan is broken`);
});

test('useToast keeps its name and its two arguments; busy is said by the caller, never guessed', () => {
  // Reintroduce `busy: opts.busy ?? /…$/.test(msg)`: "busy is guessed from the words" fails -- a translation
  // without the ellipsis would lose its ring (the critic's ruling). Rename the hook: the export check fails.
  const src = code(read('components/Toast.tsx'));
  assert.match(src, /export const useToast = \(\) => useContext\(Ctx\);/, 'useToast is gone');
  assert.match(src, /export function ToastProvider\(/, 'ToastProvider is gone');
  assert.match(src, /export type Push = \(msg: string, type\?: NoticeType, opts\?: NoticeOpts\) => void;/, 'the push function no longer takes (msg, type?)');
  assert.match(src, /busy: !!opts\.busy,/, 'busy is guessed from the words');
  assert.doesNotMatch(code(read('lib/notices.ts')), /…|\\u2026|\\.\\.\\./, 'lib/notices.ts looks for an ellipsis');
});

test('every busy message says so: an ellipsis toast passes busy, and no finished one does', () => {
  // A toast that says work is going on ("Fetching 3 chapters…", "Checking for new chapters…") carries the
  // turning ring, and the ring comes only from `busy: true`. The whole call is read and split into its
  // arguments: an ellipsis anywhere in the MESSAGE (a literal, a template, a tr(), either arm of a ternary)
  // makes it a busy message, whatever follows. The first scan looked only for an ellipsis closing the call, so
  // `toast('Syncing favorites…', 'info', …)` was never checked. Reintroduce by dropping `busy: true` from
  // TopNav's refresh ("components/TopNav.tsx: a busy message without busy") or from the Offline tab's
  // "Syncing favorites…" ("app/downloads/page.tsx: a busy message without busy"); give a finished message
  // `busy: true` and "a finished message turns" fails.
  const files = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')));
  // Helpers that word a busy message: "Fetching 3 chapters…", "Marking 3 chapters read…".
  const BUSY_HELPERS = /\b(fetchingToast|markingText)\(/;
  assert.match(code(read('lib/jobs.ts')), /export const fetchingToast = [^\n]*…/, 'fetchingToast no longer says it is busy -- update BUSY_HELPERS');
  assert.match(code(read('app/series/page.tsx')), /const markingText = [^\n]*read…/, 'markingText no longer says it is busy -- update BUSY_HELPERS');
  let busy = 0;
  let calm = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    if (rel === 'components/Toast.tsx') continue;
    const src = code(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\btoast\(/g)) {
      const open = m.index! + 'toast'.length;
      const args = splitArgs(src.slice(open + 1, callEnd(src, open) - 1));
      const [msg = '', , opts = ''] = args;
      const saysBusy = BUSY_HELPERS.test(msg) || /…|\\u2026/.test(msg);
      // A ternary may be busy on one arm only ("Looking for chapter names…" or "removed"): its busy says so.
      const passes = /busy: (?!false\b)/.test(opts);
      if (saysBusy) {
        busy++;
        assert.ok(passes, `${rel}: a busy message without busy -- ${msg.trim().slice(0, 140)}`);
      } else if (/busy: true\b/.test(opts)) {
        assert.fail(`${rel}: a finished message turns -- ${msg.trim().slice(0, 140)}`);
      } else calm++;
    }
  }
  assert.ok(busy >= 18, `only ${busy} busy messages found -- the scan is broken`);
  assert.ok(calm >= 40, `only ${calm} other messages found -- the scan is broken`);
  // TopNav's refresh is translated now, and its result takes the busy card's place.
  const nav = code(read('components/TopNav.tsx'));
  assert.match(nav, /toast\(tr\('Checking for new chapters…'\), 'info', \{ busy: true, key: 'refresh' \}\);/, 'TopNav\'s check is untranslated or not busy');
  assert.match(nav, /toast\(tr\('Library refreshed'\), 'success', \{ key: 'refresh' \}\);/, 'TopNav\'s result is untranslated or stacks under the busy card');
});

test('a sheet on a page with the bottom nav clears it; only the reader\'s sheets run to the bottom edge', () => {
  // The critic's gap: a Sheet opened without `overBottomNav` on a page that has the nav puts its last rows
  // under the bar, and it would be measured as a reader sheet. Reintroduce by dropping `overBottomNav` from
  // the chapter filter sheet: "components/ChapterFilterSheet.tsx opens a Sheet without overBottomNav" fails.
  const READER = new Set(['components/ChapterSheet.tsx', 'components/PageGrid.tsx']);
  const files = walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')));
  let sheets = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    const src = code(readFileSync(f, 'utf8'));
    // The opening tag, read past the `=>` of an arrow function in its props.
    for (const m of src.matchAll(/<Sheet\b((?:=>|[^>])*?)>/g)) {
      sheets++;
      if (READER.has(rel)) assert.doesNotMatch(m[1], /overBottomNav/, `${rel}: a reader sheet claims a nav band the reader does not have`);
      else assert.match(m[1], /\boverBottomNav\b/, `${rel} opens a Sheet without overBottomNav`);
    }
  }
  assert.ok(sheets >= 10, `only ${sheets} <Sheet> tags found -- the scan is broken`);
  // The reader's sheets hand their panel over to be measured.
  assert.match(code(read('components/ui.tsx')), /useLayer\('dialog', true, \{ navBandFree: !!overBottomNav, ref: overBottomNav \? undefined : panelRef \}\);/,
    'a reader sheet is not measured, so a notice sits on its last rows');
  assert.match(code(read('components/ui.tsx')), /<div\s+ref=\{panelRef\}/, 'the measured element is not the sheet\'s panel');
  const rs = code(read('components/ReaderSettings.tsx'));
  assert.match(rs, /useLayer\('dialog', true, \{ ref: panelRef \}\);/, 'the reader settings sheet is not measured');
  assert.match(rs, /<motion\.div\s+ref=\{panelRef\}\s+initial=\{\{ y: '100%' \}\}/, 'the measured element is not the settings panel');
});
