#!/usr/bin/env python3
"""Compose the login screen's cover wall.

The login screen is PRE-AUTHENTICATION, so it cannot show real library covers: /img/* is 401 for a
logged-out visitor by design (bff/src/routes/images.ts), and feeding a public page from the library would
bypass per-library grants, max_age_rating and the 18+ hide for anyone who can reach the server. So the wall
is built from art this project already owns -- the twelve genre backdrops and the three portrait key-art
pieces, all generated for Uchiyomi.

Each source is cut at several crop positions, because at wall scale (~180px wide) different crops of one
image read as different covers. Then a cover treatment (edge darkening, spine, border) makes a tile look
like a book rather than a photograph, the rows are offset and the whole grid is rotated, and depth is faked
by dimming rows toward the back so the login form stays legible over the busiest part.

Regenerate:  python3 scripts/login-wall.py
Output:      web/public/art/login-wall.webp
"""
from __future__ import annotations

import argparse
import glob
import math
import os
import random
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "web", "public", "art")
OUT = os.path.join(ART, "login-wall.webp")

# Final canvas. Landscape on purpose: object-cover crops this acceptably to phone portrait, and a tilted
# repeating texture survives that crop where a single piece of key art would not.
W, H = 2560, 1600

TILE_W, TILE_H = 300, 450          # 2:3, the usual cover ratio
GAP_X, GAP_Y = 14, 14
ANGLE = -14                        # degrees; matches the reference's lean
ACCENT = (124, 92, 255)            # --accent, so the wall belongs to the app
# Cover palettes. Anchored on the accent but spread across the spectrum, because a real shelf is not one
# colour -- this is what stops fifteen night scenes reading as one dark smear.
TINTS = [
    (124, 92, 255), (196, 84, 220), (232, 76, 148), (240, 108, 84), (245, 168, 66),
    (120, 200, 140), (72, 190, 205), (86, 132, 240), (168, 96, 232), (226, 92, 92),
]

random.seed(20260826)              # deterministic: same wall on every regeneration
REAL_COVERS = False                # set by --covers; changes the grading, since real covers are not dark


def cover_sources(d: str) -> list[Image.Image]:
    """Load real cover images from a directory (--covers).

    For an operator who would rather see their own shelf than generated art. The result is INSTANCE-LOCAL:
    cover art belongs to its publishers, and a login screen is reachable by anyone who can reach the server,
    so a wall built this way must never be committed or baked into a published image. The shipped default
    stays the generated wall.
    """
    files = sorted(
        f for e in ("*.webp", "*.jpg", "*.jpeg", "*.png")
        for f in glob.glob(os.path.join(d, e))
    )
    if not files:
        raise SystemExit(f"no images found in {d}")
    return [Image.open(f).convert("RGB") for f in files]


def cover_tile(im: Image.Image) -> Image.Image:
    """A real cover, cropped to 2:3 and otherwise left alone.

    No blurring: a cover is the artwork someone chose, and softening it to obscure a title costs more than
    the title is worth. The vertical bias below keeps heads and figures in frame when a tall cover has to
    lose height, which is the only judgement this function makes.
    """
    w, h = im.size
    target = TILE_W / TILE_H
    if w / h > target:                      # too wide: take the middle column
        cw = int(h * target); x = (w - cw) // 2; im = im.crop((x, 0, x + cw, h))
    else:                                   # too tall: bias upward, where the art usually is
        ch = int(w / target); y = int((h - ch) * 0.28); im = im.crop((0, y, w, y + ch))
    return im.resize((TILE_W, TILE_H), Image.LANCZOS)


def sources() -> list[Image.Image]:
    """Every piece of art this app owns that is worth cutting covers from."""
    names = [os.path.join("bg", f"{g}.webp") for g in (
        "action", "comedy", "drama", "fantasy", "historical", "horror",
        "murim", "mystery", "romance", "scifi", "sports", "supernatural",
    )] + ["login.webp", "splash.webp", "wrapped.webp", "hero.webp", "section.webp"]

    out = []
    for n in names:
        p = os.path.join(ART, n)
        if os.path.exists(p):
            out.append(Image.open(p).convert("RGB"))
    if not out:
        raise SystemExit(f"no source art found under {ART}")
    return out


def crops(im: Image.Image) -> list[Image.Image]:
    """Cut one source into several 2:3 portrait tiles at different positions.

    A 1400x788 landscape backdrop only yields a 525px-wide portrait slice, so taking several slices across
    it is what turns twelve images into a wall that does not visibly repeat.
    """
    w, h = im.size
    target = TILE_W / TILE_H                      # 0.666…
    ch = h
    cw = int(ch * target)
    if cw > w:                                    # portrait source: crop vertically instead
        cw = w
        ch = int(cw / target)

    n = max(1, min(4, (w - cw) // max(1, cw // 2) + 1))
    out = []
    for i in range(n):
        x = 0 if n == 1 else int(i * (w - cw) / (n - 1))
        y = max(0, (h - ch) // 2)
        out.append(im.crop((x, y, x + cw, y + ch)).resize((TILE_W, TILE_H), Image.LANCZOS))
    return out


def as_cover(t: Image.Image, depth: float, tint: tuple[int, int, int]) -> Image.Image:
    """Make a crop read as a book cover, and push it back in space.

    The source art is dark cinematic key art of night scenes, and LoginScreen puts two scrims, grain and a
    vignette on top of whatever this produces. So the wall is deliberately built BRIGHTER and more saturated
    than it should finally look -- the app darkens it. Built to taste it reads as a black smear.

    depth 0 = front row, 1 = far back. Kept shallow for the same reason.
    """
    if REAL_COVERS:
        # Real covers are already bright and saturated. The lift that rescues dark generated key art
        # blows them out, so they only get pushed back in space.
        t = ImageEnhance.Brightness(t).enhance(1.0 - 0.3 * depth)
        t = ImageEnhance.Color(t).enhance(1.0 - 0.2 * depth)
    else:
        t = ImageEnhance.Brightness(t).enhance(1.55 - 0.35 * depth)
        t = ImageEnhance.Color(t).enhance(1.5 - 0.25 * depth)
    t = ImageEnhance.Contrast(t).enhance(1.12)

    # Per-tile tint. One accent wash across everything flattened fifteen pictures into one colour; giving
    # each tile its own hue is what makes a wall read as a catalogue of different books.
    wash = Image.new("RGB", t.size, tint)
    t = Image.blend(t, wash, 0.04 if REAL_COVERS else 0.14)

    d = ImageDraw.Draw(t, "RGBA")
    # spine: a soft dark edge down one side, which is most of what makes a rectangle look like a book
    for x in range(int(TILE_W * 0.07)):
        a = int(150 * (1 - x / (TILE_W * 0.07)))
        d.line([(x, 0), (x, TILE_H)], fill=(0, 0, 0, a))
    # bottom shading, where a real cover carries its title block
    for y in range(int(TILE_H * 0.22)):
        yy = TILE_H - 1 - y
        a = int(120 * (1 - y / (TILE_H * 0.22)))
        d.line([(0, yy), (TILE_W, yy)], fill=(0, 0, 0, a))
    # inner border, so tiles separate from each other against black
    d.rectangle([0, 0, TILE_W - 1, TILE_H - 1], outline=(255, 255, 255, 26), width=1)
    return t


def build(covers_dir: str | None = None) -> Image.Image:
    if covers_dir:
        srcs = cover_sources(covers_dir)
        # Never draw a cover larger than it really is. Cover art tops out around 460px wide (AniList's
        # `large` is the biggest variant published for most manga; `extraLarge` 404s), so a tile any wider
        # than the source is upscaling -- which is what actually reads as "pixelated" on a high-DPI screen,
        # not the WebP quality. Shrinking the tile means more, smaller covers, which is also what the wall
        # this imitates looks like.
        # Median, not max: one high-resolution outlier in a set of ordinary covers would otherwise let the
        # tile grow past what almost every source can fill.
        import statistics
        typical = int(statistics.median([im.size[0] for im in srcs]))
        if TILE_W > typical:
            k = typical / TILE_W
            globals()["TILE_W"], globals()["TILE_H"] = typical, int(TILE_H * k)
            globals()["GAP_X"], globals()["GAP_Y"] = max(1, int(GAP_X * k)), max(1, int(GAP_Y * k))
            print(f"  tile capped at the source width: {TILE_W}x{TILE_H} (no upscaling)")
        pool = [cover_tile(im) for im in srcs]
        print(f"  {len(srcs)} real covers -> {len(pool)} tiles")
    else:
        srcs = sources()
        pool = []
        for im in srcs:
            pool.extend(crops(im))
        print(f"  {len(srcs)} source images -> {len(pool)} distinct tiles")
    random.shuffle(pool)

    # Oversize the working canvas so that after rotation no tile is cut mid-row at the edges.
    diag = int(math.hypot(W, H) * 1.25)
    canvas = Image.new("RGB", (diag, diag), (0, 0, 0))

    step_x, step_y = TILE_W + GAP_X, TILE_H + GAP_Y
    rows = diag // step_y + 2
    cols = diag // step_x + 2

    i = 0
    for r in range(rows):
        # Offset alternate rows so columns never line up into visible seams.
        off = (r % 3) * (step_x // 3)
        # Depth runs top (far) to bottom (near), like the reference.
        depth = 1.0 - (r / max(1, rows - 1))
        depth = depth ** 1.4
        for c in range(cols):
            tile = as_cover(pool[i % len(pool)].copy(), depth, TINTS[(i * 7 + r * 3) % len(TINTS)])
            i += 1
            canvas.paste(tile, (c * step_x - off, r * step_y))

    canvas = canvas.rotate(ANGLE, resample=Image.BICUBIC, expand=False)
    left, top = (diag - W) // 2, (diag - H) // 2
    wall = canvas.crop((left, top, left + W, top + H))

    # No centre dim here on purpose. LoginScreen already lays a full-height gradient scrim, an accent
    # radial, grain and a vignette over this image; dimming twice is what turned the first attempt into a
    # black rectangle. Legibility is the CSS layer's job, and it already does it.
    return wall


def main() -> None:
    global REAL_COVERS, W, H
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--covers", metavar="DIR", help="build from real cover images in DIR (instance-local; see cover_sources)")
    ap.add_argument("--out", metavar="PATH", help=f"where to write (default {OUT})")
    # Real covers carry far more detail than generated key art, so a wall built from them is heavier at the
    # same canvas. Since it is displayed scaled down, dropping the canvas buys more than dropping quality.
    ap.add_argument("--width", type=int, default=W, metavar="PX", help=f"canvas width (default {W}, 16:10)")
    # Fixed quality beats chasing a size budget. Stepping quality down until a file fits a number is how
    # this wall ended up at q30 with visible artifacts -- a login backdrop is mostly large flat artwork,
    # which is exactly what low WebP quality ruins first.
    ap.add_argument("--quality", type=int, default=0, metavar="Q", help="fixed WebP quality; omit to step down to fit ~250 KB")
    a = ap.parse_args()

    REAL_COVERS = bool(a.covers)
    if a.width != W:
        global TILE_W, TILE_H, GAP_X, GAP_Y
        k = a.width / W
        W, H = a.width, int(a.width * 10 / 16)
        # Keep the composition identical and raise its resolution, rather than fitting more, smaller covers.
        TILE_W, TILE_H = int(TILE_W * k), int(TILE_H * k)
        GAP_X, GAP_Y = max(1, int(GAP_X * k)), max(1, int(GAP_Y * k))
    out = a.out or OUT
    wall = build(a.covers)
    if a.quality:
        wall.save(out, "WEBP", quality=a.quality, method=6)
    else:
        for q in (72, 66, 60, 54, 48, 42, 36, 30):
            wall.save(out, "WEBP", quality=q, method=6)
            kb = os.path.getsize(out) // 1024
            print(f"  quality {q}: {kb} KB")
            if kb <= 250:
                break
    print(f"  -> {out}  {wall.size[0]}x{wall.size[1]}  {os.path.getsize(out)//1024} KB")


if __name__ == "__main__":
    main()
