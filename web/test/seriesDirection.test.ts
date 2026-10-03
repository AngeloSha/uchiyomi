// The series edit dialog's Reading direction (#102): what the reader's "Series default" follows.
//
// The server half -- detection, precedence, the override and everything that reports it -- is
// bff/test/readingDirection.int.test.ts; this pins the two ways the dialog itself could quietly go wrong. Since
// v0.53.0 the dialog is components/SeriesEditor.tsx and seeds through lib/seriesMeta.ts, which these drive with
// plain values; the offered directions are still read from the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { metaBody, seedMeta } from '../lib/seriesMeta';
import type { Series } from '../lib/types';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const EDITOR = 'components/SeriesEditor.tsx';

/** A series as the payload has it: detected right to left from its files, with whatever overrides are given. */
const series = (overrides?: Partial<NonNullable<Series['overrides']>>): Series => ({
  id: 's_1', libraryId: 'lib', name: 'Right To Left', booksCount: 3, booksReadCount: 0, booksUnreadCount: 3, booksInProgressCount: 0,
  metadata: { title: 'Right To Left', readingDirection: 'RIGHT_TO_LEFT' },
  detectedDirection: { direction: 'RIGHT_TO_LEFT', from: 'comicinfo' },
  overrides: overrides ? {
    title: null, summary: null, cover: null, banner: null, author: null, status: null, genres: null, ageRating: null, ...overrides,
  } : undefined,
});

test('the dialog seeds from the override, never from the effective direction', () => {
  // Seeding from `metadata.readingDirection` would save whatever was DETECTED as a hand-set override on the
  // first unrelated save (a retitle), and a better signal learned later could never reach the series again.
  // Reintroduce by seeding from `series.metadata?.readingDirection` in lib/seriesMeta.ts: the first two fail.
  assert.equal(seedMeta(series()).readingDirection, '', 'a series with no overrides at all seeds the detected direction');
  assert.equal(seedMeta(series({ readingDirection: null })).readingDirection, '', 'a cleared override seeds the detected direction');
  assert.equal(seedMeta(series({ readingDirection: 'LEFT_TO_RIGHT' })).readingDirection, 'LEFT_TO_RIGHT', 'the admin\'s own direction is not seeded');
  // '' is automatic and goes up as null, which the route reads as "clear the override"; a retitle sends it as such.
  assert.equal(metaBody({ ...seedMeta(series()), title: 'Renamed' }).readingDirection, null, 'a retitle sends the detected direction as an override');
  assert.equal(metaBody(seedMeta(series({ readingDirection: 'LEFT_TO_RIGHT' }))).readingDirection, 'LEFT_TO_RIGHT');
  // And the dialog seeds through it, rather than a copy of these rules of its own.
  assert.match(read(EDITOR), /useState<SeriesMeta>\(\(\) => seedMeta\(series\)\)/, 'the dialog does not seed its fields through seedMeta');
});

test('the dialog offers exactly the four directions the server accepts', () => {
  const src = read(EDITOR);
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
    // v0.53.0: the Automatic segment says what it reads as.
    'Automatic · {direction}',
  ];
  const src = read(EDITOR);
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
