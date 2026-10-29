import type { TitleMaskPoint, TitleMaskStroke } from './titleMaskRaster';

export function sameMaskStrokes(one: readonly TitleMaskStroke[], two: readonly TitleMaskStroke[]): boolean {
  return one.length === two.length && one.every((stroke, i) => stroke.mode === two[i].mode && stroke.radius === two[i].radius
    && stroke.points.length === two[i].points.length && stroke.points.every((p, n) => p.x === two[i].points[n].x && p.y === two[i].points[n].y));
}

/** Keep physical brush coordinates independent of the zoom and scroll position. */
export function maskCanvasPoint(x: number, y: number, bounds: { left: number; top: number; width: number; height: number }): TitleMaskPoint | null {
  if (![x, y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: Math.max(0, Math.min(1, (x - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (y - bounds.top) / bounds.height)) };
}

/** A one-pixel keyboard step stays on pixel centres, even when the smallest brush is less than half a pixel wide. */
export function maskKeyboardPoint(point: TitleMaskPoint, dx: number, dy: number, width: number, height: number): TitleMaskPoint {
  return { x: (Math.max(0, Math.min(width - 1, Math.floor(point.x * width) + dx)) + .5) / width,
    y: (Math.max(0, Math.min(height - 1, Math.floor(point.y * height) + dy)) + .5) / height };
}

/** Drop sub-quarter-radius samples and redundant collinear middles; keep corners and the final pointer position. */
export function appendMaskPoint(points: readonly TitleMaskPoint[], point: TitleMaskPoint, width: number, height: number, radius: number, final = false): TitleMaskPoint[] {
  const last = points.at(-1);
  if (!last) return [point];
  const dx = (point.x - last.x) * width, dy = (point.y - last.y) * height;
  if (dx === 0 && dy === 0) return [...points];
  if (!final && Math.hypot(dx, dy) < radius * Math.min(width, height) / 4) return [...points];
  const before = points.at(-2);
  if (before) {
    const ax = (last.x - before.x) * width, ay = (last.y - before.y) * height;
    if (Math.abs(ax * dy - ay * dx) < 1e-7 && ax * dx + ay * dy >= 0) return [...points.slice(0, -1), point];
  }
  return [...points, point];
}

export function titleMaskBounds(alpha: Uint8Array, width: number, height: number): { left: number; top: number; width: number; height: number } | null {
  if (alpha.length !== width * height) throw new Error('invalid mask dimensions');
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[y * width + x] > 0) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Alpha changes never read RGB back from an erased canvas: source colours are immutable. */
export function maskRgba(source: Uint8ClampedArray, alpha: Uint8Array): Uint8ClampedArray {
  if (source.length !== alpha.length * 4) throw new Error('invalid mask dimensions');
  const pixels = new Uint8ClampedArray(source);
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];
  return pixels;
}

export function cropTitleMask(source: Uint8ClampedArray, alpha: Uint8Array, width: number, height: number) {
  if (source.length !== width * height * 4) throw new Error('invalid source dimensions');
  const bounds = titleMaskBounds(alpha, width, height);
  if (!bounds) return null;
  const pixels = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const from = ((bounds.top + y) * width + bounds.left + x), to = (y * bounds.width + x) * 4;
    pixels[to] = source[from * 4]; pixels[to + 1] = source[from * 4 + 1]; pixels[to + 2] = source[from * 4 + 2]; pixels[to + 3] = alpha[from];
  }
  return { ...bounds, pixels };
}
