'use client';
// A status as a shaped glyph and coloured words, with no capsule around them (v0.49.0, "no more pills").
//
// Replaces the rounded-full badges the owner asked to lose: Health's "All good" / "Worth a look" / "Needs
// attention", the source cards' "ok" / "blocked", the engine's "ready". No background, no border, no
// rounding -- the shape of the glyph says the status (check, diamond, triangle, open circle, dash), so it
// still reads for an admin who cannot tell amber from red. lib/status.ts holds the tones and the words.
import { TONE_EDGE, TONE_GLYPH, TONE_TEXT, type Tone } from '@/lib/status';
import { ProgressRing } from './ProgressRing';
import { IcAlert, IcCheck } from './icons';

/**
 * The glyph alone, aria-hidden: the words beside it (or the mark's aria-label) carry the meaning.
 *
 * `working` is the one moving glyph, a small turning ring (still under Reduce effects or reduced motion),
 * and it is asked for by name. ⚠️ Not a tone: 'accent' also means FINISHED ("✓ Saved", a notice that
 * something worked), and a glyph that spun for every accent would turn forever beside "Done".
 */
export function StatusGlyph({ tone, size = 12, working }: { tone: Tone; size?: number; working?: boolean }) {
  const cls = `shrink-0 ${TONE_GLYPH[tone]}`;
  if (working) return <span className={cls}><ProgressRing size={size} progress="spin" /></span>;
  switch (tone) {
    case 'ok':
      return <IcCheck aria-hidden width={size} height={size} strokeWidth={2.6} className={cls} />;
    case 'warn':
      return (
        <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className={cls}>
          <path d="M6 1 11 6 6 11 1 6Z" fill="currentColor" />
        </svg>
      );
    case 'problem':
      return <IcAlert aria-hidden width={size} height={size} strokeWidth={2.2} className={cls} />;
    case 'info':
      return (
        <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className={cls}>
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case 'off':
      return (
        <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className={cls}>
          <path d="M3 6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'accent':
      // Finished: a check in a ring, the accent's "done" -- its own shape, so a finished action never reads
      // as the plain check of a health verdict.
      return (
        <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className={cls}>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3.7 6.1 5.3 7.7 8.4 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

/**
 * The mark: a glyph and its words, in the tone's colour. Without `label` it is a glyph alone and needs a
 * `title`, which becomes its accessible name. `working` turns the glyph into the small ring.
 */
export function StatusMark({ tone, label, size = 'sm', title, className, working }: {
  tone: Tone;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
  title?: string;
  className?: string;
  working?: boolean;
}) {
  const text = size === 'xs' ? 'text-[10px]' : size === 'md' ? 'text-xs' : 'text-[11px]';
  const glyph = size === 'xs' ? 10 : size === 'md' ? 13 : 12;
  return (
    <span data-status={tone} title={title} {...(label ? {} : { role: 'img', 'aria-label': title })}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium leading-none ${text} ${TONE_TEXT[tone]} ${className ?? ''}`}>
      <StatusGlyph tone={tone} size={glyph} working={working} />
      {label && <span>{label}</span>}
    </span>
  );
}

/**
 * A 3 px bar on a card's start edge, for a card that needs a second look (it mirrors to the right edge in
 * Arabic). The parent must be positioned -- `.grad-border` already is. It is a real child rather than a
 * pseudo-element because `.grad-border::before` already draws the card's hairline. Inset from the rounded
 * corners by default, so it never pokes out past them.
 *
 * A healthy or switched-off card has no bar: an edge on every card is an edge on none.
 */
export function StatusEdge({ tone, inset = 'inset-y-4' }: { tone: Tone; inset?: string }) {
  if (tone === 'ok' || tone === 'off') return null;
  return <span aria-hidden data-status-edge={tone} className={`pointer-events-none absolute start-0 ${inset} w-[3px] rounded-e-[3px] ${TONE_EDGE[tone]}`} />;
}
