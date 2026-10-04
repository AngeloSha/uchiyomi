// Notice chapters in the web app (bff lib/noticeChapters.ts): the per-type switches in Admin → Settings, the
// per-series switch in the Sources & translations sheet, and the series type in Edit series. Reads the source as
// text, as the other settings tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SERIES_TYPES, seriesTypeKey } from '../lib/seriesTypes';
import { metaBody, seedMeta } from '../lib/seriesMeta';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('one switch per series type, the server\'s six in its order, each with a label', () => {
  assert.deepEqual([...SERIES_TYPES], ['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'unknown']);
  assert.deepEqual(SERIES_TYPES.map(seriesTypeKey), ['Manga', 'Manhwa', 'Manhua', 'Webtoon', 'Comic', 'Unknown / other']);
});

test('Admin → Settings: the section comes after the pinned ones and saves the list whole', () => {
  const src = read('components/AdminSettings.tsx');
  const grid = src.slice(src.indexOf('<div className={SETTINGS_GRID}>\n      <ServerSection'));
  assert.match(grid, /<SourceOrderSection [^\n]*\/>\s*<NoticeChaptersSection /, 'Notice chapters is not last, after the source order');
  const section = src.slice(src.indexOf('function NoticeChaptersSection('));
  assert.match(section, /save\(\{ hideNoticeTypes: next \}\)/, 'the section does not PATCH hideNoticeTypes');
  // Held locally and rolled back on a failed save, so two quick flips do not undo each other.
  assert.match(section, /setTypes\(prev\)/);
  assert.match(section, /SERIES_TYPES\.map/);
});

test('both switches say what they hide: the short x.y chapters, not every fraction', () => {
  // The owner's rule (v0.55.2): only a chapter numbered like 12.5 with 3 pages or fewer is a notice. Reintroduce the
  // PR's text ("every chapter numbered with a fraction"): neither matches.
  const settings = read('components/AdminSettings.tsx');
  const section = settings.slice(settings.indexOf('function NoticeChaptersSection('));
  assert.match(section, /chapters numbered like 12\.5 with 3 pages or fewer are hidden/, 'the Settings text does not say what it hides');
  assert.match(read('components/SourcesSheet.tsx'), /numbered like 12\.5, with 3 pages or fewer/, 'the series switch does not say what it hides');
});

test('"Only hide short ones": a switch of its own, on unless the server says off, and every sentence follows it (v0.55.3)', () => {
  // TIGamingTV's switch (#147). Off hides every chapter numbered like 12.5 of the types switched on, real chapters a site
  // split into parts included, so its help says so before it is flipped, and the section's sentence and the series'
  // switch say which rule is in force. Reintroduce the sheet's one sentence: "the series switch says the off rule" fails.
  const settings = read('components/AdminSettings.tsx');
  const section = settings.slice(settings.indexOf('function NoticeChaptersSection('));
  assert.match(section, /const shortOnly = data\.hideNoticeShortOnly !== false;/, 'on unless the server says off');
  assert.match(section, /<SwitchRow label=\{tr\('Only hide short ones \(3 pages or fewer\)'\)\}/);
  assert.match(section, /help=\{tr\('Off hides every chapter numbered like 12\.5 of the types switched on, including real chapters a site split into parts\.'\)\}/,
    'the switch does not say what off hides');
  assert.match(section, /on=\{shortOnly\} onChange=\{\(next\) => save\(\{ hideNoticeShortOnly: next \}\)\}/, 'the switch does not PATCH hideNoticeShortOnly');
  assert.match(section, /description=\{shortOnly\s*\? tr\('[^']*with 3 pages or fewer are hidden[^']*'\)\s*: tr\('[^']*every chapter numbered like 12\.5 is hidden[^']*'\)\}/,
    'the section says one rule whichever is in force');
  const sheet = read('components/SourcesSheet.tsx');
  assert.match(sheet, /series\.hideNoticeShortOnly === false\s*\? tr\('Hide notice chapters \(numbered like 12\.5\) here, in Mihon and everywhere else\. Switching this off shows them again\.'\)/,
    'the series switch says the off rule');
});

test('the Sources & translations sheet: what applies, its own choice, and the way back to the type', () => {
  const src = read('components/SourcesSheet.tsx');
  assert.match(src, /method: 'PATCH', json: \{ hideNotices: on \}/);
  assert.match(src, /checked=\{series\.hideNoticesEffective\}/, 'the box must show what applies, not only the series\' own value');
  assert.match(src, /setHideNotices\(null\)/, 'no way back to the type\'s switch');
  assert.match(src, /'series-books'/, 'the chapter list is not refetched after a flip');
});

test('the sheet says how many it hides as a label, which reads right at 1 in every language', () => {
  // "{n} hidden now." was a counted sentence with no "1 ..." twin: "1 masqués", "1 ocultos" in fr, es and pt-BR.
  // A label takes any number. Reintroduce the sentence: the sheet's key is not this one, and the old one is back.
  const src = read('components/SourcesSheet.tsx');
  assert.match(src, /tr\('Hidden now: \{n\}\.', \{ n: series\.hiddenNotices \?\? 0 \}\)/, 'the hidden count is not the label');
  for (const lang of ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']) {
    const loc = JSON.parse(read(`public/locales/${lang}.json`));
    assert.equal(loc['{n} hidden now.'], undefined, `${lang} still carries the counted sentence`);
    assert.ok(loc['Hidden now: {n}.']?.includes('{n}'), `${lang} has no label for the hidden count`);
  }
});

test('the Settings page is called by its own name in every language', () => {
  // fr said "Réglages" where its Settings page is "Paramètres": the sheet and Edit details point at a page by a name it
  // does not carry. A stem, for languages that decline it (ru "в Настройках"). Reintroduce "Réglages": fr fails.
  for (const lang of ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']) {
    const loc = JSON.parse(read(`public/locales/${lang}.json`));
    const settings: string = loc['Settings'];
    const stem = settings.slice(0, Math.max(2, settings.length - 1));
    for (const key of ['Following the switch for {type} in Settings.',
      'What the notice-chapter switches in Settings go by. Automatic takes it from the genres, then the source, then AniList.']) {
      assert.ok(loc[key]?.includes(stem), `${lang}: "${loc[key]}" does not name the Settings page ("${settings}")`);
    }
  }
});

test('Edit details: the type is sent on every save, null for automatic, seeded from the override only', () => {
  const series = { name: 'x', metadata: {}, overrides: null } as any;
  assert.equal(seedMeta(series).seriesType, '', 'a detected type must not be seeded as an override');
  assert.equal(seedMeta({ ...series, overrides: { seriesType: 'manhwa' } }).seriesType, 'manhwa');
  assert.equal(metaBody({ ...seedMeta(series), seriesType: '' }).seriesType, null);
  assert.equal(metaBody({ ...seedMeta(series), seriesType: 'comic' }).seriesType, 'comic');
  const src = read('components/SeriesEditor.tsx');
  assert.match(src, /onPick=\{\(seriesType\) => save\(\{ seriesType \}\)\}/, 'the Reading tab has no Series type row');
});
