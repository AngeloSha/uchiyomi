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

/**
 * How a series' backdrop is drawn, for the style the page asked for (v0.53.0):
 * - 'hero' -- the home carousel and the profile: the real art sharp in a frame, a banner OR a cover (shown whole over a
 *   blurred copy of itself when its shape is far from the frame's);
 * - 'banner' -- the series page: a REAL banner (AniList's, or an admin's) sharp, as it is. The owner asked for the
 *   banner to be seen there; it was blurred like everything else;
 * - 'ambient' -- the blurred, darkened wash: a cover blown up to stand in for a banner it does not have (a stretched
 *   cover looks bad sharp), the first page when there is no art at all, and every backdrop that asks for no style.
 * `fromBanner` is whether the bytes in hand ARE the banner: a banner that could not be fetched falls back to the first
 * page, which must never be drawn sharp across a banner's frame.
 */
export type BackdropLook = 'hero' | 'banner' | 'ambient';
export function backdropLook(style: 'hero' | 'banner' | null, art: { hasUrl: boolean; fromBanner: boolean }): BackdropLook {
  if (style === 'hero' && art.hasUrl) return 'hero';
  if (style === 'banner' && art.fromBanner) return 'banner';
  return 'ambient';
}
