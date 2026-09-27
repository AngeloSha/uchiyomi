// Chapter vs volume labelling. Old manga is often stored as tomes (CBR per volume), and labelling those
// "Ch. 1" misreads the library.
//
// And, since v0.49.0, time: lib/format.ts is the one module every surface formats clocks, durations,
// estimates and "ago" through, so the same two minutes read the same on Health, Downloads and the archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isVolumeName, chapterLabel, chapterName, bytes, progressOf, formatClock, durationText, etaLine, etaText, untilText,
  relativeTime, relativeTimeShort, setActiveLocale, activeLocale, wallClock,
} from '../lib/format';

test('recognises volume-style names', () => {
  for (const n of ['Tome 01', 'tome12', 'Volume 12', 'Vol. 3', 'vol.3', 'T05', 'v01', 'Berserk T41', 'Naruto Tome 07 (FR)']) {
    assert.equal(isVolumeName(n), true, `${n} should be a volume`);
  }
});

test('chapter markers win over volume markers', () => {
  // a release-version suffix must not turn a chapter into a volume
  assert.equal(isVolumeName('Ch. 5 v2'), false);
  assert.equal(isVolumeName('Chapter 12'), false);
  assert.equal(isVolumeName('Chapitre 4'), false);
  assert.equal(isVolumeName('Episode 3'), false);
});

test('does not mistake ordinary titles for volumes', () => {
  for (const n of ['One Piece 1045', 'Titan 05', 'Revolution 5', 'Solo Leveling 110']) {
    assert.equal(isVolumeName(n), false, `${n} should not be a volume`);
  }
  assert.equal(isVolumeName(''), false);
  assert.equal(isVolumeName(null), false);
});

test('chapterLabel picks the right noun', () => {
  assert.equal(chapterLabel({ number: 1, name: 'Tome 01' }), 'Vol. 1');
  assert.equal(chapterLabel({ number: 12, name: 'Chapter 12' }), 'Ch. 12');
  assert.equal(chapterLabel({ metadata: { number: '4.5' }, name: 'Chapter 4.5' }), 'Ch. 4.5');
  assert.equal(chapterLabel({ name: 'Extras' }), 'Extras', 'no number -> fall back to the name');
  assert.equal(chapterLabel({}), '');
});

test("chapterName is the server's name for the chapter, and never the file's", () => {
  // The server strips the number off the front and keeps only a real name (bff lib/library.ts chapterName, which
  // has its own tests). Here: nothing else is ever shown. Reintroduce the fallback to `name`/`metadata.title` and
  // the second assertion reads the filename -- which is what #84 as first written did on a hand-built library.
  assert.equal(chapterName({ chapterName: 'Romance Dawn' }), 'Romance Dawn');
  assert.equal(chapterName({ chapterName: null, name: 'One Piece v02 c012 [Digital]', metadata: { title: 'One Piece v02 c012 [Digital]', number: '12' } } as any), '');
  assert.equal(chapterName({ chapterName: '  ' }), '');
  assert.equal(chapterName({}), '');
});

test('bytes formats human sizes', () => {
  assert.match(bytes(0), /0/);
  assert.match(bytes(2_500_000), /MB/i);
  assert.equal(bytes(null), bytes(0));
});

test('progressOf reports a 0..1 fraction for the progress bar', () => {
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 50, completed: false } }), 0.5);
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 10, completed: true } }), 1, 'completed is always full');
  assert.equal(progressOf({ media: { pagesCount: 100 }, readProgress: { page: 250, completed: false } }), 1, 'never overflows the bar');
  assert.equal(progressOf({ media: { pagesCount: 0 } }), 0, 'unknown page count must not divide by zero');
  assert.equal(progressOf({ media: { pagesCount: 100 } }), 0, 'unread');
});

/* ================================================================ time, said one way everywhere (v0.49.0) */

// The v0.48.4 relativeTime, verbatim: the English output must stay byte-identical to it.
function relativeTimeV0484(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatClock is a stopwatch: m:ss, then h:mm:ss, and never NaN', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(7_000), '0:07');
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(134_999), '2:14', 'a second is shown only once it has passed');
  assert.equal(formatClock(3_723_000), '1:02:03');
  assert.equal(formatClock(-4_000), '0:00', 'a clock read a moment before its start reads 0:00, not -0:04');
  assert.equal(formatClock(NaN), '0:00');
});

test('etaLine says how long before anyone presses, rounded up, with a singular and hours past 90 minutes', () => {
  // Reintroduce by dropping the singular branch: "Up to 1 minutes" fails the third line.
  assert.equal(etaLine({ maxMs: 5_000 }), 'A few seconds');
  assert.equal(etaLine({ maxMs: 45_000 }), 'Under a minute');
  assert.equal(etaLine({ maxMs: 60_000 }), 'Up to 1 minute');
  assert.equal(etaLine({ maxMs: 600_000 }), 'Up to 10 minutes');
  assert.equal(etaLine({ maxMs: 4 * MIN + 20_000 }), 'Up to 5 minutes', 'rounded UP: "up to 4" about a 4:20 run says it is stuck');
  assert.equal(etaLine({ minMs: 60_000, maxMs: 300_000 }), '1–5 minutes');
  assert.equal(etaLine({ minMs: 30_000, maxMs: 300_000 }), 'Up to 5 minutes', 'a lower bound under a minute is not a range');
  assert.equal(etaLine({ maxMs: 4 * HOUR }), 'Up to 4 hours', '"up to 240 minutes" is a number nobody reads as four hours');
  assert.equal(etaLine({ minMs: HOUR, maxMs: 3 * HOUR }), '1–3 hours');
  assert.equal(etaLine({ maxMs: 300_000, lastMs: 134_000 }), 'Up to 5 minutes · Last time 2:14');
  assert.equal(etaLine({ maxMs: NaN }), 'A few seconds');
});

test('etaText is coarse on purpose: under an hour, hours up to two days, then days', () => {
  // Reintroduce by dropping the singulars: "About 1 hours" fails.
  assert.equal(etaText(20 * MIN), 'Under an hour');
  assert.equal(etaText(HOUR), 'About 1 hour');
  assert.equal(etaText(5 * HOUR + 10 * MIN), 'About 5 hours');
  assert.equal(etaText(47 * HOUR), 'About 47 hours', '"about 1 day" for 47 hours is a day out');
  assert.equal(etaText(DAY * 2), 'About 2 days');
  assert.equal(etaText(DAY * 30), 'About 30 days');
  assert.equal(etaText(-5), 'Under an hour');
});

test('durationText speaks the reader\'s language through Intl, at the scale worth reading', () => {
  setActiveLocale('en');
  assert.equal(durationText(45_000), '45 sec');
  assert.equal(durationText(4 * MIN), '4 min');
  assert.equal(durationText(65 * MIN), '1 hr 5 min');
  assert.equal(durationText(2 * HOUR), '2 hr', 'no "0 min" tail');
  assert.equal(durationText(51 * HOUR), '2 days 3 hr');
  setActiveLocale('de');
  assert.equal(durationText(65 * MIN), '1 Std., 5 Min.');
  setActiveLocale('ar');
  assert.match(durationText(4 * MIN), /^4 /, 'Western digits in Arabic, like every other number on the page');
  setActiveLocale('en');
});

test('durationText falls back to its own keys where Intl has no unit style', () => {
  // An old WebView throws a RangeError for `style: 'unit'`. Reintroduce by removing the try/catch: the call
  // throws and the whole row with it.
  const real = Intl.NumberFormat;
  (Intl as any).NumberFormat = function NumberFormat(_l: unknown, o?: { style?: string }) {
    if (o?.style === 'unit') throw new RangeError('unit style unsupported');
    return new (real as any)(_l, o);
  };
  try {
    setActiveLocale('de'); // a new locale clears the built formatters
    assert.equal(durationText(65 * MIN), '1 h 5 min');
    assert.equal(durationText(30_000), '30 sec');
  } finally {
    (Intl as any).NumberFormat = real;
    setActiveLocale('en');
  }
});

test('wallClock writes a time of day the way the app\'s language does, not the browser\'s', () => {
  // EngineSetup's retry line read "Tried 3 times since 02:05 PM" inside a German sentence: toLocaleTimeString([])
  // follows the browser. Reintroduce `[]` for intlTag() in wallClock: the German and Japanese cases fail (this
  // Node's own locale is English).
  const at = new Date(2026, 8, 27, 14, 5);
  try {
    setActiveLocale('en');
    assert.match(wallClock(at), /^02:05\s?PM$/);
    setActiveLocale('de');
    assert.equal(wallClock(at), '14:05', 'German reads the browser\'s 12-hour clock');
    setActiveLocale('ja');
    assert.equal(wallClock(at.toISOString()), '14:05', 'an ISO string is not read, or Japanese reads the browser\'s clock');
    setActiveLocale('ar');
    assert.doesNotMatch(wallClock(at), /[\u0660-\u0669]/, 'Arabic-Indic digits beside the Western ones the rest of the line uses');
    assert.equal(wallClock('not a date'), '');
  } finally {
    setActiveLocale('en');
  }
  assert.match(readFileSync(join(__dirname, '..', 'components/EngineSetup.tsx'), 'utf8'), /time: wallClock\(retry\.since\)/, 'the retry line does not use wallClock');
  assert.doesNotMatch(readFileSync(join(__dirname, '..', 'components/EngineSetup.tsx'), 'utf8'), /toLocaleTimeString\(\[\]/, 'the retry line follows the browser\'s language');
});

test('untilText says when something happens next', () => {
  setActiveLocale('en');
  assert.equal(untilText(20 * MIN), 'in 20 minutes');
  assert.equal(untilText(3 * HOUR), 'in 3 hours');
  assert.equal(untilText(DAY), 'tomorrow');
  assert.equal(untilText(10_000), 'in under a minute', 'not Intl\'s "now", which promises it is happening as you look');
  setActiveLocale('fr');
  assert.equal(untilText(3 * HOUR), 'dans 3 heures');
  setActiveLocale('en');
});

test('relativeTime in English is the v0.48.4 line, byte for byte', () => {
  // Task results, the supply line and English tests quote it. Reintroduce by letting English through Intl
  // (dropping `locale !== 'en' &&`): "5 minutes ago" is not "5m ago".
  setActiveLocale('en');
  const cases = [null, '', 'not a date', ago(-5 * MIN), ago(0), ago(20_000), ago(5 * MIN), ago(59 * MIN), ago(61 * MIN),
    ago(5 * HOUR), ago(23 * HOUR), ago(25 * HOUR), ago(6 * DAY), ago(29 * DAY), ago(45 * DAY)];
  for (const iso of cases) assert.equal(relativeTime(iso), relativeTimeV0484(iso), `English changed for ${iso}`);
  assert.equal(relativeTime(ago(5 * MIN)), '5m ago');
});

test('relativeTime speaks every other language through Intl, in both directions', () => {
  // Before, a German line read "Aktualisiert 5m ago". Reintroduce by deleting the Intl branch: "vor 5
  // Minuten" fails.
  try {
    setActiveLocale('de');
    assert.equal(activeLocale(), 'de');
    assert.equal(relativeTime(ago(5 * MIN)), 'vor 5 Minuten');
    assert.equal(relativeTime(ago(20_000)), 'jetzt');
    assert.equal(relativeTime(ago(DAY)), 'gestern');
    assert.equal(relativeTime(ago(-3 * DAY)), 'in 3 Tagen', 'an expiry in the future is not "just now"');
    assert.equal(relativeTime(null), '');
    setActiveLocale('ja');
    assert.equal(relativeTime(ago(3 * HOUR)), '3 時間前');
    setActiveLocale('ar');
    assert.match(relativeTime(ago(5 * MIN)), /5/, 'Western digits in Arabic');
  } finally {
    setActiveLocale('en');
  }
});

test('relativeTimeShort: English is the grid\'s "3d" byte for byte, every other language Intl\'s narrow unit', () => {
  // The series page's desktop grid had room for "3d" and made it by cutting " ago" off relativeTime's
  // sentence; with Intl speaking every other language the cut matched nothing and the grid showed "vor 3
  // Tagen". Reintroduce that cut for every language (`relativeTime(iso).replace(/ ago$/, '')`): "the desktop
  // grid shows the whole German sentence" fails.
  const cut = (iso: string | null) => { const l = relativeTimeV0484(iso); return l === 'just now' ? 'now' : l.replace(/ ago$/, ''); };
  const cases = [null, '', 'not a date', ago(-5 * MIN), ago(0), ago(20_000), ago(5 * MIN), ago(59 * MIN), ago(61 * MIN),
    ago(5 * HOUR), ago(23 * HOUR), ago(25 * HOUR), ago(3 * DAY), ago(29 * DAY), ago(45 * DAY)];
  try {
    setActiveLocale('en');
    for (const iso of cases) assert.equal(relativeTimeShort(iso), cut(iso), `English changed for ${iso}`);
    assert.equal(relativeTimeShort(ago(3 * DAY)), '3d');
    assert.equal(relativeTimeShort(ago(20_000)), 'now');
    setActiveLocale('de');
    const de = relativeTimeShort(ago(3 * DAY));
    assert.notEqual(de, relativeTime(ago(3 * DAY)), 'the desktop grid shows the whole German sentence');
    assert.equal(de, new Intl.NumberFormat('de-u-nu-latn', { style: 'unit', unit: 'day', unitDisplay: 'narrow' }).format(3));
    assert.equal(relativeTimeShort(ago(5 * MIN)), new Intl.NumberFormat('de-u-nu-latn', { style: 'unit', unit: 'minute', unitDisplay: 'narrow' }).format(5));
    assert.equal(relativeTimeShort(ago(20_000)), 'jetzt');
    assert.equal(relativeTimeShort(ago(-3 * DAY)), 'jetzt', 'a future date reads as now, as it does in English');
    assert.equal(relativeTimeShort(null), '');
    for (const [lang, sentence] of [['fr', /il y a/], ['es', /hace/], ['ru', /назад/], ['ar', /قبل/], ['pt-BR', /há/]] as const) {
      setActiveLocale(lang);
      const s = relativeTimeShort(ago(3 * DAY));
      assert.doesNotMatch(s, sentence, `${lang}: the grid says the sentence ("${s}")`);
      assert.match(s, /3/, `${lang}: Western digits`);
      assert.ok(s.length < relativeTime(ago(3 * DAY)).length, `${lang}: "${s}" is no shorter than the sentence`);
    }
  } finally {
    setActiveLocale('en');
  }
});

test('I18nProvider hands the locale to the formatters beside the dictionary', () => {
  // Reintroduce by deleting `setActiveLocale(next)` from I18nProvider: every duration stays English after a
  // language change.
  const src = readFileSync(join(__dirname, '..', 'lib', 'I18nProvider.tsx'), 'utf8');
  assert.match(src, /setActiveDict\(d\);\s*setActiveLocale\(next\);/, 'I18nProvider does not set the formatters\' locale');
});

test('no English words wrap a relativeTime: the phrase is in the reader\'s language, so its sentence is too', () => {
  // relativeTime speaks German to a German reader since v0.49.0, so an English word beside it became
  // "active vor 3 Stunden" and "on iPhone vor 3 Tagen". Each wrapper is one translated key with a {when}.
  // Reintroduce `active {relativeTime(s.last_seen)}` in the admin's Sessions: "app/admin/page.tsx: English
  // around relativeTime" fails. The last one, Health's "checked {when}", went with the Health step (v0.49.0).
  const { readdirSync, statSync } = require('fs') as typeof import('fs');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  };
  const ROOT = join(__dirname, '..');
  const found: string[] = [];
  for (const f of ['app', 'components', 'lib'].flatMap((d) => walk(join(ROOT, d)))) {
    const rel = f.slice(ROOT.length + 1);
    if (rel === 'lib/format.ts') continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('relativeTime(') || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // A word written beside it: JSX text (`active {relativeTime(`) or a template (`last run ${relativeTime(`).
      if (/[A-Za-z]\s+\{relativeTime\(/.test(line) || /`[^`]*[A-Za-z]\s+\$\{relativeTime\(/.test(line)) found.push(`${rel}: English around relativeTime -- ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(found, [], `English around relativeTime: ${found.join(' | ')}`);
  // The ones the scan cannot see by shape: the Continue card's device line, whose words sit in another brace.
  // Reintroduce ` · on {elsewhere.name || 'another device'}{… relativeTime …}`: "the Continue card's
  // 'on <device> <when>' is English around the reader's language" fails.
  assert.match(readFileSync(join(ROOT, 'components/cards.tsx'), 'utf8'), /tr\('on \{device\} \{when\}', \{ device: elsewhere\.name \|\| tr\('another device'\), when: relativeTime\(elsewhere\.at\) \}\)/,
    "the Continue card's 'on <device> <when>' is English around the reader's language");
});
