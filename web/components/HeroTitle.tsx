'use client';
import { useState, type CSSProperties, type Ref } from 'react';
import type { Series } from '@/lib/types';
import { titleArtAccent, titleArtStyle, titleLogoUrl, titleLogoNeedsCaption, titleNeedsNaturalScript } from '@/lib/titleArt';

/** One title identity across both heroes. The readable name remains the heading when artwork carries its lettering. */
export function HeroTitle({ series, title = series.metadata?.title || series.name, headingRef, className = '', as = 'h1' }: {
  series: Pick<Series, 'id' | 'name' | 'metadata' | 'titleArt' | 'color'>;
  title?: string; headingRef?: Ref<HTMLHeadingElement>; className?: string; as?: 'h1' | 'div';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = titleLogoUrl(series.id, series.titleArt);
  const candidate = url && failed !== url ? url : null;
  const logo = candidate && loaded === candidate ? candidate : null;
  const style = titleArtStyle(series.metadata?.genres, series.titleArt?.style);
  const natural = titleNeedsNaturalScript(title);
  const caption = !!logo && titleLogoNeedsCaption(series.titleArt);
  const content = <>
    {candidate && <img key={candidate} src={candidate} alt="" aria-hidden="true" className={`hero-title-logo${logo ? '' : ' hero-title-loading'}`}
      onLoad={() => setLoaded(candidate)} onError={() => setFailed(candidate)} />}
    <span className={logo ? caption ? 'hero-title-caption' : 'sr-only' : 'hero-title-text'}>{title}</span>
  </>;
  const attributes = { dir: 'auto', 'data-hero-title': true, 'data-title-style': style, 'data-title-script': natural ? 'natural' : 'latin',
    className: `hero-title ${className}`, style: { '--title-accent': titleArtAccent(series.color) } as CSSProperties };
  return as === 'div' ? <div {...attributes}>{content}</div> : <h1 ref={headingRef} {...attributes}>{content}</h1>;
}
