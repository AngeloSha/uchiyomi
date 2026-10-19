// The drawings on the settings' picture cards (v0.86.0, components/settings.tsx ChoiceCards): what each choice looks
// like, small enough to sit three across on a phone. Drawn, not screenshots: they follow the tone and the accent the
// reader picked, weigh nothing, and stay sharp at any size.
//
// Each fills the card's art box (`h-16`, the card's width) and is decoration only: the card's label is its name, so
// every drawing is `aria-hidden` by the box it sits in.
import type { ReactNode } from 'react';
import { THEME_FILTER, type ReaderTheme } from '@/lib/readerPrefs';
import { TONES, type Tone } from '@/lib/tone';

const box = 'block h-full w-full';

/** A phone held upright, drawn around whatever is inside it. */
function Phone({ children }: { children: ReactNode }) {
  return (
    <>
      <rect x="44" y="4" width="32" height="56" rx="5" className="fill-ink-950 stroke-ink-500" strokeWidth="1.5" />
      {children}
    </>
  );
}

/** A manga page, very small: panels and a speech bubble on paper. */
function Page({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="1" fill="#efeff2" />
      <rect x={x + w * 0.1} y={y + h * 0.08} width={w * 0.8} height={h * 0.36} fill="none" stroke="#2b2b33" strokeWidth="0.9" />
      <rect x={x + w * 0.1} y={y + h * 0.5} width={w * 0.36} height={h * 0.42} fill="none" stroke="#2b2b33" strokeWidth="0.9" />
      <rect x={x + w * 0.54} y={y + h * 0.5} width={w * 0.36} height={h * 0.42} fill="none" stroke="#2b2b33" strokeWidth="0.9" />
      <ellipse cx={x + w * 0.62} cy={y + h * 0.24} rx={w * 0.18} ry={h * 0.09} fill="#ffffff" stroke="#2b2b33" strokeWidth="0.7" />
    </g>
  );
}

/** Webtoon: one long strip that scrolls; Paged: a page at a time, the next one sliding in from the side. */
export function ModeArt({ mode }: { mode: 'vertical' | 'paged' }) {
  return (
    <svg viewBox="0 0 120 64" className={`${box} bg-ink-900`} preserveAspectRatio="xMidYMid meet">
      {mode === 'vertical' ? (
        <>
          <Phone>
            <rect x="48" y="-6" width="24" height="20" rx="1" fill="#efeff2" />
            <rect x="48" y="16" width="24" height="22" rx="1" fill="#efeff2" />
            <rect x="48" y="40" width="24" height="22" rx="1" fill="#efeff2" />
            <path d="M51 22h18M51 27h12M51 46h18M51 51h9" stroke="#2b2b33" strokeWidth="1" strokeLinecap="round" />
          </Phone>
          <rect x="43" y="0" width="34" height="5" className="fill-ink-900" />
          <rect x="43" y="59" width="34" height="5" className="fill-ink-900" />
          <path d="M88 22v20m-5-5 5 5 5-5" fill="none" className="stroke-accent" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <Phone>
            <Page x={48} y={9} w={24} h={46} />
          </Phone>
          <g opacity="0.55">
            <rect x="82" y="9" width="24" height="46" rx="1" fill="#efeff2" />
          </g>
          <path d="M98 59H86m4-3.5L86 59l4 3.5" fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

/** The reader's theme, drawn with the reader's own filter (lib/readerPrefs.ts THEME_FILTER) over a page on black. */
export function ThemeArt({ theme }: { theme: ReaderTheme }) {
  return (
    <svg viewBox="0 0 120 64" className={`${box} bg-black`} preserveAspectRatio="xMidYMid meet">
      <g style={{ filter: THEME_FILTER[theme] }}>
        <Page x={38} y={5} w={44} h={54} />
        <rect x="44" y="9" width="16" height="10" fill="#b44" opacity="0.55" />
        <rect x="60" y="34" width="14" height="12" fill="#48a" opacity="0.5" />
      </g>
    </svg>
  );
}

/** What a double-page spread becomes on a screen held upright: whole and small, split into its two pages, or turned. */
export function WideArt({ how }: { how: 'whole' | 'split' | 'rotate' }) {
  return (
    <svg viewBox="0 0 120 64" className={`${box} bg-ink-900`} preserveAspectRatio="xMidYMid meet">
      <Phone>
        {how === 'whole' && (
          <g>
            <rect x="47" y="24" width="13" height="17" rx="0.6" fill="#efeff2" />
            <rect x="60" y="24" width="13" height="17" rx="0.6" fill="#dcdce4" />
            <path d="M60 24v17" stroke="#2b2b33" strokeWidth="0.6" />
          </g>
        )}
        {how === 'split' && (
          <g>
            <rect x="47" y="8" width="26" height="48" rx="0.8" fill="#efeff2" />
            <rect x="51" y="13" width="18" height="16" fill="none" stroke="#2b2b33" strokeWidth="0.8" />
            <rect x="51" y="33" width="18" height="18" fill="none" stroke="#2b2b33" strokeWidth="0.8" />
          </g>
        )}
        {how === 'rotate' && (
          <g>
            <rect x="47" y="7" width="26" height="24.5" rx="0.6" fill="#efeff2" />
            <rect x="47" y="32.5" width="26" height="24.5" rx="0.6" fill="#dcdce4" />
            <path d="M47 32h26" stroke="#2b2b33" strokeWidth="0.6" />
          </g>
        )}
      </Phone>
      {how === 'split' && <rect x="82" y="8" width="26" height="48" rx="0.8" fill="#dcdce4" opacity="0.45" strokeDasharray="2 2" />}
      {how === 'rotate' && (
        <path d="M90 40a10 10 0 1 1 9-14m0-6v6h-6" fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** A credits page between two story pages: shown, folded to a line you can open, or left out. */
export function RepeatedArt({ how }: { how: 'show' | 'collapse' | 'hide' }) {
  const page = (x: number) => <rect x={x} y="10" width="22" height="44" rx="1" fill="#efeff2" />;
  const credits = (x: number) => (
    <g>
      <rect x={x} y="10" width="22" height="44" rx="1" className="fill-accent" opacity="0.85" />
      <path d={`M${x + 5} 24h12M${x + 7} 30h8M${x + 5} 36h12`} stroke="#0b0b0f" strokeWidth="1.6" strokeLinecap="round" />
    </g>
  );
  return (
    <svg viewBox="0 0 120 64" className={`${box} bg-ink-900`} preserveAspectRatio="xMidYMid meet">
      {how === 'show' && <>{page(18)}{credits(49)}{page(80)}</>}
      {how === 'collapse' && (
        <>
          {page(27)}
          <rect x="54" y="10" width="5" height="44" rx="1" className="fill-accent" opacity="0.85" />
          {page(66)}
        </>
      )}
      {how === 'hide' && <>{page(35)}{page(62)}</>}
    </svg>
  );
}

/** The page's background tone, each drawn in its own colours whatever tone is on: the page, a card on it, the accent. */
export function ToneArt({ tone }: { tone: Tone }) {
  const t = TONES.find((x) => x.key === tone)!;
  return (
    <span className="relative block h-full overflow-hidden" style={{ background: t.page, boxShadow: `inset 0 0 0 1px ${t.line}` }}>
      <span className="absolute inset-x-2 bottom-2 top-5 rounded-md" style={{ background: t.surface, boxShadow: `inset 0 0 0 1px ${t.line}` }} />
      <span className="absolute start-2 top-2 h-1.5 w-7 rounded-[2px] bg-accent" />
      <span className="absolute start-4 top-7 h-1 w-10 rounded-[2px] bg-fog-300/70" />
      <span className="absolute start-4 top-9 h-1 w-6 rounded-[2px] bg-fog-500/70" />
    </span>
  );
}
