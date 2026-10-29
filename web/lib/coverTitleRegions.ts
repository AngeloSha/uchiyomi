export interface CoverTitleRect { left: number; top: number; width: number; height: number }
export interface CoverTitlePoint { x: number; y: number }
export const MIN_TITLE_REGION = 0.01;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
const rounded = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** Coordinates are physical image coordinates, independent of the interface's reading direction. */
export function coverPoint(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }): CoverTitlePoint | null {
  if (![clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: clamp((clientX - bounds.left) / bounds.width, 0, 1), y: clamp((clientY - bounds.top) / bounds.height, 0, 1) };
}

export function coverRect(a: CoverTitlePoint, b: CoverTitlePoint): CoverTitleRect {
  const x = clamp(Math.min(a.x, b.x), 0, 1 - MIN_TITLE_REGION);
  const y = clamp(Math.min(a.y, b.y), 0, 1 - MIN_TITLE_REGION);
  return { left: rounded(x), top: rounded(y), width: rounded(clamp(Math.abs(b.x - a.x), MIN_TITLE_REGION, 1 - x)),
    height: rounded(clamp(Math.abs(b.y - a.y), MIN_TITLE_REGION, 1 - y)) };
}

/** A keyboard edit keeps the selected rectangle inside the cover and never accepts an empty or invalid size. */
export function editCoverRect(rect: CoverTitleRect, field: keyof CoverTitleRect, value: number): CoverTitleRect {
  if (!Number.isFinite(value)) return rect;
  const next = { ...rect };
  if (field === 'left') next.left = rounded(clamp(value, 0, 1 - rect.width));
  else if (field === 'top') next.top = rounded(clamp(value, 0, 1 - rect.height));
  else if (field === 'width') next.width = rounded(clamp(value, MIN_TITLE_REGION, 1 - rect.left));
  else next.height = rounded(clamp(value, MIN_TITLE_REGION, 1 - rect.top));
  return next;
}

export function sameCoverSelection(a: { region: CoverTitleRect | null; exclusions: CoverTitleRect[] }, b: { region: CoverTitleRect | null; exclusions: CoverTitleRect[] }): boolean {
  const same = (one: CoverTitleRect | null, two: CoverTitleRect | null) => one === null || two === null ? one === two
    : (['left', 'top', 'width', 'height'] as const).every((field) => one[field] === two[field]);
  return same(a.region, b.region) && a.exclusions.length === b.exclusions.length && a.exclusions.every((rect, i) => same(rect, b.exclusions[i]));
}
