// Who wrote a series, name by name (v0.100.0, #338, lib/authorNames.ts): the series page links each name on the author
// line, and the Library's `authorName` lists every series that names the same person -- a whole name, in any of the
// spellings it gives, never a fragment.
//
// The split is held to web/test/fixtures/authorNames.json, which the web's twin (web/lib/authorNames.ts) reads too, so
// the name a link carries is one this side finds. Pure: no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { authorNames, lineHas, nameKeys } from '../src/lib/authorNames';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const fixtures = JSON.parse(readFileSync(join(__dirname, '..', '..', 'web', 'test', 'fixtures', 'authorNames.json'), 'utf8')) as
  Array<{ line: string; names: string[] }>;

test('an author line splits into its names as the series page splits it', () => {
  assert.ok(fixtures.length >= 8, 'the shared fixtures are read');
  // Reintroduce by splitting inside brackets: "Younggeun (Story Plus, Other)" comes apart.
  for (const f of fixtures) assert.deepEqual(authorNames(f.line), f.names, f.line);
  assert.deepEqual(authorNames(null), []);
});

test('a name is every spelling it gives: itself and each name in its brackets, folded', () => {
  assert.deepEqual(nameKeys('Chugong (추공)'), ['chugong', '추공']);
  assert.deepEqual(nameKeys('Gi So-Ryeong (기소령)'), ['gisoryeong', '기소령']);
  assert.deepEqual(nameKeys('SAN.G'), ['sang']);
  assert.deepEqual(nameKeys('Younggeun (Story Plus, Other)'), ['younggeun', 'storyplus', 'other']);
  assert.deepEqual(nameKeys('(우각)'), ['우각']);
  assert.deepEqual(nameKeys('ＥＬＦ　ＴＯＯＮ'), ['elftoon'], 'full-width letters are the same letters');
});

test('a series matches the WHOLE name, in any spelling, never a fragment of another', () => {
  const chugong = nameKeys('Chugong (추공)');
  assert.ok(lineHas('Chugong (추공), Gi So-Ryeong (기소령), h-goon (현군)', chugong));
  assert.ok(lineHas('추공', chugong), 'the bracketed spelling written on its own');
  assert.ok(lineHas('CHUGONG', chugong));
  assert.ok(lineHas('Gi So Ryeong', nameKeys('Gi So-Ryeong (기소령)')), 'a hyphen is no other person');
  // Reintroduce with a fragment match (`line.includes(name)`): "Oh" is found in "John Oh" and "Hojun", "K" everywhere.
  const oh = nameKeys('Oh (성불예정)');
  assert.ok(lineHas('Hong-Sil (홍실), Oh (성불예정)', oh));
  assert.ok(!lineHas('John Oh', oh));
  assert.ok(!lineHas('Galdr (갈드), Hojun (호쥰)', oh));
  assert.ok(!lineHas('Kim Kyung Yeol (김경열), K-Studio', nameKeys('K (케이)')));
  assert.ok(lineHas('K (케이), Nok Wolhi', nameKeys('K (케이)')));
  assert.ok(!lineHas(null, chugong));
  assert.ok(!lineHas('Chugong', []), 'no spelling names nobody');
});

test('Komga is asked for an author by name, in its own words', async () => {
  const { komgaCondition } = await import('../src/lib/backend');
  const tree = { allOf: [{ genre: { operator: 'is', value: 'Action' } }, { anyOf: [{ authorName: { operator: 'isNot', value: 'Elf Toon' } }] }] };
  assert.deepEqual(komgaCondition(tree), {
    allOf: [{ genre: { operator: 'is', value: 'Action' } }, { anyOf: [{ author: { operator: 'isNot', value: { name: 'Elf Toon' } } }] }],
  });
  assert.equal(komgaCondition(undefined), undefined);
});
