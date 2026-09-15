// A translation group's avatar: its initials on a colour that never changes, with no React in it.
//
// The series page used to name a group in a bordered pill on every row, which is why three rows of "Asura
// Scans" read as three pills of text. A small coloured circle with "AS" in it is recognised without being
// read, so the name can drop to a muted caption -- and the same circle in the sources sheet, the chapter
// sheet and the add dialog ties them together. Colour comes from the NORMALISED name (`normGroup`), so the
// "Asura Scans" a file stamp carries and the "asura-scans" a source lists get one circle, not two.

import { normGroup } from './scanlators';

/** One or two upper-case letters: the first letter of the first two words, or of the only word. `?` for nothing. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s\-_.·&/,]+/).filter(Boolean);
  if (!words.length) return '?';
  const pick = words.length >= 2 ? [words[0], words[1]] : [words[0]];
  return pick.map((w) => w.charAt(0).toUpperCase()).join('');
}

/** A hue in 0-359 from the normalised name, so spellings that the server treats as one group share it. */
export function groupHue(name: string): number {
  const key = normGroup(name) || name.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/**
 * The circle's background. Muted (45 % saturation, 32 % lightness) so a dozen of them on a phone read as
 * marks, not badges, and light text stays legible on every hue.
 */
export function groupColor(name: string): string {
  return `hsl(${groupHue(name)} 45% 32%)`;
}
