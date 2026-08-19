// Filename helpers for the library scanner. Kept dependency-free (no db/sharp imports) so they can be
// unit-tested without booting the app's environment.

/** The first number in a filename — "Chapter 12.cbz" -> 12, "Tome 01.cbr" -> 1, "Ch. 4.5" -> 4.5. 0 if none. */
export function numFromName(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Sort by leading number first, falling back to locale compare — so "Chapter 9" precedes "Chapter 10". */
export function naturalCmp(a: string, b: string): number {
  return numFromName(a) - numFromName(b) || a.localeCompare(b);
}
