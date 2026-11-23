import test from 'node:test';
import assert from 'node:assert/strict';
import { mangadex, makeMangadex } from '../src/lib/sources/mangadex';

// uploads.mangadex.org answers a browser user-agent with a bot-challenge redirect ("if this isn't a browser,
// don't send a browser UA"), which the cover proxy's Chrome default ran into: every uncached MangaDex cover 502'd.
test('MangaDex asks its image CDN not to look like a browser', () => {
  for (const src of [mangadex, makeMangadex('es-419')]) {
    const headers = typeof src.imageHeaders === 'function' ? src.imageHeaders('https://uploads.mangadex.org/covers/x.jpg') : src.imageHeaders;
    assert.match(String((headers as Record<string, string> | undefined)?.['user-agent']), /^Uchiyomi\//);
  }
});
