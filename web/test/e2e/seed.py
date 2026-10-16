#!/usr/bin/env python3
"""Write a tiny library for the end-to-end run: one series, one chapter of each format the app claims.

Generated rather than committed so there is no binary fixture in the repo, and so the formats under test are
the ones the README actually names -- if a format is added, this file is where it becomes visible that the
browser pass never opened one.
"""
import os
import random
import struct
import sys
import zipfile
import zlib

CRC = []
for i in range(256):
    c = i
    for _ in range(8):
        c = 0xEDB88320 ^ (c >> 1) if c & 1 else c >> 1
    CRC.append(c)


def crc32(b: bytes) -> int:
    c = 0xFFFFFFFF
    for x in b:
        c = CRC[(c ^ x) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


def _png_from_raw(w: int, h: int, raw: bytes) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', crc32(c))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def png(w: int, h: int, rgb) -> bytes:
    return _png_from_raw(w, h, b''.join(b'\x00' + bytes(rgb) * w for _ in range(h)))


def bands(w: int, h: int, seed: int) -> bytes:
    """A page-shaped PNG: a soft gradient with solid blocks whose layout depends on `seed`.

    ⚠️ This is the generator from bff/test/pageHash.test.ts, ported, and the shape matters twice over.
    A FLAT page hashes to all zeros whatever its colour, so solid fixtures cannot tell "the same page twice"
    from "two different pages" — the first version of this used `png()` and half the fixture went unhashed.
    And a page needs enough structure that different seeds land far apart: an earlier banded version
    produced a story page that collided with the credit page and was wrongly flagged.
    """
    raw = b''
    for y in range(h):
        row = bytearray()
        for x in range(w):
            v = int(40 + (x / w) * 120 + (y / h) * 60)
            bx, by = int((x / w) * 7), int((y / h) * 11)
            if (bx * 5 + by * 3 + seed * 13) % 6 == 0:
                v = 235
            elif (bx * 3 + by * 7 + seed * 5) % 8 == 0:
                v = 15
            row += bytes((v, v, v))
        raw += b'\x00' + bytes(row)
    return _png_from_raw(w, h, raw)


def pdf(pages: int, w: int = 600, h: int = 900) -> bytes:
    objs, kids = [], ' '.join(f'{3 + i * 2} 0 R' for i in range(pages))
    objs.append((1, b'<< /Type /Catalog /Pages 2 0 R >>'))
    objs.append((2, f'<< /Type /Pages /Kids [{kids}] /Count {pages} >>'.encode()))
    for i in range(pages):
        n = 3 + i * 2
        objs.append((n, (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Contents {n + 1} 0 R '
                         f'/Resources << /Font << /F1 {3 + pages * 2} 0 R >> >> >>').encode()))
        c = f'BT /F1 40 Tf 40 {h // 2} Td (Page {i + 1}) Tj ET'
        objs.append((n + 1, f'<< /Length {len(c)} >>\nstream\n{c}\nendstream'.encode()))
    objs.append((3 + pages * 2, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

    out, offs = b'%PDF-1.4\n', {}
    for num, body in objs:
        offs[num] = len(out)
        out += f'{num} 0 obj\n'.encode() + body + b'\nendobj\n'
    x = len(out)
    table = f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'
    for num, _ in objs:
        table += f'{offs[num]:010d} 00000 n \n'
    return out + table.encode() + f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()


def main(root: str) -> None:
    d = os.path.join(root, 'Test Source', 'Mixed Formats')
    os.makedirs(d, exist_ok=True)

    with zipfile.ZipFile(os.path.join(d, 'Chapter 001.cbz'), 'w') as z:
        for i in range(1, 4):
            z.writestr(f'{i:03d}.png', png(600, 900, (200, 60, 60)))

    open(os.path.join(d, 'Chapter 002.pdf'), 'wb').write(pdf(3))

    spine = ['i_003', 'i_001', 'i_002']   # spine order deliberately unlike filename order
    with zipfile.ZipFile(os.path.join(d, 'Chapter 003.epub'), 'w') as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml',
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>')
        man = ''.join(f'<item id="p{i + 1}" href="text/p{i + 1}.xhtml" media-type="application/xhtml+xml"/>'
                      for i in range(len(spine)))
        man += ''.join(f'<item id="{s}" href="images/{s}.png" media-type="image/png"/>' for s in spine)
        sp = ''.join(f'<itemref idref="p{i + 1}"/>' for i in range(len(spine)))
        z.writestr('OEBPS/content.opf',
                   f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
                   f'<manifest>{man}</manifest><spine>{sp}</spine></package>')
        for i, s in enumerate(spine):
            z.writestr(f'OEBPS/text/p{i + 1}.xhtml',
                       f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>'
                       f'<img src="../images/{s}.png"/></body></html>')
            z.writestr(f'OEBPS/images/{s}.png', png(600, 900, (60, 60 + i * 60, 200)))

    # A second series whose chapters all open with the SAME credit page -- the fixture for the repeated-page
    # skipper. Without it the browser suite cannot see that feature at all.
    #
    # ⚠️ The pages must have internal VARIATION. A solid-colour page has every neighbouring pixel equal, so
    # its perceptual hash is all zeros no matter what colour it is -- every flat page would look like every
    # other and they would all be flagged as the same repeated page. (The hash refuses to hash them for
    # exactly that reason; a flat fixture would silently test nothing.) So these draw bands.
    r = os.path.join(root, 'Test Source', 'Repeated Pages')
    os.makedirs(r, exist_ok=True)
    credit = bands(600, 900, 7)          # identical bytes in every chapter: the "scanlator credit page"
    for ch in range(1, 4):
        with zipfile.ZipFile(os.path.join(r, f'Chapter {ch:03d}.cbz'), 'w') as z:
            z.writestr('001.png', credit)
            for i in range(2, 5):
                z.writestr(f'{i:03d}.png', bands(600, 900, ch * 10 + i))   # unique story pages
    print(f'  seeded {r} (3 chapters sharing one credit page)')

    print(f'  seeded {d}')


def rtl(root: str) -> None:
    """The v0.48.0 walk's library (walk48.mjs, #102): which way a series reads.

    Only on request (`seed.py <root> --rtl`), so the main run's library -- and every count it asserts -- is
    unchanged. Two series: one whose ComicInfo says `<Manga>YesAndRightToLeft</Manga>`, in two twelve-page
    chapters so a page turn can cross a chapter boundary (the reader appends the next chapter four pages
    before the end), and one that says nothing. Every page differs from every other, so the walk can tell
    which page is on screen from its URL and no page is taken for a repeated one.
    """
    manga = os.path.join(root, 'Test Source', 'Right To Left')
    os.makedirs(manga, exist_ok=True)
    for ch in (1, 2):
        with zipfile.ZipFile(os.path.join(manga, f'Chapter {ch:03d}.cbz'), 'w') as z:
            for i in range(1, 13):
                z.writestr(f'{i:03d}.png', bands(300, 450, ch * 100 + i))
            z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Right To Left</Series>'
                       f'<Number>{ch}</Number><Manga>YesAndRightToLeft</Manga></ComicInfo>')
    # Named so that no AniList entry is called that: a search answers with its best guess whatever it is asked,
    # and "No Direction" came back as an unrelated Japanese manga (the direction ignores such a guess now).
    plain = os.path.join(root, 'Test Source', 'Walk Forty Eight Plain')
    os.makedirs(plain, exist_ok=True)
    with zipfile.ZipFile(os.path.join(plain, 'Chapter 001.cbz'), 'w') as z:
        for i in range(1, 13):
            z.writestr(f'{i:03d}.png', bands(300, 450, 900 + i))
        z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Walk Forty Eight Plain</Series>'
                   '<Number>1</Number><Manga>No</Manga></ComicInfo>')
    print(f'  seeded {manga} and {plain}')


def cascade(root: str) -> None:
    """The #180 walk's library (walk180.mjs): a right-to-left series long enough for appends to chain.

    Only on request (`seed.py <root> --cascade`). Four twelve-page chapters, each page different, whose ComicInfo says
    `<Manga>YesAndRightToLeft</Manga>`: four pages before the end of one the reader appends the next, and in Safari
    every append used to carry the reader to the same distance from the new end, which appended the next.
    """
    series = os.path.join(root, 'Test Source', 'Cascade Right To Left')
    os.makedirs(series, exist_ok=True)
    for ch in (1, 2, 3, 4):
        with zipfile.ZipFile(os.path.join(series, f'Chapter {ch:03d}.cbz'), 'w') as z:
            for i in range(1, 13):
                z.writestr(f'{i:03d}.png', bands(300, 450, 1800 + ch * 100 + i))
            z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Cascade Right To Left</Series>'
                       f'<Number>{ch}</Number><Manga>YesAndRightToLeft</Manga></ComicInfo>')
    print(f'  seeded {series}')


def _rows_png(w: int, h: int, row_for) -> bytes:
    """A PNG built a row at a time from `row_for(y)` (w * 3 bytes): fast enough for a 20,000-row strip."""
    raw = bytearray()
    for y in range(h):
        raw += b'\x00'
        raw += row_for(y)
    return _png_from_raw(w, h, bytes(raw))


def _patterns(w: int, seed: int, n: int, lo: int = 40, span: int = 150):
    """`n` distinct mid-tone rows: no channel near white or near black, so a crop finds no paper in them."""
    out = []
    for k in range(n):
        row = bytearray()
        for x in range(w):
            v = lo + (x * 7 + k * 31 + seed * 13) % span
            row += bytes((v, lo + (v * 3 + k) % span, lo + (v + 2 * k + seed) % span))
        out.append(bytes(row))
    return out


def strip_png(w: int, h: int, seed: int) -> bytes:
    """A long strip, art edge to edge: bands of patterned rows, a new band every 250 rows."""
    pats = _patterns(w, seed, 16)
    return _rows_png(w, h, lambda y: pats[(y // 250 + seed) % 16])


def bordered_png(w: int, h: int, seed: int, border: int = 80, halves: bool = False) -> bytes:
    """A scanned page: white paper, `border` px of it all round, art inside. `halves`: a double spread whose left
    half is dark art and right half light art, so a walk can tell which half is on screen."""
    white = b'\xff' * (w * 3)
    edge = b'\xff' * (border * 3)
    inner = w - 2 * border
    if halves:
        left = _patterns(w // 2 - border, seed, 12, lo=20, span=90)
        right = _patterns(w // 2 - border, seed + 50, 12, lo=120, span=90)
        art = [l + r for l, r in zip(left, right)]
    else:
        art = _patterns(inner, seed, 12)
    return _rows_png(w, h, lambda y: white if y < border or y >= h - border else edge + art[(y // 90 + seed) % 12] + edge)


def comfort(root: str) -> None:
    """The v0.61.0 reader walk's library (v610Walk-reader.mjs): the reader comfort pack.

    Only on request (`seed.py <root> --comfort`). Two series, every page different from every other:
      - Strip Long (left to right): chapter 1 is two 689 x 20,000 strips, chapter 2 is 120 slices of 720 x 1,000,
        chapter 3 two strips again -- the window by screens, the append six screens from the end, the zoom that keeps
        its place mid-strip, the automatic pick's "long strips", and a crop that finds nothing to trim.
      - Margins Manga (right to left, ComicInfo `YesAndRightToLeft`): two twelve-page chapters of 1,200 x 1,700 pages
        with 80 px of white paper all round, pages 10 and 12 of each a 2,400 x 1,700 double spread whose halves are
        told apart by their art (dark left, light right) -- Crop page borders, Wide pages, and the automatic pick's
        right-to-left.
    """
    strip = os.path.join(root, 'Test Source', 'Strip Long')
    os.makedirs(strip, exist_ok=True)
    for ch, kind in ((1, 'strips'), (2, 'slices'), (3, 'strips')):
        with zipfile.ZipFile(os.path.join(strip, f'Chapter {ch:03d}.cbz'), 'w', zipfile.ZIP_STORED) as z:
            if kind == 'strips':
                for i in (1, 2):
                    z.writestr(f'{i:03d}.png', strip_png(689, 20000, ch * 10 + i))
            else:
                for i in range(1, 121):
                    z.writestr(f'{i:03d}.png', strip_png(720, 1000, 1000 + i))
            z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Strip Long</Series>'
                       f'<Number>{ch}</Number><Manga>No</Manga></ComicInfo>')
    manga = os.path.join(root, 'Test Source', 'Margins Manga')
    os.makedirs(manga, exist_ok=True)
    for ch in (1, 2):
        with zipfile.ZipFile(os.path.join(manga, f'Chapter {ch:03d}.cbz'), 'w', zipfile.ZIP_STORED) as z:
            for i in range(1, 13):
                spread = i in (10, 12)
                z.writestr(f'{i:03d}.png', bordered_png(2400 if spread else 1200, 1700, ch * 100 + i, halves=spread))
            z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Margins Manga</Series>'
                       f'<Number>{ch}</Number><Manga>YesAndRightToLeft</Manga></ComicInfo>')
    print(f'  seeded {strip} and {manga}')


def noise_png(w: int, h: int, seed: int) -> bytes:
    """A page of noise: nothing in it compresses, so any copy of it made narrower is smaller -- where bordered_png's
    repeated rows make a PNG so small that no narrower copy of it is (and the server rightly sends the page as it is)."""
    rnd = random.Random(seed)
    return _rows_png(w, h, lambda y: rnd.randbytes(w * 3))


def readergroup(root: str) -> None:
    """The reader walk's library (walk263.mjs: #263, #236, #233, #234), every page different from every other.

    Only on request (`seed.py <root> --reader`). Named so that no AniList entry is called that (see rtl()):
      - Walk Two Six Three Resume (left to right): four twelve-page chapters of 300 x 450 pages -- the address following
        three crossings and a refresh, a resize; pages narrower than any width Fit pages to my screen asks for.
      - Walk Two Six Three Gaps: chapters 1, 2, 5, one file holding 6 to 8, and 9, four pages each -- 3 and 4 are missing,
        6 to 8 are one file's.
      - Walk Two Six Three Wide (left to right): one twelve-page chapter of 1,200 x 1,700 pages with 2,400 x 1,700 double
        spreads at pages 5 and 9, their halves told apart by their art -- Wide pages: Split across a turn of the phone,
        and pages wider than a phone shows them (page 2 noise, so a narrower copy of it is smaller).
    """
    resume = os.path.join(root, 'Test Source', 'Walk Two Six Three Resume')
    os.makedirs(resume, exist_ok=True)
    for ch in (1, 2, 3, 4):
        with zipfile.ZipFile(os.path.join(resume, f'Chapter {ch:03d}.cbz'), 'w') as z:
            for i in range(1, 13):
                z.writestr(f'{i:03d}.png', bands(300, 450, 2600 + ch * 100 + i))
            z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Walk Two Six Three Resume</Series>'
                       f'<Number>{ch}</Number><Manga>No</Manga></ComicInfo>')
    gaps = os.path.join(root, 'Test Source', 'Walk Two Six Three Gaps')
    os.makedirs(gaps, exist_ok=True)
    for k, name in enumerate(('Chapter 001', 'Chapter 002', 'Chapter 005', 'Chapter 006-008', 'Chapter 009')):
        with zipfile.ZipFile(os.path.join(gaps, f'{name}.cbz'), 'w') as z:
            for i in range(1, 5):
                z.writestr(f'{i:03d}.png', bands(300, 450, 2700 + k * 10 + i))
    wide = os.path.join(root, 'Test Source', 'Walk Two Six Three Wide')
    os.makedirs(wide, exist_ok=True)
    with zipfile.ZipFile(os.path.join(wide, 'Chapter 001.cbz'), 'w', zipfile.ZIP_STORED) as z:
        for i in range(1, 13):
            spread = i in (5, 9)
            # Page 2 is noise: the one a narrower copy of is smaller, which Fit pages to my screen is then sent.
            z.writestr(f'{i:03d}.png', noise_png(1200, 1700, 2802) if i == 2
                       else bordered_png(2400 if spread else 1200, 1700, 2800 + i, halves=spread))
        z.writestr('ComicInfo.xml', '<?xml version="1.0"?><ComicInfo><Series>Walk Two Six Three Wide</Series>'
                   '<Number>1</Number><Manga>No</Manga></ComicInfo>')
    print(f'  seeded {resume}, {gaps} and {wide}')


if __name__ == '__main__':
    if '--rtl' in sys.argv[2:]:
        rtl(sys.argv[1])
    elif '--cascade' in sys.argv[2:]:
        cascade(sys.argv[1])
    elif '--comfort' in sys.argv[2:]:
        comfort(sys.argv[1])
    elif '--reader' in sys.argv[2:]:
        readergroup(sys.argv[1])
    else:
        main(sys.argv[1])
