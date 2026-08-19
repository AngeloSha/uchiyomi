// Which extension a downloaded page gets stored under.
//
// This exists because of a real bug with a silent, total failure mode. The downloader used to guess the
// extension from the URL alone. Page URLs served by an extension server carry no extension at all
// ("http://host:4567/api/v1/manga/1/chapter/1/page/0"), so the guess produced "0001.http" -- and since the
// page reader lists a CBZ by matching IMAGE extensions, the chapter downloaded fine, contained all its
// images, and read as ZERO pages. Nothing errored anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageExt } from '../src/lib/imageExt';

test('an extension-less URL does not invent a nonsense extension', () => {
  // the exact bug: this used to yield "http"
  assert.equal(imageExt('http://host:4567/api/v1/manga/1/chapter/1/page/0', 'image/png'), 'png');
  assert.equal(imageExt('http://host:4567/api/v1/manga/1/chapter/1/page/0', null), 'jpg');
  assert.equal(imageExt('https://example.org/read/1/2/3'), 'jpg');
});

test('content-type wins over the URL', () => {
  // a server that hands back a webp from a .jpg path is common enough to matter
  assert.equal(imageExt('https://example.org/p/001.jpg', 'image/webp'), 'webp');
  assert.equal(imageExt('https://example.org/p/001.png', 'image/jpeg'), 'jpg');
});

test('content-type parameters and casing are handled', () => {
  assert.equal(imageExt('https://example.org/p/1', 'image/JPEG; charset=binary'), 'jpg');
  assert.equal(imageExt('https://example.org/p/1', '  image/webp  '), 'webp');
});

test('the URL is used when there is no content-type', () => {
  assert.equal(imageExt('https://example.org/p/001.webp'), 'webp');
  assert.equal(imageExt('https://example.org/p/001.PNG'), 'png');
  assert.equal(imageExt('https://example.org/p/001.jpg?token=abc&v=2'), 'jpg');
  assert.equal(imageExt('https://example.org/p/001.avif#frag'), 'avif');
});

test('jpeg is normalised to jpg so one chapter has one extension', () => {
  assert.equal(imageExt('https://example.org/p/001.jpeg'), 'jpg');
  assert.equal(imageExt('https://example.org/p/1', 'image/jpeg'), 'jpg');
});

test('an unrecognised URL extension is not trusted', () => {
  // a path segment ending in ".php" or ".aspx" is a script, not an image format
  assert.equal(imageExt('https://example.org/image.php?id=5'), 'jpg');
  assert.equal(imageExt('https://example.org/get.aspx'), 'jpg');
  // and a dotted hostname must never leak into the extension
  assert.equal(imageExt('https://cdn.images.example.org/page/1'), 'jpg');
});

test('every extension it can return is one the page reader recognises as an image', () => {
  // the guarantee that matters: whatever comes out of here must be matched by the CBZ page filter,
  // or the chapter reads as zero pages again.
  const IMG = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|jxl|heic)$/i;
  const cases: Array<[string, string | null]> = [
    ['https://example.org/p/1', 'image/jpeg'], ['https://example.org/p/1', 'image/png'],
    ['https://example.org/p/1', 'image/webp'], ['https://example.org/p/1', 'image/avif'],
    ['https://example.org/p/1', 'image/gif'], ['https://example.org/p/1', 'image/bmp'],
    ['https://example.org/p/1', 'image/tiff'], ['https://example.org/p/1', 'image/jxl'],
    ['https://example.org/p/1', 'image/heic'], ['https://example.org/p/1', null],
    ['https://example.org/p/1.jpeg', null], ['https://example.org/weird', 'application/octet-stream'],
  ];
  for (const [u, ct] of cases) {
    assert.match(`x.${imageExt(u, ct)}`, IMG, `${u} + ${ct} produced a non-image extension`);
  }
});
