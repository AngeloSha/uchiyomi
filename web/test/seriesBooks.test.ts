// The series page and the reader load EVERY chapter, not the route's first page of 1000.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllBooks, BATCH } from '../lib/seriesBooks';
import type { Book, Page } from '../lib/types';

/** A books route over `n` chapters that pages like the real one, and `hidden` rows it counts but never sends. */
function route(n: number, hidden = 0) {
  const all = Array.from({ length: n - hidden }, (_, i) => ({ id: `b${i + 1}`, number: i + 1 }) as unknown as Book);
  const urls: string[] = [];
  const get = async (url: string): Promise<Page<Book>> => {
    urls.push(url);
    const q = new URL(url, 'http://x').searchParams;
    const page = Number(q.get('page')), size = Number(q.get('size'));
    const content = all.slice(page * size, page * size + size);
    return { content, totalElements: n, totalPages: Math.ceil(n / size), number: page, size, first: page === 0, last: (page + 1) * size >= n } as Page<Book>;
  };
  return { get, urls };
}

test('walks past the first 1000 (One Piece, 1193 chapters)', async () => {
  const r = route(1193);
  const res = await fetchAllBooks('s1', r.get);
  assert.equal(res.content.length, 1193);
  assert.equal(res.content.at(-1)!.number, 1193);
  assert.equal(r.urls.length, 2);
  assert.ok(r.urls.every((u) => u.includes(`size=${BATCH}`) && u.includes('sort=metadata.numberSort,asc')));
  assert.equal(res.last, true);
});

test('one request when a single page holds the series', async () => {
  const r = route(40);
  assert.equal((await fetchAllBooks('s1', r.get)).content.length, 40);
  assert.equal(r.urls.length, 1);
});

test('an empty page ends the walk even when the count promised more', async () => {
  const r = route(1500, 600); // counted 1500, sends 900
  const res = await fetchAllBooks('s1', r.get);
  assert.equal(res.content.length, 900);
  assert.equal(r.urls.length, 2);
});
