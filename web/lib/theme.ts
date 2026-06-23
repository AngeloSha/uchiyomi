// Cover-art ambient theming: drives the `--cover` CSS var (an "r g b" triplet) so components
// can paint soft glows with `rgb(var(--cover, 124 92 255) / <alpha>)`. Falls back to accent.

function parse(hex?: string | null): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Lift very dark dominant colors so the ambient glow is still visible on true black. */
function lift({ r, g, b }: { r: number; g: number; b: number }) {
  const max = Math.max(r, g, b);
  if (max >= 90) return { r, g, b };
  const k = max === 0 ? 1 : 110 / max;
  return { r: Math.min(255, r * k), g: Math.min(255, g * k), b: Math.min(255, b * k) };
}

export function coverTriplet(hex?: string | null): string | null {
  const rgb = parse(hex);
  if (!rgb) return null;
  const l = lift(rgb);
  return `${Math.round(l.r)} ${Math.round(l.g)} ${Math.round(l.b)}`;
}

export function applyCover(hex?: string | null) {
  if (typeof document === 'undefined') return;
  const t = coverTriplet(hex);
  const el = document.documentElement;
  if (t) el.style.setProperty('--cover', t);
  else el.style.removeProperty('--cover');
}

export function clearCover() {
  if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--cover');
}
