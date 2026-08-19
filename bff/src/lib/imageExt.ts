// Pick the file extension to store a downloaded page under.
//
// Extracted so it can be unit-tested, because getting it wrong is silent and total: the page reader lists a
// CBZ's contents by matching image extensions, so a chapter packed with the wrong extension contains its
// images but reads as ZERO pages. That is exactly what happened with page URLs that carry no extension at
// all -- the old URL-only guess turned "http://host:4567/api/v1/manga/1/chapter/1/page/0" into ".http".
//
// Content-Type is trusted first because it is what the server actually sent; the URL is only consulted when
// it already ends in an extension we recognise.

const BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/jxl': 'jxl',
  'image/heic': 'heic',
};

const KNOWN = new Set(Object.values(BY_TYPE).concat(['jpeg']));

/** Extension (no dot) for a page image, from its Content-Type, falling back to the URL, then to jpg. */
export function imageExt(url: string, contentType?: string | null): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (BY_TYPE[ct]) return BY_TYPE[ct];

  // Only accept a URL-derived extension when it is one we actually recognise, so an extension-less path
  // cannot contribute a nonsense suffix.
  const path = url.split('?')[0].split('#')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot > 0) {
    const ext = last.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (KNOWN.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'jpg';
}
