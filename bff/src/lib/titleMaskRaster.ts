// Kept byte-identical with web/lib/titleMaskRaster.ts; shared pixel-center semantics for private mask edits.
export interface TitleMaskPoint { x: number; y: number }
export interface MaskStroke { mode: 'restore' | 'erase'; radius: number; points: TitleMaskPoint[] }
export type TitleMaskStroke = MaskStroke;
export const TITLE_MASK_MAX_STROKES = 128;
export const TITLE_MASK_MAX_POINTS = 8192;
export const TITLE_MASK_MAX_PIXELS = 1800 * 2400;
export const TITLE_MASK_MAX_WORK = 40_000_000;
export class TitleMaskRasterError extends Error {
  constructor(readonly code: 'invalid_mask' | 'mask_too_complex') { super(code); }
}
const invalid = (): never => { throw new TitleMaskRasterError('invalid_mask'); };
type Segment = { ax: number; ay: number; bx: number; by: number; radius: number; value: number;
  left: number; top: number; right: number; bottom: number };

function segmentsFor(width: number, height: number, strokes: readonly MaskStroke[]): Segment[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 2400 || height > 2400 || width * height > TITLE_MASK_MAX_PIXELS
    || !Array.isArray(strokes) || strokes.length > TITLE_MASK_MAX_STROKES) invalid();
  const segments: Segment[] = [];
  let points = 0, work = 0;
  for (const stroke of strokes) {
    if (!stroke || !['restore', 'erase'].includes(stroke.mode) || !Number.isFinite(stroke.radius)
      || stroke.radius < .0005 || stroke.radius > .05 || !Array.isArray(stroke.points) || stroke.points.length < 1) invalid();
    points += stroke.points.length;
    if (points > TITLE_MASK_MAX_POINTS) throw new TitleMaskRasterError('mask_too_complex');
    for (const point of stroke.points) if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) invalid();
    const radius = stroke.radius * Math.min(width, height);
    for (let index = 0; index < Math.max(1, stroke.points.length - 1); index++) {
      const a = stroke.points[index], b = stroke.points[Math.min(index + 1, stroke.points.length - 1)];
      const ax = a.x * width, ay = a.y * height, bx = b.x * width, by = b.y * height;
      const left = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
      const top = Math.max(0, Math.floor(Math.min(ay, by) - radius));
      const right = Math.min(width - 1, Math.floor(Math.max(ax, bx) + radius));
      const bottom = Math.min(height - 1, Math.floor(Math.max(ay, by) + radius));
      work += Math.max(0, right - left + 1) * Math.max(0, bottom - top + 1);
      if (work > TITLE_MASK_MAX_WORK) throw new TitleMaskRasterError('mask_too_complex');
      segments.push({ ax, ay, bx, by, radius, left, top, right, bottom, value: stroke.mode === 'restore' ? 255 : 0 });
    }
  }
  return segments;
}

/** Hard alpha round brushes. Stroke coordinates and radius refer to the full immutable cover, independent of zoom. */
export function rasterizeTitleMask(baseline: Uint8Array, width: number, height: number, strokes: readonly MaskStroke[]): Uint8Array {
  if (!(baseline instanceof Uint8Array) || baseline.length !== width * height) invalid();
  const segments = segmentsFor(width, height, strokes);
  const alpha = baseline.slice();
  for (const segment of segments) {
    const { ax, ay, bx, by, radius, value, left, top, right, bottom } = segment;
    const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy, radiusSquared = radius * radius;
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const px = x + .5, py = y + .5;
      const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
      const distanceX = px - ax - position * dx, distanceY = py - ay - position * dy;
      if (distanceX * distanceX + distanceY * distanceY <= radiusSquared) alpha[y * width + x] = value;
    }
  }
  return alpha;
}
export const applyTitleMaskStrokes = rasterizeTitleMask;
