/**
 * A language's name in the reader's own locale.
 *
 * Discover groups forty-five sources by the language they serve, and this install spans thirty of them.
 * Naming those in the dictionary would be 30 x 8 = 240 entries for data every browser already ships, and it
 * would go stale the moment someone enables a source in a thirty-first language.
 *
 * `Intl.DisplayNames` is Chrome 81 / Safari 14.1 / Firefox 86, comfortably below this app's floor, and the
 * catch falls back to the raw code rather than to nothing.
 */
export function langName(code: string, locale: string): string {
  if (!code) return '';
  try {
    const dn = new (Intl as unknown as { DisplayNames: new (l: string[], o: object) => { of(c: string): string | undefined } })
      .DisplayNames([locale], { type: 'language' });
    const out = dn.of(code);
    // Some runtimes echo the input back for an unknown tag; an uppercase code reads better than "sh".
    return out && out.toLowerCase() !== code.toLowerCase() ? out : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
