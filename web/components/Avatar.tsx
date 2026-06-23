import { IcUser } from './icons';

export interface AvatarData { emoji?: string; color?: string }

export function Avatar({ avatar, size = 40 }: { avatar?: AvatarData | null; size?: number }) {
  const emoji = avatar?.emoji;
  const color = avatar?.color || '#26262f';
  return (
    <span className="grid shrink-0 place-items-center rounded-full" style={{ width: size, height: size, background: color }}>
      {emoji ? <span style={{ fontSize: Math.round(size * 0.52), lineHeight: 1 }}>{emoji}</span> : <IcUser width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} className="text-white/80" />}
    </span>
  );
}

export const AVATAR_EMOJIS = ['🦊', '🐯', '🐲', '🐰', '🐼', '🦉', '👾', '🔥', '⚡', '🌙', '🍥', '⚔️', '🗡️', '🌸', '💀', '🎴'];
export const AVATAR_COLORS = ['#7c5cff', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#60a5fa', '#a855f7', '#ef4444'];
