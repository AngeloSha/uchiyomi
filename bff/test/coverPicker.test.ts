// The cover picker's server side: a source's cover is chosen by the source's id alone. Read from source: the route needs
// a live source to answer, and what matters here is that the picture's address never comes from the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const admin = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf8');

test('the candidates route exists and asks each followed source for its own record of the series', () => {
  const i = admin.indexOf("'/api/admin/series/:id/cover-candidates'");
  assert.ok(i > 0);
  const body = admin.slice(i, i + 900);
  assert.match(body, /seriesSourcesFor\(id\)/);
  assert.match(body, /src\.getSeries\(f\.sourceSeriesId\)/);
});

test('mode source takes only the source id, from a source the series follows, and keeps its own copy', () => {
  assert.match(admin, /mode: z\.enum\(\['url', 'upload', 'reset', 'first_page', 'source'\]\)/);
  const i = admin.indexOf("mode === 'source'");
  assert.ok(i > 0);
  const body = admin.slice(i, i + 1800);
  assert.match(body, /seriesSourcesFor\(id\)\)\.find\(\(x\) => x\.sourceId === b\.data\.source\)/);
  assert.match(body, /src\.getSeries\(follow\.sourceSeriesId\)/);
  assert.doesNotMatch(body, /b\.data\.url/, 'the address is never the caller\'s');
  assert.match(body, /writeFile\(artFile\(id, kind\), buf\)/);
});
