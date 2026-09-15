'use client';
// The coloured circle with a group's initials. See lib/groupAvatar.ts for why it exists and how the colour
// is chosen; this only draws it. `aria-hidden` because the name is always written beside it -- the circle
// is recognition, not information -- and `title` so a hover on the desktop still names it.
import { groupColor, initialsOf } from '@/lib/groupAvatar';

const SIZES = { 14: 'h-3.5 w-3.5 text-[7px]', 16: 'h-4 w-4 text-[8px]', 18: 'h-[18px] w-[18px] text-[9px]', 24: 'h-6 w-6 text-[11px]' } as const;

export function GroupAvatar({ name, size = 16, className = '' }: { name: string; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span aria-hidden title={name}
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold leading-none text-white/90 ${SIZES[size]} ${className}`}
      style={{ background: groupColor(name) }}>
      {initialsOf(name)}
    </span>
  );
}

/**
 * Up to three avatars overlapping, for the supply line on a phone, where two full group names do not fit
 * beside the source and the count. The ring is the page background so the overlap reads as a stack.
 */
export function GroupAvatarStack({ names, size = 16 }: { names: string[]; size?: keyof typeof SIZES }) {
  return (
    <span className="inline-flex items-center">
      {names.slice(0, 3).map((n, i) => (
        <GroupAvatar key={n} name={n} size={size} className={`ring-2 ring-ink-950 ${i > 0 ? '-ms-1.5' : ''}`} />
      ))}
    </span>
  );
}
