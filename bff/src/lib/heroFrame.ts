// Hero backdrop geometry. Source art arrives in wildly different shapes — AniList banners are ~1900x400,
// portrait covers are ~700x1000 — while the hero frame is a wide strip on desktop and near-portrait on a
// phone. Cropping mismatched art to fill the frame produces the "zoomed mush / head cut off" look, so the
// decision of *how* to fit is made here and kept pure for testing.

export const HERO_FRAMES = { wide: { w: 1920, h: 720 }, tall: { w: 1080, h: 1200 } } as const;
export type HeroAr = keyof typeof HERO_FRAMES;

/** How far apart two aspect ratios are, as a ratio >= 1 (1 = identical shape). */
export function aspectDistance(srcW: number, srcH: number, ar: HeroAr): number {
  const f = HERO_FRAMES[ar];
  const src = srcW > 0 && srcH > 0 ? srcW / srcH : 1;
  const frame = f.w / f.h;
  return Math.max(src, frame) / Math.min(src, frame);
}

/**
 * 'crop' — shapes are close enough that a saliency crop fills the frame without wrecking the art.
 * 'fill' — shapes differ enough that we show the whole image over a blurred copy of itself instead.
 */
export function heroFit(srcW: number, srcH: number, ar: HeroAr): 'crop' | 'fill' {
  return aspectDistance(srcW, srcH, ar) <= 1.35 ? 'crop' : 'fill';
}
