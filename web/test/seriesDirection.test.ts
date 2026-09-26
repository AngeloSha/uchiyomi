// The series edit dialog's Reading direction (#102): what the reader's "Series default" follows.
//
// Read from source, like adultFilterSettings.test.ts. The server half -- detection, precedence, the override
// and everything that reports it -- is bff/test/readingDirection.int.test.ts; this pins the two ways the
// dialog itself could quietly go wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const modal = (): string => {
  const src = code(read('app/series/page.tsx'));
  const s = src.slice(src.indexOf('function SeriesEditModal('), src.indexOf('interface CollectionRow'));
  assert.ok(s.length > 0, 'no SeriesEditModal');
  return s;
};

test('the dialog seeds from the override, never from the effective direction', () => {
  // Seeding from `metadata.readingDirection` would save whatever was DETECTED as a hand-set override on the
  // first unrelated save (a retitle), and a better signal learned later could never reach the series again.
  // Reintroduce by seeding from series.metadata?.readingDirection: this fails.
  const m = modal();
  assert.match(m, /useState<string>\(series\.overrides\?\.readingDirection \?\? ''\)/);
  assert.doesNotMatch(m, /metadata\?\.readingDirection/);
  // '' is automatic and goes up as null, which the route reads as "clear the override".
  assert.match(m, /readingDirection: direction \|\| null/);
});

test('the dialog offers exactly the four directions the server accepts', () => {
  const src = read('app/series/page.tsx');
  const values = src.match(/\(\[('[A-Z_]+'(?:, )?)+\] as const\)\.map\(\(v, i\) => \[v, DIRECTION_LABELS\[i\]\]/)?.[0] ?? '';
  for (const v of ['RIGHT_TO_LEFT', 'LEFT_TO_RIGHT', 'WEBTOON', 'VERTICAL']) assert.ok(values.includes(`'${v}'`), `${v} is not offered`);
  const server = readFileSync(join(ROOT, '..', 'bff', 'src', 'lib', 'komgaDto.ts'), 'utf8');
  assert.match(server, /READING_DIRECTIONS = \['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT', 'VERTICAL', 'WEBTOON'\] as const/);
});

test('every new string is in all eight locale files', () => {
  // Reintroduce by deleting "Webtoon" from public/locales/ja.json.
  const keys = [
    'Webtoon', 'Vertical',
    'Automatic — {direction}, from the chapter files', 'Automatic — {direction}, from the source',
    'Automatic — {direction}, from AniList', 'Automatic — not known, reads as a webtoon',
    'What “Series default” in the reader follows. Automatic takes it from the chapter files, then the source, then AniList.',
  ];
  const src = read('app/series/page.tsx');
  for (const k of keys) {
    assert.ok(src.includes(`tr('${k}'`) || src.includes(`'${k}'`), `"${k}" is no longer rendered -- update this list`);
  }
  const files = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const d = JSON.parse(read(`public/locales/${f}`));
    // "Webtoon" and "Vertical" are the same word in several languages, so only presence is required of them.
    const missing = keys.filter((k) => !(k in d) || !String(d[k]).trim() || (d[k] === k && !['Webtoon', 'Vertical'].includes(k)));
    assert.deepEqual(missing, [], `${f} lacks (or copies the English of) ${missing.join(' | ')}`);
    assert.equal(d._meta.strings, Object.keys(d).length - 1, `${f}: _meta.strings is out of date`);
  }
});
