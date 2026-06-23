import sharp from 'sharp';

const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * The dominant *vibrant* color of a cover as #rrggbb — for ambient theming.
 * sharp's `.stats().dominant` tends to return white/black borders, so instead we downsample,
 * drop near-white/near-black/gray pixels, bucket the rest, and pick the most prominent
 * saturated color (frequency weighted by saturation). Falls back to `dominant`.
 */
export async function dominantHex(input: Buffer): Promise<string> {
  try {
    const { data } = await sharp(input).resize(28, 28, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const buckets = new Map<string, { r: number; g: number; b: number; n: number; s: number }>();
    for (let i = 0; i + 2 < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const v = mx / 255;
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (v < 0.12 || v > 0.95 || sat < 0.18) continue; // skip dark / washed-out / gray
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const cur = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, s: 0 };
      cur.r += r; cur.g += g; cur.b += b; cur.n++; cur.s = Math.max(cur.s, sat);
      buckets.set(key, cur);
    }
    let best: { r: number; g: number; b: number } | null = null;
    let bestScore = -1;
    for (const v of buckets.values()) {
      const score = v.n * (0.5 + v.s);
      if (score > bestScore) { bestScore = score; best = { r: v.r / v.n, g: v.g / v.n, b: v.b / v.n }; }
    }
    if (best) return `#${hx(best.r)}${hx(best.g)}${hx(best.b)}`;
  } catch {}
  const { dominant } = await sharp(input).stats();
  return `#${hx(dominant.r)}${hx(dominant.g)}${hx(dominant.b)}`;
}
