// The reader's settings for ONE device (v0.61.0, lib/readerDevice.ts): the colour filter, the tap zones, the keys and
// the controller. Kept in this browser and never synced -- and never mistaken for a series' or a source's memory,
// which lib/readerPrefs.ts collects by key prefix and pushes to the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  get length() { return mem.size; },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as any).window = globalThis;

test('a stored device setting is made whole, and anything unknown is today\'s reader', async () => {
  const d = await import('../lib/readerDevice');
  // Reintroduce by trusting what storage holds (return `r` as it came): junk survives as a filter nobody can unset.
  assert.deepEqual(d.migrateDevicePrefs(undefined), d.DEFAULT_DEVICE);
  assert.deepEqual(d.migrateDevicePrefs('junk'), d.DEFAULT_DEVICE);
  assert.deepEqual(d.migrateDevicePrefs([1, 2]), d.DEFAULT_DEVICE);
  assert.equal(d.migrateDevicePrefs({ colorFilter: 'sepia' }).colorFilter, 'none');
  assert.equal(d.migrateDevicePrefs({ colorFilter: 'eink' }).colorFilter, 'eink');
  assert.equal(d.DEFAULT_DEVICE.colorFilter, 'none', 'the default filters the pages of every install');
  mem.clear();
  assert.deepEqual(d.loadDevicePrefs(), d.DEFAULT_DEVICE, 'nothing stored');
  mem.set(d.DEVICE_KEY, '{not json');
  assert.deepEqual(d.loadDevicePrefs(), d.DEFAULT_DEVICE, 'unreadable storage');
  d.saveDevicePrefs({ ...d.DEFAULT_DEVICE, colorFilter: 'invert' });
  assert.equal(d.loadDevicePrefs().colorFilter, 'invert');
  // Tap zones, keys and controller buttons (G5): unknown layouts are Automatic, bindings that are not keys are dropped.
  assert.equal(d.DEFAULT_DEVICE.tapLayout, 'auto', 'the default taps are not today\'s');
  assert.deepEqual([d.DEFAULT_DEVICE.keys, d.DEFAULT_DEVICE.pad], [{}, {}], 'the default keys are not today\'s');
  assert.equal(d.migrateDevicePrefs({ tapLayout: 'corners' }).tapLayout, 'auto');
  assert.equal(d.migrateDevicePrefs({ tapLayout: 'lshape' }).tapLayout, 'lshape');
  const keys = d.migrateDevicePrefs({ keys: { next: ['j', 'Escape', 'Control+n'], nope: ['x'] }, pad: { menu: [9, 99, 'x'] } });
  assert.deepEqual(keys.keys, { next: ['j'] });
  assert.deepEqual(keys.pad, { menu: [9] });
  assert.deepEqual(d.migrateDevicePrefs({ keys: 'j', pad: [1] }).keys, {});
  mem.clear();
});

test('the device key is never collected as a series\' or a source\'s memory', async () => {
  // allSeriesPrefs() and allSourcePrefs() push every key under these prefixes to the account. Reintroduce by naming the
  // key `yomi_rs_device`: this fails, and the device's settings would arrive on every other device as a series.
  const d = await import('../lib/readerDevice');
  assert.ok(!d.DEVICE_KEY.startsWith('yomi_rs_') && !d.DEVICE_KEY.startsWith('yomi_rp_'), d.DEVICE_KEY);
  assert.equal(d.DEVICE_KEY, 'yomi_reader_device');
  // And the account's reader settings never carry it.
  assert.doesNotMatch(code(read('lib/readerPrefs.ts')), /colorFilter|tapLayout|yomi_reader_device/, 'a device setting reached the synced reader settings');
});

test('the colour filters, and E-ink moves without a glide', async () => {
  const d = await import('../lib/readerDevice');
  assert.equal(d.COLOR_FILTER.none, undefined, 'None must set no filter at all');
  assert.equal(d.COLOR_FILTER.invert, 'invert(1) hue-rotate(180deg)');
  assert.equal(d.COLOR_FILTER.grayscale, 'grayscale(1)');
  assert.equal(d.COLOR_FILTER.eink, 'grayscale(1) contrast(1.3)');
  assert.equal(d.glide('eink'), 'auto');
  for (const f of ['none', 'invert', 'grayscale'] as const) assert.equal(d.glide(f), 'smooth');
  // Every page move of the reader goes through it: no hard-coded glide is left. Reintroduce `behavior: 'smooth'` in a
  // page turn: this fails, and an e-ink screen smears every turn again.
  const page = code(read('app/reader/page.tsx'));
  assert.doesNotMatch(page, /behavior: 'smooth'/, 'a page move glides whatever the filter');
  assert.match(page, /const behavior = glide\(device\.colorFilter\);/);
});

test('the colour filter is on the page images, never on the column, the track or a card', () => {
  // Reintroduce by laying COLOR_FILTER on the column's or the track's `filter` beside THEME_FILTER: Up Next, the failure
  // card and every button in the track are inverted with the pages. Drop it from ReaderImg: no page is filtered.
  const page = code(read('app/reader/page.tsx'));
  assert.match(page, /<div className="mx-auto" style=\{\{ width: colW \|\| '100%', filter: THEME_FILTER\[prefs\.theme\] \}\}>/, 'the column\'s filter is no longer the theme alone');
  assert.match(page, /className="hide-scrollbar flex h-screen-d snap-x snap-mandatory overflow-x-auto overflow-y-hidden" style=\{\{ filter: THEME_FILTER\[prefs\.theme\] \}\}/, 'the track\'s filter is no longer the theme alone');
  assert.doesNotMatch(page, /THEME_FILTER\[[^\]]+\][^}]*COLOR_FILTER|COLOR_FILTER[^}]*THEME_FILTER/, 'the colour filter is laid over a container with the theme');
  const img = code(read('components/ReaderPage.tsx'));
  assert.match(img, /style=\{filter \? \{ \.\.\.style, filter \} : style\}/, 'ReaderImg no longer puts the filter on the image');
  assert.match(img, /style=\{imgFilter \? \{ filter: imgFilter \} : undefined\}/, 'a collapsed page\'s thumbnail is not filtered with the pages');
  // Every page image in both renderers is handed it.
  const vertical = page.slice(page.indexOf('<ReaderPageRow key={p.key}'), page.indexOf('{ended && upNextCard}'));
  assert.match(vertical, /imgFilter=\{imgFilter\}/, 'the column\'s rows are not handed the filter');
  const paged = page.slice(page.indexOf('hide-scrollbar flex h-screen-d snap-x'), page.indexOf('{ended && ('));
  const pageImages = paged.match(/<(ReaderImg|SlideRegion|SlideTurned|SlidePending)\b[^>]*?>/gs) ?? [];
  assert.ok(pageImages.length >= 5, `only ${pageImages.length} page images found in the track -- the scan is broken`);
  for (const tag of pageImages) assert.match(tag, /filter=\{imgFilter\}/, `a page image of the track is not filtered: ${tag.slice(0, 80)}`);
});

test('the column width is this device\'s: a step of 30 to 100, the full width for anything else', async () => {
  const d = await import('../lib/readerDevice');
  // #233. 100 is the column as it always was, so an install that never touches it reads as before.
  assert.equal(d.DEFAULT_DEVICE.columnWidth, 100);
  assert.equal(d.migrateDevicePrefs({ columnWidth: 60 }).columnWidth, 60);
  assert.equal(d.migrateDevicePrefs({ columnWidth: 62 }).columnWidth, 60, 'a value between steps lands on one');
  assert.equal(d.migrateDevicePrefs({ columnWidth: 30 }).columnWidth, 30);
  // Reintroduce by trusting storage: a 10 % column -- or a NaN width, no column at all -- survives every reload.
  for (const junk of [10, 250, -5, 'wide', null, NaN, Infinity, [50]]) {
    assert.equal(d.migrateDevicePrefs({ columnWidth: junk }).columnWidth, 100, String(junk));
  }
  // One store for this device's settings, not a second beside it (the PR's yomi_reader_width): it travels with the rest.
  d.saveDevicePrefs({ ...d.DEFAULT_DEVICE, columnWidth: 45 });
  assert.equal(d.loadDevicePrefs().columnWidth, 45);
  mem.clear();
  assert.doesNotMatch(code(read('lib/readerPrefs.ts')), /columnWidth/, 'the column width reached the synced reader settings');
});

test('the column width narrows the reader\'s column, and its row says it is this device\'s', () => {
  // Reintroduce the measure without it: the slider moves and the column does not.
  assert.match(code(read('app/reader/page.tsx')), /const base = \(prefs\.fitWidth \? Math\.min\(w, 860\) : w\) \* \(device\.columnWidth \/ 100\);/);
  const sheet = code(read('components/ReaderSettings.tsx'));
  assert.match(sheet, /label=\{`\$\{tr\('Column width'\)\} · \$\{tr\('This device'\)\} · \$\{device\.columnWidth\}%`\}/);
  assert.match(sheet, /onChange=\{\(e\) => setDevice\(\{ columnWidth: Number\(e\.target\.value\) \}\)\}/);
  assert.doesNotMatch(sheet, /readerWidth|useReaderWidth/, 'a second store for one device setting');
});
