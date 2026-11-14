'use client';
import { useEffect, useState, type CSSProperties, type Ref } from 'react';
import type { Series } from '@/lib/types';
import { titleArtAccent, titleArtStyle, titleLogoUrl, titleLogoNeedsCaption, titleNeedsNaturalScript } from '@/lib/titleArt';

/** How long a hero holds its written title back for the logo before drawing it instead (a slow connection). */
export const LOGO_WAIT_MS = 1500;

/** One title identity across both heroes. The readable name remains the heading when artwork carries its lettering. */
export function HeroTitle({ series, title = series.metadata?.title || series.name, headingRef, className = '', as = 'h1', previewUrl, logo: showLogo = true }: {
  series: Pick<Series, 'id' | 'name' | 'metadata' | 'titleArt' | 'color'>;
  title?: string; headingRef?: Ref<HTMLHeadingElement>; className?: string; as?: 'h1' | 'div';
  /** An authenticated in-memory cutout for the admin preview only. It never becomes a stored artwork URL. */
  previewUrl?: string;
  /**
   * v0.102.2: whether the title logo may be drawn at all. Off where the cover itself is the hero (under 1024 px: the
   * heroes pass `useWideViewport()`): the cover already carries its lettering, so the styled title shows instead, and no
   * logo is downloaded. Reintroduce by ignoring it: titleArt.test.ts finds an <img> in a phone's hero.
   */
  logo?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const preview = previewUrl?.startsWith('blob:') ? previewUrl : null;
  const url = showLogo ? preview ?? titleLogoUrl(series.id, series.titleArt) : null;
  const candidate = url && failed !== url ? url : null;
  const logo = candidate && loaded === candidate ? candidate : null;
  const [waited, setWaited] = useState<string | null>(null);
  useEffect(() => {
    if (!candidate || loaded === candidate) return;
    const t = setTimeout(() => setWaited(candidate), LOGO_WAIT_MS);
    return () => clearTimeout(t);
  }, [candidate, loaded]);
  // While the logo downloads, the written title keeps its place and its words but is not drawn: drawn, it showed in every
  // hero and at every turn of Home's carousel until the logo replaced it (the owner, 11-14). It is drawn once the logo
  // fails or has taken LOGO_WAIT_MS. Opacity, not visibility, so a screen reader still has the heading meanwhile.
  const waiting = !!candidate && !logo && waited !== candidate;
  const style = titleArtStyle(series.metadata?.genres, series.titleArt?.style);
  const natural = titleNeedsNaturalScript(title);
  const caption = !!logo && (!!preview || titleLogoNeedsCaption(series.titleArt));
  const content = <>
    {candidate && <img key={candidate} src={candidate} alt="" aria-hidden="true" className={`hero-title-logo${logo ? '' : ' hero-title-loading'}`}
      onLoad={() => setLoaded(candidate)} onError={() => setFailed(candidate)} />}
    <span className={logo ? caption ? 'hero-title-caption' : 'sr-only' : waiting ? 'hero-title-text hero-title-waiting' : 'hero-title-text'}>{title}</span>
  </>;
  const attributes = { dir: 'auto', 'data-hero-title': true, 'data-title-style': style, 'data-title-script': natural ? 'natural' : 'latin',
    className: `hero-title ${className}`, style: { '--title-accent': titleArtAccent(series.color) } as CSSProperties };
  return as === 'div' ? <div {...attributes}>{content}</div> : <h1 ref={headingRef} {...attributes}>{content}</h1>;
}
