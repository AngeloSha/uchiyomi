// Discover's search cards (lib/searchAll.ts groupByTitle): which provider of a card comes first, which is the one the
// add dialog offers by default. v0.62.0: a source in every language comes last, so a title an English extension carries
// is added from it and not from the same extension's every-language variant, whose chapters mix every translation.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let groupByTitle: typeof import('../src/lib/searchAll').groupByTitle;
before(async () => { ({ groupByTitle } = await import('../src/lib/searchAll')); });

const src = (id: string, lang?: string) => ({ id, name: id, ...(lang ? { lang } : {}) }) as any;
const hit = (source: string) => ({ source, sourceId: `${source}|1`, title: 'Same Title' });

test('a source in every language comes last in its card, whatever the source order', () => {
  const order = [src('ext-all', 'all'), src('ext-en', 'en'), src('site')];
  const per = new Map(order.map((s) => [s.id, { state: 'ok' as const, items: [hit(s.id)] }]));
  const [card] = groupByTitle(per as any, order);
  // Reintroduce by dropping the sort: ext-all, first in the source order, is the add dialog's default.
  assert.deepEqual(card.providers.map((p) => p.source), ['ext-en', 'site', 'ext-all']);
});

test('with no source in every language, the order is the caller\'s, unchanged', () => {
  const order = [src('site'), src('ext-es', 'es'), src('ext-en', 'en')];
  const per = new Map(order.map((s) => [s.id, { state: 'ok' as const, items: [hit(s.id)] }]));
  const [card] = groupByTitle(per as any, order);
  assert.deepEqual(card.providers.map((p) => p.source), ['site', 'ext-es', 'ext-en']);
});
