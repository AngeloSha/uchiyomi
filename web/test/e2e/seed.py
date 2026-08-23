#!/usr/bin/env python3
"""Write a tiny library for the end-to-end run: one series, one chapter of each format the app claims.

Generated rather than committed so there is no binary fixture in the repo, and so the formats under test are
the ones the README actually names -- if a format is added, this file is where it becomes visible that the
browser pass never opened one.
"""
import os
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


def png(w: int, h: int, rgb) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', crc32(c))
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


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

    print(f'  seeded {d}')


if __name__ == '__main__':
    main(sys.argv[1])
