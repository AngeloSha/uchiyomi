import { IcUser } from './icons';
import { safeColor } from '@/lib/safeColor';
import { isFrame, type AvatarFrame } from '@/lib/badges';
import { AvatarFrameArt } from './AvatarFrame';

/** `frame` (v0.89.0, #267): the frame a badge unlocked, round the avatar wherever it shows (components/AvatarFrame.tsx). */
export interface AvatarData { emoji?: string; color?: string; frame?: AvatarFrame }

/** `frameLocked`: the avatar editor's picker, showing a frame whose badge is not earned yet -- greyed and still. */
export function Avatar({ avatar, size = 40, frameLocked = false }: { avatar?: AvatarData | null; size?: number; frameLocked?: boolean }) {
  const emoji = avatar?.emoji;
  const color = safeColor(avatar?.color, '#26262f');
  const face = (
    <span className="grid shrink-0 place-items-center rounded-full" style={{ width: size, height: size, background: color }}>
      {emoji ? <span style={{ fontSize: Math.round(size * 0.52), lineHeight: 1 }}>{emoji}</span> : <IcUser width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} className="text-white/80" />}
    </span>
  );
  // A name the app does not know is no frame: an avatar stored by a newer server, or by hand, draws as it always did.
  const frame = isFrame(avatar?.frame) ? avatar.frame : null;
  if (!frame) return face;
  // The frame is drawn over the face and a little past it, so a framed avatar takes the room an unframed one does.
  return (
    <span data-framed={frame} className="relative grid shrink-0" style={{ width: size, height: size }}>
      {face}
      <AvatarFrameArt frame={frame} size={size} locked={frameLocked} />
    </span>
  );
}

export const AVATAR_EMOJIS = ['🦊', '🐯', '🐲', '🐰', '🐼', '🦉', '👾', '🔥', '⚡', '🌙', '🍥', '⚔️', '🗡️', '🌸', '💀', '🎴'];
export const AVATAR_COLORS = ['#7c5cff', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#60a5fa', '#a855f7', '#ef4444'];
