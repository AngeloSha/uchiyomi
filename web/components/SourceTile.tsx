'use client';
// A source's face (v0.53.0 Health's Source health, shared with Admin → Sources since v0.54.0): its extension's logo
// when it has one, else the first letters of its name on a tint of its state. One component for both pages, so a
// source wears the same face in the list where it is fixed and on the card where it is reported.
import { useState } from 'react';
import { sourceIcon } from '@/lib/sourceGroups';
import { tileLetters } from '@/lib/sourceHealth';
import { TONE_SURFACE, type Tone } from '@/lib/status';

/** The ring an extension's logo wears in its row's tone. Written out: Tailwind compiles only what it finds. */
const TILE_RING: Record<Tone, string> = {
  ok: 'ring-emerald-500/40', warn: 'ring-amber-400/50', problem: 'ring-red-400/50', info: 'ring-ink-600', off: 'ring-ink-700', accent: 'ring-accent/40',
};

/** Health's rows are 32 px; the Sources list's 40, as an extension's row was; a sheet's head 52. */
const BOX = {
  32: 'h-8 w-8 rounded-lg text-[11px]',
  40: 'h-10 w-10 rounded-xl text-[13px]',
  52: 'h-[52px] w-[52px] rounded-2xl text-base',
} as const;

export function SourceTile({ id, name, icon, tone, size = 32, dim }: {
  /** The source's id; its logo is asked for only when `icon` says the server has one. */
  id?: string | null;
  name: string;
  icon?: boolean;
  tone: Tone;
  size?: keyof typeof BOX;
  /**
   * Faded: a source switched off, or one only listed for reference -- the default for those tones. The Sources list
   * passes `false` for a healthy source, which it draws on the neutral tint: a column of green tiles said nothing.
   */
  dim?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const calm = dim ?? (tone === 'off' || tone === 'info');
  if (icon && id && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={sourceIcon(id)} alt="" aria-hidden width={size} height={size} loading="lazy" decoding="async"
      onError={() => setFailed(true)}
      className={`${BOX[size]} shrink-0 bg-ink-700 object-cover ring-1 ${TILE_RING[tone]} ${calm ? 'opacity-60' : ''}`} />;
  }
  return (
    <span aria-hidden data-source-tile={tone}
      className={`grid ${BOX[size]} shrink-0 place-items-center border font-semibold ${TONE_SURFACE[tone]}`}>
      {tileLetters(name)}
    </span>
  );
}
