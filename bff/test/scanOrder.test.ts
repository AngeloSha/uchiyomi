// Which sources a scan asks first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanOrder } from '../src/lib/scanOrder';

const S = (id: string, lang?: string | null, preferredOrder?: number) => ({ id, lang, preferredOrder });

test('own source, then its language, then unpinned sources, then other languages', () => {
  const order = scanOrder(
    [S('3hentai-ru', 'ru'), S('mangadex', 'en', 10), S('aqua', undefined, 0), S('allmanga', 'en', 5), S('3hentai-ja', 'ja'), S('mangapill', undefined, 20)],
    { id: 'aqua', lang: undefined },
  );
  // own source has no language, so nothing ranks as "same language"; unpinned sources come before pinned ones
  assert.deepEqual(order, ['aqua', 'mangapill', 'allmanga', 'mangadex', '3hentai-ru', '3hentai-ja']);
});

test('a series in English asks English sources before unpinned ones', () => {
  const order = scanOrder(
    [S('3hentai-ru', 'ru'), S('mangadex', 'en', 10), S('custom', undefined, 0), S('allmanga', 'en', 5), S('own-en', 'en', 99)],
    { id: 'own-en', lang: 'en' },
  );
  assert.deepEqual(order, ['own-en', 'allmanga', 'mangadex', 'custom', '3hentai-ru']);
});

test('language matching ignores region and case', () => {
  const order = scanOrder([S('br', 'pt-BR'), S('pt', 'pt'), S('en', 'en')], { id: 'x', lang: 'PT' });
  assert.deepEqual(order, ['br', 'pt', 'en']);
});

test('ties keep registry order, so the result is stable', () => {
  const order = scanOrder([S('a'), S('b'), S('c')], null);
  assert.deepEqual(order, ['a', 'b', 'c']);
});
