// A source that asks its API for one language has to say so.
//
// Discover groups sources by the language they declare, and a source that declares none joins EVERY group —
// deliberately, because a genuinely multi-language source belongs in all of them. MangaDex declared none and
// is not multi-language in practice: both of its request builders pin `en` and nothing else. So picking the
// Japanese chip produced a wall of one Japanese source, four universals, and English-only MangaDex, which is
// precisely the "says Japanese, serves English" that got reported.
//
// This is the invariant, not the symptom: if the adapter's own requests pin a language, the adapter must
// declare that language. Making MangaDex multi-language later is fine — it just has to change both halves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mangadex } from '../src/lib/sources/mangadex';

test('MangaDex declares the one language it actually asks for', () => {
  const src = readFileSync(join(__dirname, '../src/lib/sources/mangadex.ts'), 'utf8');
  const pinned = [...src.matchAll(/(?:available)?[Tt]ranslatedLanguage\[\]=([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(pinned.length >= 2, 'expected latest() and listChapters() to pin a language');
  assert.deepEqual(
    [...new Set(pinned)], ['en'],
    'MangaDex now requests more than one language — give it lang: undefined, or list them comma-separated',
  );
  assert.equal(mangadex.lang, 'en', 'MangaDex asks the API for English only but declares no language');
});
