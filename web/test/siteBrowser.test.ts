// Open site (v0.91.0, #314), the web's half: the live page's lines, where a pointer lands on the page, and the promises the
// sheet keeps -- keys go to the page and never to the sheets under it, a finger is a tap or a scroll, leaving the sheet any
// way still leaves the page, and the extension sheet offers it with its own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagePoint, splitLines, SITE_TEXT, type SiteLine } from '../lib/siteBrowser';

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

test('input goes in order and in batches, and pointer moves only as the latest', () => {
  const lib = read('lib/siteBrowser.ts');
  assert.match(lib, /sending = sending\.then\(\(\) =>/, 'a post waits for the one before it: a click never overtakes the keys typed first');
  assert.match(lib, /if \(i\.type === 'event' && i\.eventType === 'mousemove' && last\?\.type === 'event' && last\.eventType === 'mousemove'\) queue\[queue\.length - 1\] = i;/);
  assert.match(lib, /apiResponse\(`\/api\/admin\/extensions\/site\/\$\{enc\(session\)\}\/stream`, \{ signal \}\)/, 'the stream is read with the admin\'s token, not EventSource');
});
