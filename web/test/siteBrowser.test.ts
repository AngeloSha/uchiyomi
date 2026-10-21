// Open site (v0.91.0, #314), the web's half: the live page's lines, where a pointer lands on the page, and the promises the
// sheet keeps -- keys go to the page and never to the sheets under it, a finger is a tap or a scroll, leaving the sheet any
// way still leaves the page, and the extension sheet offers it with its own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagePoint, splitLines, SITE_TEXT, TYPER_FILL, typedDiff, typedInput, type SiteLine } from '../lib/siteBrowser';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the live page is read a line at a time, across chunks, and a broken line is skipped', () => {
  const got: SiteLine[] = [];
  let rest = splitLines('{"type":"address","url":"https://batcave.biz/","title":"BatCave"}\n{"type":"fr', (l) => got.push(l));
  assert.equal(got.length, 1);
  assert.equal(rest, '{"type":"fr', 'half a line waits for the rest');
  rest = splitLines(`${rest}ame","seq":1,"png":"iVBO"}\nnot json\n\n{"type":"closed","reason":"done"}\n`, (l) => got.push(l));
  assert.equal(rest, '');
  assert.deepEqual(got.map((l) => l.type), ['address', 'frame', 'closed']);
});

test('a pointer lands on the page in its own pixels, wherever the picture is drawn', () => {
  const box = { left: 10, top: 50, width: 400, height: 300 };
  assert.deepEqual(pagePoint(10, 50, box, { width: 400, height: 300 }), { x: 0, y: 0 }, 'the same size: one to one');
  assert.deepEqual(pagePoint(210, 200, box, { width: 400, height: 300 }), { x: 200, y: 150 });
  // A box resized before the next picture: the old picture is drawn object-contain at the top left, half size here.
  assert.deepEqual(pagePoint(110, 100, box, { width: 800, height: 600 }), { x: 200, y: 100 });
  assert.equal(pagePoint(5, 60, box, { width: 400, height: 300 }), null, 'left of the picture');
  assert.equal(pagePoint(400, 345, box, { width: 800, height: 400 }), null, 'below the picture, in its letterbox');
  assert.equal(pagePoint(20, 60, box, { width: 0, height: 0 }), null, 'no picture yet: nothing to click');
});

test('the sheet: keys stay on the page, a finger taps or scrolls, and leaving it any way leaves the page', () => {
  const sheet = read('components/SiteBrowserSheet.tsx');
  assert.match(sheet, /const onKey = \(e: KeyboardEvent<HTMLTextAreaElement>\) => \{\s*e\.stopPropagation\(\);/,
    'a key typed on the site never reaches the Sheet under it (Escape would close it)');
  assert.match(sheet, /if \(t && !t\.moved && p\) \{\s*send\(\{ type: 'event', eventType: 'mousedown'/, 'a tap is a click where it landed');
  assert.match(sheet, /send\(\{ type: 'event', eventType: 'wheel', clickX: p\.x, clickY: p\.y, clientX: p\.x, clientY: p\.y, deltaY: dy \}\)/, 'a finger that moves scrolls');
  assert.match(sheet, /return \(\) => \{\s*gone = true;\s*ac\.abort\(\);\s*sender\.current\?\.stop\(\);\s*if \(session\.current\) void closeSite\(session\.current\)/,
    'closing the sheet without Done still leaves the page, so the engine saves and frees its browser');
  assert.match(sheet, /className="[^"]*touch-none[^"]*"/, 'the page area is the page\'s own: no browser scroll or zoom over it');
  assert.match(sheet, /onPaste=\{\(e\) => \{ e\.preventDefault\(\); const t = e\.clipboardData\.getData\('text'\); if \(t\) send\(\{ type: 'paste'/,
    'pasting a password reaches the page');
  const ext = read('components/ExtensionSheet.tsx');
  assert.match(ext, /<button type="button" className="btn-key shrink-0" onClick=\{\(\) => setSiteOpen\(true\)\} data-ext-open-site>/);
  assert.match(ext, /\{siteOpen && <SiteBrowserSheet sourceId=\{settingsOf\} name=\{ext\.name\} onClose=\{\(\) => setSiteOpen\(false\)\} \/>\}/,
    'it opens the site of the source the sheet is about');
  assert.equal(SITE_TEXT[0], 'Open site');
});

test('v0.91.1: a press or a tap on the page keeps the keys going to it (v0.91.0 lost every key typed after a click)', () => {
  const sheet = read('components/SiteBrowserSheet.tsx');
  // The bug: onPointerDown focused the field, then the browser's own mousedown moved the focus off it (onto <body>), so
  // the field's key handlers never saw a key. Measured in a real browser against the real engine: focus "body", 0 keys.
  const page =sheet.slice(sheet.indexOf('<div ref={box}'), sheet.indexOf('data-site-page>'));
  assert.match(page, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, 'a press on the page leaves the focus where it is: on the typing field');
  assert.match(page, /onTouchEnd=\{\(\) => \{ if \(tapped\.current\) \{ tapped\.current = false; focusTyper\(\); \} \}\}/,
    'a tap gives the field the focus in its touchend, where iOS brings up its keyboard');
  assert.match(sheet, /if \(e\.pointerType === 'touch'\) tapped\.current = true;\s*else focusTyper\(\);/, 'a mouse press focuses the field at once');
  assert.match(sheet, /t\.moved = true;\s*tapped\.current = false;/, 'a finger that scrolled brings up no keyboard');
  const field = sheet.slice(sheet.indexOf('<textarea ref={typer}'), sheet.indexOf('/>', sheet.indexOf('<textarea ref={typer}')));
  assert.doesNotMatch(field, /-left-\[/, 'the field is in the box, not off screen: focusing it scrolls nothing');
  assert.match(field, /pointer-events-none/, 'never pressed itself, so nothing can select its filler');
  assert.match(field, /select-text/, 'iOS types into nothing under a select-none ancestor unless the field says select-text');
  assert.match(field, /text-\[16px\]/, 'iOS zooms to a focused field under 16px');
  assert.match(field, /onFocus=\{freshTyper\}/);
  assert.match(field, /onInput=\{\(e\) => onTyped\(e\.currentTarget, \(e\.nativeEvent as InputEvent\)\.isComposing\)\}/,
    'what a phone\'s keyboard does to the field is what is typed');
});

test('v0.94.0: a link the site emailed opens in the page, from a row of its own', () => {
  // A sign-in link signs in whichever browser opens it: opened in the admin's own browser it signed in nothing the engine
  // has (BatCave answered it with "MySQL Error!"), so the sheet takes it and the engine's browser opens it.
  const sheet = read('components/SiteBrowserSheet.tsx');
  assert.match(sheet, /onClick=\{\(\) => \{ setLinking\(\(v\) => !v\); setLinkError\(null\); \}\} data-site-link>/);
  const row = sheet.slice(sheet.indexOf('data-site-link-row'), sheet.indexOf('</form>'));
  assert.match(row, /onKeyDown=\{\(e\) => \{ e\.stopPropagation\(\); if \(e\.key === 'Escape'\) setLinking\(false\); \}\}/,
    'keys typed into the link are the field\'s: Escape closes the row, never the sheet under this one');
  assert.match(row, /type="url"/);
  assert.match(row, /text-\[16px\]/, 'iOS zooms to a focused field under 16px');
  assert.match(sheet, /if \(e instanceof ApiError && e\.status === 422\) setLinkError\(tr\(LINK_TEXT\[3\], \{ site \}\)\);/, 'a link off the site says so');
  const lib = read('lib/siteBrowser.ts');
  assert.match(lib, /api<\{ ok: true \}>\(`\/api\/admin\/extensions\/site\/\$\{enc\(session\)\}\/open`, \{ json: \{ url \} \}\)/);
});

test('a phone\'s typing, as the page\'s Backspaces and text', () => {
  assert.deepEqual(typedDiff(TYPER_FILL, `${TYPER_FILL}h`), { back: 0, text: 'h' });
  assert.deepEqual(typedDiff(`${TYPER_FILL}he`, `${TYPER_FILL}h`), { back: 1, text: '' }, 'Backspace');
  assert.deepEqual(typedDiff(TYPER_FILL, TYPER_FILL.slice(1)), { back: 1, text: '' }, 'Backspace with nothing typed yet: the filler takes it');
  assert.deepEqual(typedDiff(`${TYPER_FILL}teh`, `${TYPER_FILL}the `), { back: 2, text: 'he ' }, 'a word the keyboard corrected');
  assert.deepEqual(typedDiff(`${TYPER_FILL}a😀`, `${TYPER_FILL}a`), { back: 1, text: '' }, 'one character, not two UTF-16 units');
  assert.deepEqual(typedDiff(TYPER_FILL, TYPER_FILL), { back: 0, text: '' });
  const down = (key: string) => ({ type: 'event', eventType: 'keydown', clickX: 0, clickY: 0, key });
  const up = (key: string) => ({ type: 'event', eventType: 'keyup', clickX: 0, clickY: 0, key });
  assert.deepEqual(typedInput(2, 'he'), [down('Backspace'), up('Backspace'), down('Backspace'), up('Backspace'), { type: 'paste', data: 'he' }],
    'Backspaces first, then the text');
  assert.deepEqual(typedInput(0, 'me\nyou\tx'), [{ type: 'paste', data: 'me' }, down('Enter'), up('Enter'), { type: 'paste', data: 'you' }, down('Tab'), up('Tab'), { type: 'paste', data: 'x' }],
    'a line break is Enter and a tab is Tab: keys for the page, not text');
  assert.deepEqual(typedInput(0, ''), []);
});

test('input goes in order, one post at a time, and pointer moves only as the latest', () => {
  const lib = read('lib/siteBrowser.ts');
  // v0.91.0 started a post every 40 ms, each chained behind the one before: over a home server's connection the keys
  // arrived twenty seconds after they were typed, behind the mouse moves queued ahead of them.
  assert.match(lib, /if \(dead \|\| posting \|\| !queue\.length\) return;/, 'one post on its way at a time: a click never overtakes the keys typed first');
  assert.match(lib, /posting = false;\s*if \(queue\.length && !timer\) timer = setTimeout\(flush, 0\);/, 'what came meanwhile goes at once, together');
  assert.match(lib, /if \(!timer && !posting\) timer = setTimeout\(flush, 40\);/);
  assert.doesNotMatch(lib, /sending = sending\.then/, 'no chain of posts');
  assert.match(lib, /if \(i\.type === 'event' && i\.eventType === 'mousemove' && last\?\.type === 'event' && last\.eventType === 'mousemove'\) queue\[queue\.length - 1\] = i;/);
  assert.match(lib, /else if \(i\.type === 'seen'\) queue = \[\.\.\.queue\.filter\(\(q\) => q\.type !== 'seen'\), i\];/, 'which picture the sheet has: only the latest');
  const sheet = read('components/SiteBrowserSheet.tsx');
  assert.match(sheet, /if \(l\.type === 'frame'\) \{ setFrame\(`data:image\/jpeg;base64,\$\{l\.jpeg\}`\); send\(\{ type: 'seen', seq: l\.seq \}\); \}/,
    'each picture is said to have arrived, so the server sends the next (v0.91.1): never a queue of them');
  assert.match(lib, /apiResponse\(`\/api\/admin\/extensions\/site\/\$\{enc\(session\)\}\/stream`, \{ signal \}\)/, 'the stream is read with the admin\'s token, not EventSource');
});
